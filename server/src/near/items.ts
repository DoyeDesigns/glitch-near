import { catalogSeedEntries } from '@glitch/shared';
import { config, requireNearConfig } from '../config';
import { db } from '../db';
import { DEFAULT_GAS, getProvider, getTreasuryAccount, parseU128 } from './client';
import { withChainRetry } from './retry';

const TOKEN_LIST_MS = 60_000;
const BALANCE_MS = 5_000;

function requireItemsContract(): string {
  requireNearConfig();
  if (!config.itemsContract) throw new Error('ITEMS_CONTRACT not set');
  return config.itemsContract;
}

let itemBalancesReader: ((accountId: string) => Promise<Record<string, string>>) | null = null;
let itemBurner:
  | ((accountId: string, tokenId: string, amount: bigint) => Promise<void>)
  | null = null;
let itemGetToken: ((tokenId: string) => Promise<TokenView | null>) | null = null;
let itemCreateToken:
  | ((tokenId: string, kind: string, title: string, maxSupply: number | null) => Promise<void>)
  | null = null;
let itemMinter: ((accountId: string, tokenId: string, amount: bigint) => Promise<void>) | null = null;

/** Test seam. Production leaves this unset and reads the chain. */
export function setItemsChainForTests(
  hooks: {
    balances?: (accountId: string) => Promise<Record<string, string>>;
    burn?: (accountId: string, tokenId: string, amount: bigint) => Promise<void>;
    getToken?: (tokenId: string) => Promise<TokenView | null>;
    createToken?: (
      tokenId: string,
      kind: string,
      title: string,
      maxSupply: number | null,
    ) => Promise<void>;
    mint?: (accountId: string, tokenId: string, amount: bigint) => Promise<void>;
  } | null,
): void {
  itemBalancesReader = hooks?.balances ?? null;
  itemBurner = hooks?.burn ?? null;
  itemGetToken = hooks?.getToken ?? null;
  itemCreateToken = hooks?.createToken ?? null;
  itemMinter = hooks?.mint ?? null;
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
  if (itemGetToken) return itemGetToken(tokenId);
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
  if (itemCreateToken) {
    await itemCreateToken(tokenId, kind, title, maxSupply);
    return;
  }
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
  invalidateItemBalances();
}

/** Mint items (NEP-245) to an account. Minter-only. Never retried. */
export async function mintItem(
  accountId: string,
  tokenId: string,
  amount: bigint | number | string,
): Promise<void> {
  const amt = String(amount);
  if (itemMinter) {
    await itemMinter(accountId, tokenId, BigInt(amt));
    return;
  }
  const contractId = requireItemsContract();
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
  invalidateItemBalances(accountId);
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
  invalidateItemBalances(accountId);
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
  invalidateItemBalances(from);
  invalidateItemBalances(to);
}

let tokenListCache: { ids: string[]; until: number } | null = null;
let tokenListInflight: Promise<string[]> | null = null;
const balanceCache = new Map<string, { value: Record<string, string>; until: number }>();
const balanceInflight = new Map<string, Promise<Record<string, string>>>();

export function invalidateItemBalances(accountId?: string): void {
  if (accountId) balanceCache.delete(accountId);
  else balanceCache.clear();
  tokenListCache = null;
}

function knownTokenIds(): string[] {
  const ids = new Set(catalogSeedEntries().map(item => item.id));
  const rows = db.prepare(`SELECT token_id FROM forges WHERE token_created = 1`).all() as { token_id: string }[];
  for (const row of rows) ids.add(row.token_id);
  const listed = db.prepare(`SELECT token_id FROM listings`).all() as { token_id: string }[];
  for (const row of listed) ids.add(row.token_id);
  return [...ids];
}

async function tokenIds(): Promise<string[]> {
  const now = Date.now();
  if (tokenListCache && tokenListCache.until > now) return tokenListCache.ids;
  if (tokenListInflight) return tokenListInflight;
  const contractId = requireItemsContract();
  tokenListInflight = withChainRetry(
    () =>
      getProvider().callFunction<TokenView[]>({
        contractId,
        method: 'mt_tokens',
        args: { from_index: null, limit: 200 },
      }),
    { idempotent: true, label: 'items.mt_tokens' },
  )
    .then(tokens => {
      const fromChain = (tokens ?? []).map(t => t.token_id).filter(Boolean);
      const ids = [...new Set([...knownTokenIds(), ...fromChain])];
      tokenListCache = { ids, until: Date.now() + TOKEN_LIST_MS };
      return ids;
    })
    .catch(err => {
      const fallback = knownTokenIds();
      if (fallback.length > 0) {
        tokenListCache = { ids: fallback, until: Date.now() + 15_000 };
        return fallback;
      }
      throw err;
    })
    .finally(() => {
      tokenListInflight = null;
    });
  return tokenListInflight;
}

/**
 * Item balances for an account. The token list is cached for 60s.
 * Balances are cached for 5s. Returns only non-zero balances.
 */
export async function getItemBalances(accountId: string): Promise<Record<string, string>> {
  if (itemBalancesReader) return itemBalancesReader(accountId);
  const now = Date.now();
  const hit = balanceCache.get(accountId);
  if (hit && hit.until > now) return hit.value;
  const pending = balanceInflight.get(accountId);
  if (pending) return pending;

  const run = (async () => {
    const contractId = requireItemsContract();
    const tokenIdsForAccount = await tokenIds();
    if (tokenIdsForAccount.length === 0) return {};
    const bals = await withChainRetry(
      () =>
        getProvider().callFunction<unknown[]>({
          contractId,
          method: 'mt_batch_balance_of',
          args: { account_id: accountId, token_ids: tokenIdsForAccount },
        }),
      { idempotent: true, label: 'items.mt_batch_balance_of', account: accountId },
    );
    const out: Record<string, string> = {};
    for (let i = 0; i < tokenIdsForAccount.length; i++) {
      const n = parseU128(bals?.[i]);
      if (n > 0n) out[tokenIdsForAccount[i]!] = n.toString();
    }
    balanceCache.set(accountId, { value: out, until: Date.now() + BALANCE_MS });
    return out;
  })().finally(() => {
    balanceInflight.delete(accountId);
  });
  balanceInflight.set(accountId, run);
  return run;
}
