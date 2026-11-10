/**
 * Chef food pricing rules. Readable game constants — not on-chain.
 * price = base * (targetStock / stock)^k * (1 + demandEma), clamped to [0.5x, 3x].
 */
import { catalogById } from './catalog';
import { clamp } from './rng';

export const CHEF_MIN_BALANCE = 1_000;
export const CHEF_PRICE_MIN_MULT = 0.5;
export const CHEF_PRICE_MAX_MULT = 3;
/** Stock units restored toward target per second. */
export const CHEF_RESTOCK_PER_S = 0.05;
/** Demand EMA decay per second toward 0. */
export const CHEF_DEMAND_DECAY_PER_S = 0.02;
/** Demand bump on each delivered food sale. */
export const CHEF_DEMAND_BUY = 0.12;

export type ChefFoodRule = {
  id: string;
  basePrice: number;
  targetStock: number;
  k: number;
};

function foodBase(id: string): number {
  const item = catalogById(id);
  if (!item || item.priceGD == null) throw new Error(`Missing catalog price for ${id}`);
  return item.priceGD;
}

export const CHEF_FOOD: readonly ChefFoodRule[] = [
  { id: 'jollof-and-chicken', basePrice: foodBase('jollof-and-chicken'), targetStock: 20, k: 1.25 },
  { id: 'suya-skewer', basePrice: foodBase('suya-skewer'), targetStock: 20, k: 1.25 },
  { id: 'zobo-drink', basePrice: foodBase('zobo-drink'), targetStock: 20, k: 1.25 },
];

export function chefFoodRule(id: string): ChefFoodRule | undefined {
  return CHEF_FOOD.find(r => r.id === id);
}

export type ChefPriceClamp = 'none' | 'low' | 'high';

export type ChefPriceReasoning = {
  stockFactor: number;
  demandFactor: number;
  clamp: ChefPriceClamp;
  finalPrice: number;
};

export function quoteChefPrice(opts: {
  basePrice: number;
  targetStock: number;
  k: number;
  stock: number;
  demandEma: number;
}): ChefPriceReasoning {
  const { basePrice, targetStock, k, demandEma } = opts;
  const stock = Math.max(opts.stock, 1);
  const stockFactor = (targetStock / stock) ** k;
  const demandFactor = 1 + demandEma;
  const raw = basePrice * stockFactor * demandFactor;
  const lo = basePrice * CHEF_PRICE_MIN_MULT;
  const hi = basePrice * CHEF_PRICE_MAX_MULT;
  const finalPrice = Math.round(clamp(raw, lo, hi));
  let clampKind: ChefPriceClamp = 'none';
  if (raw < lo) clampKind = 'low';
  else if (raw > hi) clampKind = 'high';
  return { stockFactor, demandFactor, clamp: clampKind, finalPrice };
}

/** Move stock toward target and decay demand over elapsed seconds. */
export function applyChefRestock(
  stock: number,
  demandEma: number,
  targetStock: number,
  elapsedSec: number,
): { stock: number; demandEma: number } {
  if (elapsedSec <= 0) return { stock, demandEma };
  const delta = targetStock - stock;
  const step = Math.sign(delta) * Math.min(Math.abs(delta), CHEF_RESTOCK_PER_S * elapsedSec);
  const nextStock = stock + step;
  const decay = Math.exp(-CHEF_DEMAND_DECAY_PER_S * elapsedSec);
  const nextDemand = demandEma * decay;
  return {
    stock: nextStock,
    demandEma: Math.abs(nextDemand) < 1e-9 ? 0 : nextDemand,
  };
}

/** One delivered food sale. */
export function applyChefSale(
  stock: number,
  demandEma: number,
): { stock: number; demandEma: number } {
  return {
    stock: Math.max(0, stock - 1),
    demandEma: demandEma + CHEF_DEMAND_BUY,
  };
}
