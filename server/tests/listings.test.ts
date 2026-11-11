import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth';
import { config } from '../src/config';
import { db } from '../src/db';
import {
  buyListing,
  createListing,
  getListingForTests,
  getListingSaleForTests,
  resumeListingSales,
} from '../src/listings';
import { getPlayerById, type PlayerRow } from '../src/near/accounts';
import { setNearFundingForTests, PLAYER_FUND_NEAR } from '../src/near/client';
import { setGdChainForTests } from '../src/near/gd';
import { encryptPrivateKey } from '../src/near/keys';
import { setItemsChainForTests } from '../src/near/items';
import { lastTreasuryCall, setMintTxTestHooks } from '../src/near/mintTx';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

const TOKEN = 'sofa';
const balances = new Map<string, bigint>();
const itemBalances = new Map<string, Record<string, string>>();
let signs = 0;
let broadcastImpl: () => Promise<'success' | 'failure' | 'unknown'> = async () => 'success';
let lookupImpl: (hash: string) => Promise<'success' | 'failure' | 'unknown'> = async () => 'success';

function player(tag: string): PlayerRow {
  const id = `list-${tag}-${randomBytes(4).toString('hex')}`;
  const accountId = `${id}.test`;
  db.prepare(
    `INSERT INTO players (id, name, account_id, enc_private_key, status, created_at, gd_minted)
     VALUES (?, ?, ?, ?, 'active', ?, 1)`,
  ).run(id, id, accountId, encryptPrivateKey(KeyPair.fromRandom('ed25519').toString()), Date.now());
  const row = getPlayerById(id);
  if (!row) throw new Error('player missing');
  return row;
}

function fund(accountId: string, amount: bigint): void {
  balances.set(accountId, amount);
}

function giveItem(accountId: string, tokenId: string, amount = '1'): void {
  const cur = { ...(itemBalances.get(accountId) ?? {}) };
  cur[tokenId] = amount;
  itemBalances.set(accountId, cur);
}

