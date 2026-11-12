import { KeyPair, nearToYocto } from 'near-api-js';
import { config, requireNearConfig } from '../config';
import { db } from '../db';
import { accountExistsOnChain, enqueueTreasuryWrite, getTreasuryAccount } from './client';
import { getGDBalance, mintGD } from './gd';
import { encryptPrivateKey } from './keys';
import { ChainWriteError, recordChainFailure } from './retry';

export const MERCHANT_IDS = ['chef', 'smith', 'dealer'] as const;
export const MERCHANT_FLOAT = 100_000n;
const MERCHANT_NEAR = nearToYocto('0.1');

export type MerchantRow = {
  id: string;
  account_id: string;
  enc_private_key: string;
  floated: number;
  created_at: number;
};

type MerchantChain = {
  exists: (accountId: string) => Promise<boolean>;
  create: (accountId: string, nearYocto: bigint) => Promise<void>;
};

let merchantChain: MerchantChain | null = null;

/** Test seam. Production leaves this unset. */
export function setMerchantChainForTests(hooks: MerchantChain | null): void {
  merchantChain = hooks;
}

export function merchantAccountId(id: string): string {
  return `${id}.${config.rootAccount}`;
}

export function getMerchant(id: string): MerchantRow | undefined {
  return db
    .prepare(
      `SELECT id, account_id, enc_private_key, floated, created_at FROM merchants WHERE id = ?`,
    )
    .get(id) as MerchantRow | undefined;
}

export type MerchantKeyPlain = Partial<Record<(typeof MERCHANT_IDS)[number], string>>;

/**
 * Insert missing merchant key rows from plaintext ed25519 secrets.
 * Used when Render's SQLite was wiped but on-chain merchant accounts still exist.
 */
export function restoreMerchantKeys(keys: MerchantKeyPlain): { restored: string[]; skipped: string[] } {
  const restored: string[] = [];
  const skipped: string[] = [];
  const accountIds: Record<(typeof MERCHANT_IDS)[number], string> = {
    chef: config.merchantChef || merchantAccountId('chef'),
    smith: config.merchantSmith || merchantAccountId('smith'),
    dealer: config.merchantDealer || merchantAccountId('dealer'),
  };
  for (const id of MERCHANT_IDS) {
    if (getMerchant(id)) {
      skipped.push(id);
      continue;
    }
    const secret = keys[id]?.trim();
    if (!secret || !secret.startsWith('ed25519:')) {
      skipped.push(id);
      continue;
    }
    db.prepare(
      `INSERT INTO merchants (id, account_id, enc_private_key, floated, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(id, accountIds[id], encryptPrivateKey(secret), Date.now());
    restored.push(id);
  }
  if (restored.length) {
    console.log(`[merchants] restored key rows from env: ${restored.join(', ')}`);
  }
  const missing = MERCHANT_IDS.filter(id => !getMerchant(id));
  if (missing.length) {
    console.warn(
      `[merchants] missing custodial key rows (shops stay closed for buys): ${missing.join(', ')}. ` +
        `Set MERCHANT_CHEF_KEY / MERCHANT_SMITH_KEY / MERCHANT_DEALER_KEY or copy server/data merchants from local.`,
    );
  }
  // #region agent log
  fetch('http://127.0.0.1:7748/ingest/96276866-f022-4fea-afaf-a35cfcf1e196',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'094547'},body:JSON.stringify({sessionId:'094547',hypothesisId:'A',location:'merchants.ts:restoreMerchantKeys',message:'merchant key restore',data:{restored,skipped,missing,keyProvided:{chef:!!keys.chef,smith:!!keys.smith,dealer:!!keys.dealer}},timestamp:Date.now(),runId:'post-fix'})}).catch(()=>{});
  // #endregion
  return { restored, skipped };
}

/** Boot helper: restore from MERCHANT_*_KEY env when the SQLite merchants table is empty. */
export function ensureMerchantKeysFromEnv(): { restored: string[]; skipped: string[] } {
  return restoreMerchantKeys({
    chef: config.merchantChefKey,
    smith: config.merchantSmithKey,
    dealer: config.merchantDealerKey,
  });
}

/** Ops: which merchants have a custodial row (never returns key material). */
export function merchantKeyPresence(): Record<(typeof MERCHANT_IDS)[number], boolean> {
  return {
    chef: !!getMerchant('chef'),
    smith: !!getMerchant('smith'),
    dealer: !!getMerchant('dealer'),
  };
}

async function createMerchantAccount(id: string, accountId: string, publicKey: string): Promise<void> {
  if (merchantChain) {
    await merchantChain.create(accountId, MERCHANT_NEAR);
    return;
  }
  requireNearConfig();
  await enqueueTreasuryWrite(async () => {
    try {
      await getTreasuryAccount().createSubAccount({
        accountOrPrefix: id,
        publicKey,
        nearToTransfer: MERCHANT_NEAR,
      });
    } catch (err) {
      if (await accountExistsOnChain(accountId)) return;
      const cwe = new ChainWriteError({
        label: 'createSubAccount',
        account: accountId,
        amount: '0.1',
        cause: err,
      });
      recordChainFailure(cwe);
      throw cwe;
    }
  });
}

/**
 * Create chef, smith, and dealer under the players account.
 * An account or a stored key skips creation. A GD balance already at the float skips the mint.
 * The mint registers the receiver on the GD contract.
 * Player-to-player listings (`/market`) pay the seller account directly — not these merchants.
 */
export async function setupMerchants(): Promise<{
  created: string[];
  skipped: string[];
  balances: Record<(typeof MERCHANT_IDS)[number], string>;
}> {
  if (!config.rootAccount) throw new Error('ROOT_ACCOUNT is not set');
  const created: string[] = [];
  const skipped: string[] = [];
  for (const id of MERCHANT_IDS) {
    const accountId = merchantAccountId(id);
    const row = getMerchant(id);
    const exists = merchantChain
      ? await merchantChain.exists(accountId)
      : await accountExistsOnChain(accountId);
    if (exists || row) {
      skipped.push(accountId);
    } else {
      const keyPair = KeyPair.fromRandom('ed25519');
      db.prepare(
        `INSERT INTO merchants (id, account_id, enc_private_key, floated, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(id, accountId, encryptPrivateKey(keyPair.toString()), Date.now());
      await createMerchantAccount(id, accountId, keyPair.getPublicKey().toString());
      created.push(accountId);
    }
    const balance = await getGDBalance(accountId);
    if (balance < MERCHANT_FLOAT) await mintGD(accountId, MERCHANT_FLOAT);
  }
  const balances = {} as Record<(typeof MERCHANT_IDS)[number], string>;
  for (const id of MERCHANT_IDS) {
    const accountId = merchantAccountId(id);
    const balance = await getGDBalance(accountId);
    if (balance < MERCHANT_FLOAT) {
      throw new Error(`${id} holds ${balance.toString()} GD, below the ${MERCHANT_FLOAT.toString()} float`);
    }
    balances[id] = balance.toString();
  }
  return { created, skipped, balances };
}
