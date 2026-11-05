import { mulberry32, rnd } from './rng';
import { tickMarket } from './market';
import { resolveCases, runEvent } from './events';
import { createTokens } from './tokens';
import type { World, WorldSnapshot } from './types';

export function createWorld(seed: number): World {
  const rng = mulberry32(seed);
  return {
    seed: seed >>> 0,
    rng,
    time: 0,
    marketAcc: 0,
    nextEv: 14,
    tokens: createTokens(rng),
    market: { mood: 0, heat: 0 },
    cases: [],
    caseNo: 200,
    feed: [],
    effects: [],
  };
}

/**
 * Advance the simulation by `dtSeconds`.
 * Runs 0.5s market ticks, scheduled events, and case resolution.
 * Appends presentation effects to `world.effects` (host should drain).
 */
export function stepWorld(world: World, dtSeconds: number): void {
  const dt = Math.max(0, dtSeconds);
  world.time += dt;
  world.marketAcc += dt;
  while (world.marketAcc >= 0.5) {
    world.marketAcc -= 0.5;
    tickMarket(world);
  }
  world.nextEv -= dt;
  if (world.nextEv <= 0) {
    runEvent(world);
    world.nextEv = rnd(world.rng, 32, 58);
  }
  resolveCases(world);
}

/** Deep, JSON-friendly snapshot for equality tests (excludes live rng object / effects). */
export function snapshot(world: World): WorldSnapshot {
  return {
    seed: world.seed,
    rngState: world.rng.state,
    time: world.time,
    marketAcc: world.marketAcc,
    nextEv: world.nextEv,
    market: { mood: world.market.mood, heat: world.market.heat },
    tokens: world.tokens.map(t => ({
      sym: t.sym,
      name: t.name,
      price: t.price,
      vol: t.vol,
      base: { ...t.base },
      hype: t.hype,
      usage: t.usage,
      trust: t.trust,
      flow: t.flow,
      supply: t.supply,
      hist: t.hist.slice(),
    })),
    cases: world.cases.map(c => ({ ...c })),
    caseNo: world.caseNo,
    feed: world.feed.map(f => ({ ...f })),
  };
}
