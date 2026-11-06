import { KeyPair, type KeyPairString } from 'near-api-js';
import { randomId } from '../crypto';
import { config, requireNearConfig } from '../config';
import { db } from '../db';
import {
  accountExistsOnChain,
  enqueueTreasuryWrite,
  getTreasuryAccount,
  PLAYER_FUND_NEAR,
} from './client';
import { decryptPrivateKey, encryptPrivateKey } from './keys';
import { ChainWriteError, recordChainFailure } from './retry';

const PLAYER_COLS =
  'id, name, account_id, enc_private_key, status, gd_minted, xp_json, needs_json, pin_hash, pin_salt, pay_day, pay_used, followers';

/** 2–20 chars; lowercase letters/digits/-/_; must start and end with letter or digit. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,18}[a-z0-9]$/;

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    e.code === 'SQLITE_CONSTRAINT' ||
    (typeof e.message === 'string' && e.message.includes('UNIQUE constraint failed'))
  );
}

export function validatePlayerName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      'Invalid name: 2–20 lowercase letters, digits, -, or _; must start and end with a letter or digit',
    );
  }
}

/**
 * Creates `<name>.<ROOT_ACCOUNT>`, funds 0.05 NEAR from root.
 * Inserts status='pending' first, then creates on chain, then status='active'.
 * If the account already exists on chain and the row is pending, activates it.
 */
export async function createPlayerAccount(name: string): Promise<string> {
  requireNearConfig();
  validatePlayerName(name);

  const accountId = `${name}.${config.rootAccount}`;
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  const privateKey = keyPair.toString() as KeyPairString;
  const id = randomId();
  const enc = encryptPrivateKey(privateKey);

  try {
    db.prepare(
      `INSERT INTO players (id, name, google_sub, account_id, enc_private_key, status, created_at)
       VALUES (?, ?, NULL, ?, ?, 'pending', ?)`,
    ).run(id, name, accountId, enc, Date.now());
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new Error(`Duplicate player name or account: ${name}`);
    }
    throw err;
  }

  await enqueueTreasuryWrite(async () => {
    try {
      await getTreasuryAccount().createSubAccount({
        accountOrPrefix: name,
        publicKey,
        nearToTransfer: PLAYER_FUND_NEAR,
      });
    } catch (err) {
      if (await accountExistsOnChain(accountId)) {
        // Race / prior partial create: account is on chain, pending row is ours — activate.
        return;
      }
      const cwe = new ChainWriteError({
        label: 'createSubAccount',
        account: accountId,
        amount: '0.05',
        cause: err,
      });
      recordChainFailure(cwe);
      throw cwe;
    }
  });

  db.prepare(`UPDATE players SET status = 'active' WHERE id = ? AND status = 'pending'`).run(id);
  return accountId;
}

/**
 * Finish a pending row: retry subaccount creation with the stored key,
 * or mark active if the account is already on chain.
 */
export async function resumePendingAccount(name: string): Promise<string> {
  requireNearConfig();
  const row = getPlayerByName(name);
  if (!row?.account_id || !row.enc_private_key) throw new Error('No pending account to resume');
  if (row.status === 'active') return row.account_id;

  const privateKey = decryptPrivateKey(row.enc_private_key);
  const publicKey = KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
  const accountId = row.account_id;

  await enqueueTreasuryWrite(async () => {
    try {
      await getTreasuryAccount().createSubAccount({
        accountOrPrefix: name,
        publicKey,
        nearToTransfer: PLAYER_FUND_NEAR,
      });
    } catch (err) {
      if (await accountExistsOnChain(accountId)) return;
      const cwe = new ChainWriteError({
        label: 'createSubAccount',
        account: accountId,
        amount: '0.05',
        cause: err,
      });
      recordChainFailure(cwe);
      throw cwe;
    }
  });

  db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(row.id);
  return accountId;
}

export type PlayerRow = {
  id: string;
  name: string;
  account_id: string | null;
  enc_private_key: string | null;
  status: string;
  gd_minted: number;
  xp_json: string;
  needs_json: string;
  pin_hash: string | null;
  pin_salt: string | null;
  pay_day: string;
  pay_used: number;
  followers: number;
};

export function getPlayerById(id: string): PlayerRow | undefined {
  return db.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE id = ?`).get(id) as PlayerRow | undefined;
}

export function getPlayerByName(name: string): PlayerRow | undefined {
  return db.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE name = ?`).get(name) as PlayerRow | undefined;
}

export function getPlayerByAccountId(accountId: string): PlayerRow | undefined {
  return db.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE account_id = ?`).get(accountId) as
    | PlayerRow
    | undefined;
}
