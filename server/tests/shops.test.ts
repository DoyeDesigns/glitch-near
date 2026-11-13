import { randomBytes } from 'node:crypto';
import { KeyPair, nearToYocto } from 'near-api-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogById, CHEF_DEMAND_BUY, MAINTENANCE_MS, MERCHANT_MIN_BALANCE } from '@glitch/shared';
import { availableGd, spendableGd } from '../src/auth';
import { config } from '../src/config';
import { db } from '../src/db';
import {
  merchantsView,
  quoteChefFood,
  quoteDealerItem,
  quoteSmithGear,
  recordChefFoodSale,
  recordDealerSale,
  recordSmithSale,
  syncChefInventory,
  syncMerchantInventory,
} from '../src/chef';
import { forgeMint, resumeForges } from '../src/forge';
import { homeBuy, homePayRent } from '../src/home';
import { MERCHANT_CLOSED_MSG } from '../src/merchantGate';
import { syncNeedsDecay } from '../src/needs';
import {
  clearLastTradesForTests,
  runMerchantSupplyTick,
  settleCityTrades,
  settleSupplyForTests,
} from '../src/merchantEconomy';
import { purchase, resumePurchases } from '../src/purchase';
import { restPlayer } from '../src/rest';
import { shopBuy } from '../src/shop';
import {
  PLAYER_FUND_NEAR,
  PLAYER_NEAR_TOPUP_FLOOR,
  enqueueTreasuryWrite,
  setNearFundingForTests,
} from '../src/near/client';
import {
  expireGdCacheForTests,
  getGDBalanceCached,
  invalidateGdCache,
  resumeTransfers,
  setGdChainForTests,
  ftTransfer,
} from '../src/near/gd';
import { setItemsChainForTests } from '../src/near/items';
import { encryptPrivateKey } from '../src/near/keys';
import { lastSignedCall, lastTreasuryCall, setMintTxTestHooks } from '../src/near/mintTx';
import {
  MERCHANT_FLOAT,
  ensureMerchantKeysFromEnv,
  getMerchant,
  merchantAccountId,
  setMerchantChainForTests,
  setupMerchants,
} from '../src/near/merchants';
import { ChainWriteError, recordChainFailure } from '../src/near/retry';
import { getPlayerById, type PlayerRow } from '../src/near/accounts';
import { openTrade } from '../src/trade';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

const balances = new Map<string, bigint>();
const nearBalances = new Map<string, bigint>();
const itemBalances = new Map<string, Record<string, string>>();
const exists = new Set<string>();
const created: { id: string; near: bigint }[] = [];
const mints: { id: string; amount: bigint }[] = [];
const burns: { id: string; amount: bigint }[] = [];
const topUps: { id: string; amount: bigint }[] = [];
const treasuryMethods: string[] = [];