beforeEach(() => {
  signs = 0;
  balances.clear();
  itemBalances.clear();
  broadcastImpl = async () => 'success';
  lookupImpl = async () => 'success';
  db.prepare(`DELETE FROM listing_sales`).run();
  db.prepare(`DELETE FROM listings`).run();
  db.prepare(`DELETE FROM escrow`).run();
  db.prepare(`DELETE FROM outbox`).run();
  db.prepare(`DELETE FROM pending_burns`).run();
  setMintTxTestHooks({
    sign: async () => {
      signs += 1;
      return { hash: `mkt${signs}`, signed: {} as never };
    },
    broadcast: async () => {
      const call = lastTreasuryCall;
      const outcome = await broadcastImpl();
      if (outcome === 'success' && call?.methodName === 'admin_transfer') {
        const from = String(call.args.from);
        const to = String(call.args.to);
        const tokenId = String(call.args.token_id);
        const amount = BigInt(String(call.args.amount));
        const fromBal = { ...(itemBalances.get(from) ?? {}) };
        const have = BigInt(fromBal[tokenId] ?? '0');
        fromBal[tokenId] = (have - amount).toString();
        if (BigInt(fromBal[tokenId]!) <= 0n) delete fromBal[tokenId];
        itemBalances.set(from, fromBal);
        const toBal = { ...(itemBalances.get(to) ?? {}) };
        toBal[tokenId] = (BigInt(toBal[tokenId] ?? '0') + amount).toString();
        itemBalances.set(to, toBal);
      }
      return outcome;
    },
    lookup: async hash => lookupImpl(hash),
  });
  setGdChainForTests({
    read: async accountId => balances.get(accountId) ?? 0n,
    mint: async (accountId, amount) => {
      balances.set(accountId, (balances.get(accountId) ?? 0n) + amount);
    },
    burn: async (accountId, amount) => {
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
  });
  setNearFundingForTests({
    read: async () => PLAYER_FUND_NEAR,
    topUp: async () => {},
  });
});

afterAll(() => {
  setMintTxTestHooks(null);
  setGdChainForTests(null);
  setItemsChainForTests(null);
  setNearFundingForTests(null);
});

describe('player market listings', () => {
  it('lets only one of two overlapping buys win', async () => {
    const seller = player('seller-race');
    const a = player('buyer-a');
    const b = player('buyer-b');
    giveItem(seller.account_id!, TOKEN);
    fund(a.account_id!, 50_000n);
    fund(b.account_id!, 50_000n);
    const listing = await createListing(seller.id, TOKEN, 1000);
    const results = await Promise.allSettled([
      buyListing(a.id, listing.id),
      buyListing(b.id, listing.id),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(getListingForTests(listing.id)?.status).toBe('sold');
    const winner = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{
      ok?: true;
      saleId?: string;
      settling?: true;
    }>;
    const saleId = winner.value.saleId!;
    const sale = getListingSaleForTests(saleId)!;
    expect(sale.status).toBe('delivered');
    const winnerAccount = sale.buyer_id === a.id ? a.account_id! : b.account_id!;
    const loserAccount = sale.buyer_id === a.id ? b.account_id! : a.account_id!;
    expect(itemBalances.get(winnerAccount)?.[TOKEN]).toBe('1');
    expect(itemBalances.get(loserAccount)?.[TOKEN]).toBeUndefined();
    expect(itemBalances.get(seller.account_id!)?.[TOKEN]).toBeUndefined();
    expect(balances.get(winnerAccount)).toBe(49_000n);
    expect(balances.get(seller.account_id!)).toBe(1000n);
    expect(
      db
        .prepare(`SELECT amount, reason FROM pending_burns WHERE player_id = ? AND reason = 'market_fee'`)
        .get(seller.id),
    ).toEqual({ amount: '20', reason: 'market_fee' });
  });

  it('rejects a buyer with insufficient GD', async () => {
    const seller = player('seller-poor');
    const buyer = player('buyer-poor');
    giveItem(seller.account_id!, TOKEN);
    fund(buyer.account_id!, 50n);
    const listing = await createListing(seller.id, TOKEN, 1000);
    await expect(buyListing(buyer.id, listing.id)).rejects.toSatisfy(
      (err: unknown) => err instanceof AuthError && /Not enough GD/.test(err.message),
    );
    expect(getListingForTests(listing.id)?.status).toBe('open');
    expect(balances.get(buyer.account_id!)).toBe(50n);
    expect(itemBalances.get(seller.account_id!)?.[TOKEN]).toBe('1');
  });

  it('rejects buy when the seller no longer holds the item', async () => {
    const seller = player('seller-gone');
    const buyer = player('buyer-gone');
    giveItem(seller.account_id!, TOKEN);
    fund(buyer.account_id!, 50_000n);
    const listing = await createListing(seller.id, TOKEN, 500);
    itemBalances.set(seller.account_id!, {});
    await expect(buyListing(buyer.id, listing.id)).rejects.toThrow(/no longer holds/i);
    expect(getListingForTests(listing.id)?.status).toBe('open');
    expect(balances.get(buyer.account_id!)).toBe(50_000n);
  });

  it('delivers once after an ambiguous transfer lands on resume', async () => {
    const seller = player('seller-amb');
    const buyer = player('buyer-amb');
    giveItem(seller.account_id!, TOKEN);
    fund(buyer.account_id!, 50_000n);
    const listing = await createListing(seller.id, TOKEN, 2000);

    broadcastImpl = async () => 'unknown';
    const first = await buyListing(buyer.id, listing.id);
    expect(first).toEqual({ settling: true, saleId: expect.any(String) });
    const saleId = first.saleId;
    const paying = getListingSaleForTests(saleId)!;
    expect(paying.status).toBe('paying');
    expect(paying.delivered).toBe(0);
    expect(db.prepare(`SELECT amount, reason FROM escrow WHERE id = ?`).get(saleId)).toEqual({
      amount: '2000',
      reason: 'listing',
    });
    expect(balances.get(buyer.account_id!)).toBe(50_000n);
    const transferSigns = signs;

    lookupImpl = async () => 'success';
    broadcastImpl = async () => 'success';
    await resumeListingSales();
    const done = getListingSaleForTests(saleId)!;
    expect(done.status).toBe('delivered');
    expect(done.delivered).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM escrow WHERE id = ?`).get(saleId)).toEqual({ n: 0 });
    expect(balances.get(buyer.account_id!)).toBe(48_000n);
    expect(balances.get(seller.account_id!)).toBe(2000n);
    expect(itemBalances.get(buyer.account_id!)?.[TOKEN]).toBe('1');
    expect(itemBalances.get(seller.account_id!)?.[TOKEN]).toBeUndefined();
    expect(signs).toBe(transferSigns + 1);

    const afterDeliver = signs;
    await resumeListingSales();
    expect(signs).toBe(afterDeliver);
    expect(getListingSaleForTests(saleId)?.delivered).toBe(1);
    expect(
      db
        .prepare(`SELECT amount FROM pending_burns WHERE player_id = ? AND reason = 'market_fee'`)
        .get(seller.id),
    ).toEqual({ amount: '40' });
  });
});
