import { config } from './config';
import {
  getCurrentAdResolved,
  getMarketConfigResolved,
  getPriceResolved,
  normalizeBooking,
  type MarketBooking,
} from './near/market';

export const ADS_CACHE_MS = 15_000;
export const CREATIVE_MAX_BYTES = 1 * 1024 * 1024;

export type AdsSlotView = {
  slotId: number;
  ad: {
    advertiser: string;
    projectName: string;
    creativeUrl: string;
    startNs: string;
    endNs: string;
    paid: string;
  } | null;
  price1Unit: string;
};

export type AdsPayload = {
  marketContract: string;
  slotCount: number;
  unitMs: string;
  maxUnits: number;
  basePrice: string;
  slots: AdsSlotView[];
  fetchedAt: number;
};

let cache: { until: number; payload: AdsPayload } | null = null;

/** True only for https:// creatives (contract rule + proxy safety). */
export function isHttpsCreative(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeAd(raw: MarketBooking | null): ReturnType<typeof normalizeBooking> {
  const ad = normalizeBooking(raw);
  if (!ad) return null;
  if (!isHttpsCreative(ad.creativeUrl)) return null;
  return ad;
}

export async function buildAdsSnapshot(now = Date.now()): Promise<AdsPayload> {
  const cfg = await getMarketConfigResolved();
  const slotCount = Number(cfg.slot_count) || 0;
  const slots: AdsSlotView[] = [];
  for (let slotId = 0; slotId < slotCount; slotId++) {
    const [rawAd, price] = await Promise.all([
      getCurrentAdResolved(slotId),
      getPriceResolved(slotId, 1),
    ]);
    slots.push({
      slotId,
      ad: sanitizeAd(rawAd),
      price1Unit: price.toString(),
    });
  }
  return {
    marketContract: config.marketContract,
    slotCount,
    unitMs: typeof cfg.unit_ms === 'string' ? cfg.unit_ms : String(cfg.unit_ms?.[0] ?? '0'),
    maxUnits: cfg.max_units,
    basePrice:
      typeof cfg.base_price === 'string'
        ? cfg.base_price
        : String(cfg.base_price?.[0] ?? '0'),
    slots,
    fetchedAt: now,
  };
}

/** Cached GET /ads payload; refreshes about every 15s. */
export async function getAdsPayload(now = Date.now()): Promise<AdsPayload> {
  if (cache && now < cache.until) return cache.payload;
  const payload = await buildAdsSnapshot(now);
  cache = { until: now + ADS_CACHE_MS, payload };
  return payload;
}

export function clearAdsCacheForTests(): void {
  cache = null;
}

export type CreativeProxyResult =
  | { ok: true; body: Uint8Array; contentType: string }
  | { ok: false; status: number; error: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let creativeFetch: FetchLike = globalThis.fetch.bind(globalThis);

/** Test seam for the creative proxy. */
export function setCreativeFetchForTests(fn: FetchLike | null): void {
  creativeFetch = fn ?? globalThis.fetch.bind(globalThis);
}

/**
 * Proxy an https image for billboards. Rejects non-https and bodies over 1 MiB.
 */
export async function proxyCreative(url: string): Promise<CreativeProxyResult> {
  if (!isHttpsCreative(url)) {
    return { ok: false, status: 400, error: 'Creative must be https' };
  }
  let res: Response;
  try {
    res = await creativeFetch(url, {
      redirect: 'follow',
      headers: { accept: 'image/*' },
    });
  } catch {
    return { ok: false, status: 502, error: 'Could not fetch creative' };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: `Upstream ${res.status}` };
  }
  const contentType = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    return { ok: false, status: 400, error: 'Not an image' };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > CREATIVE_MAX_BYTES) {
    return { ok: false, status: 400, error: 'Image too large' };
  }
  return { ok: true, body: buf, contentType };
}
