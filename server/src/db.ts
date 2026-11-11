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

  CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    enc_private_key TEXT NOT NULL,
    floated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    merchant_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    outbox_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paying',
    delivered INTEGER NOT NULL DEFAULT 0,
    deliver_tx_hash TEXT,
    deliver_tx_at INTEGER,
    deliver_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES players(id),
    token_id TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    price TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listing_sales (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    buyer_id TEXT NOT NULL REFERENCES players(id),
    seller_id TEXT NOT NULL REFERENCES players(id),
    token_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    fee TEXT NOT NULL,
    outbox_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paying',
    delivered INTEGER NOT NULL DEFAULT 0,
    deliver_tx_hash TEXT,
    deliver_tx_at INTEGER,
    deliver_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS forges (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    item_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    shards_cost INTEGER NOT NULL,
    amount TEXT NOT NULL,
    outbox_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paying',
    shards_burned INTEGER NOT NULL DEFAULT 0,
    burn_tx_hash TEXT,
    burn_tx_at INTEGER,
    burn_attempts INTEGER NOT NULL DEFAULT 0,
    token_created INTEGER NOT NULL DEFAULT 0,
    create_tx_hash TEXT,
    create_tx_at INTEGER,
    create_attempts INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    mint_tx_hash TEXT,
    mint_tx_at INTEGER,
    mint_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chef_inventory (
    item_id TEXT PRIMARY KEY,
    stock REAL NOT NULL,
    demand_ema REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS merchant_inventory (
    merchant_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    stock REAL NOT NULL,
    demand_ema REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (merchant_id, item_id)
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

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    sym TEXT NOT NULL,
    dir INTEGER NOT NULL,
    stake TEXT NOT NULL,
    fee TEXT NOT NULL,
    p0 TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    resolves_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    price_out TEXT,
    pnl TEXT,
    credited TEXT,
    capped INTEGER NOT NULL DEFAULT 0,
    minted INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    seed INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    stop0 INTEGER,
    stop1 INTEGER,
    stop2 INTEGER,
    hits INTEGER NOT NULL DEFAULT 0,
    gross TEXT,
    credited TEXT,
    capped INTEGER NOT NULL DEFAULT 0,
    shards INTEGER NOT NULL DEFAULT 0,
    gd_minted INTEGER NOT NULL DEFAULT 0,
    shards_minted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    sym TEXT NOT NULL,
    take TEXT NOT NULL,
    reach TEXT NOT NULL,
    followers INTEGER NOT NULL,
    pnl TEXT NOT NULL,
    credited TEXT NOT NULL,
    capped INTEGER NOT NULL DEFAULT 0,
    minted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
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
  if (!cols.has('pay_day')) db.exec(`ALTER TABLE players ADD COLUMN pay_day TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('pay_used')) db.exec(`ALTER TABLE players ADD COLUMN pay_used REAL NOT NULL DEFAULT 0`);
  if (!cols.has('followers')) db.exec(`ALTER TABLE players ADD COLUMN followers INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has('needs_updated_at')) {
    db.exec(`ALTER TABLE players ADD COLUMN needs_updated_at INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('home_paid_until')) {
    db.exec(`ALTER TABLE players ADD COLUMN home_paid_until INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('google_sub')) {
    db.exec(`ALTER TABLE players ADD COLUMN google_sub TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name ON players(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_google_sub ON players(google_sub)
      WHERE google_sub IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_account_id ON players(account_id)
      WHERE account_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      sym TEXT NOT NULL,
      dir INTEGER NOT NULL,
      stake TEXT NOT NULL,
      fee TEXT NOT NULL,
      p0 TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      resolves_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      price_out TEXT,
      pnl TEXT,
      credited TEXT,
      capped INTEGER NOT NULL DEFAULT 0,
      minted INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_one_open ON trades(player_id)
      WHERE status = 'open';
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      seed INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      stop0 INTEGER,
      stop1 INTEGER,
      stop2 INTEGER,
      hits INTEGER NOT NULL DEFAULT 0,
      gross TEXT,
      credited TEXT,
      capped INTEGER NOT NULL DEFAULT 0,
      shards INTEGER NOT NULL DEFAULT 0,
      gd_minted INTEGER NOT NULL DEFAULT 0,
      shards_minted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_one_open ON vaults(player_id)
      WHERE status = 'open';
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      sym TEXT NOT NULL,
      take TEXT NOT NULL,
      reach TEXT NOT NULL,
      followers INTEGER NOT NULL,
      pnl TEXT NOT NULL,
      credited TEXT NOT NULL,
      capped INTEGER NOT NULL DEFAULT 0,
      minted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  addMintColumns();
  migrateChefInventoryToMerchant();
}

/** Copy legacy chef_inventory rows into merchant_inventory once. */
function migrateChefInventoryToMerchant(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_inventory (
      merchant_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      stock REAL NOT NULL,
      demand_ema REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (merchant_id, item_id)
    );
  `);
  const hasChef = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chef_inventory'`)
    .get() as { name: string } | undefined;
  if (!hasChef) return;
  db.exec(`
    INSERT OR IGNORE INTO merchant_inventory (merchant_id, item_id, stock, demand_ema, updated_at)
    SELECT 'chef', item_id, stock, demand_ema, updated_at FROM chef_inventory
  `);
}

function addColumn(table: string, name: string, ddl: string): void {
  if (!columnNames(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** Tx hashes for mint resume. chain_before is diagnostic only. */
function addMintColumns(): void {
  for (const table of ['trades', 'posts'] as const) {
    addColumn(table, 'chain_before', 'chain_before TEXT');
    addColumn(table, 'mint_tx_hash', 'mint_tx_hash TEXT');
    addColumn(table, 'mint_tx_at', 'mint_tx_at INTEGER');
    addColumn(table, 'mint_attempts', 'mint_attempts INTEGER NOT NULL DEFAULT 0');
  }
  addColumn('vaults', 'chain_before', 'chain_before TEXT');
  addColumn('vaults', 'mint_tx_hash', 'mint_tx_hash TEXT');
  addColumn('vaults', 'mint_tx_at', 'mint_tx_at INTEGER');
  addColumn('vaults', 'mint_attempts', 'mint_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('vaults', 'shards_before', 'shards_before TEXT');
  addColumn('vaults', 'shard_tx_hash', 'shard_tx_hash TEXT');
  addColumn('vaults', 'shard_tx_at', 'shard_tx_at INTEGER');
  addColumn('vaults', 'shard_attempts', 'shard_attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('outbox', 'tx_hash', 'tx_hash TEXT');
  addColumn('outbox', 'tx_at', 'tx_at INTEGER');
  addColumn('outbox', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0');
  addColumn('purchases', 'delivered', 'delivered INTEGER NOT NULL DEFAULT 0');
  addColumn('purchases', 'deliver_tx_hash', 'deliver_tx_hash TEXT');
  addColumn('purchases', 'deliver_tx_at', 'deliver_tx_at INTEGER');
  addColumn('purchases', 'deliver_attempts', 'deliver_attempts INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL REFERENCES players(id),
      token_id TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      price TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_open ON listings(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_listings_seller_token ON listings(seller_id, token_id, status);
    CREATE TABLE IF NOT EXISTS listing_sales (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id),
      buyer_id TEXT NOT NULL REFERENCES players(id),
      seller_id TEXT NOT NULL REFERENCES players(id),
      token_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      fee TEXT NOT NULL,
      outbox_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paying',
      delivered INTEGER NOT NULL DEFAULT 0,
      deliver_tx_hash TEXT,
      deliver_tx_at INTEGER,
      deliver_attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mock_gd (
      account_id TEXT PRIMARY KEY,
      amount TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mock_items (
      account_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      PRIMARY KEY (account_id, token_id)
    );
    CREATE TABLE IF NOT EXISTS mock_tokens (
      token_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      max_supply TEXT,
      supply TEXT NOT NULL DEFAULT '0'
    );
    CREATE TABLE IF NOT EXISTS mock_ads (
      slot_id INTEGER PRIMARY KEY,
      advertiser TEXT,
      project_name TEXT,
      creative_url TEXT,
      start_ns TEXT,
      end_ns TEXT,
      paid TEXT
    );
    CREATE TABLE IF NOT EXISTS mock_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

migrate();

console.log(`[db] opened ${dbPath}`);
