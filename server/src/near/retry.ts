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
  override readonly cause: unknown;

  constructor(opts: {
    label: string;
    account?: string | null;
    amount?: string | null;
    cause: unknown;
  }) {
    const causeMsg = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    super(`Chain write failed [${opts.label}]: ${causeMsg}`);
    this.name = 'ChainWriteError';
    this.label = opts.label;
    this.account = opts.account ?? null;
    this.amount = opts.amount ?? null;
    this.cause = opts.cause;
  }
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
  ).run(failureId(), err.label, err.account, err.amount, err.message, Date.now());
  console.error(`[near] write failure logged: ${err.label} account=${err.account ?? '-'} ${err.message}`);
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
