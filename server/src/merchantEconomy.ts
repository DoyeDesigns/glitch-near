import {
  MERCHANT_CITY_TRADES,
  cityTradePayment,
  merchantRestockPayment,
  pushFeed,
  type MerchantRoleId,
  type MerchantSupplyPayment,
} from '@glitch/shared';
import { getGDBalance } from './near/gd';
import { getMerchant, MERCHANT_IDS } from './near/merchants';
import { merchantFtTransfer } from './near/merchantTransfer';
import { world } from './sim';

export type SupplyHopResult = MerchantSupplyPayment & { ok: boolean };

export type MerchantLastTrade = MerchantSupplyPayment & { at: number };

const lastTradeByMerchant = new Map<MerchantRoleId, MerchantLastTrade>();

function labelName(id: MerchantRoleId): string {
  return id === 'chef' ? 'Chef' : id === 'smith' ? 'Smith' : 'Dealer';
}

export function getLastTrade(merchantId: MerchantRoleId): MerchantLastTrade | undefined {
  return lastTradeByMerchant.get(merchantId);
}

function recordHop(pay: MerchantSupplyPayment, ok: boolean): void {
  if (!ok) return;
  const at = Date.now();
  const entry = { ...pay, at };
  lastTradeByMerchant.set(pay.from, entry);
  lastTradeByMerchant.set(pay.to, entry);
  pushFeed(
    world,
    'sys',
    'NPC',
    `${labelName(pay.from)} paid ${labelName(pay.to)} ${pay.amount} GD (${pay.label}).`,
  );
}

async function payHop(pay: MerchantSupplyPayment): Promise<SupplyHopResult> {
  const payee = getMerchant(pay.to);
  if (!payee?.account_id) return { ...pay, ok: false };
  const outcome = await merchantFtTransfer(pay.from, payee.account_id, BigInt(pay.amount));
  const ok = outcome === 'success';
  recordHop(pay, ok);
  return { ...pay, ok };
}

/**
 * After inventory restock deltas, pay suppliers from merchant GD wallets.
 * Short hops are skipped; payer may fall below MERCHANT_MIN_BALANCE (shop closes).
 */
export async function settleRestockSupply(
  deltas: { merchantId: MerchantRoleId; stockGained: number }[],
): Promise<SupplyHopResult[]> {
  const results: SupplyHopResult[] = [];
  const gainedByMerchant = new Map<MerchantRoleId, number>();
  for (const d of deltas) {
    if (d.stockGained <= 0) continue;
    gainedByMerchant.set(d.merchantId, (gainedByMerchant.get(d.merchantId) ?? 0) + d.stockGained);
  }

  for (const id of MERCHANT_IDS) {
    const gained = gainedByMerchant.get(id) ?? 0;
    if (gained <= 0) continue;
    const payer = getMerchant(id);
    if (!payer?.account_id) continue;
    let available = 0n;
    try {
      available = await getGDBalance(payer.account_id);
    } catch {
      continue;
    }
    const due = merchantRestockPayment(id, gained, available);
    if (!due) continue;
    results.push(await payHop(due));
  }
  return results;
}

/**
 * Full triangle city trades (staff meals, ingredients, parts, tools, repairs).
 * Each hop leaves MERCHANT_MIN_BALANCE on the payer when possible.
 */
export async function settleCityTrades(): Promise<SupplyHopResult[]> {
  const results: SupplyHopResult[] = [];
  for (const edge of MERCHANT_CITY_TRADES) {
    const payer = getMerchant(edge.from);
    if (!payer?.account_id) continue;
    let available = 0n;
    try {
      available = await getGDBalance(payer.account_id);
    } catch {
      continue;
    }
    const due = cityTradePayment(edge, available);
    if (!due) continue;
    results.push(await payHop(due));
  }
  return results;
}

/** Sync inventories, settle restock supply pays, then city triangle trades. */
export async function runMerchantSupplyTick(now = Date.now()): Promise<SupplyHopResult[]> {
  const { syncMerchantInventoryWithDeltas } = await import('./chef');
  const deltas: { merchantId: MerchantRoleId; stockGained: number }[] = [];
  for (const id of MERCHANT_IDS) {
    deltas.push(...syncMerchantInventoryWithDeltas(id, now));
  }
  const restock = await settleRestockSupply(deltas);
  const city = await settleCityTrades();
  return [...restock, ...city];
}

/** Test helper: settle as if `stockGained` units were restored. */
export async function settleSupplyForTests(
  merchantId: MerchantRoleId,
  stockGained: number,
): Promise<SupplyHopResult[]> {
  return settleRestockSupply([{ merchantId, stockGained }]);
}

/** Test helper: clear last-trade memory. */
export function clearLastTradesForTests(): void {
  lastTradeByMerchant.clear();
}
