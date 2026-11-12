import { randomBytes } from 'node:crypto';
import { tradePnl, vaultHit, vaultLockStart, vaultLocks, vaultXp } from '@glitch/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assertCanSpend, availableGd, AuthError } from '../src/auth';
import { config } from '../src/config';
import { db } from '../src/db';
import { getPlayerById, type PlayerRow } from '../src/near';
import { getGDBalanceCached, mintGD, setGdChainForTests } from '../src/near/gd';
import { MINT_UNKNOWN_WAIT_MS, nextMintStep, setMintTxTestHooks } from '../src/near/mintTx';
import { publishPost } from '../src/post';
import { world } from '../src/sim';
import { resumeTrades, openTrade, resolveTrade } from '../src/trade';
import { finishVault, startVault } from '../src/vault';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

const balances = new Map<string, bigint>();
let signs = 0;

function player(tag: string): PlayerRow {
  const id = `p-${tag}-${randomBytes(4).toString('hex')}`;
  const accountId = `${id}.test`;
  db.prepare(
    `INSERT INTO players (id, name, account_id, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
  ).run(id, id, accountId, Date.now());
  const row = getPlayerById(id);
  if (!row) throw new Error('player missing');
  return row;
}

function fund(accountId: string, amount: bigint): void {
  balances.set(accountId, amount);
}

function zoneStop(seed: number, prior: number[]): number {
  const index = prior.length;
  const lock = vaultLocks(seed)[index];
  if (!lock) throw new Error('lock missing');
  const origin = vaultLockStart(prior, index);
  for (let local = 0; local < 30_000; local += 16) {
    if (vaultHit(local, lock.zoneStart, lock.zoneWidth, lock.speed)) return origin + local;
  }
  throw new Error('zone missing');
}

beforeEach(() => {
  signs = 0;
  setMintTxTestHooks({
    sign: async () => {
      signs += 1;
      return { hash: `h${signs}`, signed: {} as never };
    },
    broadcast: async () => 'success',
    lookup: async () => 'success',
  });
});

afterAll(() => {
  setMintTxTestHooks(null);
  setGdChainForTests(null);
});

setGdChainForTests({
  read: async accountId => balances.get(accountId) ?? 0n,
  mint: async (accountId, amount) => {
    balances.set(accountId, (balances.get(accountId) ?? 0n) + amount);
  },
});

describe('settlement', () => {
  it('lets only one of two overlapping trades escrow the balance', async () => {
    const row = player('overlap');
    fund(row.account_id!, 10_000n);
    const results = await Promise.allSettled([
      openTrade(row, { sym: 'BTX', dir: 1, stake: 6000 }),
      openTrade(row, { sym: 'BTX', dir: 1, stake: 6000 }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const escrow = db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE player_id = ?`).get(row.id) as { n: number };
    expect(escrow.n).toBe(1);
  });

  it('keeps XP when a trade and a vault settle together', async () => {
    const row = player('both');
    fund(row.account_id!, 100_000n);
    const token = world.tokens.find(t => t.sym === 'BTX');
    if (!token) throw new Error('BTX');
    const stake = 1_000;
    const pnl = tradePnl(stake, 1, token.price / 2, token.price);
    expect(pnl).toBeGreaterThan(0);
    const now = Date.now();
    const tradeId = `both-${row.id}`;
    db.prepare(
      `INSERT INTO trades (id, player_id, sym, dir, stake, fee, p0, opened_at, resolves_at, status)
       VALUES (?, ?, 'BTX', 1, ?, '10', ?, ?, ?, 'open')`,
    ).run(tradeId, row.id, String(stake), String(token.price / 2), now, now);
    const started = await startVault(row);
    const stops: number[] = [];
    for (let i = 0; i < 2; i++) {
      const stop = zoneStop(started.seed, stops);
      db.prepare(`UPDATE vaults SET started_at = ? WHERE id = ?`).run(Date.now() - stop, started.id);
      await finishVault(row, [...stops, stop]);
      stops.push(stop);
    }
    const last = zoneStop(started.seed, stops);
    db.prepare(`UPDATE vaults SET started_at = ? WHERE id = ?`).run(Date.now() - last, started.id);
    await Promise.all([resolveTrade(tradeId), finishVault(row, [...stops, last])]);
    const after = getPlayerById(row.id);
    const xp = JSON.parse(after?.xp_json || '{}') as { trade: number; sec: number; comm: number };
    expect(xp.trade).toBe(20);
    expect(xp.sec).toBe(vaultXp(3));
    // Daily skill-pay meter removed — pay_used stays inert.
    expect(after?.pay_used).toBe(0);
  });

  it('rejects a stake the balance cannot cover', async () => {
    const row = player('short');
    fund(row.account_id!, 1_000n);
    await expect(openTrade(row, { sym: 'BTX', dir: 1, stake: 5000 })).rejects.toThrow(/Not enough GD/);
  });

  it('rejects a second open trade', async () => {
    const row = player('second');
    fund(row.account_id!, 50_000n);
    await openTrade(row, { sym: 'BTX', dir: 1, stake: 1000 });
    await expect(openTrade(row, { sym: 'BTX', dir: -1, stake: 1000 })).rejects.toThrow(/already have a bet/);
  });

  it('rejects three in-zone stops that are older than the arrival window', async () => {
    const row = player('stale');
    fund(row.account_id!, 1_000n);
    const started = await startVault(row);
    const stops = [zoneStop(started.seed, [])];
    stops.push(zoneStop(started.seed, stops));
    stops.push(zoneStop(started.seed, stops));
    db.prepare(`UPDATE vaults SET started_at = ? WHERE id = ?`).run(Date.now() - (stops[0]! + 2_000), started.id);
    await expect(finishVault(row, [stops[0]!])).rejects.toThrow(/clock/);
    await expect(finishVault(row, stops)).rejects.toBeInstanceOf(AuthError);
    const saved = db.prepare(`SELECT status, credited, hits FROM vaults WHERE id = ?`).get(started.id) as {
      status: string;
      credited: string | null;
      hits: number;
    };
    expect(saved.status).toBe('open');
    expect(saved.credited).toBeNull();
    expect(saved.hits).toBe(0);
    expect(getPlayerById(row.id)?.pay_used).toBe(0);
  });

  it('does not pay, grant XP, or mint again when the same vault stops are replayed', async () => {
    const row = player('replay');
    fund(row.account_id!, 1_000n);
    const started = await startVault(row);
    const stops: number[] = [];
    for (let i = 0; i < 3; i++) {
      const stop = zoneStop(started.seed, stops);
      db.prepare(`UPDATE vaults SET started_at = ? WHERE id = ?`).run(Date.now() - stop, started.id);
      await finishVault(row, [...stops, stop]);
      stops.push(stop);
    }
    const after = getPlayerById(row.id);
    const minted = signs;
    expect(minted).toBe(2);
    await finishVault(row, stops);
    const again = getPlayerById(row.id);
    expect(again?.xp_json).toBe(after?.xp_json);
    expect(again?.pay_used).toBe(after?.pay_used);
    expect(signs).toBe(minted);
  });

  it('waits 8 seconds between vault starts', async () => {
    const row = player('gap');
    fund(row.account_id!, 1_000n);
    await startVault(row);
    db.prepare(`UPDATE vaults SET status = 'abandoned' WHERE player_id = ? AND status = 'open'`).run(row.id);
    await expect(startVault(row)).rejects.toThrow(/Wait before the next vault/);
  });

  it('rejects an unknown post symbol', async () => {
    const row = player('symbol');
    fund(row.account_id!, 20_000n);
    await expect(publishPost(row, { sym: 'NOPE', take: 'meme' })).rejects.toThrow(/Unknown coin/);
  });

  it('rejects a second post inside 30 seconds', async () => {
    const row = player('cool');
    fund(row.account_id!, 100_000n);
    await publishPost(row, { sym: 'BTX', take: 'meme' });
    await expect(publishPost(row, { sym: 'BTX', take: 'meme' })).rejects.toThrow(/Wait before the next post/);
  });

  it('refuses a purchase that only unminted credits would cover', async () => {
    const row = player('spend');
    fund(row.account_id!, 1_000n);
    const now = Date.now();
    db.prepare(
      `INSERT INTO trades (id, player_id, sym, dir, stake, fee, p0, opened_at, resolves_at, status, pnl, credited, capped, minted)
       VALUES (?, ?, 'BTX', 1, '1000', '10', '1', ?, ?, 'settled', '5000', '5000', 0, 0)`,
    ).run(`t-${row.id}`, row.id, now, now);
    await expect(assertCanSpend(row, 2_000n)).rejects.toThrow(/still landing on chain/);
    await assertCanSpend(row, 500n);
  });

  it('sets the minted flag from a stored hash when the process died after broadcast', async () => {
    db.prepare(`UPDATE trades SET status = 'abandoned' WHERE status = 'open'`).run();
    db.prepare(`UPDATE trades SET minted = 1 WHERE minted = 0`).run();
    db.prepare(`UPDATE posts SET minted = 1 WHERE minted = 0`).run();
    db.prepare(`UPDATE vaults SET gd_minted = 1, shards_minted = 1 WHERE gd_minted = 0 OR shards_minted = 0`).run();
    const row = player('crash');
    fund(row.account_id!, 1_000n);
    const id = `crash-${row.id}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO trades (id, player_id, sym, dir, stake, fee, p0, opened_at, resolves_at, status, pnl, credited, capped, minted)
       VALUES (?, ?, 'BTX', 1, '1000', '10', '1', ?, ?, 'settled', '100', '100', 0, 0)`,
    ).run(id, row.id, now, now);
    let broadcasts = 0;
    setMintTxTestHooks({
      sign: async () => {
        signs += 1;
        return { hash: 'crash-hash', signed: {} as never };
      },
      broadcast: async () => {
        broadcasts += 1;
        throw new Error('crash');
      },
      lookup: async () => 'success',
    });
    await resumeTrades();
    const mid = db.prepare(`SELECT minted, mint_tx_hash FROM trades WHERE id = ?`).get(id) as {
      minted: number;
      mint_tx_hash: string;
    };
    expect(mid.minted).toBe(0);
    expect(mid.mint_tx_hash).toBe('crash-hash');
    expect(broadcasts).toBe(1);
    expect(signs).toBe(1);
    await resumeTrades();
    const done = db.prepare(`SELECT minted, mint_tx_hash FROM trades WHERE id = ?`).get(id) as {
      minted: number;
      mint_tx_hash: string;
    };
    expect(done.minted).toBe(1);
    expect(done.mint_tx_hash).toBe('crash-hash');
    expect(broadcasts).toBe(1);
    expect(signs).toBe(1);
  });

  it('drops the GD cache when a mint lands', async () => {
    const row = player('cache');
    fund(row.account_id!, 1_000n);
    expect(await getGDBalanceCached(row.account_id!)).toBe('1000');
    await mintGD(row.account_id!, 250n);
    expect(await availableGd(row)).toBe(1_250n);
  });

  it('waits out an unknown mint hash and retries a failed one once', () => {
    const base = { flag: 0, hash: 'h', txAt: 0, attempts: 1, now: 1_000 };
    expect(nextMintStep({ ...base, status: 'unknown' })).toBe('wait');
    expect(nextMintStep({ ...base, status: 'unknown', now: MINT_UNKNOWN_WAIT_MS })).toBe('fresh');
    expect(nextMintStep({ ...base, status: 'failure' })).toBe('fresh');
    expect(nextMintStep({ ...base, status: 'failure', attempts: 2 })).toBe('skip');
    expect(nextMintStep({ ...base, status: 'success' })).toBe('mark');
    expect(nextMintStep({ ...base, flag: 1, status: 'success' })).toBe('skip');
  });
});