let signs = 0;
let burnFails = false;
let gdReadHold: Promise<void> | null = null;
let gdReadHoldAccount = '';
let broadcastImpl: () => Promise<'success' | 'failure' | 'unknown'> = async () => 'success';
let lookupImpl: (hash: string) => Promise<'success' | 'failure' | 'unknown'> = async () => 'success';
let inFlight = 0;
let maxInFlight = 0;
let holdBroadcast = false;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function player(tag: string): PlayerRow {
  const id = `shop-${tag}-${randomBytes(4).toString('hex')}`;
  const accountId = `${id}.test`;
  const secret = KeyPair.fromRandom('ed25519').toString();
  db.prepare(
    `INSERT INTO players (id, name, account_id, enc_private_key, status, created_at, xp_json, needs_json, followers, pay_used)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    accountId,
    encryptPrivateKey(secret),
    Date.now(),
    '{"trade":3,"sec":4,"comm":5}',
    '{"energy":70,"hunger":60}',
    12,
    9,
  );
  nearBalances.set(accountId, PLAYER_FUND_NEAR);
  const row = getPlayerById(id);
  if (!row) throw new Error('player missing');
  return row;
}

function fund(accountId: string, amount: bigint): void {
  balances.set(accountId, amount);
}

function state(id: string): { xp_json: string; needs_json: string; followers: number; pay_used: number } {
  return db
    .prepare(`SELECT xp_json, needs_json, followers, pay_used FROM players WHERE id = ?`)
    .get(id) as { xp_json: string; needs_json: string; followers: number; pay_used: number };
}

function insertMerchant(id: 'chef' | 'smith' | 'dealer', gd = MERCHANT_FLOAT): string {
  const accountId = merchantAccountId(id);
  db.prepare(
    `INSERT INTO merchants (id, account_id, enc_private_key, floated, created_at) VALUES (?, ?, ?, 1, ?)`,
  ).run(id, accountId, encryptPrivateKey(KeyPair.fromRandom('ed25519').toString()), Date.now());
  fund(accountId, gd);
  invalidateGdCache(accountId);
  return accountId;
}

function purchaseRow(playerId: string): {
  id: string;
  status: string;
  delivered: number;
  outbox_id: string;
  amount: string;
} {
  return db
    .prepare(
      `SELECT id, status, delivered, outbox_id, amount FROM purchases WHERE player_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(playerId) as {
    id: string;
    status: string;
    delivered: number;
    outbox_id: string;
    amount: string;
  };
}

beforeEach(() => {
  signs = 0;
  burnFails = false;
  gdReadHold = null;
  gdReadHoldAccount = '';
  inFlight = 0;
  maxInFlight = 0;
  holdBroadcast = false;
  broadcastImpl = async () => 'success';
  lookupImpl = async () => 'success';
  balances.clear();
  nearBalances.clear();
  exists.clear();
  created.length = 0;
  mints.length = 0;
  burns.length = 0;
  topUps.length = 0;
  treasuryMethods.length = 0;
  itemBalances.clear();
  db.prepare(`DELETE FROM outbox`).run();
  db.prepare(`DELETE FROM merchants`).run();
  db.prepare(`DELETE FROM pending_burns`).run();
  db.prepare(`DELETE FROM escrow`).run();
  db.prepare(`DELETE FROM purchases`).run();
  db.prepare(`DELETE FROM forges`).run();
  db.prepare(`DELETE FROM chef_inventory`).run();
  db.prepare(`DELETE FROM merchant_inventory`).run();
  db.prepare(`DELETE FROM trades`).run();
  setMintTxTestHooks({
    sign: async () => {
      signs += 1;
      return { hash: `t${signs}`, signed: {} as never };
    },
    broadcast: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (holdBroadcast) await delay(40);
      const call = lastTreasuryCall;
      if (call) treasuryMethods.push(call.methodName);
      const outcome = await broadcastImpl();
      if (outcome === 'success' && call?.methodName === 'burn_from') {
        const accountId = String(call.args.account_id);
        const tokenId = String(call.args.token_id);
        const amount = BigInt(String(call.args.amount));
        const cur = { ...(itemBalances.get(accountId) ?? {}) };
        const have = BigInt(cur[tokenId] ?? '0');
        cur[tokenId] = (have - amount).toString();
        if (BigInt(cur[tokenId]!) <= 0n) delete cur[tokenId];
        itemBalances.set(accountId, cur);
      }
      if (outcome === 'success' && call?.methodName === 'mint') {
        const accountId = String(call.args.account_id);
        const tokenId = String(call.args.token_id);
        const amount = BigInt(String(call.args.amount));
        const cur = { ...(itemBalances.get(accountId) ?? {}) };
        cur[tokenId] = (BigInt(cur[tokenId] ?? '0') + amount).toString();
        itemBalances.set(accountId, cur);
      }
      inFlight -= 1;
      return outcome;
    },
    lookup: async hash => lookupImpl(hash),
  });
  setGdChainForTests({
    read: async accountId => {
      if (gdReadHold && accountId === gdReadHoldAccount) await gdReadHold;
      return balances.get(accountId) ?? 0n;
    },
    mint: async (accountId, amount) => {
      mints.push({ id: accountId, amount });
      balances.set(accountId, (balances.get(accountId) ?? 0n) + amount);
    },
    burn: async (accountId, amount) => {
      burns.push({ id: accountId, amount });
      if (burnFails) throw new Error('burn failed');
      balances.set(accountId, (balances.get(accountId) ?? 0n) - amount);
    },
    transfer: async (from, to, amount) => {
      const have = balances.get(from) ?? 0n;
      if (have < amount) throw new Error('insufficient');
      balances.set(from, have - amount);
      balances.set(to, (balances.get(to) ?? 0n) + amount);
    },
  });
  setItemsChainForTests({
    balances: async accountId => ({ ...(itemBalances.get(accountId) ?? {}) }),
    burn: async (accountId, tokenId, amount) => {
      const cur = { ...(itemBalances.get(accountId) ?? {}) };
      const have = BigInt(cur[tokenId] ?? '0');
      if (have < amount) throw new Error('Not enough balance');
      cur[tokenId] = (have - amount).toString();
      if (BigInt(cur[tokenId]!) <= 0n) delete cur[tokenId];
      itemBalances.set(accountId, cur);
    },
  });
  setNearFundingForTests({
    read: async accountId => nearBalances.get(accountId) ?? PLAYER_FUND_NEAR,
    topUp: async (accountId, amount) => {
      topUps.push({ id: accountId, amount });
      nearBalances.set(accountId, (nearBalances.get(accountId) ?? 0n) + amount);
    },
  });
  setMerchantChainForTests({
    exists: async accountId => exists.has(accountId),
    create: async (accountId, near) => {
      created.push({ id: accountId, near });
      exists.add(accountId);
    },
  });
});

afterAll(() => {
  setMintTxTestHooks(null);
  setGdChainForTests(null);
  setItemsChainForTests(null);
  setNearFundingForTests(null);
  setMerchantChainForTests(null);
});

