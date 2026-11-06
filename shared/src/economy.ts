/**
 * Shared economy constants (MVP GD-only).
 * Tuned from docs/ECONOMY.md proposals — applied values live here.
 */

import { mulberry32, rnd } from './rng';

/** Prototype swap desk rate (legacy `RATE`). Used only to convert old USDG prices. */
export const USDG_TO_GD = 500;

/** New player starting GD balance. Was 250_000. */
export const START_GD = 60_000;

/** Studio apartment purchase price (GD). Was 200_000. */
export const HOMEP_GD = 90_000;

/** Studio rent (GD per period). Was 15 USDG × 500 = 7_500. */
export const RENT_GD = 1_000;

/** Rent period in ms (1 hour). Was 600_000 (10 min). */
export const RENT_MS = 3_600_000;

/** Passive upkeep fraction of balance per tick. Was 0.0004 (0.04%). */
export const UPKEEP_RATE = 0.0001;

/** Seconds between upkeep ticks. */
export const UPKEEP_INTERVAL_S = 10;

/** Daily skill-pay cap: BASE + PER_LEVEL * (sumLevels - 3). */
export const PAY_CAP_BASE = 150_000;
export const PAY_CAP_PER_LEVEL = 25_000;

/** Fast-travel gas fee (GD). */
export const GAS_GD = 200;

/** Furniture price overrides applied from ECONOMY.md (others stay prototype). */
export const FURN_PRICE_GD: Record<string, number> = {
  bed2: 70_000, // was 150_000
  trophy: 60_000, // was 120_000
};

/** 10-second up/down bet. */
export const TRADE_MIN_STAKE = 1_000;
export const TRADE_MAX_STAKE = 100_000;
export const TRADE_SECS = 10;
export const TRADE_OPENS_PER_MIN = 6;

export type SkillXp = { trade: number; sec: number; comm: number };

/** Skill level from XP. Same curve the client HUD uses. */
export const skillLevel = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 40));

export function payCapFor(xp: SkillXp): number {
  const sum = skillLevel(xp.trade) + skillLevel(xp.sec) + skillLevel(xp.comm);
  return PAY_CAP_BASE + PAY_CAP_PER_LEVEL * (sum - 3);
}

/** 1% of the stake, nearest GD. */
export function tradeFee(stake: number): number {
  return Math.round(stake * 0.01);
}

/**
 * 10s bet result in GD.
 * pnl = round(max(-stake, stake * 0.99 * 20 * dir * (price / p0 - 1))).
 */
export function tradePnl(stake: number, dir: 1 | -1, p0: number, price: number): number {
  if (!(p0 > 0)) return 0;
  const raw = stake * 0.99 * 20 * dir * (price / p0 - 1);
  return Math.round(Math.max(-stake, raw));
}

/**
 * Daily faucet: weak cuts 40%, then the cap, then 20% of the overflow.
 * `payUsed` grows by the full-rate portion only (same as the client earn()).
 */
export function faucetCredit(
  amount: number,
  weak: boolean,
  cap: number,
  payUsed: number,
): { credited: number; capped: boolean; payUsed: number } {
  let amt = amount;
  if (weak) amt *= 0.6;
  const room = Math.max(0, cap - payUsed);
  const full = Math.min(amt, room);
  const over = amt - full;
  const credited = Math.round(full + over * 0.2);
  return { credited, capped: over > 0, payUsed: payUsed + full };
}

/** Vault Cracker. Widths shrink and the needle speeds up across the three locks. */
export const VAULT_WIDTHS = [0.24, 0.18, 0.13] as const;
export const VAULT_SPEEDS = [0.75, 1.0, 1.3] as const;
export const VAULT_HIT_GD = 15_000;
export const VAULT_PERFECT_GD = 30_000;
export const VAULT_TOLERANCE_MS = 150;
export const VAULT_PAUSE_MS = 600;

export type VaultLock = { zoneStart: number; zoneWidth: number; speed: number };

/** Three locks from a mulberry32 seed. Zone start is in [0.08, 0.92 - width]. */
export function vaultLocks(seed: number): VaultLock[] {
  const rng = mulberry32(seed >>> 0);
  return VAULT_WIDTHS.map((zoneWidth, i) => ({
    zoneWidth,
    speed: VAULT_SPEEDS[i]!,
    zoneStart: rnd(rng, 0.08, 0.92 - zoneWidth),
  }));
}

/**
 * Needle position in [0, 1]. Ping-pong: phase `(speed * elapsedMs / 1000) mod 2`,
 * then `phase` going right and `2 - phase` going back.
 */
export function vaultNeedle(elapsedMs: number, speed: number): number {
  const phase = ((speed * Math.max(0, elapsedMs)) / 1000) % 2;
  return phase <= 1 ? phase : 2 - phase;
}

/** Elapsed ms from the round start when lock `index` begins. Lock 0 starts at 0. */
export function vaultLockStart(stops: readonly number[], index: number): number {
  if (index <= 0) return 0;
  return stops[index - 1]! + VAULT_PAUSE_MS;
}

/** Positions the needle covers from t0 to t1. A short window crosses at most one end. */
function vaultSweep(t0: number, t1: number, speed: number): { lo: number; hi: number } {
  const a = Math.max(0, Math.min(t0, t1));
  const b = Math.max(0, Math.max(t0, t1));
  const p0 = vaultNeedle(a, speed);
  const p1 = vaultNeedle(b, speed);
  const dist = (speed * (b - a)) / 1000;
  const span = Math.abs(p1 - p0);
  if (dist <= span + 1e-9) return { lo: Math.min(p0, p1), hi: Math.max(p0, p1) };
  const phase0 = ((speed * a) / 1000) % 2;
  if (phase0 <= 1) return { lo: Math.min(p0, p1), hi: 1 };
  return { lo: 0, hi: Math.max(p0, p1) };
}

/** True when the 150 ms look-back overlaps the green zone. */
export function vaultHit(
  elapsedMs: number,
  zoneStart: number,
  zoneWidth: number,
  speed: number,
  toleranceMs = VAULT_TOLERANCE_MS,
): boolean {
  const { lo, hi } = vaultSweep(elapsedMs - toleranceMs, elapsedMs, speed);
  return hi >= zoneStart && lo <= zoneStart + zoneWidth;
}

/** GD before the daily cap and the weak cut. */
export function vaultGross(hits: number): number {
  return hits * VAULT_HIT_GD + (hits === 3 ? VAULT_PERFECT_GD : 0);
}

/** Shards minted on the items contract. Not a SQLite balance. */
export function vaultShards(hits: number): number {
  return hits + (hits === 3 ? 1 : 0);
}

/** Security XP for a finished vault. Same as the old client: 8 + 6 per hit. */
export function vaultXp(hits: number): number {
  return 8 + hits * 6;
}
