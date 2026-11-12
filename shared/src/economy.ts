/**
 * Shared economy constants (MVP GD-only).
 * Tuned from docs/ECONOMY.md proposals — applied values live here.
 */

import { clamp, mulberry32, randn, rnd, type Rng } from './rng';

/** Prototype swap desk rate (legacy `RATE`). Used only to convert old USDG prices. */
export const USDG_TO_GD = 500;

/** New player starting GD balance. Was 250_000. */
export const START_GD = 60_000;

/** Studio apartment purchase price (GD). Was 200_000. */
export const HOMEP_GD = 90_000;

/** Studio maintenance (GD per period). Was 15 USDG × 500 = 7_500. */
export const MAINTENANCE_GD = 1_000;

/** Maintenance period in ms (1 hour). Was 600_000 (10 min). */
export const MAINTENANCE_MS = 3_600_000;

/** @deprecated Use MAINTENANCE_GD */
export const RENT_GD = MAINTENANCE_GD;
/** @deprecated Use MAINTENANCE_MS */
export const RENT_MS = MAINTENANCE_MS;

/** Passive upkeep fraction of balance per tick. Was 0.0004 (0.04%). */
export const UPKEEP_RATE = 0.0001;

/** Seconds between upkeep ticks. */
export const UPKEEP_INTERVAL_S = 10;

/** Needs decay (per second). From the old client lifeUpdate. */
export const HUNGER_DECAY_PER_S = 0.2;
export const ENERGY_DECAY_PER_S = 0.25;
export const ENERGY_DECAY_STARVING_PER_S = 0.5;
/** At home (x > 100), energy drains at this fraction of the outdoor rate. */
export const ENERGY_HOME_MULT = 0.5;

/** Bench rest. */
export const BENCH_ENERGY = 25;
export const BENCH_HUNGER = -3;

/** Sleep at home (energy fills; hunger drops). */
export const SLEEP_ENERGY = 100;
export const SLEEP_HUNGER = -10;

export type NeedsState = { energy: number; hunger: number };

export function clampNeeds(needs: NeedsState): NeedsState {
  return {
    energy: clamp(needs.energy, 0, 100),
    hunger: clamp(needs.hunger, 0, 100),
  };
}

/**
 * Advance hunger and energy by elapsed seconds.
 * Starving (hunger at 0) drains energy faster. At home, energy drains slower.
 */
export function applyNeedsDecay(needs: NeedsState, elapsedSec: number, atHome: boolean): NeedsState {
  const dt = Math.max(0, elapsedSec);
  let hunger = needs.hunger - dt * HUNGER_DECAY_PER_S;
  const energyRate =
    (hunger <= 0 ? ENERGY_DECAY_STARVING_PER_S : ENERGY_DECAY_PER_S) * (atHome ? ENERGY_HOME_MULT : 1);
  let energy = needs.energy - dt * energyRate;
  return clampNeeds({ energy, hunger });
}

/** Apply a rest or sleep effect after decay. */
export function applyRestEffect(needs: NeedsState, kind: 'bench' | 'sleep'): NeedsState {
  if (kind === 'sleep') {
    return clampNeeds({ energy: SLEEP_ENERGY, hunger: needs.hunger + SLEEP_HUNGER });
  }
  return clampNeeds({
    energy: needs.energy + BENCH_ENERGY,
    hunger: needs.hunger + BENCH_HUNGER,
  });
}

/** @deprecated Unused — skill pay no longer has a daily cap. Kept for old imports. */
export const PAY_CAP_BASE = 150_000;
/** @deprecated Unused — skill pay no longer has a daily cap. Kept for old imports. */
export const PAY_CAP_PER_LEVEL = 25_000;

/** Fast-travel gas fee (GD). */
export const GAS_GD = 200;

/**
 * Total holding-tax GD for `ticks` intervals, applying floor(available * UPKEEP_RATE)
 * sequentially so later ticks see prior charges. Never exceeds starting available.
 */
export function holdingTaxCharge(availableGd: number | bigint, ticks: number): number {
  let available = typeof availableGd === 'bigint' ? Number(availableGd) : availableGd;
  if (!Number.isFinite(available) || available <= 0 || ticks <= 0) return 0;
  available = Math.floor(available);
  let total = 0;
  for (let i = 0; i < ticks; i++) {
    if (available <= 0) break;
    const charge = Math.min(Math.floor(available * UPKEEP_RATE), available);
    if (charge <= 0) break;
    total += charge;
    available -= charge;
  }
  return total;
}

