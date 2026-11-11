import { merchantShopOpen } from '@glitch/shared';
import { AuthError } from './auth';
import { getGDBalanceCached } from './near/gd';
import { getMerchant, MERCHANT_IDS } from './near/merchants';

export type MerchantId = (typeof MERCHANT_IDS)[number];

export const MERCHANT_CLOSED_MSG = 'Closed — merchant is out of GD';

export function isMerchantId(id: string): id is MerchantId {
  return (MERCHANT_IDS as readonly string[]).includes(id);
}

/** Throws when the merchant spendable GD is below MERCHANT_MIN_BALANCE. */
export async function assertMerchantOpen(merchantId: MerchantId): Promise<void> {
  const merchant = getMerchant(merchantId);
  if (!merchant) throw new AuthError(`${merchantId} is not set up`, 503);
  let bal = 0n;
  try {
    bal = BigInt(await getGDBalanceCached(merchant.account_id));
  } catch {
    bal = 0n;
  }
  if (!merchantShopOpen(bal)) throw new AuthError(MERCHANT_CLOSED_MSG, 400);
}
