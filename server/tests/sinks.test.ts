import { randomBytes } from 'node:crypto';
import {
  ciaFineGd,
  GAS_GD,
  holdingTaxCharge,
  openCase,
  UPKEEP_INTERVAL_S,
} from '@glitch/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { availableGd, meForPlayer } from '../src/auth';
import { applyHoldingTax, chargeCiaFine, chargeTravel } from '../src/burns';
import { config } from '../src/config';
import { db } from '../src/db';
import { getPlayerById, type PlayerRow } from '../src/near/accounts';
import { invalidateGdCache, setGdChainForTests } from '../src/near/gd';
import { setItemsChainForTests } from '../src/near/items';
import { clearActiveEventsForTests, stepSim, world } from '../src/sim';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

const balances = new Map<string, bigint>();

function player(tag: string): PlayerRow {
  const id = `sink-${tag}-${randomBytes(4).toString('hex')}`;
  const accountId = `${id}.test`;
  db.prepare(
    `INSERT INTO players (id, name, account_id, status, created_at, last_upkeep_at) VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(id, id, accountId, Date.now(), Date.now());
  const row = getPlayerById(id);
  if (!row) throw new Error('player missing');
  return row;
}

function fund(accountId: string, amount: bigint): void {
  balances.set(accountId, amount);
  invalidateGdCache(accountId);
}

function pendingTotal(playerId: string): bigint {
  const rows = db
    .prepare(`SELECT amount FROM pending_burns WHERE player_id = ?`)
    .all(playerId) as { amount: string }[];
  return rows.reduce((n, r) => n + BigInt(r.amount), 0n);
}

function pendingReasons(playerId: string): string[] {
  return (
    db.prepare(`SELECT reason FROM pending_burns WHERE player_id = ? ORDER BY created_at`).all(playerId) as {
      reason: string;
    }[]
  ).map(r => r.reason);
}

beforeEach(() => {
  balances.clear();
  db.prepare(`DELETE FROM pending_burns`).run();
  db.prepare(`DELETE FROM escrow`).run();
  clearActiveEventsForTests();
  world.effects.length = 0;
  world.cases.length = 0;
  setGdChainForTests({
    read: async accountId => balances.get(accountId) ?? 0n,
    mint: async (accountId, amount) => {
      balances.set(accountId, (balances.get(accountId) ?? 0n) + amount);
    },
  });
  setItemsChainForTests({
    balances: async () => ({}),
  });
});

afterAll(() => {
  setGdChainForTests(null);
  setItemsChainForTests(null);
});

describe('travel sink', () => {
  it('charges GAS_GD as a pending burn and rejects a second short charge', async () => {
    const row = player('travel');
    fund(row.account_id!, BigInt(GAS_GD + 50));

    const first = await chargeTravel(row.id);
    expect(BigInt(first.available)).toBe(50n);
    expect(pendingTotal(row.id)).toBe(BigInt(GAS_GD));
    expect(pendingReasons(row.id)).toEqual(['travel-gas']);
    expect(await availableGd(getPlayerById(row.id)!)).toBe(50n);

    await expect(chargeTravel(row.id)).rejects.toThrow(/Not enough GD to travel/);
    expect(pendingTotal(row.id)).toBe(BigInt(GAS_GD));
    expect(await availableGd(getPlayerById(row.id)!)).toBe(50n);
  });
});

describe('holding tax sink', () => {
  it('accrues upkeep on meForPlayer catch-up and cannot drive available below zero', async () => {
    const row = player('upkeep');
    const start = 60_000n;
    fund(row.account_id!, start);
    const ticks = 3;
    const past = Date.now() - ticks * UPKEEP_INTERVAL_S * 1000 - 100;
    db.prepare(`UPDATE players SET last_upkeep_at = ? WHERE id = ?`).run(past, row.id);

    const expected = holdingTaxCharge(start, ticks);
    const me = await meForPlayer(getPlayerById(row.id)!);
    expect(pendingReasons(row.id)).toContain('upkeep');
    expect(pendingTotal(row.id)).toBe(BigInt(expected));
    expect(BigInt(me.available)).toBe(start - BigInt(expected));

    // Zero available: further ticks must not add a negative-driving burn.
    fund(row.account_id!, 0n);
    db.prepare(`DELETE FROM pending_burns WHERE player_id = ?`).run(row.id);
    db.prepare(`UPDATE players SET last_upkeep_at = ? WHERE id = ?`).run(
      Date.now() - UPKEEP_INTERVAL_S * 1000 * 5,
      row.id,
    );
    const charged = await applyHoldingTax(row.id);
    expect(charged).toBe(0);
    expect(pendingTotal(row.id)).toBe(0n);
    expect(await availableGd(getPlayerById(row.id)!)).toBe(0n);
  });
});

describe('CIA fine sink', () => {
  it('charges min(available, floor(loot * 1.25)) when a player case resolves', async () => {
    const row = player('cia');
    fund(row.account_id!, 5_000n);
    const loot = 2_000;
    const fine = ciaFineGd(5_000, loot);

    openCase(world, 'Player tip', 'player', {
      playerId: row.id,
      loot,
      caught: true,
      at: world.time - 1,
    });
    await stepSim(1);

    expect(pendingReasons(row.id)).toContain('cia-fine');
    expect(pendingTotal(row.id)).toBe(BigInt(fine));
    expect(await availableGd(getPlayerById(row.id)!)).toBe(5_000n - BigInt(fine));
  });

  it('does not drive available below zero when loot exceeds balance', async () => {
    const row = player('cia0');
    fund(row.account_id!, 100n);
    const fine = await chargeCiaFine(row.id, 50_000, 99);
    expect(fine).toBe(100);
    expect(pendingTotal(row.id)).toBe(100n);
    expect(await availableGd(getPlayerById(row.id)!)).toBe(0n);

    const again = await chargeCiaFine(row.id, 50_000, 100);
    expect(again).toBe(0);
    expect(pendingTotal(row.id)).toBe(100n);
    expect(await availableGd(getPlayerById(row.id)!)).toBe(0n);
  });
});