/** Guilty CIA fine: min(available, floor(loot * 1.25)). */
export function ciaFineGd(availableGd: number | bigint, loot: number): number {
  const available = typeof availableGd === 'bigint' ? Number(availableGd) : availableGd;
  if (!Number.isFinite(available) || available <= 0) return 0;
  const raw = Math.floor(Math.max(0, loot) * 1.25);
  return Math.min(Math.floor(available), raw);
}

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

/** @deprecated Always Infinity — daily skill-pay cap removed. */
export function payCapFor(_xp: SkillXp): number {
  return Number.POSITIVE_INFINITY;
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
 * Flow added to the bet coin when the bet opens, in the bet's direction.
 * Was `stake / 2e6` (cap 0.5). A 100,000 GD bet moved its own price about
 * 0.13% in the bettor's favour and the mean pnl was positive, so the nudge is 0.
 */
export const TRADE_FLOW_PER_STAKE = 0;
export const TRADE_FLOW_CAP = 0.5;

export function applyFlow(token: { flow: number }, dir: 1 | -1, stake: number): void {
  token.flow += dir * Math.min(TRADE_FLOW_CAP, stake * TRADE_FLOW_PER_STAKE);
}

/**
 * Skill payout credit: weak (tired/hungry) cuts 40%. No daily meter or soft cap.
 * `cap` / `payUsed` are ignored (kept for call-site compatibility). `capped` is always false;
 * `payUsed` is left unchanged so DB columns stay inert.
 */
export function faucetCredit(
  amount: number,
  weak: boolean,
  _cap = 0,
  payUsed = 0,
): { credited: number; capped: boolean; payUsed: number } {
  let amt = amount;
  if (weak) amt *= 0.6;
  return { credited: Math.round(amt), capped: false, payUsed };
}

/** Vault Cracker. Widths shrink and the needle speeds up across the three locks. */
export const VAULT_WIDTHS = [0.24, 0.18, 0.13] as const;
export const VAULT_SPEEDS = [0.75, 1.0, 1.3] as const;
export const VAULT_HIT_GD = 15_000;
export const VAULT_PERFECT_GD = 30_000;
/** Needle sweep only. A stop is a hit when this look-back overlaps the zone. */
export const VAULT_TOLERANCE_MS = 150;
/** A stop may be this far ahead of the server clock. */
export const VAULT_MAX_SKEW_MS = 50;
/** A stop older than this is rejected. The sweep stays at 150 ms. */
export const VAULT_MAX_AGE_MS = 700;
/** Minimum gap between vault starts for one player. */
export const VAULT_START_GAP_MS = 8_000;
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

/** Attention Booth. Half the cost is burned, half is escrowed and settled against the payout. */
export const POST_COST = 10_000;
export const POST_BURN = 5_000;
export const POST_ESCROW = 5_000;
export const POST_PER_MIN = 6;
export const POST_XP = 14;
/** A player cannot post again until this long after their last post. */
export const POST_COOLDOWN_MS = 30_000;
/**
 * Added to every post's reach. Was 0.25 (hype mean about +4,259 GD at
 * community level 1). -0.282 brings that hype mean to about 0.
 */
export const POST_REACH_FLOOR = -0.282;

export type PostTake = 'hype' | 'warn' | 'meme';

/** How well this take fits the server mood and heat. */
export function postFit(take: PostTake, mood: number, heat: number): number {
  if (take === 'hype') return clamp(0.5 + mood * 0.5 - heat, 0, 1);
  if (take === 'warn') return clamp(0.3 + heat * 2 - mood * 0.3, 0, 1);
  return 0.45;
}

/**
 * Reach for one post. `luck` is `exp(randn * 0.6)` from the given rng.
 * Community level is the level before this post's XP.
 */
export function postReach(take: PostTake, mood: number, heat: number, commLevel: number, rng: Rng): number {
  const luck = Math.exp(randn(rng) * 0.6);
  return postFit(take, mood, heat) * luck * (1 + 0.1 * (commLevel - 1)) + POST_REACH_FLOOR;
}

/** GD the escrow half is settled against, before the daily faucet. */
export function postPay(reach: number): number {
  return POST_ESCROW * (0.5 + reach * 1.6);
}

/** Profit after the escrow half is released. Negative means part of the escrow is lost. */
export function postProfit(reach: number): number {
  return postPay(reach) - POST_ESCROW;
}

export function postFollowers(reach: number, commLevel: number): number {
  return Math.floor(reach * 40 * (1 + commLevel * 0.1));
}

export function postViral(reach: number): boolean {
  return reach > 1.5;
}
