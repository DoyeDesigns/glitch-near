import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@glitch/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/stream': { target: 'http://localhost:8787', changeOrigin: true },
      '/health': { target: 'http://localhost:8787', changeOrigin: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
      '/me': { target: 'http://localhost:8787', changeOrigin: true },
      '/leaderboard': { target: 'http://localhost:8787', changeOrigin: true },
      '/trade': { target: 'http://localhost:8787', changeOrigin: true },
      '/vault': { target: 'http://localhost:8787', changeOrigin: true },
      '/post': { target: 'http://localhost:8787', changeOrigin: true },
      '/shop': { target: 'http://localhost:8787', changeOrigin: true },
      '/market': { target: 'http://localhost:8787', changeOrigin: true },
      '/home': { target: 'http://localhost:8787', changeOrigin: true },
      '/rest': { target: 'http://localhost:8787', changeOrigin: true },
      '/forge': { target: 'http://localhost:8787', changeOrigin: true },
      '/merchants': { target: 'http://localhost:8787', changeOrigin: true },
      '/sim': { target: 'http://localhost:8787', changeOrigin: true },
      '/ads': { target: 'http://localhost:8787', changeOrigin: true },
      '/admin/health': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  plugins: [
    {
      name: 'extra-pages',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          rewriteExtraPages(req);
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, _res, next) => {
          rewriteExtraPages(req);
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        admin: path.resolve(import.meta.dirname, 'admin.html'),
        advertise: path.resolve(import.meta.dirname, 'advertise.html'),
      },
    },
  },
});

function rewriteExtraPages(req: { url?: string }): void {
  const q = req.url ?? '';
  const pathOnly = q.split('?')[0];
  const query = q.includes('?') ? q.slice(q.indexOf('?')) : '';
  if (pathOnly === '/admin' || pathOnly === '/admin/') {
    req.url = `/admin.html${query}`;
  } else if (pathOnly === '/advertise' || pathOnly === '/advertise/') {
    req.url = `/advertise.html${query}`;
  }
}
