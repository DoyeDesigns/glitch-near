import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../data');
const dbPath = config.dbPath || path.join(dataDir, 'glitch.sqlite');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    google_sub TEXT UNIQUE,
    account_id TEXT,
    enc_private_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cooldowns (
    player_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    until_ts INTEGER NOT NULL,
    PRIMARY KEY (player_id, kind)
  );

  CREATE TABLE IF NOT EXISTS chain_failures (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    account TEXT,
    amount TEXT,
    error TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_burns (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    amount TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS escrow (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    amount TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signup_log (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_lockouts (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    fails INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, key)
  );
`);

function columnNames(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

/** Lightweight migrations for existing SQLite files. */
function migrate(): void {
  const cols = columnNames('players');
  if (!cols.has('status')) {
    db.exec(`ALTER TABLE players ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!cols.has('gd_minted')) {
    db.exec(`ALTER TABLE players ADD COLUMN gd_minted INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('xp_json')) {
    db.exec(
      `ALTER TABLE players ADD COLUMN xp_json TEXT NOT NULL DEFAULT '{"trade":0,"sec":0,"comm":0}'`,
    );
  }
  if (!cols.has('needs_json')) {
    db.exec(
      `ALTER TABLE players ADD COLUMN needs_json TEXT NOT NULL DEFAULT '{"energy":100,"hunger":80}'`,
    );
  }
  if (!cols.has('pin_hash')) db.exec(`ALTER TABLE players ADD COLUMN pin_hash TEXT`);
  if (!cols.has('pin_salt')) db.exec(`ALTER TABLE players ADD COLUMN pin_salt TEXT`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name ON players(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_account_id ON players(account_id)
      WHERE account_id IS NOT NULL;
  `);
}

migrate();

console.log(`[db] opened ${dbPath}`);
