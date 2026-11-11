import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAdsSnapshot,
  clearAdsCacheForTests,
  CREATIVE_MAX_BYTES,
  isHttpsCreative,
  proxyCreative,
  setCreativeFetchForTests,
} from '../src/ads';
import { setMarketViewsForTests } from '../src/near/market';
import { config } from '../src/config';

describe('ads https guards', () => {
  afterEach(() => {
    setMarketViewsForTests(null);
    setCreativeFetchForTests(null);
    clearAdsCacheForTests();
  });

  it('isHttpsCreative accepts only https URLs', () => {
    expect(isHttpsCreative('https://cdn.example/a.png')).toBe(true);
    expect(isHttpsCreative('http://cdn.example/a.png')).toBe(false);
    expect(isHttpsCreative('ftp://x')).toBe(false);
    expect(isHttpsCreative('')).toBe(false);
  });

  it('snapshot drops non-https creatives', async () => {
    setMarketViewsForTests({
      config: async () =>
        ({
          owner: 'o',
          treasury: 't',
          unit_ms: '60000',
          max_units: 10,
          max_horizon_units: 100,
          base_price: '1000',
          slot_count: 2,
          attention_bps: 10000,
          cycle_cooldown_ms: '0',
          cycle_max_ms: '0',
        }) as never,
      currentAd: async slotId =>
        slotId === 0
          ? {
              advertiser: 'a.test',
              project_name: 'Bad',
              creative_url: 'http://insecure.example/x.png',
              start_ns: '1',
              end_ns: '2',
              paid: '1',
            }
          : {
              advertiser: 'b.test',
              project_name: 'Good',
              creative_url: 'https://cdn.example/ok.png',
              start_ns: '1',
              end_ns: '2',
              paid: '1',
            },
      price: async () => 10n ** 24n,
    });
    const snap = await buildAdsSnapshot();
    expect(snap.slotCount).toBe(2);
    expect(snap.slots[0]!.ad).toBeNull();
    expect(snap.slots[1]!.ad?.projectName).toBe('Good');
    expect(snap.slots[1]!.ad?.creativeUrl).toBe('https://cdn.example/ok.png');
    expect(snap.marketContract).toBe(config.marketContract);
  });

  it('proxy rejects http and oversized images', async () => {
    const http = await proxyCreative('http://evil.example/a.png');
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.error).toMatch(/https/i);

    setCreativeFetchForTests(async () => {
      const body = new Uint8Array(CREATIVE_MAX_BYTES + 1);
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const big = await proxyCreative('https://cdn.example/big.png');
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/large/i);

    setCreativeFetchForTests(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    const ok = await proxyCreative('https://cdn.example/ok.png');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.contentType).toBe('image/png');
      expect(ok.body.length).toBe(3);
    }
  });
});
