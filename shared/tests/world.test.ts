import { describe, expect, it } from 'vitest';
import { createWorld, snapshot, stepWorld } from '../src/index';

describe('World determinism', () => {
  it('same seed gives identical results after 1000 steps', () => {
    const a = createWorld(42);
    const b = createWorld(42);
    for (let i = 0; i < 1000; i++) {
      stepWorld(a, 0.5);
      stepWorld(b, 0.5);
    }
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('same seed is identical across independent runs', () => {
    const run = () => {
      const w = createWorld(123456);
      for (let i = 0; i < 1000; i++) stepWorld(w, 1 / 3);
      return snapshot(w);
    };
    expect(run()).toEqual(run());
  });

  it('different seeds diverge', () => {
    const a = createWorld(1);
    const b = createWorld(2);
    for (let i = 0; i < 1000; i++) {
      stepWorld(a, 0.5);
      stepWorld(b, 0.5);
    }
    expect(snapshot(a)).not.toEqual(snapshot(b));
  });

  it('createWorld initializes tokens and market', () => {
    const w = createWorld(7);
    expect(w.tokens).toHaveLength(5);
    expect(w.tokens[0]!.sym).toBe('BTX');
    expect(w.tokens[0]!.hist.length).toBe(120);
    expect(w.market).toEqual({ mood: 0, heat: 0 });
    expect(w.caseNo).toBe(200);
    expect(w.nextEv).toBe(14);
  });
});