describe('ftTransfer', () => {
  it('signs ft_transfer for 1 yocto, stores the hash before broadcast, and clears the cache', async () => {
    const row = player('xfer');
    const to = 'chef.test';
    fund(row.account_id!, 5_000n);
    fund(to, 0n);
    await getGDBalanceCached(row.account_id!);
    await getGDBalanceCached(to);
    let hashAtBroadcast: string | null = null;
    broadcastImpl = async () => {
      const stored = db.prepare(`SELECT tx_hash FROM outbox WHERE player_id = ?`).get(row.id) as {
        tx_hash: string | null;
      };
      hashAtBroadcast = stored.tx_hash;
      return 'success';
    };
    await ftTransfer(row.id, to, 1_000n);
    expect(lastSignedCall?.methodName).toBe('ft_transfer');
    expect(lastSignedCall?.deposit).toBe(1n);
    expect(lastSignedCall?.args).toMatchObject({ receiver_id: to, amount: '1000', memo: 'glitch' });
    expect(hashAtBroadcast).toBe('t1');
    expect(signs).toBe(1);
    expect(await getGDBalanceCached(row.account_id!)).toBe('4000');
    expect(await getGDBalanceCached(to)).toBe('1000');
    const out = db.prepare(`SELECT status, tx_hash FROM outbox WHERE player_id = ?`).get(row.id) as {
      status: string;
      tx_hash: string;
    };
    expect(out.status).toBe('landed');
    expect(out.tx_hash).toBe('t1');
  });

  it('does not sign again when broadcast dies after the hash is stored', async () => {
    const row = player('crash');
    fund(row.account_id!, 4_000n);
    broadcastImpl = async () => {
      throw new Error('rpc down');
    };
    expect(await ftTransfer(row.id, 'chef.test', 500n)).toBe('unknown');
    expect(signs).toBe(1);
    const pending = db.prepare(`SELECT status, tx_hash, attempts FROM outbox WHERE player_id = ?`).get(row.id) as {
      status: string;
      tx_hash: string;
      attempts: number;
    };
    expect(pending.status).toBe('pending');
    expect(pending.tx_hash).toBe('t1');
    expect(pending.attempts).toBe(1);
    broadcastImpl = async () => {
      throw new Error('should not broadcast');
    };
    await resumeTransfers();
    expect(signs).toBe(1);
    const landed = db.prepare(`SELECT status FROM outbox WHERE player_id = ?`).get(row.id) as { status: string };
    expect(landed.status).toBe('landed');
    expect(balances.get(row.account_id!)).toBe(3_500n);
  });

  it('runs one signer account at a time and leaves the treasury queue free', async () => {
    const row = player('queue');
    fund(row.account_id!, 5_000n);
    holdBroadcast = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let treasuryHeld = false;
    const treasury = enqueueTreasuryWrite(async () => {
      treasuryHeld = true;
      await gate;
      treasuryHeld = false;
    });
    let sawTreasury = false;
    broadcastImpl = async () => {
      sawTreasury = treasuryHeld;
      return 'success';
    };
    const first = ftTransfer(row.id, 'a.test', 100n);
    const second = ftTransfer(row.id, 'b.test', 100n);
    await delay(60);
    expect(maxInFlight).toBe(1);
    expect(sawTreasury).toBe(true);
    release();
    await first;
    await second;
    await treasury;
    expect(maxInFlight).toBe(1);
    expect(balances.get(row.account_id!)).toBe(4_800n);
  });

  it('tops up NEAR from the players account when the balance is below 0.02', async () => {
    const row = player('gas');
    fund(row.account_id!, 1_000n);
    nearBalances.set(row.account_id!, nearToYocto('0.01'));
    expect(await ftTransfer(row.id, 'chef.test', 100n)).toBe('success');
    expect(topUps).toEqual([{ id: row.account_id, amount: PLAYER_FUND_NEAR - nearToYocto('0.01') }]);
    expect(nearBalances.get(row.account_id!)).toBe(PLAYER_FUND_NEAR);
    topUps.length = 0;
    expect(await ftTransfer(row.id, 'chef.test', 100n)).toBe('success');
    expect(topUps).toEqual([]);
    nearBalances.set(row.account_id!, PLAYER_NEAR_TOPUP_FLOOR);
    expect(await ftTransfer(row.id, 'chef.test', 100n)).toBe('success');
    expect(topUps).toEqual([]);
  });
});

describe('spendable', () => {
  it('leaves settling out of an on-chain spend', async () => {
    const row = player('spend');
    fund(row.account_id!, 1_000n);
    const now = Date.now();
    db.prepare(
      `INSERT INTO trades (id, player_id, sym, dir, stake, fee, p0, opened_at, resolves_at, status, credited, minted)
       VALUES (?, ?, 'BTX', 1, '1000', '10', '1', ?, ?, 'settled', '5000', 0)`,
    ).run(`trade-${row.id}`, row.id, now, now);
    expect(await spendableGd(row)).toBe(1_000n);
    expect(await availableGd(row)).toBe(6_000n);
    insertMerchant('chef');
    const before = state(row.id);
    await expect(purchase(row.id, 'suya-skewer')).rejects.toThrow(/still on the way/);
    expect(state(row.id)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).toEqual({ n: 0 });
    const result = await purchase(row.id, 'zobo-drink');
    expect(result).toEqual({ ok: true, purchaseId: expect.any(String), status: 'delivered' });
    expect(balances.get(row.account_id!)).toBe(0n);
    expect(balances.get(merchantAccountId('chef'))).toBe(MERCHANT_FLOAT + 1_000n);
  });
});

describe('merchants', () => {
  it('creates the three shops once and mints one float', async () => {
    const first = await setupMerchants();
    expect(first.created.map(id => id.split('.')[0])).toEqual(['chef', 'smith', 'dealer']);
    expect(created.map(row => row.near)).toEqual([
      100_000_000_000_000_000_000_000n,
      100_000_000_000_000_000_000_000n,
      100_000_000_000_000_000_000_000n,
    ]);
    expect(mints.map(row => row.amount)).toEqual([MERCHANT_FLOAT, MERCHANT_FLOAT, MERCHANT_FLOAT]);
    expect(first.balances).toEqual({
      chef: MERCHANT_FLOAT.toString(),
      smith: MERCHANT_FLOAT.toString(),
      dealer: MERCHANT_FLOAT.toString(),
    });
    const stored = db.prepare(`SELECT enc_private_key FROM merchants`).all() as { enc_private_key: string }[];
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row.enc_private_key.startsWith('ed25519:')).toBe(false);
      expect(row.enc_private_key.split(':')).toHaveLength(3);
    }
    const second = await setupMerchants();
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(3);
    expect(created).toHaveLength(3);
    expect(mints).toHaveLength(3);
    expect(second.balances.chef).toBe(MERCHANT_FLOAT.toString());
  });

  it('skips creation when the account or key exists, and skips a mint already at the float', async () => {
    const chef = merchantAccountId('chef');
    const smith = merchantAccountId('smith');
    exists.add(chef);
    fund(chef, MERCHANT_FLOAT);
    exists.add(smith);
    fund(smith, 0n);
    db.prepare(
      `INSERT INTO merchants (id, account_id, enc_private_key, floated, created_at) VALUES ('smith', ?, ?, 0, ?)`,
    ).run(smith, encryptPrivateKey(KeyPair.fromRandom('ed25519').toString()), Date.now());
    const result = await setupMerchants();
    expect(result.skipped).toEqual([chef, smith]);
    expect(created.map(row => row.id)).toEqual([merchantAccountId('dealer')]);
    expect(mints.map(row => row.id)).toEqual([smith, merchantAccountId('dealer')]);
    expect(result.balances.chef).toBe(MERCHANT_FLOAT.toString());
    expect(result.balances.smith).toBe(MERCHANT_FLOAT.toString());
    expect(result.balances.dealer).toBe(MERCHANT_FLOAT.toString());
  });
});

