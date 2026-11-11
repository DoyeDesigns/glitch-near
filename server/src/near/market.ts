import { config, requireNearConfig } from '../config';
import { getProvider, parseU128 } from './client';
import { withChainRetry } from './retry';

function requireMarketContract(): string {
  requireNearConfig();
  if (!config.marketContract) throw new Error('MARKET_CONTRACT not set');
  return config.marketContract;
}

export type MarketBooking = {
  advertiser: string;
  project_name: string;
  creative_url: string;
  start_ns: string | { 0: string };
  end_ns: string | { 0: string };
  paid: string | { 0: string };
};

export type MarketConfig = {
  owner: string;
  treasury: string;
  unit_ms: string | { 0: string };
  max_units: number;
  max_horizon_units: number;
  base_price: string | { 0: string };
  slot_count: number;
  attention_bps: number;
  cycle_cooldown_ms: string | { 0: string };
  cycle_max_ms: string | { 0: string };
};

function nsString(v: string | { 0: string } | undefined): string {
  if (v == null) return '0';
  if (typeof v === 'string') return v;
  return String(v[0] ?? '0');
}

export function normalizeBooking(raw: MarketBooking | null | undefined): {
  advertiser: string;
  projectName: string;
  creativeUrl: string;
  startNs: string;
  endNs: string;
  paid: string;
} | null {
  if (!raw) return null;
  return {
    advertiser: raw.advertiser,
    projectName: raw.project_name,
    creativeUrl: raw.creative_url,
    startNs: nsString(raw.start_ns),
    endNs: nsString(raw.end_ns),
    paid: parseU128(raw.paid).toString(),
  };
}

export async function getMarketConfig(): Promise<MarketConfig> {
  const contractId = requireMarketContract();
  const raw = await withChainRetry(
    () =>
      getProvider().callFunction<MarketConfig>({
        contractId,
        method: 'get_config',
        args: {},
      }),
    { idempotent: true, label: 'market.get_config' },
  );
  if (!raw) throw new Error('market.get_config returned empty');
  return raw;
}

export async function getCurrentAd(slotId: number): Promise<MarketBooking | null> {
  const contractId = requireMarketContract();
  const raw = await withChainRetry(
    () =>
      getProvider().callFunction<MarketBooking>({
        contractId,
        method: 'get_current_ad',
        args: { slot_id: slotId },
      }),
    { idempotent: true, label: 'market.get_current_ad', account: String(slotId) },
  );
  return raw ?? null;
}

export async function getQueue(slotId: number): Promise<MarketBooking[]> {
  const contractId = requireMarketContract();
  const raw = await withChainRetry(
    () =>
      getProvider().callFunction<MarketBooking[]>({
        contractId,
        method: 'get_queue',
        args: { slot_id: slotId },
      }),
    { idempotent: true, label: 'market.get_queue', account: String(slotId) },
  );
  return raw ?? [];
}

export async function getPrice(slotId: number, units: number): Promise<bigint> {
  const contractId = requireMarketContract();
  const raw = await withChainRetry(
    () =>
      getProvider().callFunction<string | number | object>({
        contractId,
        method: 'get_price',
        args: { slot_id: slotId, units },
      }),
    { idempotent: true, label: 'market.get_price', account: String(slotId) },
  );
  return parseU128(raw);
}

/** Test seam for ads snapshot. */
let marketViewsForTests: {
  config?: () => Promise<MarketConfig>;
  currentAd?: (slotId: number) => Promise<MarketBooking | null>;
  price?: (slotId: number, units: number) => Promise<bigint>;
} | null = null;

export function setMarketViewsForTests(
  hooks: typeof marketViewsForTests,
): void {
  marketViewsForTests = hooks;
}

export async function getMarketConfigResolved(): Promise<MarketConfig> {
  if (marketViewsForTests?.config) return marketViewsForTests.config();
  return getMarketConfig();
}

export async function getCurrentAdResolved(slotId: number): Promise<MarketBooking | null> {
  if (marketViewsForTests?.currentAd) return marketViewsForTests.currentAd(slotId);
  return getCurrentAd(slotId);
}

export async function getPriceResolved(slotId: number, units: number): Promise<bigint> {
  if (marketViewsForTests?.price) return marketViewsForTests.price(slotId, units);
  return getPrice(slotId, units);
}
