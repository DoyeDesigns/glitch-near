import { AuthError, assertCanSpend, fundsView } from './auth';
import { config, isMockChain } from './config';
import { DEFAULT_GAS, getProvider, getTreasuryAccount, parseU128, withTimeout } from './near/client';
import { ftTransfer } from './near/gd';
import type { PlayerRow } from './near/accounts';

const NAMED_ACCOUNT =
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** Standard NEP-145 minimum when the contract does not answer bounds. */
const STORAGE_DEPOSIT_FALLBACK = 1_250_000_000_000_000_000_000n;

export function parseWithdrawAccount(raw: unknown, ownAccount: string): string {
  if (typeof raw !== 'string') throw new AuthError('Enter a testnet account', 400);
  const to = raw.trim().toLowerCase();
  const implicit = /^[0-9a-f]{64}$/.test(to);
  const named = to.endsWith('.testnet') && to.length <= 64 && NAMED_ACCOUNT.test(to);
  if (!implicit && !named) throw new AuthError('Enter a testnet account', 400);
  if (to === ownAccount.toLowerCase()) throw new AuthError('That is already your account', 400);
  return to;
}

export function parseWithdrawAmount(raw: unknown): bigint {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9]\d{0,14}$/.test(s)) throw new AuthError('Enter a whole number of GD', 400);
  return BigInt(s);
}

async function receiverHasStorage(accountId: string): Promise<boolean> {
  const raw = await withTimeout(
    getProvider().callFunction({
      contractId: config.gdContract,
      method: 'storage_balance_of',
      args: { account_id: accountId },
    }),
    8_000,
    'gd.storage_balance_of',
  );
  return raw != null && raw !== 'null';
}

async function registerReceiver(accountId: string): Promise<void> {
  let deposit = STORAGE_DEPOSIT_FALLBACK;
  try {
    const bounds = await withTimeout(
      getProvider().callFunction({
        contractId: config.gdContract,
        method: 'storage_balance_bounds',
        args: {},
      }),
      8_000,
      'gd.storage_balance_bounds',
    );
    const min = parseU128((bounds as { min?: unknown } | null)?.min);
    if (min > 0n) deposit = min;
  } catch {
    /* use the standard minimum */
  }
  await withTimeout(
    getTreasuryAccount().callFunction({
      contractId: config.gdContract,
      methodName: 'storage_deposit',
      args: { account_id: accountId, registration_only: true },
      gas: DEFAULT_GAS,
      deposit,
    }),
    25_000,
    'gd.storage_deposit',
  );
}

export async function withdrawGd(
  player: PlayerRow,
  input: { to?: unknown; amount?: unknown },
): Promise<{ available: string; settling: string; to: string; amount: string; pending: boolean }> {
  if (!player.account_id) throw new AuthError('Player has no account', 503);
  const to = parseWithdrawAccount(input.to, player.account_id);
  const amount = parseWithdrawAmount(input.amount);
  await assertCanSpend(player, amount);
  if (!isMockChain()) {
    try {
      const ready = await receiverHasStorage(to);
      if (!ready) await registerReceiver(to);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('Could not register that account for GD', 503);
    }
  }
  const outcome = await ftTransfer(player.id, to, amount);
  if (outcome === 'failure') throw new AuthError('Could not send GD', 503);
  const funds = await fundsView(player);
  return { ...funds, to, amount: amount.toString(), pending: outcome === 'unknown' };
}