describe('chain write errors', () => {
  it('logs the label, account, hash, and kind without the transaction result', () => {
    const blob = { receipts: 'x'.repeat(4000), status: { Failure: { ActionError: { index: 0 } } } };
    const cause = Object.assign(new Error('wasm execution failed'), {
      name: 'HostGuestPanicError',
      txHash: 'abc123',
      transactionResult: { transaction_outcome: { id: 'abc123' }, ...blob },
    });
    const err = new ChainWriteError({ label: 'gd.mint', account: 'chef.test', amount: '100000', cause });
    const lines: string[] = [];
    const orig = console.error;
    console.error = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      recordChainFailure(err);
    } finally {
      console.error = orig;
    }
    expect(lines).toEqual(['[near] write failure label=gd.mint account=chef.test hash=abc123 kind=HostGuestPanicError']);
    expect(lines[0]).not.toContain('receipts');
    expect(err.message).not.toContain('receipts');
    expect('transactionResult' in err).toBe(false);
    const stored = db
      .prepare(`SELECT error FROM chain_failures WHERE label = 'gd.mint' ORDER BY created_at DESC LIMIT 1`)
      .get() as { error: string };
    expect(stored.error).toBe(lines[0]);
    expect(stored.error).not.toContain('ActionError');
  });
});

