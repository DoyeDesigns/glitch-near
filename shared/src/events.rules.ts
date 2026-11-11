/**
 * Pressure-driven market events. Euphoria (hype posts) and leverage (large bets)
 * raise the chance of a pump or rugPull. mulberry32 / Rng only.
 */
import { clamp, pick, type Rng } from './rng';
import type { EventArchetype, Pressures, Token } from './types';

export type { EventArchetype, Pressures, EventStage } from './types';

export const EUPHORIA_POST_BUMP = 0.28;
export const LEVERAGE_LARGE_BUMP = 0.22;
export const LARGE_STAKE_GD = 25_000;
export const PRESSURE_DECAY_PER_S = 0.004;
export const EVENT_COOLDOWN_S = 90;
export const RUMOR_LEAD_S = 25;
export const EVENT_CHECK_S = 8;
export const P_PUMP_BASE = 0.02;
export const P_RUG_BASE = 0.02;
export const P_PUMP_PER_EUPHORIA = 0.55;
export const P_RUG_PER_LEVERAGE = 0.55;

export function clampPressure(v: number): number {
  return clamp(v, 0, 1);
}

export function decayPressures(euphoria: number, leverage: number, dt: number): Pressures {
  if (dt <= 0) return { euphoria: clampPressure(euphoria), leverage: clampPressure(leverage) };
  const decay = Math.exp(-PRESSURE_DECAY_PER_S * dt);
  return {
    euphoria: clampPressure(euphoria * decay),
    leverage: clampPressure(leverage * decay),
  };
}

export function bumpEuphoria(euphoria: number, amount = EUPHORIA_POST_BUMP): number {
  return clampPressure(euphoria + amount);
}

export function bumpLeverage(leverage: number, amount = LEVERAGE_LARGE_BUMP): number {
  return clampPressure(leverage + amount);
}

/** Heavy-tailed severity in [0.1, 1]. */
export function drawSeverity(rng: Rng): number {
  return clamp(0.1 / (0.1 + rng.next()), 0.1, 1);
}

export function pumpChance(euphoria: number): number {
  const e = clampPressure(euphoria);
  return clamp(P_PUMP_BASE + P_PUMP_PER_EUPHORIA * e * e, 0, 1);
}

export function rugChance(leverage: number): number {
  const L = clampPressure(leverage);
  return clamp(P_RUG_BASE + P_RUG_PER_LEVERAGE * L * L, 0, 1);
}

/**
 * Independent rolls for pump and rug. If both hit, higher pressure wins; tie → rng.
 */
export function rollArchetype(
  rng: Rng,
  euphoria: number,
  leverage: number,
): EventArchetype | null {
  const hitPump = rng.next() < pumpChance(euphoria);
  const hitRug = rng.next() < rugChance(leverage);
  if (hitPump && hitRug) {
    if (euphoria > leverage) return 'pump';
    if (leverage > euphoria) return 'rugPull';
    return rng.next() < 0.5 ? 'pump' : 'rugPull';
  }
  if (hitPump) return 'pump';
  if (hitRug) return 'rugPull';
  return null;
}

const PUMP_RUMORS = [
  (sym: string, name: string) => `Whispers on the timeline: ${sym} (${name}) might rip.`,
  (sym: string, name: string) => `Insider chatter: bags stacking ${sym}. ${name} looking spicy.`,
  (sym: string) => `Rumor mill: a whale just screenshotted ${sym} charts.`,
] as const;

const RUG_RUMORS = [
  (sym: string, name: string) => `Uneasy chatter: ${sym} (${name}) liquidity looks thin.`,
  (sym: string) => `Anon claims the ${sym} team is moving funds. Unconfirmed.`,
  (sym: string, name: string) => `CIA tip line lighting up about ${name} (${sym}).`,
] as const;

export function rumorForArchetype(
  rng: Rng,
  archetype: EventArchetype,
  tokens: Token[],
): { rumor: string; sym: string } {
  if (archetype === 'rugPull') {
    const t = tokens[3] ?? tokens[0]!;
    const tmpl = pick(rng, [...RUG_RUMORS]);
    return { rumor: tmpl(t.sym, t.name), sym: t.sym };
  }
  const memes = tokens.filter(t => t.sym !== 'BTX');
  const t = pick(rng, memes.length ? memes : tokens);
  const tmpl = pick(rng, [...PUMP_RUMORS]);
  return { rumor: tmpl(t.sym, t.name), sym: t.sym };
}
