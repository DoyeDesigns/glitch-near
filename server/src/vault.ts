import { randomBytes } from 'node:crypto';
import {
  faucetCredit,
  VAULT_MAX_AGE_MS,
  VAULT_MAX_SKEW_MS,
  VAULT_PAUSE_MS,
  VAULT_START_GAP_MS,
  VAULT_TOLERANCE_MS,
  vaultGross,
  vaultHit,
  vaultLockStart,
  vaultLocks,
  vaultShards,
  vaultXp,
  type SkillXp,
  type VaultLock,
} from '@glitch/shared';
import { AuthError, fundsView } from './auth';
import { config } from './config';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById, type PlayerRow } from './near';
import { invalidateGdCache, readGdBalanceForLog } from './near/gd';
import { createToken, getItemBalances, getToken } from './near/items';
import { resumeOrSend } from './near/mintTx';

const minting = new Set<string>();
let retryTimer: ReturnType<typeof setInterval> | null = null;

type VaultRow = {
  id: string;
  player_id: string;
  seed: number;
  started_at: number;
  stop0: number | null;
  stop1: number | null;
  stop2: number | null;
  hits: number;
  gross: string | null;
  credited: string | null;
  capped: number;
  shards: number;
  gd_minted: number;
  shards_minted: number;
  status: string;
  chain_before: string | null;
  mint_tx_hash: string | null;
  mint_tx_at: number | null;
  mint_attempts: number;
  shards_before: string | null;
  shard_tx_hash: string | null;
  shard_tx_at: number | null;
  shard_attempts: number;
};

export type VaultStart = {
  id: string;
  seed: number;
  startedAt: number;
  locks: VaultLock[];
  pauseMs: number;
};

export type VaultFinish = {
  status: 'open' | 'settled';
  hit: boolean;
  hits: number;
  stops: number[];
  credited: string | null;
  capped: boolean;
  shardsMinted: number;
  shardBalance: string | null;
  available: string;
  settling: string;
  xp: SkillXp;
  payUsed: number;
};

function parseXp(raw: string): SkillXp {
  try {
    const j = JSON.parse(raw) as Partial<SkillXp>;
    return { trade: Number(j.trade) || 0, sec: Number(j.sec) || 0, comm: Number(j.comm) || 0 };
  } catch {
    return { trade: 0, sec: 0, comm: 0 };
  }
}

function isWeak(raw: string): boolean {
  try {
    const j = JSON.parse(raw) as { energy?: number; hunger?: number };
    return (Number(j.energy) || 0) < 15 || (Number(j.hunger) || 0) < 10;
  } catch {
    return false;
  }
}

function readStops(row: VaultRow): number[] {
  const out: number[] = [];
  for (const value of [row.stop0, row.stop1, row.stop2]) {
    if (value == null) break;
    out.push(value);
  }
  return out;
}

function sameStops(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function scoreStop(seed: number, stops: readonly number[], index: number): boolean {
  const lock = vaultLocks(seed)[index];
  if (!lock) return false;
  const local = stops[index]! - vaultLockStart(stops, index);
  return vaultHit(local, lock.zoneStart, lock.zoneWidth, lock.speed);
}

function hitCount(seed: number, stops: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < stops.length; i++) if (scoreStop(seed, stops, i)) n++;
  return n;
}

export function parseVaultStops(body: unknown): number[] | null {
  if (!body || typeof body !== 'object') return null;
  const stops = (body as { stops?: unknown }).stops;
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > 3) return null;
  const out: number[] = [];
  for (const stop of stops) {
    if (typeof stop !== 'number' || !Number.isInteger(stop) || stop < 0) return null;
    out.push(stop);
  }
  return out;
}

function openVault(playerId: string): VaultRow | undefined {
  return db
    .prepare(`SELECT * FROM vaults WHERE player_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`)
    .get(playerId) as VaultRow | undefined;
}

async function accountView(player: PlayerRow): Promise<{ available: string; settling: string; xp: SkillXp; payUsed: number }> {
  const fresh = getPlayerById(player.id) ?? player;
  const funds = await fundsView(fresh);
  return {
    available: funds.available,
    settling: funds.settling,
    xp: parseXp(fresh.xp_json),
    payUsed: 0,
  };
}

async function shardBalanceOf(accountId: string): Promise<string | null> {
  if (process.env.VITEST) return null;
  try {
    const items = await getItemBalances(accountId);
    return items.shard ?? '0';
  } catch {
    return null;
  }
}

async function shardsBefore(accountId: string | null): Promise<string | null> {
  if (!accountId || process.env.VITEST) return null;
  return shardBalanceOf(accountId);
}