describe('purchase', () => {
  it('flushes pending burns, reserves escrow, then delivers after the transfer lands', async () => {
    const row = player('buy');
    const chef = insertMerchant('chef');
    fund(row.account_id!, 2_000n);
    db.prepare(`INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, '400', 'loss', ?)`).run(
      `burn-${row.id}`,
      row.id,
      Date.now(),
    );
    const result = await purchase(row.id, 'zobo-drink');
    expect(result).toEqual({ ok: true, purchaseId: expect.any(String), status: 'delivered' });
    expect(burns).toEqual([{ id: row.account_id, amount: 400n }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_burns WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(600n);
    expect(balances.get(chef)).toBe(MERCHANT_FLOAT + 1_000n);
    const bought = purchaseRow(row.id);
    expect(bought.status).toBe('delivered');
    expect(bought.delivered).toBe(1);
    expect(state(row.id).needs_json).toBe('{"energy":82,"hunger":68}');
  });

  it('credits the chef wallet even when the shop balance was never cached', async () => {
    const row = player('chef-uncached');
    const chef = insertMerchant('chef');
    fund(row.account_id!, 2_000n);
    const result = await purchase(row.id, 'zobo-drink');
    expect(result).toEqual({ ok: true, purchaseId: expect.any(String), status: 'delivered' });
    expect(balances.get(chef)).toBe(MERCHANT_FLOAT + 1_000n);
    const view = await merchantsView();
    expect(Number(view.chef.gdBalance)).toBe(Number(MERCHANT_FLOAT + 1_000n));
  });

  it('keeps the merchant sale credit if a stale balance view finishes after the transfer', async () => {
    const row = player('stale-credit');
    const chef = insertMerchant('chef');
    fund(row.account_id!, 2_000n);
    await getGDBalanceCached(chef);
    expireGdCacheForTests(chef);

    let release!: () => void;
    gdReadHoldAccount = chef;
    gdReadHold = new Promise<void>(resolve => {
      release = resolve;
    });
    const inFlight = getGDBalanceCached(chef);
    await delay(10);

    const result = await purchase(row.id, 'zobo-drink');
    expect(result).toEqual({ ok: true, purchaseId: expect.any(String), status: 'delivered' });
    expect(balances.get(chef)).toBe(MERCHANT_FLOAT + 1_000n);

    release();
    await inFlight;
    expect(await getGDBalanceCached(chef)).toBe(String(MERCHANT_FLOAT + 1_000n));
    const view = await merchantsView();
    expect(Number(view.chef.gdBalance)).toBe(Number(MERCHANT_FLOAT + 1_000n));
  });

  it('lets only one of two concurrent purchases reserve the balance', async () => {
    const row = player('race');
    insertMerchant('dealer');
    fund(row.account_id!, 10_000n);
    const results = await Promise.allSettled([purchase(row.id, 'plant'), purchase(row.id, 'plant')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE player_id = ?`).get(row.id)).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(2_000n);
  });

  it('lets only one of a purchase and a trade open reserve the balance', async () => {
    const row = player('vs-trade');
    insertMerchant('dealer');
    fund(row.account_id!, 10_000n);
    const results = await Promise.allSettled([
      purchase(row.id, 'plant'),
      openTrade(row, { sym: 'BTX', dir: 1, stake: 6000 }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const purchases = db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE player_id = ?`).get(row.id) as {
      n: number;
    };
    const trades = db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE player_id = ? AND status = 'open'`).get(row.id) as {
      n: number;
    };
    expect(purchases.n + trades.n).toBe(1);
    if (purchases.n === 1) {
      expect(purchaseRow(row.id).status).toBe('delivered');
      expect(balances.get(row.account_id!)).toBe(2_000n);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    } else {
      expect(db.prepare(`SELECT reason FROM escrow WHERE player_id = ?`).all(row.id)).toEqual([{ reason: 'trade' }]);
    }
  });

  it('keeps escrow on an ambiguous transfer and delivers once when it lands later', async () => {
    const row = player('ambig');
    insertMerchant('dealer');
    fund(row.account_id!, 10_000n);
    broadcastImpl = async () => 'unknown';
    const first = await purchase(row.id, 'plant');
    expect(first).toEqual({ settling: true, purchaseId: expect.any(String) });
    const paying = purchaseRow(row.id);
    expect(paying.status).toBe('paying');
    expect(paying.delivered).toBe(0);
    expect(db.prepare(`SELECT amount, reason FROM escrow WHERE id = ?`).get(paying.id)).toEqual({
      amount: '8000',
      reason: 'purchase',
    });
    expect(balances.get(row.account_id!)).toBe(10_000n);
    const transferSigns = signs;
    lookupImpl = async () => 'success';
    // Transfer resume only looks up the stored hash. Item mint may broadcast once.
    broadcastImpl = async () => 'success';
    await resumePurchases();
    const done = purchaseRow(row.id);
    expect(done.status).toBe('delivered');
    expect(done.delivered).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE id = ?`).get(paying.id)).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(2_000n);
    expect(balances.get(merchantAccountId('dealer'))).toBe(MERCHANT_FLOAT + 8_000n);
    // One transfer sign earlier, then one item-mint sign on resume.
    expect(signs).toBe(transferSigns + 1);
    const mintSigns = signs;
    await resumePurchases();
    expect(signs).toBe(mintSigns);
    expect(purchaseRow(row.id).delivered).toBe(1);
  });

  it('releases escrow on a definite transfer failure', async () => {
    const row = player('fail-tx');
    insertMerchant('chef');
    fund(row.account_id!, 3_000n);
    const before = state(row.id);
    broadcastImpl = async () => 'failure';
    await expect(purchase(row.id, 'zobo-drink')).rejects.toThrow(/did not go through/);
    expect(state(row.id)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    expect(purchaseRow(row.id).status).toBe('failed');
    expect(balances.get(row.account_id!)).toBe(3_000n);
    expect(balances.get(merchantAccountId('chef')) ?? 0n).toBe(MERCHANT_FLOAT);
  });

  it('leaves the player row alone when the burn fails before reserve', async () => {
    const row = player('fail-burn');
    insertMerchant('chef');
    fund(row.account_id!, 3_000n);
    db.prepare(`INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, '250', 'loss', ?)`).run(
      `burn-${row.id}`,
      row.id,
      Date.now(),
    );
    const before = state(row.id);
    burnFails = true;
    await expect(purchase(row.id, 'zobo-drink')).rejects.toThrow(/burn failed/);
    expect(state(row.id)).toEqual(before);
    expect(db.prepare(`SELECT amount FROM pending_burns WHERE player_id = ?`).get(row.id)).toEqual({ amount: '250' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM purchases`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get()).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(3_000n);
  });
});

describe('shop home rest', () => {
  it('shop food updates needs and does not mint an item token', async () => {
    const row = player('food');
    insertMerchant('chef');
    fund(row.account_id!, 5_000n);
    const signsBefore = signs;
    const res = await shopBuy(row.id, 'zobo-drink');
    expect(res.status).toBe('delivered');
    // zobo-drink: +2 energy, +8 hunger on the default 80/60 — tiny decay may land first.
    expect(res.needs!.energy).toBeGreaterThanOrEqual(81.9);
    expect(res.needs!.hunger).toBeGreaterThanOrEqual(67.9);
    expect(JSON.parse(state(row.id).needs_json)).toEqual(res.needs);
    // Only the player GD transfer is signed; no items.mint.
    expect(signs).toBe(signsBefore + 1);
    expect(lastSignedCall?.methodName).toBe('ft_transfer');
  });

  it('furniture delivers once and a second resume does not mint again', async () => {
    const row = player('furn');
    insertMerchant('dealer');
    fund(row.account_id!, 20_000n);
    const res = await shopBuy(row.id, 'plant');
    expect(res.status).toBe('delivered');
    expect(purchaseRow(row.id).delivered).toBe(1);
    const after = signs;
    await resumePurchases();
    expect(signs).toBe(after);
  });

  it('home buy and pay-rent extend home_paid_until; sleep rejects when overdue', async () => {
    const row = player('home');
    insertMerchant('dealer');
    fund(row.account_id!, 200_000n);
    const before = Date.now();
    const bought = await homeBuy(row.id);
    expect(bought.studioStatus).toBe('delivered');
    expect(bought.maintenanceStatus).toBe('delivered');
    expect(bought.homePaidUntil).toBeGreaterThanOrEqual(before + MAINTENANCE_MS - 1000);
    const paid = await homePayRent(row.id);
    expect(paid.homePaidUntil).toBeGreaterThanOrEqual(bought.homePaidUntil + MAINTENANCE_MS - 1000);

    db.prepare(`UPDATE players SET home_paid_until = ? WHERE id = ?`).run(Date.now() - 1, row.id);
    await expect(restPlayer(row.id, 'sleep')).rejects.toThrow(/locked|maintenance/i);

    db.prepare(`UPDATE players SET home_paid_until = ? WHERE id = ?`).run(Date.now() + MAINTENANCE_MS, row.id);
    const slept = await restPlayer(row.id, 'sleep');
    expect(slept.needs.energy).toBe(100);
  });

  it('decays needs across timestamps and applies bench rest', async () => {
    const row = player('decay');
    db.prepare(`UPDATE players SET needs_json = ?, needs_updated_at = ? WHERE id = ?`).run(
      '{"energy":100,"hunger":80}',
      Date.now() - 10_000,
      row.id,
    );
    const after = syncNeedsDecay(row.id);
    expect(after.hunger).toBeLessThan(80);
    expect(after.energy).toBeLessThan(100);
    const rested = await restPlayer(row.id, 'bench');
    expect(rested.needs.energy).toBeGreaterThan(after.energy);
  });

  it('rejects shop gear and home when funds are short', async () => {
    const row = player('short');
    insertMerchant('chef');
    insertMerchant('dealer');
    fund(row.account_id!, 100n);
    await expect(shopBuy(row.id, 'cap')).rejects.toThrow(/shop item|cannot/i);
    await expect(shopBuy(row.id, 'zobo-drink')).rejects.toThrow(/Not enough GD/);
    await expect(homeBuy(row.id)).rejects.toThrow(/Not enough GD/);
  });
});

describe('chef prices', () => {
  it('shopBuy food charges the quote and lowers stock on deliver', async () => {
    const row = player('chef-q');
    const chef = insertMerchant('chef');
    fund(row.account_id!, 20_000n);
    const quote = quoteChefFood('zobo-drink');
    expect(quote.finalPrice).toBe(1_000);
    const res = await shopBuy(row.id, 'zobo-drink');
    expect(res.status).toBe('delivered');
    expect(res.price).toBe(1_000);
    expect(balances.get(chef)).toBe(MERCHANT_FLOAT + 1_000n);
    expect(purchaseRow(row.id).amount).toBe('1000');
    expect(res.stock).toBeCloseTo(19, 2);
    expect(res.demandEma).toBeCloseTo(CHEF_DEMAND_BUY, 4);
    expect(res.reasoning!.finalPrice).toBeGreaterThan(1_000);
  });

  it('furniture charges the dealer quote and lowers stock on deliver', async () => {
    const row = player('furn-q');
    insertMerchant('dealer');
    fund(row.account_id!, 50_000n);
    const quote = quoteDealerItem('plant');
    expect(quote.finalPrice).toBe(catalogById('plant')!.priceGD);
    const res = await shopBuy(row.id, 'plant');
    expect(res.status).toBe('delivered');
    expect(res.price).toBe(quote.finalPrice);
    expect(purchaseRow(row.id).amount).toBe(String(quote.finalPrice));
    expect(res.stock).toBeCloseTo(19, 2);
    expect(res.demandEma).toBeCloseTo(CHEF_DEMAND_BUY, 4);
  });

  it('rejects sold-out food and restocks across timestamps', async () => {
    insertMerchant('chef');
    syncChefInventory();
    db.prepare(
      `UPDATE merchant_inventory SET stock = 0.5, demand_ema = 0.4, updated_at = ? WHERE merchant_id = 'chef' AND item_id = ?`,
    ).run(Date.now(), 'suya-skewer');
    expect(() => quoteChefFood('suya-skewer')).toThrow(/Sold out/);
    db.prepare(
      `UPDATE merchant_inventory SET stock = 10, demand_ema = 0.4, updated_at = ? WHERE merchant_id = 'chef' AND item_id = ?`,
    ).run(Date.now() - 60_000, 'suya-skewer');
    syncChefInventory();
    const snap = db
      .prepare(
        `SELECT stock, demand_ema FROM merchant_inventory WHERE merchant_id = 'chef' AND item_id = ?`,
      )
      .get('suya-skewer') as { stock: number; demand_ema: number };
    expect(snap.stock).toBeGreaterThan(10);
    expect(snap.demand_ema).toBeLessThan(0.4);
  });

  it('recordChefFoodSale bumps demand without minting', async () => {
    syncChefInventory();
    const before = db
      .prepare(
        `SELECT stock, demand_ema FROM merchant_inventory WHERE merchant_id = 'chef' AND item_id = ?`,
      )
      .get('jollof-and-chicken') as { stock: number; demand_ema: number };
    recordChefFoodSale('jollof-and-chicken');
    const after = db
      .prepare(
        `SELECT stock, demand_ema FROM merchant_inventory WHERE merchant_id = 'chef' AND item_id = ?`,
      )
      .get('jollof-and-chicken') as { stock: number; demand_ema: number };
    expect(after.stock).toBe(before.stock - 1);
    expect(after.demand_ema).toBeCloseTo(before.demand_ema + CHEF_DEMAND_BUY, 5);
  });
});

describe('smith and dealer prices', () => {
  it('forge charges smith quote and lowers template stock on deliver', async () => {
    const row = player('forge-q');
    const smith = insertMerchant('smith');
    fund(row.account_id!, 50_000n);
    itemBalances.set(row.account_id!, { shard: '10' });
    const quote = quoteSmithGear('cap');
    expect(quote.finalPrice).toBe(catalogById('cap')!.effect.gdCost);
    const res = await forgeMint(row.id, 'cap');
    expect(res.status).toBe('delivered');
    expect(res.price).toBe(quote.finalPrice);
    expect(balances.get(smith)).toBe(MERCHANT_FLOAT + BigInt(quote.finalPrice));
    // Open-gate + forge path can restock/decay slightly before the sale is recorded.
    expect(res.stock).toBeCloseTo(19, 2);
    expect(res.demandEma).toBeCloseTo(CHEF_DEMAND_BUY, 4);
    expect(res.tokenId).toMatch(/^gear-cap-/);
  });

  it('credits the smith wallet on forge even when that balance was never cached', async () => {
    const row = player('smith-uncached');
    const smith = insertMerchant('smith');
    fund(row.account_id!, 50_000n);
    itemBalances.set(row.account_id!, { shard: '10' });
    const quote = quoteSmithGear('cap');
    const res = await forgeMint(row.id, 'cap');
    expect(res.status).toBe('delivered');
    expect(balances.get(smith)).toBe(MERCHANT_FLOAT + BigInt(quote.finalPrice));
    const view = await merchantsView();
    expect(Number(view.smith.gdBalance)).toBe(Number(MERCHANT_FLOAT + BigInt(quote.finalPrice)));
  });

  it('credits the dealer wallet on furniture buy', async () => {
    const row = player('dealer-credit');
    const dealer = insertMerchant('dealer');
    fund(row.account_id!, 20_000n);
    const res = await shopBuy(row.id, 'plant');
    expect(res.status).toBe('delivered');
    expect(balances.get(dealer)).toBe(MERCHANT_FLOAT + BigInt(res.price ?? 0));
    const view = await merchantsView();
    expect(Number(view.dealer.gdBalance)).toBe(Number(MERCHANT_FLOAT + BigInt(res.price ?? 0)));
  });

  it('rejects sold-out smith gear', () => {
    insertMerchant('smith');
    syncMerchantInventory('smith');
    db.prepare(
      `UPDATE merchant_inventory SET stock = 0.2, updated_at = ? WHERE merchant_id = 'smith' AND item_id = ?`,
    ).run(Date.now(), 'cap');
    expect(() => quoteSmithGear('cap')).toThrow(/Sold out/);
  });

  it('recordSmithSale and recordDealerSale bump demand', () => {
    syncMerchantInventory('smith');
    syncMerchantInventory('dealer');
    recordSmithSale('chain');
    recordDealerSale('sofa');
    const smith = db
      .prepare(
        `SELECT stock, demand_ema FROM merchant_inventory WHERE merchant_id = 'smith' AND item_id = ?`,
      )
      .get('chain') as { stock: number; demand_ema: number };
    const dealer = db
      .prepare(
        `SELECT stock, demand_ema FROM merchant_inventory WHERE merchant_id = 'dealer' AND item_id = ?`,
      )
      .get('sofa') as { stock: number; demand_ema: number };
    expect(smith.stock).toBe(19);
    expect(smith.demand_ema).toBeCloseTo(CHEF_DEMAND_BUY, 5);
    expect(dealer.stock).toBe(19);
    expect(dealer.demand_ema).toBeCloseTo(CHEF_DEMAND_BUY, 5);
  });
});

describe('forge', () => {
  it('burns shards, pays smith, creates and mints gear once', async () => {
    const row = player('forge');
    const smith = insertMerchant('smith');
    fund(row.account_id!, 50_000n);
    itemBalances.set(row.account_id!, { shard: '10' });
    const signsBefore = signs;
    const res = await forgeMint(row.id, 'cap');
    expect(res.status).toBe('delivered');
    expect(res.itemId).toBe('cap');
    expect(res.tokenId).toMatch(/^gear-cap-[a-f0-9]+$/);
    expect(balances.get(smith)).toBe(MERCHANT_FLOAT + 1_000n);
    expect(itemBalances.get(row.account_id!)?.shard).toBe('7');
    expect(itemBalances.get(row.account_id!)?.[res.tokenId]).toBe('1');
    // player ft_transfer + burn_from + create_token + mint
    expect(signs).toBe(signsBefore + 4);
    expect(treasuryMethods.filter(m => m === 'burn_from' || m === 'create_token' || m === 'mint')).toEqual([
      'burn_from',
      'create_token',
      'mint',
    ]);
    const after = signs;
    await resumeForges();
    expect(signs).toBe(after);
  });

  it('rejects forge when shards or GD are short', async () => {
    const row = player('forge-short');
    insertMerchant('smith');
    fund(row.account_id!, 50_000n);
    itemBalances.set(row.account_id!, { shard: '1' });
    await expect(forgeMint(row.id, 'cap')).rejects.toThrow(/Not enough shards/);
    itemBalances.set(row.account_id!, { shard: '10' });
    fund(row.account_id!, 100n);
    await expect(forgeMint(row.id, 'cap')).rejects.toThrow(/Not enough GD/);
    await expect(forgeMint(row.id, 'headphones')).rejects.toThrow(/Unknown forge item/);
  });
});

describe('merchant key restore', () => {
  it('restores missing rows from MERCHANT_*_KEY and opens the shop view', async () => {
    const secret = KeyPair.fromRandom('ed25519').toString();
    const prev = {
      chef: config.merchantChefKey,
      smith: config.merchantSmithKey,
      dealer: config.merchantDealerKey,
    };
    config.merchantChefKey = secret;
    config.merchantSmithKey = '';
    config.merchantDealerKey = '';
    try {
      db.prepare(`DELETE FROM merchants`).run();
      expect(getMerchant('chef')).toBeUndefined();

      const result = ensureMerchantKeysFromEnv();
      expect(result.restored).toEqual(['chef']);
      expect(getMerchant('chef')?.account_id).toBe(merchantAccountId('chef'));

      fund(merchantAccountId('chef'), 50_000n);
      insertMerchant('smith');
      insertMerchant('dealer');
      syncMerchantInventory('chef');

      const view = await merchantsView();
      expect(view.chef.closed).toBe(false);
      expect(view.chef.closedReason).toBeUndefined();
      expect(view.chef.menu.length).toBeGreaterThan(0);
    } finally {
      config.merchantChefKey = prev.chef;
      config.merchantSmithKey = prev.smith;
      config.merchantDealerKey = prev.dealer;
    }
  });

  it('reports closedReason no_keys when the custodial row is missing', async () => {
    db.prepare(`DELETE FROM merchants`).run();
    insertMerchant('smith');
    insertMerchant('dealer');
    fund(merchantAccountId('chef'), 50_000n);
    invalidateGdCache(merchantAccountId('chef'));
    syncMerchantInventory('chef');

    const view = await merchantsView();
    expect(view.chef.closed).toBe(true);
    expect(view.chef.closedReason).toBe('no_keys');
    expect(view.chef.menu.length).toBeGreaterThan(0);
    expect(Number(view.chef.gdBalance)).toBe(50_000);
  });
});

describe('merchant insolvency', () => {
  it('marks shops closed below MERCHANT_MIN_BALANCE and refuses buy', async () => {
    const row = player('insolvent');
    const chef = insertMerchant('chef', BigInt(MERCHANT_MIN_BALANCE - 1));
    insertMerchant('smith');
    insertMerchant('dealer');
    fund(row.account_id!, 50_000n);
    syncMerchantInventory('chef');

    const view = await merchantsView();
    expect(view.chef.closed).toBe(true);
    expect(Number(view.chef.gdBalance)).toBe(MERCHANT_MIN_BALANCE - 1);

    const beforePlayer = balances.get(row.account_id!)!;
    const beforeChef = balances.get(chef)!;
    await expect(shopBuy(row.id, 'zobo-drink')).rejects.toThrow(MERCHANT_CLOSED_MSG);
    expect(balances.get(row.account_id!)).toBe(beforePlayer);
    expect(balances.get(chef)).toBe(beforeChef);
  });

  it('NPC supply-chain payment can reopen a closed shop for the next buy', async () => {
    const row = player('reopen');
    const chef = insertMerchant('chef', BigInt(MERCHANT_MIN_BALANCE - 400));
    const dealer = insertMerchant('dealer', 50_000n);
    insertMerchant('smith');
    fund(row.account_id!, 50_000n);
    syncMerchantInventory('chef');

    await expect(shopBuy(row.id, 'zobo-drink')).rejects.toThrow(MERCHANT_CLOSED_MSG);

    // Dealer restocks and pays chef (canteen) — NPC cashflow, not player invest.
    const hops = await settleSupplyForTests('dealer', 20);
    expect(hops.some(h => h.ok && h.to === 'chef')).toBe(true);
    expect(balances.get(chef)!).toBeGreaterThanOrEqual(BigInt(MERCHANT_MIN_BALANCE));
    expect(balances.get(dealer)!).toBeLessThan(50_000n);

    const view = await merchantsView();
    expect(view.chef.closed).toBe(false);

    const res = await shopBuy(row.id, 'zobo-drink');
    expect(res.status).toBe('delivered');
  });

  it('chef restock pays dealer and can drain below the open minimum', async () => {
    insertMerchant('chef', 5_000n);
    const dealer = insertMerchant('dealer', MERCHANT_FLOAT);
    insertMerchant('smith');
    const hops = await settleSupplyForTests('chef', 10);
    expect(hops).toEqual([
      expect.objectContaining({ from: 'chef', to: 'dealer', amount: 2_000, ok: true }),
    ]);
    expect(balances.get(dealer)).toBe(MERCHANT_FLOAT + 2_000n);
  });

  it('city trades move GD among all three and respect the open floor', async () => {
    clearLastTradesForTests();
    const chef = insertMerchant('chef', BigInt(MERCHANT_MIN_BALANCE + 200));
    const smith = insertMerchant('smith', BigInt(MERCHANT_MIN_BALANCE + 5_000));
    const dealer = insertMerchant('dealer', BigInt(MERCHANT_MIN_BALANCE + 5_000));
    const before = {
      chef: balances.get(chef)!,
      smith: balances.get(smith)!,
      dealer: balances.get(dealer)!,
    };
    const hops = await settleCityTrades();
    expect(hops.some(h => h.ok)).toBe(true);
    expect(hops.every(h => h.ok)).toBe(true);
    for (const h of hops) {
      expect(h.amount).toBeGreaterThan(0);
    }
    // Surplus above min was only 200 on chef — hops leave the floor.
    expect(balances.get(chef)!).toBeGreaterThanOrEqual(BigInt(MERCHANT_MIN_BALANCE));
    expect(balances.get(smith)!).toBeGreaterThanOrEqual(BigInt(MERCHANT_MIN_BALANCE));
    expect(balances.get(dealer)!).toBeGreaterThanOrEqual(BigInt(MERCHANT_MIN_BALANCE));
    const moved =
      balances.get(chef)! !== before.chef ||
      balances.get(smith)! !== before.smith ||
      balances.get(dealer)! !== before.dealer;
    expect(moved).toBe(true);

    const view = await merchantsView();
    expect(view.chef.lastTrade || view.smith.lastTrade || view.dealer.lastTrade).toBeTruthy();
  });

  it('supply tick still moves GD when shelves are already full (city trades)', async () => {
    clearLastTradesForTests();
    insertMerchant('chef', 80_000n);
    insertMerchant('smith', 80_000n);
    insertMerchant('dealer', 80_000n);
    syncMerchantInventory('chef');
    syncMerchantInventory('smith');
    syncMerchantInventory('dealer');
    const before = {
      chef: balances.get(merchantAccountId('chef'))!,
      smith: balances.get(merchantAccountId('smith'))!,
      dealer: balances.get(merchantAccountId('dealer'))!,
    };
    const hops = await runMerchantSupplyTick();
    expect(hops.some(h => h.ok && h.label !== 'ingredients' && h.label !== 'parts' && h.label !== 'canteen')).toBe(
      true,
    );
    const after = {
      chef: balances.get(merchantAccountId('chef'))!,
      smith: balances.get(merchantAccountId('smith'))!,
      dealer: balances.get(merchantAccountId('dealer'))!,
    };
    expect(after).not.toEqual(before);
  });
});
