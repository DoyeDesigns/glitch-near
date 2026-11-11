import { describe, expect, it } from 'vitest';
import { ciaFineGd, GAS_GD, holdingTaxCharge, UPKEEP_RATE } from '../src/economy';

describe('holdingTaxCharge', () => {
  it('returns 0 for zero ticks or non-positive available', () => {
    expect(holdingTaxCharge(60_000, 0)).toBe(0);
    expect(holdingTaxCharge(0, 5)).toBe(0);
    expect(holdingTaxCharge(-10, 5)).toBe(0);
  });

  it('charges floor(available * UPKEEP_RATE) per tick sequentially', () => {
    expect(holdingTaxCharge(60_000, 1)).toBe(Math.floor(60_000 * UPKEEP_RATE));
    // 60_000 → 6; then 59_994 → 5; …
    const two = holdingTaxCharge(60_000, 2);
    expect(two).toBe(Math.floor(60_000 * UPKEEP_RATE) + Math.floor((60_000 - 6) * UPKEEP_RATE));
  });

  it('never exceeds starting available', () => {
    expect(holdingTaxCharge(5, 1000)).toBeLessThanOrEqual(5);
    expect(holdingTaxCharge(1n, 100)).toBeLessThanOrEqual(1);
  });
});

describe('ciaFineGd', () => {
  it('uses min(available, floor(loot * 1.25))', () => {
    expect(ciaFineGd(10_000, 800)).toBe(Math.floor(800 * 1.25));
    expect(ciaFineGd(100, 800)).toBe(100);
    expect(ciaFineGd(0, 800)).toBe(0);
    expect(ciaFineGd(10_000n, 0)).toBe(0);
  });
});

describe('GAS_GD', () => {
  it('is 200', () => {
    expect(GAS_GD).toBe(200);
  });
});
