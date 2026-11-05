import { clamp, randn } from './rng';
import type { World } from './types';

/** One market tick over world.tokens / world.market (mutates world). */
export function tickMarket(world: World): void {
  const { tokens, market, rng } = world;
  let avg = 0;
  for (const t of tokens) {
    t.hype = clamp(t.hype + (t.base.hype - t.hype) * 0.012 + randn(rng) * 0.004, 0, 1);
    t.usage = clamp(t.usage + (t.base.usage - t.usage) * 0.008 + randn(rng) * 0.004, 0, 1);
    t.trust = clamp(t.trust + (t.base.trust - t.trust) * 0.006, 0, 1);
    t.flow *= 0.92;
    t.supply *= 0.985;
    const drift =
      0.9 * (t.hype - t.base.hype) +
      0.6 * (t.usage - t.base.usage) +
      1.1 * (t.trust - t.base.trust) +
      0.8 * t.flow -
      0.7 * t.supply +
      50 * t.vol * market.mood;
    const ret = clamp(drift * 0.0035 + randn(rng) * t.vol, -0.25, 0.25);
    t.price = Math.max(t.price * (1 + ret), 0.0001);
    t.hist.push(t.price);
    if (t.hist.length > 300) t.hist.shift();
    avg += ret;
  }
  market.mood = clamp(market.mood * 0.995 + (avg / tokens.length) * 6, -1, 1);
  market.heat = Math.max(0, market.heat - 0.0004);
}