async function viewOf(player: PlayerRow, row: VaultRow, hit: boolean): Promise<VaultFinish> {
  const account = await accountView(player);
  const settled = row.status === 'settled';
  return {
    status: settled ? 'settled' : 'open',
    hit,
    hits: row.hits,
    stops: readStops(row),
    credited: settled ? row.credited : null,
    capped: settled && row.capped === 1,
    shardsMinted: settled && row.shards_minted === 1 ? row.shards : 0,
    shardBalance: settled && player.account_id ? await shardBalanceOf(player.account_id) : null,
    ...account,
  };
}

export async function startVault(player: PlayerRow): Promise<VaultStart> {
  const id = randomId();
  const seed = randomBytes(4).readUInt32LE(0);
  const startedAt = Date.now();
  const insert = db.transaction(() => {
    const open = db
      .prepare(`SELECT id FROM vaults WHERE player_id = ? AND status = 'open'`)
      .get(player.id) as { id: string } | undefined;
    if (open) throw new AuthError('A vault is already open', 409);
    const last = db
      .prepare(`SELECT started_at FROM vaults WHERE player_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(player.id) as { started_at: number } | undefined;
    if (last && startedAt - last.started_at < VAULT_START_GAP_MS) {
      throw new AuthError('Wait before the next vault', 429);
    }
    db.prepare(
      `INSERT INTO vaults (id, player_id, seed, started_at, status) VALUES (?, ?, ?, ?, 'open')`,
    ).run(id, player.id, seed, startedAt);
  });
  try {
    insert.immediate();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) throw new AuthError('A vault is already open', 409);
    throw err;
  }
  return { id, seed, startedAt, locks: vaultLocks(seed), pauseMs: VAULT_PAUSE_MS };
}

export async function cancelVault(player: PlayerRow): Promise<{ ok: true }> {
  db.prepare(`UPDATE vaults SET status = 'abandoned' WHERE player_id = ? AND status = 'open'`).run(player.id);
  return { ok: true };
}

export async function finishVault(player: PlayerRow, stops: number[]): Promise<VaultFinish> {
  const row = openVault(player.id);
  if (!row) {
    const last = db
      .prepare(`SELECT * FROM vaults WHERE player_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(player.id) as VaultRow | undefined;
    if (last?.status === 'settled' && sameStops(readStops(last), stops)) {
      return viewOf(player, last, scoreStop(last.seed, stops, stops.length - 1));
    }
    throw new AuthError('No vault is open', 400);
  }

  const stored = readStops(row);
  if (sameStops(stored, stops)) {
    return viewOf(player, row, stored.length ? scoreStop(row.seed, stored, stored.length - 1) : false);
  }
  if (stops.length !== stored.length + 1 || !sameStops(stored, stops.slice(0, stored.length))) {
    throw new AuthError('Send the stops in order', 400);
  }

  const index = stops.length - 1;
  const stop = stops[index]!;
  const serverElapsed = Date.now() - row.started_at;
  if (stop > serverElapsed + VAULT_MAX_SKEW_MS || stop < serverElapsed - VAULT_MAX_AGE_MS) {
    throw new AuthError('The server clock missed that stop. Try again.', 400);
  }
  const lockStart = vaultLockStart(stops, index);
  if (stop < lockStart - VAULT_TOLERANCE_MS) throw new AuthError('That lock has not started', 400);

  const hit = scoreStop(row.seed, stops, index);
  const hits = hitCount(row.seed, stops);
  const done = stops.length === 3;
  const chainBefore = done ? await readGdBalanceForLog(player.account_id) : null;
  const shardBefore = done ? await shardsBefore(player.account_id) : null;

  const saved = db.transaction(() => {
    const fresh = db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow | undefined;
    if (!fresh || fresh.status !== 'open') return null;
    if (!sameStops(readStops(fresh), stored)) return null;
    const column = index === 0 ? 'stop0' : index === 1 ? 'stop1' : 'stop2';
    if (!done) {
      db.prepare(`UPDATE vaults SET ${column} = ?, hits = ? WHERE id = ?`).run(stop, hits, row.id);
      return db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow;
    }

    const progress = db
      .prepare(`SELECT xp_json, needs_json FROM players WHERE id = ?`)
      .get(player.id) as { xp_json: string; needs_json: string } | undefined;
    if (!progress) return null;
    const xp = parseXp(progress.xp_json);
    xp.sec += vaultXp(hits);
    const gross = vaultGross(hits);
    const shards = vaultShards(hits);
    let credited = 0;
    if (gross > 0) {
      credited = faucetCredit(gross, isWeak(progress.needs_json)).credited;
    }
    db.prepare(`UPDATE players SET xp_json = ? WHERE id = ?`).run(JSON.stringify(xp), player.id);
    db.prepare(
      `UPDATE vaults SET ${column} = ?, hits = ?, gross = ?, credited = ?, capped = ?, shards = ?, gd_minted = ?, shards_minted = ?, status = 'settled', chain_before = ?, shards_before = ? WHERE id = ?`,
    ).run(
      stop,
      hits,
      String(gross),
      String(credited),
      0,
      shards,
      credited > 0 ? 0 : 1,
      shards > 0 ? 0 : 1,
      chainBefore,
      shardBefore,
      row.id,
    );
    return db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow;
  });

  const next = saved.immediate();
  if (!next) throw new AuthError('That vault is already finished', 409);
  if (next.status === 'settled') await mintVault(next);
  const paid = db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow;
  return viewOf(player, paid, hit);
}

/** Boot check. A vault finish does not call getToken or createToken. */
export async function ensureShardToken(): Promise<void> {
  try {
    const existing = await getToken('shard');
    if (existing) return;
    await createToken('shard', 'shard', 'Shard', null);
  } catch {
    console.error('[vault] shard token is missing');
  }
}

async function mintVault(row: VaultRow): Promise<void> {
  if (row.status !== 'settled') return;
  if (row.gd_minted === 1 && row.shards_minted === 1) return;
  if (minting.has(row.id)) return;
  minting.add(row.id);
  try {
    const fresh = db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow | undefined;
    if (!fresh || fresh.status !== 'settled') return;
    const player = getPlayerById(fresh.player_id);
    if (!player?.account_id) return;
    const accountId = player.account_id;
    if (fresh.gd_minted !== 1) {
      const credited = BigInt(fresh.credited ?? '0');
      if (credited <= 0n) {
        db.prepare(`UPDATE vaults SET gd_minted = 1 WHERE id = ?`).run(fresh.id);
      } else {
        try {
          await resumeOrSend(
            {
              flag: fresh.gd_minted,
              hash: fresh.mint_tx_hash,
              txAt: fresh.mint_tx_at,
              attempts: fresh.mint_attempts ?? 0,
            },
            {
              mark: () => {
                db.prepare(`UPDATE vaults SET gd_minted = 1 WHERE id = ? AND gd_minted = 0`).run(fresh.id);
                invalidateGdCache(accountId);
              },
              persist: (hash, at, attempts) => {
                db.prepare(
                  `UPDATE vaults SET mint_tx_hash = ?, mint_tx_at = ?, mint_attempts = ? WHERE id = ?`,
                ).run(hash, at, attempts, fresh.id);
              },
              call: {
                contractId: config.gdContract,
                methodName: 'mint',
                args: { account_id: accountId, amount: String(credited) },
              },
            },
          );
        } catch {
          console.error('[vault] gd mint failed');
        }
      }
    }
    const afterGd = db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(fresh.id) as VaultRow;
    if (afterGd.shards_minted !== 1) {
      if (afterGd.shards <= 0) {
        db.prepare(`UPDATE vaults SET shards_minted = 1 WHERE id = ?`).run(fresh.id);
      } else {
        try {
          await resumeOrSend(
            {
              flag: afterGd.shards_minted,
              hash: afterGd.shard_tx_hash,
              txAt: afterGd.shard_tx_at,
              attempts: afterGd.shard_attempts ?? 0,
            },
            {
              mark: () => {
                db.prepare(`UPDATE vaults SET shards_minted = 1 WHERE id = ? AND shards_minted = 0`).run(fresh.id);
              },
              persist: (hash, at, attempts) => {
                db.prepare(
                  `UPDATE vaults SET shard_tx_hash = ?, shard_tx_at = ?, shard_attempts = ? WHERE id = ?`,
                ).run(hash, at, attempts, fresh.id);
              },
              call: {
                contractId: config.itemsContract,
                methodName: 'mint',
                args: { account_id: accountId, token_id: 'shard', amount: String(afterGd.shards) },
              },
            },
          );
        } catch {
          console.error('[vault] shard mint failed');
        }
      }
    }
  } finally {
    minting.delete(row.id);
  }
}

async function retryPendingMints(): Promise<void> {
  const due = db
    .prepare(`SELECT * FROM vaults WHERE status = 'settled' AND (gd_minted = 0 OR shards_minted = 0)`)
    .all() as VaultRow[];
  for (const row of due) await mintVault(row);
}

/**
 * Stored mint_tx_hash and shard_tx_hash are looked up for the treasury signer.
 * Success only sets that flag. Failure may sign one fresh transaction.
 * Unknown waits 3 minutes, then signs a fresh transaction.
 * Signed bytes are not stored, so a sent transaction is never broadcast again.
 * chain_before and shards_before are diagnostic only.
 */
export function resumeVaults(): Promise<void> {
  if (!retryTimer && !process.env.VITEST) retryTimer = setInterval(() => void retryPendingMints(), 20_000);
  return retryPendingMints();
}
