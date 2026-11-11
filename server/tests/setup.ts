import os from 'node:os';
import path from 'node:path';

process.env.CHAIN_MODE = process.env.CHAIN_MODE || 'mock';
process.env.DB_PATH = path.join(os.tmpdir(), `glitch-vitest-${process.pid}.sqlite`);
