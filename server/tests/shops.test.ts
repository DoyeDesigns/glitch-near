import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { availableGd, spendableGd } from '../src/auth';
import { config } from '../src/config';
import { db } from '../src/db';
import { purchase } from '../src/purchase';
import { enqueueTreasuryWrite } from '../src/near/client';
import { getGDBalanceCached, resumeTransfers, setGdChainForTests, ftTransfer } from '../src/near/gd';
import { encryptPrivateKey } from '../src/near/keys';
import { lastSignedCall, setMintTxTestHooks } from '../src/near/mintTx';
import { MERCHANT_FLOAT, merchantAccountId, setMerchantChainForTests, setupMerchants } from '../src/near/merchants';
import { ChainWriteError, recordChainFailure } from '../src/near/retry';
import { getPlayerById, type PlayerRow } from '../src/near/accounts';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

const balances = new Map<string, bigint>();
const exists = new Set<string>();
const created: { id: string; near: bigint }[] = [];
const mints: { id: string; amount: bigint }[] = [];
const burns: { id: string; amount: bigint }[] = [];

let signs = 0;
let burnFails = false;
let broadcastImpl: () => Promise<'success' | 'failure'> = async () => 'success';
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

function insertMerchant(id: 'chef' | 'smith' | 'dealer'): string {
  const accountId = merchantAccountId(id);
  db.prepare(
    `INSERT INTO merchants (id, account_id, enc_private_key, floated, created_at) VALUES (?, ?, ?, 1, ?)`,
  ).run(id, accountId, encryptPrivateKey(KeyPair.fromRandom('ed25519').toString()), Date.now());
  return accountId;
}

beforeEach(() => {
  signs = 0;
  burnFails = false;
  inFlight = 0;
  maxInFlight = 0;
  holdBroadcast = false;
  broadcastImpl = async () => 'success';
  balances.clear();
  exists.clear();
  created.length = 0;
  mints.length = 0;
  burns.length = 0;
  db.prepare(`DELETE FROM outbox`).run();
  db.prepare(`DELETE FROM merchants`).run();
  db.prepare(`DELETE FROM pending_burns`).run();
  setMintTxTestHooks({
    sign: async () => {
      signs += 1;
      return { hash: `t${signs}`, signed: {} as never };
    },
    broadcast: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (holdBroadcast) await delay(40);
      const outcome = await broadcastImpl();
      inFlight -= 1;
      return outcome;
    },
    lookup: async () => 'success',
  });
  setGdChainForTests({
    read: async accountId => balances.get(accountId) ?? 0n,
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
    await expect(ftTransfer(row.id, 'chef.test', 500n)).rejects.toThrow(/rpc down/);
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
    await expect(purchase(row.id, 'chef', 2_000n)).rejects.toThrow(/still landing on chain/);
    expect(state(row.id)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).toEqual({ n: 0 });
    await purchase(row.id, 'chef', 500n);
    expect(balances.get(row.account_id!)).toBe(500n);
    expect(balances.get(merchantAccountId('chef'))).toBe(500n);
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
  it('flushes pending burns, then transfers, and returns only after the transfer lands', async () => {
    const row = player('buy');
    const chef = insertMerchant('chef');
    fund(row.account_id!, 2_000n);
    db.prepare(`INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, '400', 'loss', ?)`).run(
      `burn-${row.id}`,
      row.id,
      Date.now(),
    );
    const result = await purchase(row.id, 'chef', 500n);
    expect(result).toEqual({ ok: true });
    expect(burns).toEqual([{ id: row.account_id, amount: 400n }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_burns WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(1_100n);
    expect(balances.get(chef)).toBe(500n);
    const out = db.prepare(`SELECT status FROM outbox WHERE player_id = ?`).get(row.id) as { status: string };
    expect(out.status).toBe('landed');
  });

  it('leaves the player row alone when the burn or the transfer fails', async () => {
    const row = player('fail');
    insertMerchant('smith');
    fund(row.account_id!, 3_000n);
    db.prepare(`INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, '250', 'loss', ?)`).run(
      `burn-${row.id}`,
      row.id,
      Date.now(),
    );
    const before = state(row.id);
    burnFails = true;
    await expect(purchase(row.id, 'smith', 100n)).rejects.toThrow(/burn failed/);
    expect(state(row.id)).toEqual(before);
    expect(db.prepare(`SELECT amount FROM pending_burns WHERE player_id = ?`).get(row.id)).toEqual({ amount: '250' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox`).get()).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(3_000n);

    burnFails = false;
    broadcastImpl = async () => {
      throw new Error('transfer failed');
    };
    await expect(purchase(row.id, 'smith', 100n)).rejects.toThrow(/transfer failed/);
    expect(state(row.id)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_burns WHERE player_id = ?`).get(row.id)).toEqual({ n: 0 });
    expect(balances.get(row.account_id!)).toBe(2_750n);
    expect(balances.get(merchantAccountId('smith')) ?? 0n).toBe(0n);
    const out = db.prepare(`SELECT status FROM outbox WHERE player_id = ?`).get(row.id) as { status: string };
    expect(out.status).toBe('pending');
  });
});
