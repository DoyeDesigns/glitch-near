/**
 * Shared economy constants (MVP GD-only).
 * Tuned from docs/ECONOMY.md proposals — applied values live here.
 */

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
