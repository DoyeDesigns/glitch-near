import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { nearToYocto } from 'near-api-js';
import { START_GD } from '@glitch/shared';
import { config, requireNearConfig } from './config';
import { randomId } from './crypto';
import { db } from './db';
import {
  createPlayerAccount,
  formatNear,
  getItemBalances,
  getGDBalanceCached,
  getNearBalanceCached,
  getPlayerById,
  getPlayerByName,
  getProvider,
  mintGD,
  resumePendingAccount,
  validatePlayerName,
  type PlayerRow,
} from './near';
import { syncNeedsDecay } from './needs';

export const SESSION_COOKIE = 'glitch_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

const HOUR_MS = 3_600_000;
const SESSION_MS = 30 * 24 * HOUR_MS;
const GUEST_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PIN_RE = /^\d{4,6}$/;
const LOCK_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const AUTH_FAIL = 'Invalid name or PIN';
/** Dummy scrypt target so a missing account still does a compare. */
const DUMMY_SALT = randomBytes(16);
const DUMMY_HASH = scryptSync('000000', DUMMY_SALT, 32);
/** Refuse new signups when the players parent account is below this. */
const MIN_ROOT_NEAR = nearToYocto('0.2');

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429 | 503 = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type XpState = { trade: number; sec: number; comm: number };
export type NeedsState = { energy: number; hunger: number };

export type MePayload = {
  name: string;
  accountId: string;
  available: string;
  settling: string;
  items: Record<string, string>;
  xp: XpState;
  needs: NeedsState;
  homePaidUntil: number;
};

export type BalanceParts = {
  chain: bigint;
  pending: bigint;
  escrowed: bigint;
  settling: bigint;
  spendable: bigint;
  available: bigint;
};

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sumAmounts(table: 'pending_burns' | 'escrow', playerId: string): bigint {
  const rows = db.prepare(`SELECT amount FROM ${table} WHERE player_id = ?`).all(playerId) as {
    amount: string;
  }[];
  let n = 0n;
  for (const r of rows) {
    try {
      n += BigInt(r.amount);
    } catch {
      /* skip corrupt rows */
    }
  }
  return n;
}

/** Credited GD on settled rows whose mint flag is still off. */
function settlingGd(playerId: string): bigint {
  const rows = db
    .prepare(
      `SELECT credited AS amount FROM trades WHERE player_id = ? AND status = 'settled' AND minted = 0
       UNION ALL
       SELECT credited AS amount FROM vaults WHERE player_id = ? AND status = 'settled' AND gd_minted = 0
       UNION ALL
       SELECT credited AS amount FROM posts WHERE player_id = ? AND minted = 0`,
    )
    .all(playerId, playerId, playerId) as { amount: string | null }[];
  let n = 0n;
  for (const row of rows) {
    if (!row.amount) continue;
    try {
      const value = BigInt(row.amount);
      if (value > 0n) n += value;
    } catch {
      /* skip corrupt rows */
    }
  }
  return n;
}

/** Pending burns, escrow, and unminted credits. Safe to call inside a SQLite transaction. */
export function ledgerTotals(playerId: string): { pending: bigint; escrowed: bigint; settling: bigint } {
  return {
    pending: sumAmounts('pending_burns', playerId),
    escrowed: sumAmounts('escrow', playerId),
    settling: settlingGd(playerId),
  };
}

function parseXp(raw: string): XpState {
  try {
    const j = JSON.parse(raw) as Partial<XpState>;
    return { trade: Number(j.trade) || 0, sec: Number(j.sec) || 0, comm: Number(j.comm) || 0 };
  } catch {
    return { trade: 0, sec: 0, comm: 0 };
  }
}

function parseNeeds(raw: string): NeedsState {
  try {
    const j = JSON.parse(raw) as Partial<NeedsState>;
    return { energy: Number(j.energy) || 0, hunger: Number(j.hunger) || 0 };
  } catch {
    return { energy: 100, hunger: 80 };
  }
}

