import {
  applyChefRestock,
  applyChefSale,
  catalogById,
  CHEF_FOOD,
  CHEF_MIN_BALANCE,
  chefFoodRule,
  DEALER_GOODS,
  dealerItemRule,
  MERCHANT_MIN_BALANCE,
  merchantItemRule,
  merchantRulesFor,
  merchantShopOpen,
  quoteChefPrice,
  SMITH_GEAR,
  smithGearRule,
  type ChefPriceReasoning,
} from '@glitch/shared';
import { AuthError } from './auth';
import { db } from './db';
import { getGDBalanceCached } from './near/gd';
import { getMerchant, merchantAccountId, MERCHANT_IDS } from './near/merchants';

type MerchantId = (typeof MERCHANT_IDS)[number];

export type MerchantInventoryRow = {
  merchant_id: string;
  item_id: string;
  stock: number;
  demand_ema: number;
  updated_at: number;
};

/** @deprecated Use MerchantInventoryRow. */
export type ChefInventoryRow = Omit<MerchantInventoryRow, 'merchant_id'>;

export type MerchantMenuItem = {
  itemId: string;
  title: string;
  stock: number;
  demandEma: number;
  price: number;
  reasoning: ChefPriceReasoning;
  /** Smith forge only. */
  shardsCost?: number;
};

/** @deprecated Use MerchantMenuItem. */
export type ChefMenuItem = MerchantMenuItem;

export type MerchantShopView = {
  accountId: string;
  gdBalance: string;
  minBalance: number;
  /** False when the chain balance could not be read (do not treat as insolvent). */
  balanceKnown: boolean;
  /** True when buys are blocked (missing custodial key row and/or insolvent). */
  closed: boolean;
  /** Distinguishes missing server keys from a real empty wallet. */
  closedReason?: 'no_keys' | 'insolvent';
  menu: MerchantMenuItem[];
  /** Most recent NPC supply/city trade touching this merchant. */
  lastTrade?: {
    from: string;
    to: string;
    amount: number;
    label: string;
    at: number;
  };
};

export type MerchantsPayload = {
  chef: MerchantShopView;
  smith: MerchantShopView;
  dealer: MerchantShopView;
};

export type MerchantQuote = {
  itemId: string;
  stock: number;
  demandEma: number;
  reasoning: ChefPriceReasoning;
  finalPrice: number;
};

/** @deprecated Use MerchantQuote. */
export type ChefQuote = MerchantQuote;

