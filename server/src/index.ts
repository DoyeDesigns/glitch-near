import { serve } from '@hono/node-server';
import { config } from './config';
import './db';
import { createApp } from './routes';
import { startSimLoop } from './sim';
import { resumePosts } from './post';
import { resumeTrades } from './trade';
import { resumeTransfers } from './near/gd';
import { ensureShardToken, resumeVaults } from './vault';

startSimLoop();
resumeTrades();
resumeVaults();
resumePosts();
void resumeTransfers();
void ensureShardToken();

const app = createApp();

serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`[server] listening on http://localhost:${info.port}`);
  console.log(`[server] NEAR_NETWORK=${config.nearNetwork || '(unset)'}`);
});
