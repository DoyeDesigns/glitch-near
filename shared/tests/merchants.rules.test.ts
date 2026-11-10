import { describe, expect, it } from 'vitest';
import {
  applyChefRestock,
  applyChefSale,
  CHEF_DEMAND_BUY,
  CHEF_FOOD,
  CHEF_PRICE_MAX_MULT,
  CHEF_PRICE_MIN_MULT,
  quoteChefPrice,
} from '../src/merchants.rules';

const zobo = CHEF_FOOD.find(r => r.id === 'zobo-drink')!;

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
