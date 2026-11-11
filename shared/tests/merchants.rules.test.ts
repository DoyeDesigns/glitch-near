import { describe, expect, it } from 'vitest';
import {
  applyChefRestock,
  applyChefSale,
  CHEF_DEMAND_BUY,
  CHEF_FOOD,
  CHEF_PRICE_MAX_MULT,
  CHEF_PRICE_MIN_MULT,
  CHEF_SIM_MAX_HOURS,
  DEALER_GOODS,
  MERCHANT_CITY_TRADES,
  MERCHANT_CITY_TRADES_PER_DAY,
  MERCHANT_MIN_BALANCE,
  cityTradePayment,
  merchantInvestToOpen,
  merchantRestockPayment,
  merchantShopOpen,
  quoteChefPrice,
  simulateCityFastForward,
  simulateMerchantCityDay,
  SMITH_GEAR,
} from '../src/merchants.rules';

const zobo = CHEF_FOOD.find(r => r.id === 'zobo-drink')!;

describe('merchant insolvency helpers', () => {
  it('shop is closed below MERCHANT_MIN_BALANCE and open at or above', () => {
    expect(merchantShopOpen(0)).toBe(false);
    expect(merchantShopOpen(MERCHANT_MIN_BALANCE - 1)).toBe(false);
    expect(merchantShopOpen(MERCHANT_MIN_BALANCE)).toBe(true);
    expect(merchantShopOpen(BigInt(MERCHANT_MIN_BALANCE) + 50n)).toBe(true);
  });

  it('invest-to-open is the shortfall to the minimum', () => {
    expect(merchantInvestToOpen(0)).toBe(MERCHANT_MIN_BALANCE);
    expect(merchantInvestToOpen(MERCHANT_MIN_BALANCE - 250)).toBe(250);
    expect(merchantInvestToOpen(MERCHANT_MIN_BALANCE)).toBe(0);
    expect(merchantInvestToOpen(String(MERCHANT_MIN_BALANCE + 10))).toBe(0);
  });

  it('restock supply payment pays the chain partner and caps at available', () => {
    expect(merchantRestockPayment('chef', 2, 10_000)).toEqual({
      from: 'chef',
      to: 'dealer',
      amount: 400,
      label: 'ingredients',
    });
    expect(merchantRestockPayment('chef', 10, 150)?.amount).toBe(150);
    expect(merchantRestockPayment('chef', 1, 0)).toBeNull();
  });

  it('city trade pays up to amountGd but never spends the open floor', () => {
    const edge = MERCHANT_CITY_TRADES.find(t => t.from === 'smith' && t.to === 'chef')!;
    expect(cityTradePayment(edge, MERCHANT_MIN_BALANCE + 500)).toEqual({
      from: 'smith',
      to: 'chef',
      amount: Math.min(edge.amountGd, 500),
      label: 'staff meals',
    });
    expect(cityTradePayment(edge, MERCHANT_MIN_BALANCE)).toBeNull();
    expect(cityTradePayment(edge, MERCHANT_MIN_BALANCE + 10)?.amount).toBe(10);
  });
});

describe('merchant city trades day sim', () => {
  it('triangle: each role sends and receives across a day', () => {
    const day = simulateMerchantCityDay(
      { chef: 50_000, smith: 50_000, dealer: 50_000 },
      { rounds: 12, seed: 42 },
    );
    expect(day.trades.length).toBeGreaterThan(6);
    const senders = new Set(day.trades.map(t => t.from));
    const receivers = new Set(day.trades.map(t => t.to));
    expect(senders).toEqual(new Set(['chef', 'smith', 'dealer']));
    expect(receivers).toEqual(new Set(['chef', 'smith', 'dealer']));
    for (const id of ['chef', 'smith', 'dealer'] as const) {
      expect(day.end[id]).toBeGreaterThanOrEqual(MERCHANT_MIN_BALANCE);
    }
  });

  it('city fast-forward embeds many NPC trades', () => {
    const r = simulateCityFastForward(24, 42);
    expect(r.npcTrades.rounds).toBe(MERCHANT_CITY_TRADES_PER_DAY);
    expect(r.npcTrades.trades.length).toBeGreaterThan(20);
  });
});