function ensureMerchantRows(merchantId: MerchantId, now = Date.now()): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO merchant_inventory (merchant_id, item_id, stock, demand_ema, updated_at)
     VALUES (?, ?, ?, 0, ?)`,
  );
  for (const rule of merchantRulesFor(merchantId)) {
    insert.run(merchantId, rule.id, rule.targetStock, now);
  }
}

function getRow(merchantId: MerchantId, itemId: string): MerchantInventoryRow | undefined {
  return db
    .prepare(
      `SELECT merchant_id, item_id, stock, demand_ema, updated_at
       FROM merchant_inventory WHERE merchant_id = ? AND item_id = ?`,
    )
    .get(merchantId, itemId) as MerchantInventoryRow | undefined;
}

function writeRow(
  merchantId: MerchantId,
  itemId: string,
  stock: number,
  demandEma: number,
  now: number,
): void {
  db.prepare(
    `UPDATE merchant_inventory SET stock = ?, demand_ema = ?, updated_at = ?
     WHERE merchant_id = ? AND item_id = ?`,
  ).run(stock, demandEma, now, merchantId, itemId);
}

export type MerchantRestockDelta = { merchantId: MerchantId; itemId: string; stockGained: number };

/** Apply timestamp restock/demand decay; returns stock units gained (for supply-chain GD). */
export function syncMerchantInventoryWithDeltas(
  merchantId: MerchantId,
  now = Date.now(),
): MerchantRestockDelta[] {
  ensureMerchantRows(merchantId, now);
  const rows = db
    .prepare(
      `SELECT merchant_id, item_id, stock, demand_ema, updated_at
       FROM merchant_inventory WHERE merchant_id = ?`,
    )
    .all(merchantId) as MerchantInventoryRow[];
  const deltas: MerchantRestockDelta[] = [];
  for (const row of rows) {
    const rule = merchantItemRule(merchantId, row.item_id);
    if (!rule) continue;
    const elapsedSec = Math.max(0, (now - row.updated_at) / 1000);
    if (elapsedSec <= 0) continue;
    const next = applyChefRestock(row.stock, row.demand_ema, rule.targetStock, elapsedSec);
    const stockGained = next.stock - row.stock;
    writeRow(merchantId, row.item_id, next.stock, next.demandEma, now);
    if (stockGained > 0) deltas.push({ merchantId, itemId: row.item_id, stockGained });
  }
  return deltas;
}

/** Apply timestamp restock/demand decay for one merchant. */
export function syncMerchantInventory(merchantId: MerchantId, now = Date.now()): void {
  syncMerchantInventoryWithDeltas(merchantId, now);
}

/** Sync all three merchants. */
export function syncAllMerchantInventory(now = Date.now()): void {
  syncMerchantInventory('chef', now);
  syncMerchantInventory('smith', now);
  syncMerchantInventory('dealer', now);
}

/** @deprecated Prefer syncMerchantInventory('chef'). */
export function syncChefInventory(now = Date.now()): void {
  syncMerchantInventory('chef', now);
}

function quoteFor(
  merchantId: MerchantId,
  itemId: string,
  opts: { requireStock?: boolean },
  now = Date.now(),
): MerchantQuote {
  const rule = merchantItemRule(merchantId, itemId);
  if (!rule) throw new AuthError(`Unknown ${merchantId} item`, 400);
  syncMerchantInventory(merchantId, now);
  const row = getRow(merchantId, itemId);
  if (!row) throw new AuthError(`Unknown ${merchantId} item`, 400);
  if (opts.requireStock && row.stock < 1) throw new AuthError('Sold out', 400);
  const reasoning = quoteChefPrice({
    basePrice: rule.basePrice,
    targetStock: rule.targetStock,
    k: rule.k,
    stock: row.stock,
    demandEma: row.demand_ema,
  });
  return {
    itemId,
    stock: row.stock,
    demandEma: row.demand_ema,
    reasoning,
    finalPrice: reasoning.finalPrice,
  };
}

function recordSale(merchantId: MerchantId, itemId: string, now = Date.now()): void {
  const rule = merchantItemRule(merchantId, itemId);
  if (!rule) return;
  syncMerchantInventory(merchantId, now);
  const row = getRow(merchantId, itemId);
  if (!row) return;
  const next = applyChefSale(row.stock, row.demand_ema);
  writeRow(merchantId, itemId, next.stock, next.demandEma, now);
}

function snapshotFor(merchantId: MerchantId, itemId: string, now = Date.now()): MerchantQuote | null {
  const rule = merchantItemRule(merchantId, itemId);
  if (!rule) return null;
  syncMerchantInventory(merchantId, now);
  const row = getRow(merchantId, itemId);
  if (!row) return null;
  const reasoning = quoteChefPrice({
    basePrice: rule.basePrice,
    targetStock: rule.targetStock,
    k: rule.k,
    stock: row.stock,
    demandEma: row.demand_ema,
  });
  return {
    itemId,
    stock: row.stock,
    demandEma: row.demand_ema,
    reasoning,
    finalPrice: reasoning.finalPrice,
  };
}

/** Sync inventory, then quote. Rejects sold-out dishes. */
export function quoteChefFood(itemId: string, now = Date.now()): MerchantQuote {
  if (!chefFoodRule(itemId)) throw new AuthError('Unknown chef food', 400);
  return quoteFor('chef', itemId, { requireStock: true }, now);
}

export function quoteSmithGear(itemId: string, now = Date.now()): MerchantQuote {
  if (!smithGearRule(itemId)) throw new AuthError('Unknown forge item', 400);
  return quoteFor('smith', itemId, { requireStock: true }, now);
}

export function quoteDealerItem(itemId: string, now = Date.now()): MerchantQuote {
  if (!dealerItemRule(itemId)) throw new AuthError('Unknown dealer item', 400);
  return quoteFor('dealer', itemId, { requireStock: true }, now);
}

export function recordChefFoodSale(itemId: string, now = Date.now()): void {
  recordSale('chef', itemId, now);
}

export function recordSmithSale(itemId: string, now = Date.now()): void {
  recordSale('smith', itemId, now);
}

export function recordDealerSale(itemId: string, now = Date.now()): void {
  recordSale('dealer', itemId, now);
}

export function chefFoodSnapshot(itemId: string, now = Date.now()): MerchantQuote | null {
  return snapshotFor('chef', itemId, now);
}

export function smithGearSnapshot(itemId: string, now = Date.now()): MerchantQuote | null {
  return snapshotFor('smith', itemId, now);
}

export function dealerItemSnapshot(itemId: string, now = Date.now()): MerchantQuote | null {
  return snapshotFor('dealer', itemId, now);
}

async function shopView(merchantId: MerchantId): Promise<MerchantShopView> {
  // Local stock/price sync only. On-chain restock pays run in runMerchantSupplyTick —
  // awaiting ft_transfer here blocks GET /merchants (menus + balances) on testnet.
  syncMerchantInventory(merchantId);
  const merchant = getMerchant(merchantId);
  const accountId = merchant?.account_id ?? merchantAccountId(merchantId);
  let gdBalance = '0';
  let balanceKnown = false;
  try {
    gdBalance = await getGDBalanceCached(accountId);
    balanceKnown = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[merchants] ${merchantId} GD balance failed: ${msg.slice(0, 160)}`);
  }
  const rules =
    merchantId === 'chef' ? CHEF_FOOD : merchantId === 'smith' ? SMITH_GEAR : DEALER_GOODS;
  // Menu/stock live in merchant_inventory — do not require the merchants key row.
  const menu: MerchantMenuItem[] = [];
  for (const rule of rules) {
    const row = getRow(merchantId, rule.id);
    if (!row) continue;
    const item = catalogById(rule.id);
    const reasoning = quoteChefPrice({
      basePrice: rule.basePrice,
      targetStock: rule.targetStock,
      k: rule.k,
      stock: Math.max(row.stock, 1),
      demandEma: row.demand_ema,
    });
    const entry: MerchantMenuItem = {
      itemId: rule.id,
      title: item?.title ?? rule.id,
      stock: row.stock,
      demandEma: row.demand_ema,
      price: reasoning.finalPrice,
      reasoning,
    };
    if (merchantId === 'smith' && item?.effect.shardsCost != null) {
      entry.shardsCost = item.effect.shardsCost;
    }
    menu.push(entry);
  }
  const minBalance = merchantId === 'chef' ? CHEF_MIN_BALANCE : MERCHANT_MIN_BALANCE;
  const { getLastTrade } = await import('./merchantEconomy');
  const last = getLastTrade(merchantId);
  // Insolvent only when balance is known and below floor. Missing custodial key rows
  // must not look like "out of GD" (Render often has chain float but empty merchants table).
  const insolvent = balanceKnown && !merchantShopOpen(gdBalance);
  const closed = !merchant || insolvent;
  return {
    accountId,
    gdBalance: balanceKnown ? gdBalance : '0',
    balanceKnown,
    minBalance,
    closed,
    /** Why the shop is closed — UI should not say "out of GD" for missing keys. */
    closedReason: !merchant ? 'no_keys' : insolvent ? 'insolvent' : undefined,
    menu,
    ...(last
      ? {
          lastTrade: {
            from: last.from,
            to: last.to,
            amount: last.amount,
            label: last.label,
            at: last.at,
          },
        }
      : {}),
  };
}

/** Session GET /merchants payload (chef, smith, dealer). */
export async function merchantsView(): Promise<MerchantsPayload> {
  const [chef, smith, dealer] = await Promise.all([
    shopView('chef'),
    shopView('smith'),
    shopView('dealer'),
  ]);
  return { chef, smith, dealer };
}
