import type { KeyPairString } from 'near-api-js';
import { config, requireNearConfig } from '../config';
import { randomId } from '../crypto';
import { db } from '../db';
import { getPlayerById } from './accounts';
import { DEFAULT_GAS, ONE_YOCTO, enqueueSignerWrite, getProvider, getTreasuryAccount, parseU128 } from './client';
import { decryptPrivateKey } from './keys';
import { deliverSigned, lookupSignedTx, nextMintStep, signAccountCall } from './mintTx';
import { ChainWriteError, recordChainFailure, withChainRetry } from './retry';

const GD_CACHE_MS = 5_000;
const gdCache = new Map<string, { balance: string; until: number }>();

let gdReader: ((accountId: string) => Promise<bigint>) | null = null;
let gdMinter: ((accountId: string, amount: bigint) => Promise<void>) | null = null;
let gdBurner: ((accountId: string, amount: bigint) => Promise<void>) | null = null;
let gdTransfer: ((from: string, to: string, amount: bigint) => Promise<void>) | null = null;

/** Test seam. Production leaves this unset and reads the chain. */
export function setGdChainForTests(
  hooks: {
    read: (accountId: string) => Promise<bigint>;
    mint: (accountId: string, amount: bigint) => Promise<void>;
    burn?: (accountId: string, amount: bigint) => Promise<void>;
    transfer?: (from: string, to: string, amount: bigint) => Promise<void>;
  } | null,
): void {
  gdReader = hooks?.read ?? null;
  gdMinter = hooks?.mint ?? null;
  gdBurner = hooks?.burn ?? null;
  gdTransfer = hooks?.transfer ?? null;
  gdCache.clear();
}

/**
 * Drop one account from the GD balance cache.
 * A player ft_transfer must call this after the transfer lands.
 */
export function invalidateGdCache(accountId: string): void {
  gdCache.delete(accountId);
}

