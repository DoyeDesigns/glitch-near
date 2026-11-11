import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const dbPath = path.join(os.tmpdir(), `glitch-vitest-${process.pid}.sqlite`);
process.env.DB_PATH = dbPath;
// Before any test imports config.ts (dotenv override: false preserves this over empty .env.local).
process.env.KEY_ENCRYPTION_SECRET ??= '0'.repeat(64);

export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000,
    env: {
      DB_PATH: dbPath,
      // Throwaway for encryptPrivateKey in tests; survives empty KEY_ENCRYPTION_SECRET= in .env.local (override: false).
      KEY_ENCRYPTION_SECRET: '0'.repeat(64),
    },
  },
});
