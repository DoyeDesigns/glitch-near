/**
 * Merchant pricing rules (chef / smith / dealer). Readable game constants — not on-chain.
 * price = base * (targetStock / stock)^k * (1 + demandEma), clamped to [0.5x, 3x].
 * Gear merchant stock is template inventory — never on-chain maxSupply of 1.
 */
import { catalogById } from './catalog';
import {
  bumpEuphoria,
  bumpLeverage,
  decayPressures,
  EVENT_CHECK_S,
  EVENT_COOLDOWN_S,
  rollArchetype,
  rumorForArchetype,
} from './events.rules';
import { clamp, mulberry32 } from './rng';
import { TOKEN_DEFS } from './tokens';
import type { Token } from './types';

/** Chance per event-check to bump pressures during city fast-forward. */
const SIM_EUPHORIA_BUMP_P = 0.12;
const SIM_LEVERAGE_BUMP_P = 0.12;

/** Tokens for rumor titles — no rng (must not disturb sim seed). */
function simTokens(): Token[] {
  return TOKEN_DEFS.map(d => ({
    ...d,
    base: { ...d.base },
    hype: d.base.hype,
    usage: d.base.usage,
    trust: d.base.trust,
    flow: 0,
    supply: 0,
    hist: [d.price],
  }));
}

export const CHEF_MIN_BALANCE = 1_000;
export const MERCHANT_MIN_BALANCE = CHEF_MIN_BALANCE;

/** Shop is open when merchant spendable GD is at least MERCHANT_MIN_BALANCE. */
export function merchantShopOpen(gdBalance: number | bigint | string): boolean {
  const bal = typeof gdBalance === 'bigint' ? gdBalance : BigInt(gdBalance);
  return bal >= BigInt(MERCHANT_MIN_BALANCE);
}

/** GD still needed for the merchant to reopen (0 when already open). */
export function merchantInvestToOpen(gdBalance: number | bigint | string): number {
  const bal = typeof gdBalance === 'bigint' ? gdBalance : BigInt(gdBalance);
  const need = BigInt(MERCHANT_MIN_BALANCE) - bal;
  return need > 0n ? Number(need) : 0;
}
export const CHEF_PRICE_MIN_MULT = 0.5;
export const CHEF_PRICE_MAX_MULT = 3;
/** Stock units restored toward target per second. */
export const CHEF_RESTOCK_PER_S = 0.05;
/** Demand EMA decay per second toward 0. */
export const CHEF_DEMAND_DECAY_PER_S = 0.02;
/** Demand bump on each delivered sale. */
export const CHEF_DEMAND_BUY = 0.12;
/** Mean seconds between simulated buys in fast-forward. */
export const CHEF_SIM_MEAN_BUY_INTERVAL_S = 180;
export const CHEF_SIM_MAX_HOURS = 168;
const CHEF_SIM_MAX_EVENTS = 10_000;

const DEFAULT_TARGET_STOCK = 20;
const DEFAULT_K = 1.25;

export type MerchantItemRule = {
  id: string;
  basePrice: number;
  targetStock: number;
  k: number;
};

/** @deprecated Alias — same shape as MerchantItemRule. */
export type ChefFoodRule = MerchantItemRule;

function priceBase(id: string): number {
  const item = catalogById(id);
  if (!item || item.priceGD == null) throw new Error(`Missing catalog price for ${id}`);
  return item.priceGD;
}

function gdCostBase(id: string): number {
  const item = catalogById(id);
  if (!item || item.effect.gdCost == null) throw new Error(`Missing gdCost for ${id}`);
  return item.effect.gdCost;
}

