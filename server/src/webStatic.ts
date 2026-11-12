/**
 * Serve the built Vite app from the same process as the API.
 * Dev still uses Vite on :5173. Render and `npm start` use web/dist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo web/dist, independent of the process working directory. */
export const defaultWebDist = path.resolve(here, '../../web/dist');

/** Map a URL path to a file under web/dist. Leading slashes are stripped so path.join keeps the root. */
export function webFile(requestPath: string): string {
  const bare = requestPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (bare === '' || bare === 'index.html') return 'index.html';
  if (bare === 'admin') return 'admin.html';
  if (bare === 'advertise') return 'advertise.html';
  return requestPath.replace(/^\/+/, '');
}

export function mountWeb(app: Hono, root = defaultWebDist): void {
  if (!fs.existsSync(root)) {
    console.warn(`[web] no build at ${root} — API only`);
    return;
  }
  app.use(
    '*',
    serveStatic({
      root,
      rewriteRequestPath: (requestPath) => webFile(requestPath),
    }),
  );
  console.log(`[web] serving ${root}`);
}
