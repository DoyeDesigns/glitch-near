import { serve } from '@hono/node-server';
import { config } from './config';
import './db';
import { installMockChain } from './near/mockLedger';
import { ensureMerchantKeysFromEnv } from './near/merchants';
import { createApp } from './routes';
import { mountWeb } from './webStatic';
import { startSimLoop } from './sim';
import { resumePosts } from './post';
import { resumeTrades } from './trade';
import { resumeTransfers } from './near/gd';
import { resumeForges } from './forge';
import { resumeListingSales } from './listings';
import { resumePurchases } from './purchase';
import { ensureShardToken, resumeVaults } from './vault';

installMockChain();
// Before listen: Render often boots with empty SQLite while on-chain merchants still hold GD.
if (config.chainMode === 'testnet') {
  ensureMerchantKeysFromEnv();
}

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
      let supplyBusy = false;
      setInterval(() => {
        if (supplyBusy) return;
        supplyBusy = true;
        void runMerchantSupplyTick()
          .catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[merchants] supply tick failed: ${msg.slice(0, 160)}`);
          })
          .finally(() => {
            supplyBusy = false;
          });
      }, MERCHANT_CITY_TRADE_INTERVAL_MS);
    });
  });
}

const app = createApp();
mountWeb(app);

serve({ fetch: app.fetch, hostname: '0.0.0.0', port: config.port }, info => {
  console.log(`[server] listening on http://localhost:${info.port}`);
  console.log(`[server] CHAIN_MODE=${config.chainMode}`);
  console.log(`[server] NEAR_NETWORK=${config.nearNetwork || '(unset)'}`);
  // Warm merchant GD cache so the first diner/forge open is not a cold RPC wait.
  if (config.chainMode === 'testnet') {
    void import('./near/gd').then(({ getGDBalanceCached }) =>
      import('./near/merchants').then(({ MERCHANT_IDS, getMerchant, merchantAccountId }) => {
        for (const id of MERCHANT_IDS) {
          const accountId = getMerchant(id)?.account_id ?? merchantAccountId(id);
          void getGDBalanceCached(accountId).catch(() => {});
        }
      }),
    );
  }
});
