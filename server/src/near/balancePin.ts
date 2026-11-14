import { db } from '../db';

/** How long a known mint or transfer wins over a lagging ft/mt balance view. */
const PIN_MS = 120_000;

type PinRow = { basis: string; offset: string; until_ms: number };

function readPin(accountId: string, tokenId: string): PinRow | undefined {
  return db
    .prepare(
      `SELECT basis, offset, until_ms FROM balance_pins WHERE account_id = ? AND token_id = ?`,
    )
    .get(accountId, tokenId) as PinRow | undefined;
}

/**
 * Remember a balance change we already applied.
 * `basis` is the last balance before this delta. Later chain reads that still
 * show the old number keep serving basis + offset until they catch up.
 * Returns the balance to show.
 */
export function addBalancePin(accountId: string, tokenId: string, basis: string, delta: bigint): string {
  const existing = readPin(accountId, tokenId);
  const base = existing?.basis ?? basis;
  const offset = (existing ? BigInt(existing.offset) : 0n) + delta;
  const until = Date.now() + PIN_MS;
  db.prepare(
    `INSERT INTO balance_pins (account_id, token_id, basis, offset, until_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, token_id) DO UPDATE SET
       basis = excluded.basis,
       offset = excluded.offset,
       until_ms = excluded.until_ms`,
  ).run(accountId, tokenId, base, offset.toString(), until);
  const next = BigInt(base) + offset;
  return (next < 0n ? 0n : next).toString();
}

/** Chain view vs the pin. A caught-up view drops the pin and wins. */
export function reconcileBalancePin(accountId: string, tokenId: string, chain: bigint): bigint {
  const row = readPin(accountId, tokenId);
  if (!row) return chain;
  if (row.until_ms <= Date.now()) {
    db.prepare(`DELETE FROM balance_pins WHERE account_id = ? AND token_id = ?`).run(accountId, tokenId);
    return chain;
  }
  const offset = BigInt(row.offset);
  const expected = BigInt(row.basis) + offset;
  const caughtUp =
    offset === 0n || (offset > 0n ? chain >= expected : chain <= expected);
  if (caughtUp) {
    db.prepare(`DELETE FROM balance_pins WHERE account_id = ? AND token_id = ?`).run(accountId, tokenId);
    return chain;
  }
  return expected < 0n ? 0n : expected;
}
