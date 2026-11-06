import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const dbPath = path.join(os.tmpdir(), `glitch-vitest-${process.pid}.sqlite`);
process.env.DB_PATH = dbPath;

export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000,
    env: {
      DB_PATH: dbPath,
    },
  },
});
