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

let provider: JsonRpcProvider | null = null;
let treasury: Account | null = null;

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

const NEAR_CACHE_MS = 5_000;
const nearCache = new Map<string, { yocto: bigint | null; until: number }>();

/** NEAR balance in yocto, or null if the account is missing. Cached 5s. One RPC attempt. */
export async function getNearBalanceCached(accountId: string): Promise<bigint | null> {
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
