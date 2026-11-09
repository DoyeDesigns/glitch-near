/**
 * Shared NEAR RPC + treasury/oracle signer (near-api-js v7).
 * Docs: https://docs.near.org/tools/near-api
 */
import {
  Account,
  JsonRpcProvider,
  nearToYocto,
  teraToGas,
  type KeyPairString,
} from 'near-api-js';
import { config, requireNearConfig } from '../config';

/** 1 yoctoNEAR — required by NEP-141 / NEP-245 transfer methods. */
export const ONE_YOCTO = 1n;
export const DEFAULT_GAS = teraToGas('30');
export const PLAYER_FUND_NEAR = nearToYocto('0.05');
/** Top up a player before a signed transfer when their NEAR is below this. */
export const PLAYER_NEAR_TOPUP_FLOOR = nearToYocto('0.02');

let provider: JsonRpcProvider | null = null;
let treasury: Account | null = null;

const NEAR_CACHE_MS = 5_000;
const nearCache = new Map<string, { yocto: bigint | null; until: number }>();

let nearReader: ((accountId: string) => Promise<bigint | null>) | null = null;
let nearTopUp: ((accountId: string, amount: bigint) => Promise<void>) | null = null;

/** Test seam for player NEAR gas top-ups. */
export function setNearFundingForTests(
  hooks: {
    read: (accountId: string) => Promise<bigint | null>;
    topUp: (accountId: string, amount: bigint) => Promise<void>;
  } | null,
): void {
  nearReader = hooks?.read ?? null;
  nearTopUp = hooks?.topUp ?? null;
  nearCache.clear();
}

/** Single-flight queue: every treasury-signed write runs one at a time. */
let writeTail: Promise<unknown> = Promise.resolve();

export function enqueueTreasuryWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeTail.then(() => fn(), () => fn());
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One nonce queue per signer account. The treasury queue above is separate. */
const signerTails = new Map<string, Promise<unknown>>();

export function enqueueSignerWrite<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = signerTails.get(accountId) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  signerTails.set(
    accountId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function getProvider(): JsonRpcProvider {
  if (!provider) provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  return provider;
}

/** Treasury / oracle signer: ROOT_ACCOUNT + TREASURY_KEY. */
export function getTreasuryAccount(): Account {
  requireNearConfig();
  if (!treasury) {
    treasury = new Account(config.rootAccount, getProvider(), config.treasuryKey as KeyPairString);
  }
  return treasury;
}

export function parseU128(raw: unknown): bigint {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
    return BigInt(raw);
  }
  if (raw && typeof raw === 'object' && '0' in raw) {
    return BigInt(String((raw as { 0: unknown })[0]));
  }
  return 0n;
}

/** NEAR balance in yocto, or null if the account is missing. Cached 5s. One RPC attempt. */
export async function getNearBalanceCached(accountId: string): Promise<bigint | null> {
  if (nearReader) return nearReader(accountId);
  const now = Date.now();
  const hit = nearCache.get(accountId);
  if (hit && hit.until > now) return hit.yocto;
  let yocto: bigint | null = null;
  try {
    const view = await getProvider().viewAccount({ accountId });
    yocto = view.amount;
  } catch {
    yocto = null;
  }
  nearCache.set(accountId, { yocto, until: now + NEAR_CACHE_MS });
  return yocto;
}

/**
 * Fund a player to PLAYER_FUND_NEAR when their balance is below 0.02 NEAR.
 * One treasury transfer, never retried. Runs on the treasury write queue.
 */
export async function ensurePlayerNear(accountId: string): Promise<void> {
  const bal = await getNearBalanceCached(accountId);
  if (bal == null) throw new Error(`Account ${accountId} is missing`);
  if (bal >= PLAYER_NEAR_TOPUP_FLOOR) return;
  const amount = PLAYER_FUND_NEAR - bal;
  if (amount <= 0n) return;
  if (nearTopUp) {
    await nearTopUp(accountId, amount);
    nearCache.delete(accountId);
    return;
  }
  requireNearConfig();
  await enqueueTreasuryWrite(async () => {
    await getTreasuryAccount().transfer({ receiverId: accountId, amount });
  });
  nearCache.delete(accountId);
}

/** Up to 4 decimal places, trailing zeros trimmed. */
export function formatNear(yocto: bigint): string {
  const neg = yocto < 0n;
  const v = neg ? -yocto : yocto;
  const base = 10n ** 24n;
  const whole = v / base;
  const frac = (v % base).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/** True if the account is present on-chain. */
export async function accountExistsOnChain(accountId: string): Promise<boolean> {
  try {
    await getProvider().viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}
