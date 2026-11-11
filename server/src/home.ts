import { AuthError, fundsView } from './auth';
import { dealerItemSnapshot, quoteDealerItem } from './chef';
import { assertMerchantOpen } from './merchantGate';
import { getPlayerById } from './near/accounts';
import { syncNeedsDecay } from './needs';
import { ownsStudio, payMaintenance, purchase, type PurchaseResult } from './purchase';

function statusOf(result: PurchaseResult | undefined): 'delivered' | 'settling' | undefined {
  if (!result) return undefined;
  return 'ok' in result && result.ok ? 'delivered' : 'settling';
}

export type HomeResult = {
  studioStatus?: 'delivered' | 'settling';
  maintenanceStatus?: 'delivered' | 'settling';
  homePaidUntil: number;
  available: string;
  settling: string;
  needs: { energy: number; hunger: number };
  /** Quoted studio deed price when buying. */
  price?: number;
  stock?: number;
  demandEma?: number;
};

/** Buy the studio deed (dealer quote), then charge the first maintenance period. */
export async function homeBuy(playerId: string): Promise<HomeResult> {
  if (await ownsStudio(playerId)) throw new AuthError('You already own a studio', 409);
  syncNeedsDecay(playerId);
  await assertMerchantOpen('dealer');
  const quote = quoteDealerItem('studio-apartment');
  const studio = await purchase(playerId, 'studio-apartment', {
    amountGd: BigInt(quote.finalPrice),
  });
  let maintenance: PurchaseResult | undefined;
  if ('ok' in studio && studio.ok) {
    try {
      maintenance = await payMaintenance(playerId);
    } catch (err) {
      // Deed is kept. Player pays from /home/pay-rent. home_paid_until stays unchanged.
      if (!(err instanceof AuthError)) throw err;
    }
  }
  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);
  const funds = await fundsView(player);
  const after =
    'ok' in studio && studio.ok ? dealerItemSnapshot('studio-apartment') ?? quote : quote;
  return {
    studioStatus: statusOf(studio),
    maintenanceStatus: statusOf(maintenance),
    homePaidUntil: player.home_paid_until ?? 0,
    ...funds,
    needs: syncNeedsDecay(playerId),
    price: quote.finalPrice,
    stock: after.stock,
    demandEma: after.demandEma,
  };
}

/** Extend studio maintenance by one period. */
export async function homePayRent(playerId: string): Promise<HomeResult> {
  syncNeedsDecay(playerId);
  const maintenance = await payMaintenance(playerId);
  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);
  const funds = await fundsView(player);
  return {
    maintenanceStatus: statusOf(maintenance),
    homePaidUntil: player.home_paid_until ?? 0,
    ...funds,
    needs: syncNeedsDecay(playerId),
  };
}
