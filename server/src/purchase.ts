import { AuthError, assertCanSpend } from './auth';
import { getPlayerById } from './near/accounts';
import { flushPlayer } from './near/flush';
import { ftTransfer } from './near/gd';
import { getMerchant } from './near/merchants';

/** Move GD from a player to a merchant. Success means the transfer has landed. */
export async function purchase(
  playerId: string,
  merchantId: string,
  amount: bigint | number | string,
): Promise<{ ok: true }> {
  const amt = BigInt(amount);
  if (amt <= 0n) throw new AuthError('Amount must be positive', 400);
  const merchant = getMerchant(merchantId);
  if (!merchant) throw new AuthError('Unknown merchant', 400);
  await flushPlayer(playerId);
  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);
  await assertCanSpend(player, amt);
  await ftTransfer(playerId, merchant.account_id, amt);
  return { ok: true };
}
