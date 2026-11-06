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