export function issueSession(playerId: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)`).run(
    sha256(token),
    playerId,
    Date.now() + SESSION_MS,
  );
  return token;
}

export function playerFromSessionToken(token: string | undefined): PlayerRow | undefined {
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT player_id FROM sessions WHERE token_hash = ? AND expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as { player_id: string } | undefined;
  if (!row) return undefined;
  return getPlayerById(row.player_id);
}

function guestName(): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    let suffix = '';
    for (let i = 0; i < 5; i++) suffix += GUEST_ALPHABET[randomInt(GUEST_ALPHABET.length)]!;
    const name = `guest-${suffix}`;
    validatePlayerName(name);
    if (!getPlayerByName(name)) return name;
  }
  throw new AuthError('Could not allocate a guest name', 503);
}

function assertSignupAllowed(ip: string, inviteCode: string | undefined): void {
  if (config.inviteCode && inviteCode !== config.inviteCode) {
    throw new AuthError('Invite code required', 403);
  }
  const since = Date.now() - HOUR_MS;
  const byIp = db
    .prepare(`SELECT COUNT(*) AS n FROM signup_log WHERE ip = ? AND created_at > ?`)
    .get(ip, since) as { n: number };
  if (byIp.n >= config.signupIpPerHour) {
    throw new AuthError('Too many new accounts from this network. Try again later.', 429);
  }
  const global = db.prepare(`SELECT COUNT(*) AS n FROM signup_log WHERE created_at > ?`).get(since) as {
    n: number;
  };
  if (global.n >= config.signupHourlyCap) {
    throw new AuthError('New accounts are paused for this hour. Try again later.', 429);
  }
}

async function assertRootFunded(): Promise<void> {
  requireNearConfig();
  const view = await getProvider().viewAccount({ accountId: config.rootAccount });
  const yocto = BigInt(view.amount);
  if (yocto < MIN_ROOT_NEAR) {
    throw new AuthError('New accounts are paused. Try again later.', 503);
  }
}

async function ensureStarterMint(row: PlayerRow): Promise<void> {
  if (row.gd_minted) return;
  if (!row.account_id) throw new AuthError('Account is not ready', 503);
  await mintGD(row.account_id, START_GD);
  db.prepare(`UPDATE players SET gd_minted = 1 WHERE id = ?`).run(row.id);
  row.gd_minted = 1;
}

function recordSignup(ip: string): void {
  db.prepare(`INSERT INTO signup_log (id, ip, created_at) VALUES (?, ?, ?)`).run(randomId(), ip, Date.now());
}

function assertPin(pin: string): void {
  if (!PIN_RE.test(pin)) throw new AuthError('PIN must be 4–6 digits', 400);
}

function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

/** Constant-time check. Missing hash still runs scrypt so unknown names are not faster. */
function pinMatches(pin: string, saltB64: string | null, hashB64: string | null): boolean {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : DUMMY_SALT;
  const expected = hashB64 ? Buffer.from(hashB64, 'base64') : DUMMY_HASH;
  const actual = scryptSync(pin, salt, expected.length);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return ok && !!hashB64 && !!saltB64;
}

function storePin(playerId: string, pin: string): void {
  const { hash, salt } = hashPin(pin);
  db.prepare(`UPDATE players SET pin_hash = ?, pin_salt = ? WHERE id = ?`).run(hash, salt, playerId);
}

type LockRow = { fails: number; locked_until: number };

function lockState(scope: 'name' | 'ip', key: string): LockRow {
  const row = db
    .prepare(`SELECT fails, locked_until FROM auth_lockouts WHERE scope = ? AND key = ?`)
    .get(scope, key) as LockRow | undefined;
  if (!row) return { fails: 0, locked_until: 0 };
  if (row.locked_until > 0 && row.locked_until <= Date.now()) return { fails: 0, locked_until: 0 };
  return row;
}

function assertNotLocked(name: string, ip: string): void {
  const now = Date.now();
  for (const [scope, key] of [
    ['name', name],
    ['ip', ip],
  ] as const) {
    const row = lockState(scope, key);
    if (row.locked_until > now) {
      throw new AuthError('Too many attempts. Try again in 10 minutes.', 429);
    }
  }
}

function recordAuthFailure(name: string, ip: string): void {
  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO auth_lockouts (scope, key, fails, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`,
  );
  for (const [scope, key] of [
    ['name', name],
    ['ip', ip],
  ] as const) {
    const fails = lockState(scope, key).fails + 1;
    const lockedUntil = fails >= LOCK_FAILS ? now + LOCK_MS : 0;
    upsert.run(scope, key, fails >= LOCK_FAILS ? LOCK_FAILS : fails, lockedUntil);
  }
}

