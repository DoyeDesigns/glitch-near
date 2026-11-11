/**
 * CHAIN_MODE=mock: SQLite-persisted GD/items/market ledger behind the same near/* APIs.
 * No RPC, no NEAR keys, no subaccount creation.
 */
import { randomId } from '../crypto';
import { config, isMockChain } from '../config';
import { db } from '../db';
import { setCreatePlayerAccountForTests } from './accounts';
import { PLAYER_FUND_NEAR, setNearFundingForTests } from './client';
import { setGdChainForTests, invalidateGdCache } from './gd';
import { setItemsChainForTests, type TokenView } from './items';
import { lastSignedCall, lastTreasuryCall, setMintTxTestHooks } from './mintTx';
import { MERCHANT_FLOAT, MERCHANT_IDS, merchantAccountId, setMerchantChainForTests } from './merchants';
import { setMarketViewsForTests, type MarketBooking, type MarketConfig } from './market';

const MOCK_KEY = 'mock';
const BASE_PRICE_YOCTO = 10n ** 22n; // 0.01 NEAR

let installed = false;
let mintSeq = 0;

function metaGet(key: string, fallback: string): string {
  const row = db.prepare(`SELECT value FROM mock_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

function metaSet(key: string, value: string): void {
  db.prepare(
    `INSERT INTO mock_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function readGd(accountId: string): bigint {
  const row = db.prepare(`SELECT amount FROM mock_gd WHERE account_id = ?`).get(accountId) as
    | { amount: string }
    | undefined;
  return row ? BigInt(row.amount) : 0n;
}

function writeGd(accountId: string, amount: bigint): void {
  if (amount <= 0n) {
    db.prepare(`DELETE FROM mock_gd WHERE account_id = ?`).run(accountId);
    return;
  }
  db.prepare(
    `INSERT INTO mock_gd (account_id, amount) VALUES (?, ?)
     ON CONFLICT(account_id) DO UPDATE SET amount = excluded.amount`,
  ).run(accountId, amount.toString());
}

function readItems(accountId: string): Record<string, string> {
  const rows = db
    .prepare(`SELECT token_id, amount FROM mock_items WHERE account_id = ?`)
    .all(accountId) as { token_id: string; amount: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (BigInt(r.amount) > 0n) out[r.token_id] = r.amount;
  }
  return out;
}

function writeItem(accountId: string, tokenId: string, amount: bigint): void {
  if (amount <= 0n) {
    db.prepare(`DELETE FROM mock_items WHERE account_id = ? AND token_id = ?`).run(accountId, tokenId);
    return;
  }
  db.prepare(
    `INSERT INTO mock_items (account_id, token_id, amount) VALUES (?, ?, ?)
     ON CONFLICT(account_id, token_id) DO UPDATE SET amount = excluded.amount`,
  ).run(accountId, tokenId, amount.toString());
}

function bumpTokenSupply(tokenId: string, delta: bigint): void {
  const row = db.prepare(`SELECT supply FROM mock_tokens WHERE token_id = ?`).get(tokenId) as
    | { supply: string }
    | undefined;
  if (!row) return;
  const next = BigInt(row.supply) + delta;
  db.prepare(`UPDATE mock_tokens SET supply = ? WHERE token_id = ?`).run(
    (next < 0n ? 0n : next).toString(),
    tokenId,
  );
}

function getTokenRow(tokenId: string): TokenView | null {
  const row = db
    .prepare(`SELECT token_id, kind, title, max_supply, supply FROM mock_tokens WHERE token_id = ?`)
    .get(tokenId) as
    | { token_id: string; kind: string; title: string; max_supply: string | null; supply: string }
    | undefined;
  if (!row) return null;
  return {
    token_id: row.token_id,
    kind: row.kind,
    title: row.title,
    supply: row.supply,
    max_supply: row.max_supply,
  };
}

function applyCreateToken(args: Record<string, unknown>): void {
  const tokenId = String(args.token_id ?? '');
  if (!tokenId) return;
  const existing = getTokenRow(tokenId);
  if (existing) return;
  const max =
    args.max_supply == null || args.max_supply === ''
      ? null
      : String(args.max_supply);
  db.prepare(
    `INSERT INTO mock_tokens (token_id, kind, title, max_supply, supply) VALUES (?, ?, ?, ?, '0')`,
  ).run(tokenId, String(args.kind ?? 'item'), String(args.title ?? tokenId), max);
}

function applyItemMint(args: Record<string, unknown>): void {
  const accountId = String(args.account_id ?? '');
  const tokenId = String(args.token_id ?? '');
  const amount = BigInt(String(args.amount ?? '0'));
  if (!accountId || !tokenId || amount <= 0n) return;
  const have = BigInt(readItems(accountId)[tokenId] ?? '0');
  writeItem(accountId, tokenId, have + amount);
  bumpTokenSupply(tokenId, amount);
}

function applyItemBurn(args: Record<string, unknown>): void {
  const accountId = String(args.account_id ?? '');
  const tokenId = String(args.token_id ?? '');
  const amount = BigInt(String(args.amount ?? '0'));
  if (!accountId || !tokenId || amount <= 0n) return;
  const have = BigInt(readItems(accountId)[tokenId] ?? '0');
  if (have < amount) throw new Error('Not enough balance');
  writeItem(accountId, tokenId, have - amount);
  bumpTokenSupply(tokenId, -amount);
}

function applyGdMint(args: Record<string, unknown>): void {
  const accountId = String(args.account_id ?? '');
  const amount = BigInt(String(args.amount ?? '0'));
  if (!accountId || amount <= 0n) return;
  writeGd(accountId, readGd(accountId) + amount);
  invalidateGdCache(accountId);
}

function applyGdBurn(args: Record<string, unknown>): void {
  const accountId = String(args.account_id ?? '');
  const amount = BigInt(String(args.amount ?? '0'));
  if (!accountId || amount <= 0n) return;
  writeGd(accountId, readGd(accountId) - amount);
  invalidateGdCache(accountId);
}

function applyTreasuryOrSigned(): void {
  const call = lastTreasuryCall ?? (lastSignedCall
    ? { methodName: lastSignedCall.methodName, args: lastSignedCall.args }
    : null);
  if (!call) return;
  const { methodName, args } = call;
  if (methodName === 'create_token') {
    applyCreateToken(args);
    return;
  }
  if (methodName === 'mint') {
    if ('token_id' in args && args.token_id != null) applyItemMint(args);
    else applyGdMint(args);
    return;
  }
  if (methodName === 'burn_from') {
    if ('token_id' in args && args.token_id != null) applyItemBurn(args);
    else applyGdBurn(args);
    return;
  }
  if (methodName === 'ft_transfer') {
    // Balance move happens in gdTransfer hook after broadcast succeeds.
    return;
  }
  if (methodName === 'admin_transfer') {
    const from = String(args.from ?? '');
    const to = String(args.to ?? '');
    const tokenId = String(args.token_id ?? '');
    const amount = BigInt(String(args.amount ?? '0'));
    if (!from || !to || !tokenId || amount <= 0n) return;
    const have = BigInt(readItems(from)[tokenId] ?? '0');
    if (have < amount) throw new Error('Not enough balance');
    writeItem(from, tokenId, have - amount);
    writeItem(to, tokenId, BigInt(readItems(to)[tokenId] ?? '0') + amount);
  }
}

function seedMetaAndAds(): void {
  if (!metaGet('slot_count', '')) metaSet('slot_count', '5');
  if (!metaGet('max_units', '')) metaSet('max_units', '10');
  if (!metaGet('unit_ms', '')) metaSet('unit_ms', '60000');
  if (!metaGet('base_price', '')) metaSet('base_price', BASE_PRICE_YOCTO.toString());
  const slotCount = Number(metaGet('slot_count', '5')) || 5;
  for (let i = 0; i < slotCount; i++) {
    const row = db.prepare(`SELECT slot_id FROM mock_ads WHERE slot_id = ?`).get(i);
    if (!row) {
      db.prepare(
        `INSERT INTO mock_ads (slot_id, advertiser, project_name, creative_url, start_ns, end_ns, paid)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      ).run(i);
    }
  }
}

function ensureMerchants(): void {
  for (const id of MERCHANT_IDS) {
    const accountId = merchantAccountId(id);
    const row = db.prepare(`SELECT id FROM merchants WHERE id = ?`).get(id);
    if (!row) {
      db.prepare(
        `INSERT INTO merchants (id, account_id, enc_private_key, floated, created_at)
         VALUES (?, ?, ?, 1, ?)`,
      ).run(id, accountId, MOCK_KEY, Date.now());
    }
    if (readGd(accountId) < MERCHANT_FLOAT) writeGd(accountId, MERCHANT_FLOAT);
  }
}

function marketConfig(): MarketConfig {
  return {
    owner: 'mock',
    treasury: 'treasury.mock',
    unit_ms: metaGet('unit_ms', '60000'),
    max_units: Number(metaGet('max_units', '10')) || 10,
    max_horizon_units: 100,
    base_price: metaGet('base_price', BASE_PRICE_YOCTO.toString()),
    slot_count: Number(metaGet('slot_count', '5')) || 5,
    attention_bps: 10000,
    cycle_cooldown_ms: '0',
    cycle_max_ms: '0',
  };
}

function currentAd(slotId: number): MarketBooking | null {
  const row = db
    .prepare(
      `SELECT advertiser, project_name, creative_url, start_ns, end_ns, paid FROM mock_ads WHERE slot_id = ?`,
    )
    .get(slotId) as
    | {
        advertiser: string | null;
        project_name: string | null;
        creative_url: string | null;
        start_ns: string | null;
        end_ns: string | null;
        paid: string | null;
      }
    | undefined;
  if (!row?.advertiser || !row.creative_url) return null;
  return {
    advertiser: row.advertiser,
    project_name: row.project_name ?? '',
    creative_url: row.creative_url,
    start_ns: row.start_ns ?? '0',
    end_ns: row.end_ns ?? '0',
    paid: row.paid ?? '0',
  };
}

/** Seed or replace a mock ad booking (tests / tools). */
export function seedMockAd(
  slotId: number,
  booking: {
    advertiser: string;
    projectName: string;
    creativeUrl: string;
    startNs?: string;
    endNs?: string;
    paid?: string;
  },
): void {
  db.prepare(
    `INSERT INTO mock_ads (slot_id, advertiser, project_name, creative_url, start_ns, end_ns, paid)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slot_id) DO UPDATE SET
       advertiser = excluded.advertiser,
       project_name = excluded.project_name,
       creative_url = excluded.creative_url,
       start_ns = excluded.start_ns,
       end_ns = excluded.end_ns,
       paid = excluded.paid`,
  ).run(
    slotId,
    booking.advertiser,
    booking.projectName,
    booking.creativeUrl,
    booking.startNs ?? '1',
    booking.endNs ?? '2',
    booking.paid ?? BASE_PRICE_YOCTO.toString(),
  );
}

export function readMockGd(accountId: string): bigint {
  return readGd(accountId);
}

/** Install mock chain seams. Idempotent. No-op when CHAIN_MODE=testnet. */
export function installMockChain(): void {
  if (!isMockChain()) return;
  if (installed) return;
  installed = true;

  seedMetaAndAds();
  ensureMerchants();

  setGdChainForTests({
    read: async accountId => readGd(accountId),
    mint: async (accountId, amount) => {
      writeGd(accountId, readGd(accountId) + amount);
    },
    burn: async (accountId, amount) => {
      writeGd(accountId, readGd(accountId) - amount);
    },
    transfer: async (from, to, amount) => {
      const have = readGd(from);
      if (have < amount) throw new Error('insufficient');
      writeGd(from, have - amount);
      writeGd(to, readGd(to) + amount);
    },
  });

  setItemsChainForTests({
    balances: async accountId => readItems(accountId),
    burn: async (accountId, tokenId, amount) => {
      applyItemBurn({ account_id: accountId, token_id: tokenId, amount: amount.toString() });
    },
    getToken: async tokenId => getTokenRow(tokenId),
    createToken: async (tokenId, kind, title, maxSupply) => {
      applyCreateToken({
        token_id: tokenId,
        kind,
        title,
        max_supply: maxSupply == null ? null : String(maxSupply),
      });
    },
    mint: async (accountId, tokenId, amount) => {
      applyItemMint({
        account_id: accountId,
        token_id: tokenId,
        amount: amount.toString(),
      });
    },
  });

  setMintTxTestHooks({
    sign: async () => {
      mintSeq += 1;
      return { hash: `mock-tx-${mintSeq}`, signed: {} as never };
    },
    broadcast: async () => {
      applyTreasuryOrSigned();
      return 'success';
    },
    lookup: async () => 'success',
  });

  setNearFundingForTests({
    read: async () => PLAYER_FUND_NEAR,
    topUp: async () => {},
  });

  setMerchantChainForTests({
    exists: async () => true,
    create: async () => {},
  });

  setMarketViewsForTests({
    config: async () => marketConfig(),
    currentAd: async slotId => currentAd(slotId),
    price: async (_slotId, units) => BASE_PRICE_YOCTO * BigInt(Math.max(1, units)),
  });

  setCreatePlayerAccountForTests(async (name, opts) => {
    const accountId = `${name}.${config.rootAccount}`;
    const id = randomId();
    try {
      db.prepare(
        `INSERT INTO players (id, name, google_sub, account_id, enc_private_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).run(id, name, opts?.googleSub ?? null, accountId, MOCK_KEY, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE')) throw new Error(`Duplicate player name or account: ${name}`);
      throw err;
    }
    return accountId;
  });

  // Shard token for vault finishes
  applyCreateToken({ token_id: 'shard', kind: 'shard', title: 'Shard', max_supply: null });

  console.log('[chain] CHAIN_MODE=mock (SQLite ledger, no testnet RPC)');
}

export function resetMockChainInstallForTests(): void {
  installed = false;
}

export const MOCK_PLAYER_KEY = MOCK_KEY;
