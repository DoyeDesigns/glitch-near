/**
 * In-process mock-chain smoke: signup, vault, purchase, forge, ads.
 * Run: npm run verify -w @glitch/server
 */
import os from 'node:os';
import path from 'node:path';
import { vaultHit, vaultLockStart, vaultLocks } from '@glitch/shared';

process.env.CHAIN_MODE = 'mock';
process.env.DB_PATH = path.join(os.tmpdir(), `glitch-verify-${process.pid}.sqlite`);
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { createApp } = await import('../src/routes');
const { db } = await import('../src/db');
const { installMockChain } = await import('../src/near/mockLedger');

installMockChain();
const app = createApp();

type Step = { name: string; ok: boolean; detail?: string };
const results: Step[] = [];

function cookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  if (raw.length) return raw.map(c => c.split(';')[0]!).join('; ');
  const single = res.headers.get('set-cookie');
  return single ? single.split(';')[0]! : '';
}

async function req(
  method: string,
  url: string,
  opts?: { body?: unknown; cookie?: string },
): Promise<{ res: Response; json: Record<string, unknown>; cookie: string }> {
  const headers: Record<string, string> = {};
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  if (opts?.cookie) headers.cookie = opts.cookie;
  const res = await app.request(url, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, json, cookie: cookieFrom(res) || opts?.cookie || '' };
}

function zoneStop(seed: number, prior: number[]): number {
  const index = prior.length;
  const lock = vaultLocks(seed)[index];
  if (!lock) throw new Error('lock missing');
  const origin = vaultLockStart(prior, index);
  for (let local = 0; local < 30_000; local += 16) {
    if (vaultHit(local, lock.zoneStart, lock.zoneWidth, lock.speed)) return origin + local;
  }
  throw new Error('zone missing');
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = (await fn()) || undefined;
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`FAIL ${name} — ${detail}`);
  }
}

const name = `v${Date.now().toString(36).slice(-8)}`;
let cookie = '';
let accountId = '';

await step('signup', async () => {
  const { res, json, cookie: c } = await req('POST', '/auth/login', {
    body: { name, pin: '1234', signup: true },
  });
  if (!res.ok) throw new Error(String(json.error || res.status));
  cookie = c;
  if (!cookie) throw new Error('no session cookie');
  const me = await req('GET', '/me', { cookie });
  if (!me.res.ok) throw new Error(String(me.json.error || me.res.status));
  const available = BigInt(String(me.json.available ?? '0'));
  if (available <= 0n) throw new Error('available is 0');
  accountId = String(me.json.accountId ?? '');
  return `available=${available}`;
});

await step('vault', async () => {
  const start = await req('POST', '/vault/start', { cookie });
  if (!start.res.ok) throw new Error(String(start.json.error || start.res.status));
  const seed = Number(start.json.seed);
  const vaultId = String(start.json.id);
  const stops: number[] = [];
  for (let i = 0; i < 3; i++) {
    const stop = zoneStop(seed, stops);
    // Align server clock window with the stop timestamp.
    db.prepare(`UPDATE vaults SET started_at = ? WHERE id = ?`).run(Date.now() - stop, vaultId);
    const finish = await req('POST', '/vault/finish', {
      cookie,
      body: { stops: [...stops, stop] },
    });
    if (!finish.res.ok) throw new Error(String(finish.json.error || finish.res.status));
    stops.push(stop);
  }
  return `hits via ${stops.length} stops`;
});

await step('purchase', async () => {
  const buy = await req('POST', '/shop/buy', { cookie, body: { itemId: 'suya-skewer' } });
  if (!buy.res.ok) throw new Error(String(buy.json.error || buy.res.status));
  return 'suya-skewer';
});

await step('forge', async () => {
  const mint = await req('POST', '/forge/mint', { cookie, body: { itemId: 'cap' } });
  if (!mint.res.ok) throw new Error(String(mint.json.error || mint.res.status));
  return String(mint.json.tokenId || 'cap');
});

await step('ad lookup', async () => {
  const ads = await req('GET', '/ads');
  if (!ads.res.ok) throw new Error(String(ads.json.error || ads.res.status));
  const slots = ads.json.slots;
  if (!Array.isArray(slots) || slots.length < 1) throw new Error('no slots');
  return `slots=${slots.length}`;
});

const failed = results.filter(r => !r.ok);
console.log('');
console.log(failed.length ? `verify FAIL (${failed.length}/${results.length})` : `verify PASS (${results.length}/${results.length})`);
if (accountId) console.log(`player ${accountId}`);
process.exit(failed.length ? 1 : 0);
