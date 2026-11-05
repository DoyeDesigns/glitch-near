import { randn, type Rng } from './rng';
import type { Token } from './types';

export const TOKEN_DEFS: ReadonlyArray<Omit<Token, 'hype' | 'usage' | 'trust' | 'flow' | 'supply' | 'hist'>> = [
  { sym: 'BTX', name: 'Bitcrumb', price: 42000, vol: 0.0022, base: { hype: 0.35, usage: 0.8, trust: 0.9 } },
  { sym: 'ETHR', name: 'Ethereal', price: 3100, vol: 0.0035, base: { hype: 0.45, usage: 0.75, trust: 0.8 } },
  { sym: 'PIZZ', name: 'PizzaDay', price: 10, vol: 0.006, base: { hype: 0.5, usage: 0.3, trust: 0.6 } },
  { sym: 'MOON', name: 'MoonBoy', price: 0.42, vol: 0.01, base: { hype: 0.55, usage: 0.15, trust: 0.45 } },
  { sym: 'FARM', name: 'YieldFarm', price: 7.8, vol: 0.007, base: { hype: 0.45, usage: 0.6, trust: 0.65 } },
];

export function createTokens(rng: Rng): Token[] {
  return TOKEN_DEFS.map(d => {
    const t: Token = {
      ...d,
      base: { ...d.base },
      hype: d.base.hype,
      usage: d.base.usage,
      trust: d.base.trust,
      flow: 0,
      supply: 0,
      hist: [],
    };
    for (let i = 0; i < 120; i++) t.hist.push(t.price * (1 + randn(rng) * 0.004));
    return t;
  });
}

export const chg = (t: Token, n = 60) => t.price / t.hist[Math.max(0, t.hist.length - 1 - n)]! - 1;