export const CHEF_FOOD: readonly MerchantItemRule[] = [
  { id: 'jollof-and-chicken', basePrice: priceBase('jollof-and-chicken'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'suya-skewer', basePrice: priceBase('suya-skewer'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'zobo-drink', basePrice: priceBase('zobo-drink'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
];

/** Forgeable gear (smith). basePrice = catalog gdCost. */
export const SMITH_GEAR: readonly MerchantItemRule[] = [
  { id: 'cap', basePrice: gdCostBase('cap'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'chain', basePrice: gdCostBase('chain'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'backpack', basePrice: gdCostBase('backpack'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'cape', basePrice: gdCostBase('cape'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'crown', basePrice: gdCostBase('crown'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
];

/** Furniture + studio (dealer). basePrice = catalog priceGD. */
export const DEALER_GOODS: readonly MerchantItemRule[] = [
  { id: 'bed2', basePrice: priceBase('bed2'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'rug', basePrice: priceBase('rug'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'sofa', basePrice: priceBase('sofa'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'plant', basePrice: priceBase('plant'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'lamp', basePrice: priceBase('lamp'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'tv', basePrice: priceBase('tv'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'pc', basePrice: priceBase('pc'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'neon', basePrice: priceBase('neon'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'trophy', basePrice: priceBase('trophy'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
  { id: 'studio-apartment', basePrice: priceBase('studio-apartment'), targetStock: DEFAULT_TARGET_STOCK, k: DEFAULT_K },
];

export function chefFoodRule(id: string): MerchantItemRule | undefined {
  return CHEF_FOOD.find(r => r.id === id);
}

export function smithGearRule(id: string): MerchantItemRule | undefined {
  return SMITH_GEAR.find(r => r.id === id);
}

export function dealerItemRule(id: string): MerchantItemRule | undefined {
  return DEALER_GOODS.find(r => r.id === id);
}

export function merchantRulesFor(merchantId: 'chef' | 'smith' | 'dealer'): readonly MerchantItemRule[] {
  if (merchantId === 'chef') return CHEF_FOOD;
  if (merchantId === 'smith') return SMITH_GEAR;
  return DEALER_GOODS;
}

export function merchantItemRule(
  merchantId: 'chef' | 'smith' | 'dealer',
  itemId: string,
): MerchantItemRule | undefined {
  return merchantRulesFor(merchantId).find(r => r.id === itemId);
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

export type ChefSimPoint = {
  t: number;
  itemId: string;
  price: number;
  stock: number;
  demandEma: number;
};

export type ChefSimEnding = {
  price: number;
  stock: number;
  demandEma: number;
};

export type ChefSimResult = {
  hours: number;
  seed: number;
  timeline: ChefSimPoint[];
  ending: Record<string, ChefSimEnding>;
};

export type CitySimMerchant = {
  timeline: ChefSimPoint[];
  ending: Record<string, ChefSimEnding>;
};

export type CitySimEvent = {
  t: number;
  kind: 'pump' | 'rugPull';
  title: string;
};

export type CitySimResult = {
  hours: number;
  seed: number;
  merchants: {
    chef: CitySimMerchant;
    smith: CitySimMerchant;
    dealer: CitySimMerchant;
  };
  events: CitySimEvent[];
};

type MerchantId = 'chef' | 'smith' | 'dealer';

type ItemState = { stock: number; demandEma: number; merchantId: MerchantId; rule: MerchantItemRule };

function endingFor(
  rules: readonly MerchantItemRule[],
  state: Map<string, ItemState>,
): Record<string, ChefSimEnding> {
  const ending: Record<string, ChefSimEnding> = {};
  for (const rule of rules) {
    const s = state.get(rule.id)!;
    const q = quoteChefPrice({
      basePrice: rule.basePrice,
      targetStock: rule.targetStock,
      k: rule.k,
      stock: s.stock,
      demandEma: s.demandEma,
    });
    ending[rule.id] = { price: q.finalPrice, stock: s.stock, demandEma: s.demandEma };
  }
  return ending;
}

function restockAll(state: Map<string, ItemState>, dt: number): void {
  for (const s of state.values()) {
    const next = applyChefRestock(s.stock, s.demandEma, s.rule.targetStock, dt);
    s.stock = next.stock;
    s.demandEma = next.demandEma;
  }
}

/**
 * Pure city fast-forward: chef + smith + dealer prices and pump/rugPull moments.
 * No SQLite, GD, or NEAR. Same (hours, seed) → same payload.
 */
export function simulateCityFastForward(hours: number, seed: number): CitySimResult {
  const h = clamp(Number.isFinite(hours) ? hours : 0, 0, CHEF_SIM_MAX_HOURS);
  const seedU = seed >>> 0;
  const horizon = h * 3600;
  const rng = mulberry32(seedU);
  const tokens = simTokens();

  const state = new Map<string, ItemState>();
  const timelines: Record<MerchantId, ChefSimPoint[]> = { chef: [], smith: [], dealer: [] };
  for (const [merchantId, rules] of [
    ['chef', CHEF_FOOD],
    ['smith', SMITH_GEAR],
    ['dealer', DEALER_GOODS],
  ] as const) {
    for (const rule of rules) {
      state.set(rule.id, {
        stock: rule.targetStock,
        demandEma: 0,
        merchantId,
        rule,
      });
    }
  }

  const emptyMerchants = (): CitySimResult['merchants'] => ({
    chef: { timeline: [], ending: endingFor(CHEF_FOOD, state) },
    smith: { timeline: [], ending: endingFor(SMITH_GEAR, state) },
    dealer: { timeline: [], ending: endingFor(DEALER_GOODS, state) },
  });

  if (horizon <= 0) {
    return { hours: h, seed: seedU, merchants: emptyMerchants(), events: [] };
  }

  let t = 0;
  let buyEvents = 0;
  let nextBuyT = 0;
  {
    const u = Math.max(1e-12, 1 - rng.next());
    nextBuyT = -Math.log(u) * CHEF_SIM_MEAN_BUY_INTERVAL_S;
  }
  let nextEventCheckT = EVENT_CHECK_S;
  let lastEventT = -EVENT_COOLDOWN_S;
  let euphoria = 0;
  let leverage = 0;
  const cityEvents: CitySimEvent[] = [];

  while (t < horizon && buyEvents < CHEF_SIM_MAX_EVENTS) {
    const nextT = Math.min(nextBuyT, nextEventCheckT, horizon);
    if (nextT <= t) break;
    const dt = nextT - t;
    restockAll(state, dt);
    const pressures = decayPressures(euphoria, leverage, dt);
    euphoria = pressures.euphoria;
    leverage = pressures.leverage;
    t = nextT;

    if (t >= nextEventCheckT - 1e-9 && t < horizon) {
      if (rng.next() < SIM_EUPHORIA_BUMP_P) euphoria = bumpEuphoria(euphoria);
      if (rng.next() < SIM_LEVERAGE_BUMP_P) leverage = bumpLeverage(leverage);
      if (t - lastEventT >= EVENT_COOLDOWN_S) {
        const kind = rollArchetype(rng, euphoria, leverage);
        if (kind) {
          const { rumor } = rumorForArchetype(rng, kind, tokens);
          cityEvents.push({ t, kind, title: rumor });
          lastEventT = t;
        }
      }
      nextEventCheckT = t + EVENT_CHECK_S;
    }

    if (t >= nextBuyT - 1e-9 && t < horizon) {
      buyEvents += 1;
      const available = [...state.values()].filter(s => s.stock >= 1);
      if (available.length > 0) {
        const pick = available[Math.floor(rng.next() * available.length)]!;
        const rule = pick.rule;
        const quoted = quoteChefPrice({
          basePrice: rule.basePrice,
          targetStock: rule.targetStock,
          k: rule.k,
          stock: pick.stock,
          demandEma: pick.demandEma,
        });
        const sold = applyChefSale(pick.stock, pick.demandEma);
        pick.stock = sold.stock;
        pick.demandEma = sold.demandEma;
        timelines[pick.merchantId].push({
          t,
          itemId: rule.id,
          price: quoted.finalPrice,
          stock: pick.stock,
          demandEma: pick.demandEma,
        });
      }
      const u = Math.max(1e-12, 1 - rng.next());
      nextBuyT = t + -Math.log(u) * CHEF_SIM_MEAN_BUY_INTERVAL_S;
    }
  }

  if (t < horizon) {
    restockAll(state, horizon - t);
    const pressures = decayPressures(euphoria, leverage, horizon - t);
    euphoria = pressures.euphoria;
    leverage = pressures.leverage;
  }

  return {
    hours: h,
    seed: seedU,
    merchants: {
      chef: { timeline: timelines.chef, ending: endingFor(CHEF_FOOD, state) },
      smith: { timeline: timelines.smith, ending: endingFor(SMITH_GEAR, state) },
      dealer: { timeline: timelines.dealer, ending: endingFor(DEALER_GOODS, state) },
    },
    events: cityEvents,
  };
}

/** Chef slice of the city fast-forward (compat). */
export function simulateChefFastForward(hours: number, seed: number): ChefSimResult {
  const city = simulateCityFastForward(hours, seed);
  return {
    hours: city.hours,
    seed: city.seed,
    timeline: city.merchants.chef.timeline,
    ending: city.merchants.chef.ending,
  };
}
