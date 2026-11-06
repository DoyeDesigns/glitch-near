import { randomBytes } from 'node:crypto';
import {
  faucetCredit,
  payCapFor,
  VAULT_PAUSE_MS,
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
import { AuthError, availableGd } from './auth';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById, type PlayerRow } from './near';
import { mintGD } from './near/gd';
import { createToken, getItemBalances, getToken, mintItem } from './near/items';

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

function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
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

async function accountView(player: PlayerRow): Promise<{ available: string; xp: SkillXp; payUsed: number }> {
  const fresh = getPlayerById(player.id) ?? player;
  const today = dayKey();
  return {
    available: (await availableGd(fresh)).toString(),
    xp: parseXp(fresh.xp_json),
    payUsed: fresh.pay_day === today ? fresh.pay_used : 0,
  };
}

async function shardBalanceOf(accountId: string): Promise<string | null> {
  try {
    const items = await getItemBalances(accountId);
    return items.shard ?? '0';
  } catch {
    return null;
  }
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
    db.prepare(
      `INSERT INTO vaults (id, player_id, seed, started_at, status) VALUES (?, ?, ?, ?, 'open')`,
    ).run(id, player.id, seed, startedAt);
  });
  try {
    insert();
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
  if (Math.abs(serverElapsed - stop) > VAULT_TOLERANCE_MS) {
    throw new AuthError('The server clock missed that stop. Try again.', 400);
  }
  const lockStart = vaultLockStart(stops, index);
  if (stop < lockStart - VAULT_TOLERANCE_MS) throw new AuthError('That lock has not started', 400);

  const hit = scoreStop(row.seed, stops, index);
  const hits = hitCount(row.seed, stops);
  const done = stops.length === 3;

  const saved = db.transaction(() => {
    const fresh = db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow | undefined;
    if (!fresh || fresh.status !== 'open') return null;
    if (!sameStops(readStops(fresh), stored)) return null;
    const column = index === 0 ? 'stop0' : index === 1 ? 'stop1' : 'stop2';
    if (!done) {
      db.prepare(`UPDATE vaults SET ${column} = ?, hits = ? WHERE id = ?`).run(stop, hits, row.id);
      return db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow;
    }

    const now = Date.now();
    const today = dayKey(now);
    const xp = parseXp(player.xp_json);
    xp.sec += vaultXp(hits);
    const payUsed0 = player.pay_day === today ? player.pay_used : 0;
    const gross = vaultGross(hits);
    const shards = vaultShards(hits);
    let credited = 0;
    let capped = false;
    let payUsed = payUsed0;
    if (gross > 0) {
      const next = faucetCredit(gross, isWeak(player.needs_json), payCapFor(xp), payUsed0);
      credited = next.credited;
      capped = next.capped;
      payUsed = next.payUsed;
    }
    db.prepare(`UPDATE players SET xp_json = ?, pay_day = ?, pay_used = ? WHERE id = ?`).run(
      JSON.stringify(xp),
      today,
      payUsed,
      player.id,
    );
    db.prepare(
      `UPDATE vaults SET ${column} = ?, hits = ?, gross = ?, credited = ?, capped = ?, shards = ?, gd_minted = ?, shards_minted = ?, status = 'settled' WHERE id = ?`,
    ).run(
      stop,
      hits,
      String(gross),
      String(credited),
      capped ? 1 : 0,
      shards,
      credited > 0 ? 0 : 1,
      shards > 0 ? 0 : 1,
      row.id,
    );
    return db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow;
  });

  const next = saved();
  if (!next) throw new AuthError('That vault is already finished', 409);
  if (next.status === 'settled') await mintVault(next);
  const paid = db.prepare(`SELECT * FROM vaults WHERE id = ?`).get(row.id) as VaultRow;
  return viewOf(player, paid, hit);
}

async function ensureShardToken(): Promise<void> {
  const existing = await getToken('shard');
  if (existing) return;
  await createToken('shard', 'shard', 'Shard', null);
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
    if (fresh.gd_minted !== 1) {
      const credited = BigInt(fresh.credited ?? '0');
      if (credited <= 0n) {
        db.prepare(`UPDATE vaults SET gd_minted = 1 WHERE id = ?`).run(fresh.id);
      } else {
        try {
          await mintGD(player.account_id, credited);
          db.prepare(`UPDATE vaults SET gd_minted = 1 WHERE id = ? AND gd_minted = 0`).run(fresh.id);
        } catch {
          console.error('[vault] gd mint failed');
        }
      }
    }
    if (fresh.shards_minted !== 1) {
      if (fresh.shards <= 0) {
        db.prepare(`UPDATE vaults SET shards_minted = 1 WHERE id = ?`).run(fresh.id);
      } else {
        try {
          await ensureShardToken();
          await mintItem(player.account_id, 'shard', fresh.shards);
          db.prepare(`UPDATE vaults SET shards_minted = 1 WHERE id = ? AND shards_minted = 0`).run(fresh.id);
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

export function resumeVaults(): void {
  if (!retryTimer) retryTimer = setInterval(() => void retryPendingMints(), 20_000);
  void retryPendingMints();
}
