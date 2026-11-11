import { catalogById, type ChefPriceReasoning } from '@glitch/shared';
import { AuthError, fundsView } from './auth';
import {
  chefFoodSnapshot,
  dealerItemSnapshot,
  quoteChefFood,
  quoteDealerItem,
} from './chef';
import { getPlayerById } from './near/accounts';
import { syncNeedsDecay } from './needs';
import { purchase } from './purchase';

export type ShopBuyResult = {
  status: 'delivered' | 'settling';
  purchaseId: string;
  available: string;
  settling: string;
  needs: { energy: number; hunger: number };
  /** Quoted merchant price when food or furniture. */
  price?: number;
  reasoning?: ChefPriceReasoning;
  stock?: number;
  demandEma?: number;
};

/** Food or furniture. Charges the merchant quote, not catalog list price. */
export async function shopBuy(playerId: string, itemId: string): Promise<ShopBuyResult> {
  const item = catalogById(itemId);
  if (!item || (item.kind !== 'food' && item.kind !== 'furniture')) {
    throw new AuthError('Unknown shop item', 400);
  }
  syncNeedsDecay(playerId);

  const quote = item.kind === 'food' ? quoteChefFood(itemId) : quoteDealerItem(itemId);
  const result = await purchase(playerId, itemId, { amountGd: BigInt(quote.finalPrice) });

  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);
  const funds = await fundsView(player);
  const needs = syncNeedsDecay(playerId);
  const delivered = 'ok' in result && result.ok;
  const after = delivered
    ? item.kind === 'food'
      ? chefFoodSnapshot(itemId) ?? quote
      : dealerItemSnapshot(itemId) ?? quote
    : quote;
  return {
    status: delivered ? 'delivered' : 'settling',
    purchaseId: result.purchaseId,
    ...funds,
    needs,
    price: quote.finalPrice,
    reasoning: after.reasoning,
    stock: after.stock,
    demandEma: after.demandEma,
  };
}
