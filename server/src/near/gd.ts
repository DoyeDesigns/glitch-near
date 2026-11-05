import { config, requireNearConfig } from '../config';
import { DEFAULT_GAS, getProvider, getTreasuryAccount, parseU128 } from './client';
import { withChainRetry } from './retry';

const GD_CACHE_MS = 5_000;
const gdCache = new Map<string, { balance: string; until: number }>();

function invalidateGdCache(accountId: string): void {
  gdCache.delete(accountId);
}

/** Mint GD via treasury/oracle signer. Amount as string for U128. Never retried. */
export async function mintGD(accountId: string, amount: bigint | number | string): Promise<void> {
  requireNearConfig();
  const amt = String(amount);
  await withChainRetry(
    () =>
      getTreasuryAccount().callFunction({
        contractId: config.gdContract,
        methodName: 'mint',
        args: { account_id: accountId, amount: amt },
        gas: DEFAULT_GAS,
        deposit: 0n,
      }),
    { idempotent: false, label: 'gd.mint', account: accountId, amount: amt },
  );
  invalidateGdCache(accountId);
}

/** View GD balance (ft_balance_of). */
export async function getGDBalance(accountId: string): Promise<bigint> {
  requireNearConfig();
  const raw = await withChainRetry(
    () =>
      getProvider().callFunction({
        contractId: config.gdContract,
        method: 'ft_balance_of',
        args: { account_id: accountId },
      }),
    { idempotent: true, label: 'gd.ft_balance_of', account: accountId },
  );
  return parseU128(raw);
}

/** GD balance with 5s in-memory cache (for GET /me). */
export async function getGDBalanceCached(accountId: string): Promise<string> {
  const hit = gdCache.get(accountId);
  const now = Date.now();
  if (hit && hit.until > now) return hit.balance;
  const bal = (await getGDBalance(accountId)).toString();
  gdCache.set(accountId, { balance: bal, until: now + GD_CACHE_MS });
  return bal;
}

/** Burn GD from a player (minter-only burn_from). Never retried. */
export async function burnGD(accountId: string, amount: bigint | number | string): Promise<void> {
  requireNearConfig();
  const amt = String(amount);
  await withChainRetry(
    () =>
      getTreasuryAccount().callFunction({
        contractId: config.gdContract,
        methodName: 'burn_from',
        args: { account_id: accountId, amount: amt },
        gas: DEFAULT_GAS,
        deposit: 0n,
      }),
    { idempotent: false, label: 'gd.burn_from', account: accountId, amount: amt },
  );
  invalidateGdCache(accountId);
}
