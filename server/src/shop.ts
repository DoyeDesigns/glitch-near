import { catalogById, type ChefPriceReasoning } from '@glitch/shared';
import { AuthError, fundsView } from './auth';
import { chefFoodSnapshot, quoteChefFood } from './chef';
import { getPlayerById } from './near/accounts';
import { syncNeedsDecay } from './needs';
import { purchase } from './purchase';

export type ShopBuyResult = {
  status: 'delivered' | 'settling';
  purchaseId: string;
  available: string;
  settling: string;
  needs: { energy: number; hunger: number };
  /** Quoted food price when kind is food. */
  price?: number;
  reasoning?: ChefPriceReasoning;
  stock?: number;
  demandEma?: number;
};

/** Food or furniture only. Food charges the chef quote, not catalog priceGD. */
export async function shopBuy(playerId: string, itemId: string): Promise<ShopBuyResult> {
  const item = catalogById(itemId);
  if (!item || (item.kind !== 'food' && item.kind !== 'furniture')) {
    throw new AuthError('Unknown shop item', 400);
  }
  syncNeedsDecay(playerId);

  let quote: ReturnType<typeof quoteChefFood> | null = null;
  let result;
  if (item.kind === 'food') {
    quote = quoteChefFood(itemId);
    result = await purchase(playerId, itemId, { amountGd: BigInt(quote.finalPrice) });
  } else {
    result = await purchase(playerId, itemId);
  }

  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);
  const funds = await fundsView(player);
  const needs = syncNeedsDecay(playerId);
  const delivered = 'ok' in result && result.ok;
  const after = quote && delivered ? chefFoodSnapshot(itemId) ?? quote : quote;
  return {
    status: delivered ? 'delivered' : 'settling',
    purchaseId: result.purchaseId,
    ...funds,
    needs,
    ...(after
      ? {
          price: quote!.finalPrice,
          reasoning: after.reasoning,
          stock: after.stock,
          demandEma: after.demandEma,
        }
      : {}),
  };
}