describe('chef quote', () => {
  it('at full stock with no demand quotes base price', () => {
    const q = quoteChefPrice({
      basePrice: zobo.basePrice,
      targetStock: zobo.targetStock,
      k: zobo.k,
      stock: zobo.targetStock,
      demandEma: 0,
    });
    expect(q.finalPrice).toBe(zobo.basePrice);
    expect(q.stockFactor).toBeCloseTo(1, 8);
    expect(q.demandFactor).toBe(1);
    expect(q.clamp).toBe('none');
  });

  it('raises stockFactor after a sale', () => {
    const after = applyChefSale(zobo.targetStock, 0);
    expect(after.stock).toBe(zobo.targetStock - 1);
    expect(after.demandEma).toBeCloseTo(CHEF_DEMAND_BUY, 8);
    const q = quoteChefPrice({
      basePrice: zobo.basePrice,
      targetStock: zobo.targetStock,
      k: zobo.k,
      stock: after.stock,
      demandEma: after.demandEma,
    });
    expect(q.stockFactor).toBeGreaterThan(1);
    expect(q.finalPrice).toBeGreaterThan(zobo.basePrice);
  });

  it('clamps to 0.5x and 3x', () => {
    const low = quoteChefPrice({
      basePrice: 1000,
      targetStock: 20,
      k: 1.25,
      stock: 200,
      demandEma: -0.9,
    });
    expect(low.clamp).toBe('low');
    expect(low.finalPrice).toBe(Math.round(1000 * CHEF_PRICE_MIN_MULT));

    const high = quoteChefPrice({
      basePrice: 1000,
      targetStock: 20,
      k: 1.25,
      stock: 1,
      demandEma: 5,
    });
    expect(high.clamp).toBe('high');
    expect(high.finalPrice).toBe(Math.round(1000 * CHEF_PRICE_MAX_MULT));
  });

  it('restocks toward target and decays demand', () => {
    const next = applyChefRestock(10, 0.5, 20, 100);
    expect(next.stock).toBeGreaterThan(10);
    expect(next.stock).toBeLessThanOrEqual(20);
    expect(next.demandEma).toBeLessThan(0.5);
  });
});

describe('city fast-forward', () => {
  it('same seed and hours returns the same payload twice', () => {
    const a = simulateCityFastForward(24, 7);
    const b = simulateCityFastForward(24, 7);
    expect(a).toEqual(b);
    expect(a.merchants.chef.timeline.length).toBeGreaterThan(0);
    expect(Object.keys(a.merchants.chef.ending)).toEqual(CHEF_FOOD.map(f => f.id));
    expect(Object.keys(a.merchants.smith.ending)).toEqual(SMITH_GEAR.map(f => f.id));
    expect(Object.keys(a.merchants.dealer.ending)).toEqual(DEALER_GOODS.map(f => f.id));
  });

  it('caps hours at 168', () => {
    const r = simulateCityFastForward(999, 1);
    expect(r.hours).toBe(CHEF_SIM_MAX_HOURS);
  });

  it('zero hours yields empty timelines and base ending prices', () => {
    const r = simulateCityFastForward(0, 3);
    expect(r.merchants.chef.timeline).toEqual([]);
    expect(r.merchants.smith.timeline).toEqual([]);
    expect(r.merchants.dealer.timeline).toEqual([]);
    expect(r.events).toEqual([]);
    for (const rule of CHEF_FOOD) {
      expect(r.merchants.chef.ending[rule.id]!.price).toBe(rule.basePrice);
      expect(r.merchants.chef.ending[rule.id]!.stock).toBe(rule.targetStock);
      expect(r.merchants.chef.ending[rule.id]!.demandEma).toBe(0);
    }
    for (const rule of SMITH_GEAR) {
      expect(r.merchants.smith.ending[rule.id]!.price).toBe(rule.basePrice);
      expect(r.merchants.smith.ending[rule.id]!.stock).toBe(rule.targetStock);
    }
    for (const rule of DEALER_GOODS) {
      expect(r.merchants.dealer.ending[rule.id]!.price).toBe(rule.basePrice);
      expect(r.merchants.dealer.ending[rule.id]!.stock).toBe(rule.targetStock);
    }
  });

  it('24h run produces at least one smith or dealer sale', () => {
    const r = simulateCityFastForward(24, 42);
    const smithOrDealer =
      r.merchants.smith.timeline.length + r.merchants.dealer.timeline.length;
    expect(smithOrDealer).toBeGreaterThan(0);
  });
});
