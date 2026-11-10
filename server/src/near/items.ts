import { config, requireNearConfig } from '../config';
import { DEFAULT_GAS, getProvider, getTreasuryAccount, parseU128 } from './client';
import { withChainRetry } from './retry';

function requireItemsContract(): string {
  requireNearConfig();
  if (!config.itemsContract) throw new Error('ITEMS_CONTRACT not set');
  return config.itemsContract;
}

let itemBalancesReader: ((accountId: string) => Promise<Record<string, string>>) | null = null;
let itemBurner:
  | ((accountId: string, tokenId: string, amount: bigint) => Promise<void>)
  | null = null;

/** Test seam. Production leaves this unset and reads the chain. */
export function setItemsChainForTests(
  hooks: {
    balances?: (accountId: string) => Promise<Record<string, string>>;
    burn?: (accountId: string, tokenId: string, amount: bigint) => Promise<void>;
  } | null,
): void {
  itemBalancesReader = hooks?.balances ?? null;
  itemBurner = hooks?.burn ?? null;
}

export type TokenView = {
  token_id: string;
  kind: string;
  title: string;
  supply: string | { 0: string };
  max_supply: string | { 0: string } | null;
};

/** View a token type; null if not registered. */
export async function getToken(tokenId: string): Promise<TokenView | null> {
  const contractId = requireItemsContract();
  const raw = await withChainRetry(
    () =>
      getProvider().callFunction<TokenView>({
        contractId,
        method: 'get_token',
        args: { token_id: tokenId },
      }),
    { idempotent: true, label: 'items.get_token' },
  );
  return raw ?? null;
}

/** Register a token type (minter-only). Never retried. */
export async function createToken(
  tokenId: string,
  kind: string,
  title: string,
  maxSupply: number | null,
): Promise<void> {
  const contractId = requireItemsContract();
  await withChainRetry(
    () =>
      getTreasuryAccount().callFunction({
        contractId,
        methodName: 'create_token',
        args: {
          token_id: tokenId,
          kind,
          title,
          max_supply: maxSupply == null ? null : String(maxSupply),
        },
        gas: DEFAULT_GAS,
        deposit: 0n,
      }),
    { idempotent: false, label: 'items.create_token', account: tokenId },
  );
}

/** Mint items (NEP-245) to an account. Minter-only. Never retried. */
export async function mintItem(
  accountId: string,
  tokenId: string,
  amount: bigint | number | string,
): Promise<void> {
  const contractId = requireItemsContract();
  const amt = String(amount);
  await withChainRetry(
    () =>
      getTreasuryAccount().callFunction({
        contractId,
        methodName: 'mint',
        args: { account_id: accountId, token_id: tokenId, amount: amt },
        gas: DEFAULT_GAS,
        deposit: 0n,
      }),
    { idempotent: false, label: 'items.mint', account: accountId, amount: amt },
  );
}

/** Burn items from a player (minter-only burn_from). Never retried. */
export async function burnItem(
  accountId: string,
  tokenId: string,
  amount: bigint | number | string,
): Promise<void> {
  const amt = String(amount);
  if (itemBurner) {
    await itemBurner(accountId, tokenId, BigInt(amt));
    return;
  }
  const contractId = requireItemsContract();
  await withChainRetry(
    () =>
      getTreasuryAccount().callFunction({
        contractId,
        methodName: 'burn_from',
        args: { account_id: accountId, token_id: tokenId, amount: amt },
        gas: DEFAULT_GAS,
        deposit: 0n,
      }),
    { idempotent: false, label: 'items.burn_from', account: accountId, amount: amt },
  );
}

/** Server-signed move between accounts (admin_transfer). Never retried. */
export async function adminTransfer(
  from: string,
  to: string,
  tokenId: string,
  amount: bigint | number | string,
): Promise<void> {
  const contractId = requireItemsContract();
  const amt = String(amount);
  await withChainRetry(
    () =>
      getTreasuryAccount().callFunction({
        contractId,
        methodName: 'admin_transfer',
        args: { from, to, token_id: tokenId, amount: amt },
        gas: DEFAULT_GAS,
        deposit: 0n,
      }),
    { idempotent: false, label: 'items.admin_transfer', account: from, amount: amt },
  );
}

/**
 * Item balances for an account: catalog via mt_tokens, then mt_batch_balance_of.
 * Returns only non-zero balances as { [tokenId]: amountString }.
 */
export async function getItemBalances(accountId: string): Promise<Record<string, string>> {
  if (itemBalancesReader) return itemBalancesReader(accountId);
  const contractId = requireItemsContract();
  const tokens = await withChainRetry(
    () =>
      getProvider().callFunction<TokenView[]>({
        contractId,
        method: 'mt_tokens',
        args: { from_index: null, limit: 200 },
      }),
    { idempotent: true, label: 'items.mt_tokens', account: accountId },
  );

  const tokenIds = (tokens ?? []).map(t => t.token_id).filter(Boolean);
  if (tokenIds.length === 0) return {};

  const bals = await withChainRetry(
    () =>
      getProvider().callFunction<unknown[]>({
        contractId,
        method: 'mt_batch_balance_of',
        args: { account_id: accountId, token_ids: tokenIds },
      }),
    { idempotent: true, label: 'items.mt_batch_balance_of', account: accountId },
  );

  const out: Record<string, string> = {};
  for (let i = 0; i < tokenIds.length; i++) {
    const n = parseU128(bals?.[i]);
    if (n > 0n) out[tokenIds[i]!] = n.toString();
  }
  return out;
}
