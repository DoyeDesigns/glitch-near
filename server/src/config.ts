import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
for (const name of ['.env.local', '.env']) {
  const p = path.join(serverRoot, name);
  if (fs.existsSync(p)) loadEnv({ path: p, override: false });
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function isPlaceholderKey(v: string): boolean {
  return !v || v.includes('<') || v.includes('…') || v.includes('...');
}

/** Load private_key from ~/.near-credentials/<network>/<accountId>.json when TREASURY_KEY unset. */
function loadNearCredentialsKey(network: string, accountId: string): string {
  if (!accountId) return '';
  const p = path.join(os.homedir(), '.near-credentials', network, `${accountId}.json`);
  if (!fs.existsSync(p)) return '';
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { private_key?: string };
    return typeof raw.private_key === 'string' ? raw.private_key : '';
  } catch {
    return '';
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

const nearNetwork = str('NEAR_NETWORK', 'testnet');
const rpcUrls: Record<string, string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
};

const rootAccount = str('ROOT_ACCOUNT');
/** Parent of players/treasury/merchants. ROOT_ACCOUNT is the players signer (`players.<root>`). */
const chainRoot =
  str('CHAIN_ROOT') || (rootAccount.startsWith('players.') ? rootAccount.slice('players.'.length) : '');
const treasuryKeyEnv = str('TREASURY_KEY');
const treasuryKey = isPlaceholderKey(treasuryKeyEnv)
  ? loadNearCredentialsKey(nearNetwork, rootAccount)
  : treasuryKeyEnv;

export const config = {
  nodeEnv,
  isProd,
  port: num('PORT', 8787),
  seed: num('SEED', 42) >>> 0,
  nearNetwork,
  nearRpcUrl: str('NEAR_RPC_URL', rpcUrls[nearNetwork] ?? rpcUrls.testnet!),
  gdContract: str('GD_CONTRACT'),
  itemsContract: str('ITEMS_CONTRACT'),
  marketContract: str('MARKET_CONTRACT'),
  rootAccount,
  treasuryKey,
  keyEncryptionSecret: str('KEY_ENCRYPTION_SECRET'),
  corsOrigin: str('CORS_ORIGIN', 'http://localhost:5173'),
  dbPath: str('DB_PATH', ''),
  /** Minimal NEAR to fund new player subaccounts (yocto as string via nearToYocto). */
  playerFundNear: str('PLAYER_FUND_NEAR', '0.05'),
  /** Empty = open signup. Set to require a matching inviteCode on new accounts. */
  inviteCode: str('INVITE_CODE'),
  signupIpPerHour: num('SIGNUP_IP_PER_HOUR', 5),
  signupHourlyCap: num('SIGNUP_HOURLY_CAP', 30),
  /** Empty = GET /admin/health is 404. Sent by the dashboard as the x-admin-token header. */
  adminToken: str('ADMIN_TOKEN'),
  /** Chain owner (`glitch-….testnet`), not the players signer. */
  chainRoot,
  treasuryAccount: str('TREASURY_ACCOUNT', chainRoot ? `treasury.${chainRoot}` : ''),
  merchantChef: str('MERCHANT_CHEF', chainRoot ? `chef.${chainRoot}` : ''),
  merchantSmith: str('MERCHANT_SMITH', chainRoot ? `smith.${chainRoot}` : ''),
  merchantDealer: str('MERCHANT_DEALER', chainRoot ? `dealer.${chainRoot}` : ''),
  /** Sender account id in admin top-up commands. */
  topupFrom: str('TOPUP_ACCOUNT', chainRoot),
};

if (isProd && !config.keyEncryptionSecret) {
  throw new Error('KEY_ENCRYPTION_SECRET is required in production');
}
if (!isProd && !config.keyEncryptionSecret) {
  console.warn('[config] KEY_ENCRYPTION_SECRET is empty (dev only)');
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/**
 * ADMIN_TOKEN as written in server/.env.local (then .env).
 * Read on each admin check so a file edit is picked up without a restart,
 * and so a token already in the process environment cannot hide the file.
 */
export function readAdminToken(): string {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(serverRoot, name);
    if (!fs.existsSync(p)) continue;
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const match = text.match(/^ADMIN_TOKEN\s*=\s*(.*)$/m);
    if (!match) continue;
    const value = unquote(match[1] ?? '').replace(/\s+/g, '');
    if (value) return value;
  }
  return unquote(process.env.ADMIN_TOKEN ?? '').replace(/\s+/g, '');
}

export function requireNearConfig(): void {
  const missing = (
    [
      ['ROOT_ACCOUNT', config.rootAccount],
      ['TREASURY_KEY', config.treasuryKey],
      ['GD_CONTRACT', config.gdContract],
      ['KEY_ENCRYPTION_SECRET', config.keyEncryptionSecret],
    ] as const
  ).filter(([, v]) => isPlaceholderKey(v));
  if (missing.length) {
    throw new Error(
      `Missing/invalid NEAR config: ${missing.map(([k]) => k).join(', ')}` +
        (missing.some(([k]) => k === 'TREASURY_KEY')
          ? ` (set TREASURY_KEY or place ~/.near-credentials/${nearNetwork}/${rootAccount || '<ROOT_ACCOUNT>'}.json)`
          : ''),
    );
  }
}
