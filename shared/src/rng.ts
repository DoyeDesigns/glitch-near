/** Seeded PRNG handle. `next()` returns [0, 1). State is serializable for snapshots. */
export interface Rng {
  state: number;
  next(): number;
}

/** Mulberry32 — small, fast, deterministic. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return {
    get state() {
      return state;
    },
    set state(s: number) {
      state = s >>> 0;
    },
    next() {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const rnd = (rng: Rng, a: number, b: number) => a + rng.next() * (b - a);

export const pick = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng.next() * a.length)]!;

/** Box–Muller normal using the given RNG (not Math.random). */
export const randn = (rng: Rng) => {
  let u = 0,
    v = 0;
  while (!u) u = rng.next();
  while (!v) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