function clearAuthFailures(name: string, ip: string): void {
  db.prepare(`DELETE FROM auth_lockouts WHERE (scope = 'name' AND key = ?) OR (scope = 'ip' AND key = ?)`).run(
    name,
    ip,
  );
}

async function activateNamed(name: string, ip: string, inviteCode: string | undefined, pin: string): Promise<PlayerRow> {
  assertSignupAllowed(ip, inviteCode);
  await assertRootFunded();
  await createPlayerAccount(name);
  recordSignup(ip);
  const row = getPlayerByName(name);
  if (!row) throw new AuthError('Account was not stored', 503);
  storePin(row.id, pin);
  return row;
}

export async function loginPlayer(opts: {
  name?: string;
  pin?: string;
  guest?: boolean;
  signup?: boolean;
  inviteCode?: string;
  ip: string;
}): Promise<{ token: string; player: PlayerRow }> {
  if (opts.guest) {
    const name = guestName();
    assertSignupAllowed(opts.ip, opts.inviteCode);
    await assertRootFunded();
    await createPlayerAccount(name);
    recordSignup(opts.ip);
    let row = getPlayerByName(name);
    if (!row) throw new AuthError('Account was not stored', 503);
    if (row.status !== 'active') {
      await resumePendingAccount(name);
      row = getPlayerByName(name);
      if (!row || row.status !== 'active') throw new AuthError('Account is not ready', 503);
    }
    await ensureStarterMint(row);
    const fresh = getPlayerByName(name) ?? row;
    return { token: issueSession(fresh.id), player: fresh };
  }

  const name = (opts.name ?? '').trim().toLowerCase();
  const pin = opts.pin ?? '';
  try {
    validatePlayerName(name);
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : 'Invalid name', 400);
  }
  assertPin(pin);
  assertNotLocked(name, opts.ip);

  let row = getPlayerByName(name);

  if (opts.signup) {
    if (row) {
      recordAuthFailure(name, opts.ip);
      throw new AuthError(AUTH_FAIL, 401);
    }
    row = await activateNamed(name, opts.ip, opts.inviteCode, pin);
  } else {
    const ok = pinMatches(pin, row?.pin_salt ?? null, row?.pin_hash ?? null);
    if (!row || !ok) {
      recordAuthFailure(name, opts.ip);
      throw new AuthError(AUTH_FAIL, 401);
    }
  }

  if (!row) throw new AuthError(AUTH_FAIL, 401);

  if (row.status !== 'active') {
    await resumePendingAccount(name);
    row = getPlayerByName(name);
    if (!row || row.status !== 'active') throw new AuthError('Account is not ready', 503);
  }

  clearAuthFailures(name, opts.ip);
  await ensureStarterMint(row);
  const fresh = getPlayerByName(name) ?? row;
  return { token: issueSession(fresh.id), player: fresh };
}

/**
 * available = chain − pending burns − escrow + settling.
 * spendable = chain − pending burns − escrow.
 * Chain balance is cached 5s. settling is credited GD that is not minted yet.
 */
