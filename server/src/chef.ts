import {
  applyChefRestock,
  applyChefSale,
  catalogById,
  CHEF_FOOD,
  CHEF_MIN_BALANCE,
  chefFoodRule,
  quoteChefPrice,
  type ChefPriceReasoning,
} from '@glitch/shared';
import { AuthError } from './auth';
import { db } from './db';
import { getGDBalanceCached } from './near/gd';
import { getMerchant } from './near/merchants';

export type ChefInventoryRow = {
  item_id: string;
  stock: number;
  demand_ema: number;
  updated_at: number;
};

export type ChefMenuItem = {
  itemId: string;
  title: string;
  stock: number;
  demandEma: number;
  price: number;
  reasoning: ChefPriceReasoning;
};

export type MerchantsPayload = {
  chef: {
    accountId: string;
    gdBalance: string;
    minBalance: number;
    menu: ChefMenuItem[];
  };
};

function ensureChefRows(now = Date.now()): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO chef_inventory (item_id, stock, demand_ema, updated_at) VALUES (?, ?, 0, ?)`,
  );
  for (const rule of CHEF_FOOD) {
    insert.run(rule.id, rule.targetStock, now);
  }
}

function getRow(itemId: string): ChefInventoryRow | undefined {
  return db
    .prepare(`SELECT item_id, stock, demand_ema, updated_at FROM chef_inventory WHERE item_id = ?`)
    .get(itemId) as ChefInventoryRow | undefined;
}

function writeRow(itemId: string, stock: number, demandEma: number, now: number): void {
  db.prepare(
    `UPDATE chef_inventory SET stock = ?, demand_ema = ?, updated_at = ? WHERE item_id = ?`,
  ).run(stock, demandEma, now, itemId);
}

/** Apply timestamp restock/demand decay for every chef food row. */
export function syncChefInventory(now = Date.now()): void {
  ensureChefRows(now);
  const rows = db
    .prepare(`SELECT item_id, stock, demand_ema, updated_at FROM chef_inventory`)
    .all() as ChefInventoryRow[];
  for (const row of rows) {
    const rule = chefFoodRule(row.item_id);
    if (!rule) continue;
    const elapsedSec = Math.max(0, (now - row.updated_at) / 1000);
    if (elapsedSec <= 0) continue;
    const next = applyChefRestock(row.stock, row.demand_ema, rule.targetStock, elapsedSec);
    writeRow(row.item_id, next.stock, next.demandEma, now);
  }
}

export type ChefQuote = {
  itemId: string;
  stock: number;
  demandEma: number;
  reasoning: ChefPriceReasoning;
  finalPrice: number;
};

/** Sync inventory, then quote. Rejects sold-out dishes. */
export function quoteChefFood(itemId: string, now = Date.now()): ChefQuote {
  const rule = chefFoodRule(itemId);
  if (!rule) throw new AuthError('Unknown chef food', 400);
  syncChefInventory(now);
  const row = getRow(itemId);
  if (!row) throw new AuthError('Unknown chef food', 400);
  if (row.stock < 1) throw new AuthError('Sold out', 400);
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

/** After a food purchase delivers: lower stock and bump demand. */
export function recordChefFoodSale(itemId: string, now = Date.now()): void {
  const rule = chefFoodRule(itemId);
  if (!rule) return;
  syncChefInventory(now);
  const row = getRow(itemId);
  if (!row) return;
  const next = applyChefSale(row.stock, row.demand_ema);
  writeRow(itemId, next.stock, next.demandEma, now);
}

/** Current stock/demand + quote (allows stock below 1 for display after a sale). */
export function chefFoodSnapshot(itemId: string, now = Date.now()): ChefQuote | null {
  const rule = chefFoodRule(itemId);
  if (!rule) return null;
  syncChefInventory(now);
  const row = getRow(itemId);
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

/** Session GET /merchants payload (chef only). */
export async function merchantsView(): Promise<MerchantsPayload> {
  syncChefInventory();
  const merchant = getMerchant('chef');
  if (!merchant) throw new AuthError('Chef is not set up', 503);
  let gdBalance = '0';
  try {
    gdBalance = await getGDBalanceCached(merchant.account_id);
  } catch {
    gdBalance = '0';
  }
  const menu: ChefMenuItem[] = [];
  for (const rule of CHEF_FOOD) {
    const row = getRow(rule.id);
    if (!row) continue;
    const item = catalogById(rule.id);
    const reasoning = quoteChefPrice({
      basePrice: rule.basePrice,
      targetStock: rule.targetStock,
      k: rule.k,
      stock: Math.max(row.stock, 1),
      demandEma: row.demand_ema,
    });
    menu.push({
      itemId: rule.id,
      title: item?.title ?? rule.id,
      stock: row.stock,
      demandEma: row.demand_ema,
      price: reasoning.finalPrice,
      reasoning,
    });
  }
  return {
    chef: {
      accountId: merchant.account_id,
      gdBalance,
      minBalance: CHEF_MIN_BALANCE,
      menu,
    },
  };
}
