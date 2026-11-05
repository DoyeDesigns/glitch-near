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
      '/admin/health': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  plugins: [
    {
      name: 'admin-page',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          rewriteAdmin(req);
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, _res, next) => {
          rewriteAdmin(req);
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
      },
    },
  },
});

function rewriteAdmin(req: { url?: string }): void {
  const q = req.url ?? '';
  const pathOnly = q.split('?')[0];
  if (pathOnly === '/admin' || pathOnly === '/admin/') {
    const query = q.includes('?') ? q.slice(q.indexOf('?')) : '';
    req.url = `/admin.html${query}`;
  }
}