export async function balanceParts(player: PlayerRow): Promise<BalanceParts> {
  if (!player.account_id) throw new AuthError('Player has no account', 503);
  const chain = BigInt(await getGDBalanceCached(player.account_id));
  const { pending, escrowed, settling } = ledgerTotals(player.id);
  const rawSpend = chain - pending - escrowed;
  const spendable = rawSpend < 0n ? 0n : rawSpend;
  const rawAvail = rawSpend + settling;
  const available = rawAvail < 0n ? 0n : rawAvail;
  return { chain, pending, escrowed, settling, spendable, available };
}

/** HUD and stake checks. Includes unminted credits so the number does not drop when a mint lands. */
export async function availableGd(player: PlayerRow): Promise<bigint> {
  return (await balanceParts(player)).available;
}

/** On-chain spends. Unminted credits are not included. */
export async function spendableGd(player: PlayerRow): Promise<bigint> {
  return (await balanceParts(player)).spendable;
}

export async function fundsView(player: PlayerRow): Promise<{ available: string; settling: string }> {
  const parts = await balanceParts(player);
  return { available: parts.available.toString(), settling: parts.settling.toString() };
}

/**
 * On-chain purchase or maintenance. Refuses when only unminted credits would cover the cost.
 */
export async function assertCanSpend(player: PlayerRow, amount: bigint): Promise<void> {
  const parts = await balanceParts(player);
  if ((await spendableGd(player)) >= amount) return;
  if (parts.spendable + parts.settling >= amount) {
    throw new AuthError('Winnings are still landing on chain. Wait and try again.', 400);
  }
  throw new AuthError('Not enough GD', 400);
}

/** available includes settling. Chain balance is cached 5s. Needs are decayed first. */
export async function meForPlayer(player: PlayerRow): Promise<MePayload> {
  if (!player.account_id) throw new AuthError('Player has no account', 503);
  const needs = syncNeedsDecay(player.id);
  const fresh = getPlayerById(player.id) ?? player;
  const [parts, items] = await Promise.all([balanceParts(fresh), getItemBalances(fresh.account_id!)]);
  return {
    name: fresh.name,
    accountId: fresh.account_id!,
    available: parts.available.toString(),
    settling: parts.settling.toString(),
    items,
    xp: parseXp(fresh.xp_json),
    needs,
    homePaidUntil: fresh.home_paid_until ?? 0,
  };
}

export type ChainProof = {
  accountId: string;
  gdOnChain: string;
  available: string;
  pending: string;
  items: Record<string, string>;
  /** Player NEAR, formatted. Network fees, covered by the game. */
  nearBalance: string;
  gdContract: string;
  itemsContract: string;
};

const proofCache = new Map<string, { until: number; value: ChainProof }>();
const PROOF_CACHE_MS = 5_000;

/** On-chain snapshot for Settings. Chain reads are cached 5s. No keys. */
export async function chainProofFor(player: PlayerRow): Promise<ChainProof> {
  if (!player.account_id) throw new AuthError('Player has no account', 503);
  const now = Date.now();
  const hit = proofCache.get(player.id);
  if (hit && hit.until > now) return hit.value;

  const accountId = player.account_id;
  const [chainRaw, items, nearYocto] = await Promise.all([
    getGDBalanceCached(accountId),
    getItemBalances(accountId),
    getNearBalanceCached(accountId),
  ]);
  const chain = BigInt(chainRaw);
  const pendingHeld = sumAmounts('pending_burns', player.id) + sumAmounts('escrow', player.id);
  let available = chain - pendingHeld;
  if (available < 0n) available = 0n;
  const pending = chain - available;
  if (nearYocto == null) throw new Error('NEAR balance unavailable');
  const value: ChainProof = {
    accountId,
    gdOnChain: chain.toString(),
    available: available.toString(),
    pending: pending.toString(),
    items,
    nearBalance: formatNear(nearYocto),
    gdContract: config.gdContract,
    itemsContract: config.itemsContract,
  };
  proofCache.set(player.id, { until: now + PROOF_CACHE_MS, value });
  return value;
}
