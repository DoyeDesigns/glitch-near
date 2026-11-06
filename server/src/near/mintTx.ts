import { Account, actions, baseEncode, KeyPairSigner, type KeyPairString, type SignedTransaction } from 'near-api-js';
import { config, requireNearConfig } from '../config';
import { DEFAULT_GAS, enqueueTreasuryWrite, getProvider, getTreasuryAccount } from './client';

/** How long an unseen transaction hash is left alone before a fresh one is signed. */
export const MINT_UNKNOWN_WAIT_MS = 3 * 60 * 1000;

export type TxLookup = 'success' | 'failure' | 'unknown';

type SignedCall = { hash: string; signed: SignedTransaction };

let testSign: (() => Promise<SignedCall>) | null = null;
let testBroadcast: ((hash: string) => Promise<TxLookup>) | null = null;
let testLookup: ((hash: string) => Promise<TxLookup>) | null = null;

/** Test seam. Production leaves this unset and uses near-api-js. */
export function setMintTxTestHooks(
  hooks: {
    sign?: () => Promise<SignedCall>;
    broadcast?: (hash: string) => Promise<TxLookup>;
    lookup?: (hash: string) => Promise<TxLookup>;
  } | null,
): void {
  testSign = hooks?.sign ?? null;
  testBroadcast = hooks?.broadcast ?? null;
  testLookup = hooks?.lookup ?? null;
}

/**
 * Success sets the minted flag. Failure may sign one fresh transaction
 * (attempts already includes the failed send). Unknown waits 3 minutes,
 * then a fresh transaction is signed. A missing hash is the first send.
 */
export function nextMintStep(row: {
  flag: number;
  hash: string | null;
  txAt: number | null;
  attempts: number;
  status: TxLookup | null;
  now: number;
}): 'skip' | 'mark' | 'wait' | 'fresh' {
  if (row.flag === 1) return 'skip';
  if (!row.hash) return 'fresh';
  if (row.status === 'success') return 'mark';
  if (row.status === 'failure') return row.attempts >= 2 ? 'skip' : 'fresh';
  const age = row.txAt == null ? 0 : row.now - row.txAt;
  return age >= MINT_UNKNOWN_WAIT_MS ? 'fresh' : 'wait';
}

export function classifyTxStatus(status: unknown): TxLookup {
  if (typeof status === 'string') return status === 'Failure' ? 'failure' : 'unknown';
  if (status && typeof status === 'object') {
    if ('SuccessValue' in status || 'SuccessReceiptId' in status) return 'success';
    if ('Failure' in status) return 'failure';
  }
  return 'unknown';
}

/**
 * Sign with the treasury key. The hash is sha256 of the unsigned transaction,
 * which is what `viewTransactionStatus` looks up. Signed bytes are returned
 * to the caller and are not stored.
 */
export async function signTreasuryCall(
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<SignedCall> {
  if (testSign) return testSign();
  requireNearConfig();
  const signer = KeyPairSigner.fromSecretKey(config.treasuryKey as KeyPairString);
  const account = getTreasuryAccount();
  const action = actions.functionCall(methodName, args, DEFAULT_GAS, 0n);
  const tx = await account.createTransaction({
    receiverId: contractId,
    actions: [action],
    publicKey: await signer.getPublicKey(),
  });
  const { txHash, signedTransaction } = await signer.signTransaction(tx);
  return { hash: baseEncode(txHash), signed: signedTransaction };
}

/** Broadcast once. Callers must not keep the signed transaction for a later send. */
export async function broadcastSigned(signed: SignedTransaction, hash: string): Promise<TxLookup> {
  if (testBroadcast) return testBroadcast(hash);
  const res = await getProvider().sendTransaction(signed);
  return classifyTxStatus(res.status);
}

/** Point query for a stored hash and the account that signed it. */
export async function lookupSignedTx(hash: string, signerAccountId = config.rootAccount): Promise<TxLookup> {
  if (testLookup) return testLookup(hash);
  try {
    const res = await getProvider().viewTransactionStatus({
      txHash: hash,
      accountId: signerAccountId,
    });
    return classifyTxStatus(res.status);
  } catch {
    return 'unknown';
  }
}

/** Last player-signed call, so tests can see the method and deposit. */
export let lastSignedCall: {
  methodName: string;
  deposit: bigint;
  args: Record<string, unknown>;
} | null = null;

/**
 * Sign with an account's own key. near-api-js builds the signer from the
 * Account(accountId, provider, secretKey) constructor, then
 * KeyPairSigner.fromSecretKey signs the unsigned transaction.
 */
export async function signAccountCall(opts: {
  accountId: string;
  secretKey: KeyPairString;
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit: bigint;
}): Promise<SignedCall> {
  lastSignedCall = { methodName: opts.methodName, deposit: opts.deposit, args: opts.args };
  if (testSign) return testSign();
  requireNearConfig();
  const signer = KeyPairSigner.fromSecretKey(opts.secretKey);
  const account = new Account(opts.accountId, getProvider(), opts.secretKey);
  const action = actions.functionCall(opts.methodName, opts.args, DEFAULT_GAS, opts.deposit);
  const tx = await account.createTransaction({
    receiverId: opts.contractId,
    actions: [action],
    publicKey: await signer.getPublicKey(),
  });
  const { txHash, signedTransaction } = await signer.signTransaction(tx);
  return { hash: baseEncode(txHash), signed: signedTransaction };
}

/**
 * Persist the hash, then broadcast. The signed transaction is dropped after
 * this returns, so a resume can never rebroadcast the same bytes.
 */
/** Persist the hash, then broadcast once. Signed bytes are not stored. */
export async function deliverSigned(opts: {
  sign: () => Promise<SignedCall>;
  persistHash: (hash: string, at: number) => void;
}): Promise<TxLookup> {
  const signed = await opts.sign();
  opts.persistHash(signed.hash, Date.now());
  return broadcastSigned(signed.signed, signed.hash);
}

export async function deliverMint(opts: {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  persistHash: (hash: string, at: number) => void;
}): Promise<TxLookup> {
  return enqueueTreasuryWrite(() =>
    deliverSigned({
      sign: () => signTreasuryCall(opts.contractId, opts.methodName, opts.args),
      persistHash: opts.persistHash,
    }),
  );
}

/**
 * Look up a stored hash, or sign a fresh mint. Never broadcasts a stored
 * signed transaction, because only the hash is kept.
 */
export async function resumeOrSend(row: {
  flag: number;
  hash: string | null;
  txAt: number | null;
  attempts: number;
}, actions: {
  mark: () => void;
  persist: (hash: string, at: number, attempts: number) => void;
  call: { contractId: string; methodName: string; args: Record<string, unknown> };
}): Promise<void> {
  if (row.flag === 1) return;
  const now = Date.now();
  const status = row.hash ? await lookupSignedTx(row.hash) : null;
  const step = nextMintStep({ ...row, status, now });
  if (step === 'skip' || step === 'wait') return;
  if (step === 'mark') {
    actions.mark();
    return;
  }
  const attempts = row.attempts + 1;
  const outcome = await deliverMint({
    ...actions.call,
    persistHash: (hash, at) => actions.persist(hash, at, attempts),
  });
  if (outcome === 'success') actions.mark();
}
