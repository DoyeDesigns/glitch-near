import { describe, expect, it } from 'vitest';
import {
  bumpEuphoria,
  createWorld,
  drawSeverity,
  EVENT_COOLDOWN_S,
  mulberry32,
  pumpChance,
  rollArchetype,
  RUMOR_LEAD_S,
  rugChance,
  snapshot,
  stepWorld,
} from '../src/index';

describe('events.rules', () => {
  it('clamps severity to [0.1, 1]', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const s = drawSeverity(rng);
      expect(s).toBeGreaterThanOrEqual(0.1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('raises rug chance with leverage vs zero', () => {
    expect(rugChance(0.8)).toBeGreaterThan(rugChance(0));
    expect(pumpChance(0.8)).toBeGreaterThan(pumpChance(0));
  });

  it('rollArchetype prefers pump when euphoria is high and leverage is zero', () => {
    let pump = 0;
    let rug = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const hit = rollArchetype(mulberry32(seed), 1, 0);
      if (hit === 'pump') pump += 1;
      if (hit === 'rugPull') rug += 1;
    }
    expect(pump).toBeGreaterThan(80);
    expect(pump).toBeGreaterThan(rug * 5);
  });
});

describe('pressure schedule', () => {
  it('hype bump then minutes of sim yields rumor then pump; same seed matches', () => {
    const run = () => {
      const w = createWorld(4242);
      w.pressures.euphoria = bumpEuphoria(0, 1); // max pressure so a pump is likely
      w.eventCheckIn = 0;
      const prices0 = w.tokens.map(t => t.price);
      let sawRumor = false;
      let sawPumpBanner = false;
      // ~4 minutes of 0.5s steps
      for (let i = 0; i < 480; i++) {
        stepWorld(w, 0.5);
        if (w.feed.some(f => f.who === 'RUMOR')) sawRumor = true;
        if (w.effects.some(e => e.kind === 'banner' && e.text.includes('pumping'))) sawPumpBanner = true;
        if (sawRumor && sawPumpBanner) break;
      }
      expect(sawRumor).toBe(true);
      expect(sawPumpBanner).toBe(true);
      const moved = w.tokens.some((t, i) => t.price !== prices0[i]! || t.hype > 0.01 || t.flow !== 0);
      expect(moved).toBe(true);
      return snapshot(w);
    };
    expect(run()).toEqual(run());
  });

  it('respects cooldown after a fired event', () => {
    const w = createWorld(7);
    w.pressures.euphoria = 1;
    w.eventCheckIn = 0;
    // Force a rumor stage directly then fire
    w.eventStage = {
      archetype: 'pump',
      phase: 'rumor',
      severity: 0.5,
      rumor: 'test',
      fireAt: w.time,
      sym: 'TEST',
    };
    stepWorld(w, 0.5);
    expect(w.eventStage).toBeNull();
    expect(w.eventCooldownUntil).toBeGreaterThan(w.time);
    const until = w.eventCooldownUntil;
    w.pressures.euphoria = 1;
    w.eventCheckIn = 0;
    // Step until just before cooldown ends — should not start a new rumor
    while (w.time + 0.5 < until) {
      stepWorld(w, 0.5);
    }
    expect(w.eventStage).toBeNull();
    expect(w.eventCooldownUntil).toBe(until);
    expect(EVENT_COOLDOWN_S).toBe(90);
    expect(RUMOR_LEAD_S).toBe(25);
  });
});
