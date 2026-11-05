import { serve } from '@hono/node-server';
import { config } from './config';
import './db';
import { createApp } from './routes';
import { startSimLoop } from './sim';

startSimLoop();

const app = createApp();

serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`[server] listening on http://localhost:${info.port}`);
  console.log(`[server] NEAR_NETWORK=${config.nearNetwork || '(unset)'}`);
});
