import { serve } from '@hono/node-server';
import { config } from './config';
import './db';
import { installMockChain } from './near/mockLedger';
import { createApp } from './routes';
import { startSimLoop } from './sim';
import { resumePosts } from './post';
import { resumeTrades } from './trade';
import { resumeTransfers } from './near/gd';
import { resumeForges } from './forge';
import { resumeListingSales } from './listings';
import { resumePurchases } from './purchase';
import { ensureShardToken, resumeVaults } from './vault';

installMockChain();

startSimLoop();
resumeTrades();
resumeVaults();
resumePosts();
void resumeTransfers()
  .then(() => resumePurchases())
  .then(() => resumeListingSales())
  .then(() => resumeForges());
void ensureShardToken();

if (process.env.VITEST !== 'true') {
  void import('./merchantEconomy').then(({ runMerchantSupplyTick }) => {
    void import('@glitch/shared').then(({ MERCHANT_CITY_TRADE_INTERVAL_MS }) => {
      setInterval(() => {
        void runMerchantSupplyTick().catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[merchants] supply tick failed: ${msg.slice(0, 160)}`);
        });
      }, MERCHANT_CITY_TRADE_INTERVAL_MS);
    });
  });
}

const app = createApp();

serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`[server] listening on http://localhost:${info.port}`);
  console.log(`[server] CHAIN_MODE=${config.chainMode}`);
  console.log(`[server] NEAR_NETWORK=${config.nearNetwork || '(unset)'}`);
});
