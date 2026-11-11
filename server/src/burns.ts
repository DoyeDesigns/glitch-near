import {
  ciaFineGd,
  GAS_GD,
  holdingTaxCharge,
  UPKEEP_INTERVAL_S,
} from '@glitch/shared';
import { AuthError, balanceParts, fundsView } from './auth';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById } from './near/accounts';

/** Insert a pending burn row. No-op when amount is 0. */
export function enqueueBurn(
  playerId: string,
  amount: bigint,
  reason: string,
  id: string = randomId(),
): void {
  if (amount <= 0n) return;
  db.prepare(
    `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, playerId, amount.toString(), reason, Date.now());
}

/**
 * Accrue holding tax for elapsed UPKEEP_INTERVAL_S ticks.
 * Seeds last_upkeep_at on first call. Cap: never charges more than available.
 */
export async function applyHoldingTax(playerId: string, now = Date.now()): Promise<number> {
  const player = getPlayerById(playerId);
  if (!player?.account_id) return 0;

  const last = player.last_upkeep_at ?? 0;
  if (last <= 0) {
    db.prepare(`UPDATE players SET last_upkeep_at = ? WHERE id = ?`).run(now, playerId);
    return 0;
  }

  const intervalMs = UPKEEP_INTERVAL_S * 1000;
  const ticks = Math.floor((now - last) / intervalMs);
  if (ticks <= 0) return 0;

  const parts = await balanceParts(player);
  const total = holdingTaxCharge(parts.available, ticks);
  const nextAt = last + ticks * intervalMs;

  const apply = db.transaction(() => {
    if (total > 0) {
      enqueueBurn(playerId, BigInt(total), 'upkeep', `upkeep-${playerId}-${nextAt}`);
    }
    db.prepare(`UPDATE players SET last_upkeep_at = ? WHERE id = ?`).run(nextAt, playerId);
  });
  apply.immediate();
  return total;
}

/** Fast travel gas: pending burn GAS_GD or 400 if available is short. */
export async function chargeTravel(playerId: string): Promise<{ available: string; settling: string }> {
  await applyHoldingTax(playerId);
  const player = getPlayerById(playerId);
  if (!player?.account_id) throw new AuthError('Player has no account', 503);

  const parts = await balanceParts(player);
  const gas = BigInt(GAS_GD);
  if (parts.available < gas) throw new AuthError('Not enough GD to travel', 400);

  enqueueBurn(playerId, gas, 'travel-gas', `travel-${randomId()}`);
  const fresh = getPlayerById(playerId) ?? player;
  return fundsView(fresh);
}

/** CIA guilty fine as pending burn; returns charged GD (0 if none). */
export async function chargeCiaFine(
  playerId: string,
  loot: number,
  caseNo: number,
): Promise<number> {
  const player = getPlayerById(playerId);
  if (!player?.account_id) return 0;
  await applyHoldingTax(playerId);
  const fresh = getPlayerById(playerId) ?? player;
  const parts = await balanceParts(fresh);
  const fine = ciaFineGd(parts.available, loot);
  if (fine > 0) {
    enqueueBurn(playerId, BigInt(fine), 'cia-fine', `cia-${caseNo}-${playerId}`);
  }
  return fine;
}