/** Mint GD via treasury/oracle signer. Amount as string for U128. Never retried. */
export async function mintGD(accountId: string, amount: bigint | number | string): Promise<void> {
  const amt = String(amount);
  if (gdMinter) {
    await gdMinter(accountId, BigInt(amt));
    invalidateGdCache(accountId);
    return;
  }
  requireNearConfig();
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
  if (gdReader) return gdReader(accountId);
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
  const amt = String(amount);
  if (gdBurner) {
    await gdBurner(accountId, BigInt(amt));
    invalidateGdCache(accountId);
    return;
  }
  requireNearConfig();
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

/** Diagnostic balance. A cache miss that cannot reach the chain returns null. */
export async function readGdBalanceForLog(accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  try {
    return await getGDBalanceCached(accountId);
  } catch {
    return null;
  }
}

const TRANSFER_MEMO = 'glitch';

type OutboxRow = {
  id: string;
  player_id: string;
  payload: string;
  status: string;
  tx_hash: string | null;
  tx_at: number | null;
  attempts: number;
};

function outboxRow(id: string): OutboxRow | undefined {
  return db
    .prepare(
      `SELECT id, player_id, payload, status, tx_hash, tx_at, attempts FROM outbox WHERE id = ?`,
    )
    .get(id) as OutboxRow | undefined;
}

function markTransferLanded(id: string, fromAccount: string, toAccount: string, amount: bigint): Promise<void> {
  return (async () => {
    if (gdTransfer) await gdTransfer(fromAccount, toAccount, amount);
    db.prepare(`UPDATE outbox SET status = 'landed' WHERE id = ?`).run(id);
    invalidateGdCache(fromAccount);
    invalidateGdCache(toAccount);
  })();
}

/**
 * Player-signed ft_transfer. One attempt. The hash is stored on the outbox
 * row before broadcast. Writes for one signer account run one at a time.
 */
export async function ftTransfer(
  fromPlayerId: string,
  toAccountId: string,
  amount: bigint | number | string,
): Promise<void> {
  const amt = BigInt(amount);
  if (amt <= 0n) throw new Error('Amount must be positive');
  const player = getPlayerById(fromPlayerId);
  if (!player?.account_id || !player.enc_private_key) throw new Error('Player has no key');
  decryptPrivateKey(player.enc_private_key);
  const id = randomId();
  db.prepare(
    `INSERT INTO outbox (id, player_id, kind, payload, status, created_at, attempts)
     VALUES (?, ?, 'ft_transfer', ?, 'pending', ?, 0)`,
  ).run(
    id,
    fromPlayerId,
    JSON.stringify({ to: toAccountId, amount: amt.toString(), memo: TRANSFER_MEMO }),
    Date.now(),
  );
  await pushTransfer(id, true);
}

/** Finish pending player transfers. A stored hash is looked up; it is never rebroadcast. */
export async function resumeTransfers(): Promise<void> {
  const rows = db
    .prepare(`SELECT id FROM outbox WHERE kind = 'ft_transfer' AND status = 'pending'`)
    .all() as { id: string }[];
  for (const row of rows) {
    try {
      await pushTransfer(row.id, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gd] resume transfer ${row.id} failed: ${msg}`);
    }
  }
}

async function pushTransfer(id: string, requireLanded: boolean): Promise<void> {
  const row = outboxRow(id);
  if (!row || row.status === 'landed') return;
  const player = getPlayerById(row.player_id);
  if (!player?.account_id || !player.enc_private_key) throw new Error('Player has no key');
  const accountId = player.account_id;
  const secret = decryptPrivateKey(player.enc_private_key) as KeyPairString;
  const payload = JSON.parse(row.payload) as { to: string; amount: string; memo: string };
  await enqueueSignerWrite(accountId, async () => {
    const fresh = outboxRow(id);
    if (!fresh || fresh.status === 'landed') return;
    const looked = fresh.tx_hash ? await lookupSignedTx(fresh.tx_hash, accountId) : null;
    const step = nextMintStep({
      flag: 0,
      hash: fresh.tx_hash,
      txAt: fresh.tx_at,
      attempts: fresh.attempts,
      status: looked,
      now: Date.now(),
    });
    if (step === 'mark') {
      await markTransferLanded(id, accountId, payload.to, BigInt(payload.amount));
      return;
    }
    if (step !== 'fresh') return;
    const attempts = fresh.attempts + 1;
    let outcome: Awaited<ReturnType<typeof deliverSigned>>;
    try {
      outcome = await deliverSigned({
        sign: () =>
          signAccountCall({
            accountId,
            secretKey: secret,
            contractId: config.gdContract,
            methodName: 'ft_transfer',
            args: {
              receiver_id: payload.to,
              amount: payload.amount,
              memo: payload.memo,
            },
            deposit: ONE_YOCTO,
          }),
        persistHash: (hash, at) => {
          db.prepare(`UPDATE outbox SET tx_hash = ?, tx_at = ?, attempts = ? WHERE id = ?`).run(
            hash,
            at,
            attempts,
            id,
          );
        },
      });
    } catch (err) {
      const cwe =
        err instanceof ChainWriteError
          ? err
          : new ChainWriteError({
              label: 'gd.ft_transfer',
              account: accountId,
              amount: payload.amount,
              cause: err,
            });
      if (!(err instanceof ChainWriteError)) recordChainFailure(cwe);
      throw cwe;
    }
    if (outcome !== 'success') {
      const cwe = new ChainWriteError({
        label: 'gd.ft_transfer',
        account: accountId,
        amount: payload.amount,
        cause: new Error(outcome),
      });
      recordChainFailure(cwe);
      throw cwe;
    }
    await markTransferLanded(id, accountId, payload.to, BigInt(payload.amount));
  });
  if (!requireLanded) return;
  const done = outboxRow(id);
  if (done?.status !== 'landed') throw new Error('Transfer has not landed');
}
