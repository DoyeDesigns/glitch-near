import { describe, expect, it } from 'vitest';
import { faucetCredit, tradeFee, tradePnl } from '../src/economy';

describe('trade pnl', () => {
  it('pays 20x the post-fee move', () => {
    // 1% up on 1000 GD: 1000 * 0.99 * 20 * 0.01 = 198
    expect(tradePnl(1000, 1, 100, 101)).toBe(198);
    expect(tradePnl(1000, -1, 100, 101)).toBe(-198);
  });

  it('caps a loss at the stake', () => {
    expect(tradePnl(1000, 1, 100, 1)).toBe(-1000);
    expect(tradePnl(5000, -1, 10, 1000)).toBe(-5000);
  });

  it('takes a 1% fee rounded down', () => {
    expect(tradeFee(1000)).toBe(10);
    expect(tradeFee(1999)).toBe(19);
  });

  it('applies the daily cap and the weak cut before minting', () => {
    const capped = faucetCredit(200, false, 150, 100);
    expect(capped.capped).toBe(true);
    // 50 at full rate, 150 over at 20% = 50 + 30
    expect(capped.credited).toBe(80);
    expect(capped.payUsed).toBe(150);

    const weak = faucetCredit(100, true, 150_000, 0);
    expect(weak.credited).toBe(60);
    expect(weak.capped).toBe(false);
  });
});
