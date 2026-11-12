import {
  MERCHANT_CITY_TRADES,
  cityTradePayment,
  merchantRestockPayment,
  pushFeed,
  type MerchantRoleId,
  type MerchantSupplyPayment,
} from '@glitch/shared';
import {
  clearLatestCityTrade,
  formatCityTradeLine,
  getLatestCityTrade,
  setLatestCityTrade,
  type CityTradeHop,
} from './cityTradeState';
import { db } from './db';
import { getGDBalanceCached } from './near/gd';
import { getMerchant, MERCHANT_IDS } from './near/merchants';
import { merchantFtTransfer } from './near/merchantTransfer';
import { world } from './sim';

export type SupplyHopResult = MerchantSupplyPayment & { ok: boolean };

export type MerchantLastTrade = MerchantSupplyPayment & { at: number };

const LAST_TRADE_KEY = 'merchant_last_city_trade';

const lastTradeByMerchant = new Map<MerchantRoleId, MerchantLastTrade>();

function loadPersistedLastTrade(): void {
  try {
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(LAST_TRADE_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return;
    const parsed = JSON.parse(row.value) as MerchantLastTrade;
    if (!parsed?.from || !parsed?.to || !parsed?.amount || !parsed?.at) return;
    setLatestCityTrade(parsed);
    lastTradeByMerchant.set(parsed.from, parsed);
    lastTradeByMerchant.set(parsed.to, parsed);
  } catch {
    /* ignore corrupt row */
  }
}

function persistLastTrade(entry: MerchantLastTrade): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(LAST_TRADE_KEY, JSON.stringify(entry));
}

loadPersistedLastTrade();

export function getLastTrade(merchantId: MerchantRoleId): MerchantLastTrade | undefined {
  return lastTradeByMerchant.get(merchantId) ?? (getLatestCityTrade() as MerchantLastTrade | undefined);
}

export { getLatestCityTrade, formatCityTradeLine };

function recordHop(pay: MerchantSupplyPayment, ok: boolean): void {
  if (!ok) return;
  const at = Date.now();
  const entry: MerchantLastTrade = { ...pay, at };
  setLatestCityTrade(entry as CityTradeHop);
  lastTradeByMerchant.set(pay.from, entry);
  lastTradeByMerchant.set(pay.to, entry);
  try {
    persistLastTrade(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[merchants] could not persist last trade: ${msg.slice(0, 120)}`);
  }
  pushFeed(world, 'sys', 'NPC', formatCityTradeLine(entry));
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
      available = BigInt(await getGDBalanceCached(payer.account_id));
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
      available = BigInt(await getGDBalanceCached(payer.account_id));
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
  clearLatestCityTrade();
  db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(LAST_TRADE_KEY);
}
