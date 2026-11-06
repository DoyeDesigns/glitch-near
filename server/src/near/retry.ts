import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db';
import { enqueueTreasuryWrite } from './client';

const READ_ATTEMPTS = 3;
const BASE_MS = 250;

export type ChainRetryOpts = {
  /** true = view/read (up to 3 attempts). false = write (exactly 1 attempt, never retry). */
  idempotent: boolean;
  label?: string;
  account?: string | null;
  amount?: string | null;
};

export class ChainWriteError extends Error {
  readonly label: string;
  readonly account: string | null;
  readonly amount: string | null;
  readonly hash: string;
  readonly kind: string;

  constructor(opts: {
    label: string;
    account?: string | null;
    amount?: string | null;
    cause: unknown;
  }) {
    const summary = summarizeChainError(opts.cause);
    super(`Chain write failed [${opts.label}]: ${summary.brief}`);
    this.name = 'ChainWriteError';
    this.label = opts.label;
    this.account = opts.account ?? null;
    this.amount = opts.amount ?? null;
    this.hash = summary.hash;
    this.kind = summary.kind;
  }
}

function isBrief(text: string): boolean {
  return text.length > 0 && text.length <= 120 && !text.includes('{') && !/transactionResult|transaction_outcome/.test(text);
}

function txHashOf(cause: unknown): string {
  if (!cause || typeof cause !== 'object') return '-';
  const row = cause as {
    txHash?: unknown;
    context?: { transactionHash?: unknown };
    transactionResult?: { transaction_outcome?: { id?: unknown } };
  };
  if (typeof row.txHash === 'string' && row.txHash) return row.txHash;
  if (typeof row.context?.transactionHash === 'string' && row.context.transactionHash) return row.context.transactionHash;
  const id = row.transactionResult?.transaction_outcome?.id;
  if (typeof id === 'string' && id) return id;
  return '-';
}

function failureKind(cause: unknown): string {
  if (!cause || typeof cause !== 'object') return '';
  const failure = (cause as { transactionResult?: { status?: { Failure?: unknown } } }).transactionResult?.status
    ?.Failure;
  if (!failure || typeof failure !== 'object') return '';
  return Object.keys(failure)[0] ?? '';
}

/** Label fields only. The RPC transactionResult object is not kept. */
export function summarizeChainError(cause: unknown): { hash: string; kind: string; brief: string } {
  const hash = txHashOf(cause);
  const name = cause instanceof Error && cause.name && cause.name !== 'Error' ? cause.name : '';
  const message = cause instanceof Error ? cause.message : '';
  const kind = name || failureKind(cause) || (isBrief(message) ? message : 'Error');
  const brief = isBrief(message) ? message : kind;
  return { hash, kind, brief };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function failureId(): string {
  return createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 24);
}

/** Persist a failed write for later reconciliation. Never logs private keys. */
export function recordChainFailure(err: ChainWriteError): void {
  db.prepare(
    `INSERT INTO chain_failures (id, label, account, amount, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(failureId(), err.label, err.account, err.amount, failureLine(err), Date.now());
  console.error(failureLine(err));
}

function failureLine(err: ChainWriteError): string {
  return `[near] write failure label=${err.label} account=${err.account ?? '-'} hash=${err.hash} kind=${err.kind}`;
}

/**
 * Wrap chain calls.
 * Reads (`idempotent: true`): up to 3 attempts with backoff.
 * Writes (`idempotent: false`): exactly 1 attempt, single-flight via treasury queue;
 * on failure throw ChainWriteError and insert into chain_failures.
 */
export async function withChainRetry<T>(fn: () => Promise<T>, opts: ChainRetryOpts): Promise<T> {
  const label = opts.label ?? 'near';

  if (opts.idempotent) {
    let last: unknown;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[near] ${label} attempt ${attempt}/${READ_ATTEMPTS} failed: ${msg}`);
        if (attempt < READ_ATTEMPTS) await sleep(BASE_MS * 2 ** (attempt - 1));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  return enqueueTreasuryWrite(async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ChainWriteError) throw err;
      const cwe = new ChainWriteError({
        label,
        account: opts.account,
        amount: opts.amount,
        cause: err,
      });
      recordChainFailure(cwe);
      throw cwe;
    }
  });
}
