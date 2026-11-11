import { catalogById, MAINTENANCE_GD, MAINTENANCE_MS, merchantShopOpen } from '@glitch/shared';
import { AuthError, fundsView, ledgerTotals } from './auth';
import { config } from './config';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById } from './near/accounts';
import { flushPlayer } from './near/flush';
import { getGDBalanceCached, pushTransfer, type TransferOutcome } from './near/gd';
import { getItemBalances } from './near/items';
import { getMerchant } from './near/merchants';
import { resumeOrSend } from './near/mintTx';
import { recordChefFoodSale, recordDealerSale } from './chef';
import { assertMerchantOpen, isMerchantId, type MerchantId } from './merchantGate';
import { parseNeeds, syncNeedsDecay, writeNeeds } from './needs';

export type PurchaseRow = {
  id: string;
  player_id: string;
  merchant_id: string;
  item_id: string;
  amount: string;
  outbox_id: string;
  status: string;
  delivered: number;
  deliver_tx_hash: string | null;
  deliver_tx_at: number | null;
  deliver_attempts: number;
  created_at: number;
};

export type PurchaseResult =
  | { ok: true; purchaseId: string; status: 'delivered' }
  | { settling: true; purchaseId: string };

const PURCHASE_COLS =
  'id, player_id, merchant_id, item_id, amount, outbox_id, status, delivered, deliver_tx_hash, deliver_tx_at, deliver_attempts, created_at';

const MAINTENANCE_ITEM = 'maintenance';
/** Pay-then-deliver GD top-up to a merchant; no item mint. */
export const INVEST_ITEM = 'invest';

function getPurchase(id: string): PurchaseRow | undefined {
  return db.prepare(`SELECT ${PURCHASE_COLS} FROM purchases WHERE id = ?`).get(id) as PurchaseRow | undefined;
}

function markFailed(purchaseId: string): void {
  const apply = db.transaction(() => {
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(purchaseId);
    db.prepare(`UPDATE purchases SET status = 'failed' WHERE id = ? AND status = 'paying'`).run(purchaseId);
  });
  apply.immediate();
}

function markPaid(purchaseId: string): void {
  const apply = db.transaction(() => {
    const row = getPurchase(purchaseId);
    if (!row || row.status !== 'paying') return;
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(purchaseId);
    db.prepare(`UPDATE purchases SET status = 'paid' WHERE id = ? AND status = 'paying'`).run(purchaseId);
  });
  apply.immediate();
}

function extendHomePaidUntil(playerId: string, now = Date.now()): void {
  const row = getPlayerById(playerId);
  const paidUntil = row?.home_paid_until ?? 0;
  const next = Math.max(now, paidUntil) + MAINTENANCE_MS;
  db.prepare(`UPDATE players SET home_paid_until = ? WHERE id = ?`).run(next, playerId);
}

/** Studio deed on chain or a delivered studio purchase. */
export async function ownsStudio(playerId: string): Promise<boolean> {
  const delivered = db
    .prepare(
      `SELECT id FROM purchases
       WHERE player_id = ? AND item_id = 'studio-apartment' AND delivered = 1
       LIMIT 1`,
    )
    .get(playerId) as { id: string } | undefined;
  if (delivered) return true;
  const player = getPlayerById(playerId);
  if (!player?.account_id) return false;
  try {
    const items = await getItemBalances(player.account_id);
    return BigInt(items['studio-apartment'] ?? '0') > 0n;
  } catch {
    return false;
  }
}

/**
 * Deliver a paid purchase once. Food updates needs. Furniture/house mints the item.
 * Maintenance extends home_paid_until. Mint uses the existing tx-hash resume path.
 */
async function deliverPurchase(purchaseId: string): Promise<boolean> {
  const row = getPurchase(purchaseId);
  if (!row) return false;
  if (row.delivered === 1 || row.status === 'delivered') return true;
  if (row.status !== 'paid' && row.status !== 'paying') return false;
  if (row.status === 'paying') markPaid(purchaseId);
  const paid = getPurchase(purchaseId);
  if (!paid || paid.status !== 'paid' || paid.delivered === 1) {
    return getPurchase(purchaseId)?.delivered === 1;
  }

  const player = getPlayerById(paid.player_id);
  if (!player?.account_id) throw new Error('Player has no account');

  if (paid.item_id === MAINTENANCE_ITEM) {
    const apply = db.transaction(() => {
      const fresh = getPurchase(purchaseId);
      if (!fresh || fresh.delivered === 1) return;
      extendHomePaidUntil(paid.player_id);
      db.prepare(
        `UPDATE purchases SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
      ).run(purchaseId);
    });
    apply.immediate();
    return getPurchase(purchaseId)?.delivered === 1;
  }

  if (paid.item_id === INVEST_ITEM) {
    const apply = db.transaction(() => {
      const fresh = getPurchase(purchaseId);
      if (!fresh || fresh.delivered === 1) return;
      db.prepare(
        `UPDATE purchases SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
      ).run(purchaseId);
    });
    apply.immediate();
    return getPurchase(purchaseId)?.delivered === 1;
  }

  const item = catalogById(paid.item_id);
  if (!item) throw new Error(`Unknown item ${paid.item_id}`);

  if (item.kind === 'food') {
    const apply = db.transaction(() => {
      const fresh = getPurchase(purchaseId);
      if (!fresh || fresh.delivered === 1) return;
      syncNeedsDecay(paid.player_id);
      const needs = parseNeeds(
        (
          db.prepare(`SELECT needs_json FROM players WHERE id = ?`).get(paid.player_id) as
            | { needs_json: string }
            | undefined
        )?.needs_json ?? '{"energy":100,"hunger":80}',
      );
      const hunger = Math.min(100, needs.hunger + (item.effect.hunger ?? 0));
      const energy = Math.min(100, needs.energy + (item.effect.energy ?? 0));
      writeNeeds(paid.player_id, { energy, hunger });
      recordChefFoodSale(paid.item_id);
      db.prepare(
        `UPDATE purchases SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
      ).run(purchaseId);
    });
    apply.immediate();
    return getPurchase(purchaseId)?.delivered === 1;
  }

  if (item.kind !== 'furniture' && item.kind !== 'house') {
    throw new AuthError('Item cannot be purchased this way', 400);
  }

  if (!config.itemsContract) throw new Error('ITEMS_CONTRACT not set');
  await resumeOrSend(
    {
      flag: paid.delivered,
      hash: paid.deliver_tx_hash,
      txAt: paid.deliver_tx_at,
      attempts: paid.deliver_attempts ?? 0,
    },
    {
      mark: () => {
        const apply = db.transaction(() => {
          const fresh = getPurchase(purchaseId);
          if (!fresh || fresh.delivered === 1) return;
          recordDealerSale(paid.item_id);
          db.prepare(
            `UPDATE purchases SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
          ).run(purchaseId);
        });
        apply.immediate();
      },
      persist: (hash, at, attempts) => {
        db.prepare(
          `UPDATE purchases SET deliver_tx_hash = ?, deliver_tx_at = ?, deliver_attempts = ? WHERE id = ?`,
        ).run(hash, at, attempts, purchaseId);
      },
      call: {
        contractId: config.itemsContract,
        methodName: 'mint',
        args: { account_id: player.account_id, token_id: item.id, amount: '1' },
      },
    },
  );
  return getPurchase(purchaseId)?.delivered === 1;
}

async function settleOutcome(purchaseId: string, outcome: TransferOutcome): Promise<PurchaseResult> {
  if (outcome === 'success') {
    markPaid(purchaseId);
    const delivered = await deliverPurchase(purchaseId);
    if (!delivered) return { settling: true, purchaseId };
    return { ok: true, purchaseId, status: 'delivered' };
  }
  if (outcome === 'failure') {
    markFailed(purchaseId);
    throw new AuthError('Purchase failed on chain', 400);
  }
  return { settling: true, purchaseId };
}

async function reserveAndTransfer(opts: {
  playerId: string;
  merchantId: string;
  merchantAccountId: string;
  itemId: string;
  amount: bigint;
}): Promise<PurchaseResult> {
  const { playerId, merchantId, merchantAccountId, itemId, amount } = opts;
  if (amount <= 0n) throw new AuthError('Amount must be positive', 400);

  await flushPlayer(playerId);
  const player = getPlayerById(playerId);
  if (!player?.account_id) throw new AuthError('Player not found', 400);
  const chain = BigInt(await getGDBalanceCached(player.account_id));

  const purchaseId = randomId();
  const outboxId = randomId();
  const now = Date.now();
  const reserve = db.transaction(() => {
    const held = ledgerTotals(playerId);
    const spendable = chain - held.pending - held.escrowed;
    if (spendable < amount) {
      if (spendable + held.settling >= amount) {
        throw new AuthError('Winnings are still landing on chain. Wait and try again.', 400);
      }
      throw new AuthError('Not enough GD', 400);
    }
    db.prepare(
      `INSERT INTO escrow (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, 'purchase', ?)`,
    ).run(purchaseId, playerId, amount.toString(), now);
    db.prepare(
      `INSERT INTO outbox (id, player_id, kind, payload, status, created_at, attempts)
       VALUES (?, ?, 'ft_transfer', ?, 'pending', ?, 0)`,
    ).run(
      outboxId,
      playerId,
      JSON.stringify({ to: merchantAccountId, amount: amount.toString(), memo: 'glitch' }),
      now,
    );
    db.prepare(
      `INSERT INTO purchases (id, player_id, merchant_id, item_id, amount, outbox_id, status, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'paying', 0, ?)`,
    ).run(purchaseId, playerId, merchantId, itemId, amount.toString(), outboxId, now);
  });
  try {
    reserve.immediate();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw err;
  }

  const outcome = await pushTransfer(outboxId);
  return settleOutcome(purchaseId, outcome);
}

/**
 * Pay a catalog item. Reserves spend in one immediate SQLite transaction, then
 * transfers GD to the merchant. Success means paid and delivered. An ambiguous
 * transfer keeps the escrow and returns settling.
 * Food / furniture / studio may pass `amountGd` from the merchant quote;
 * otherwise catalog `priceGD`.
 */
export async function purchase(
  playerId: string,
  itemId: string,
  opts?: { amountGd?: bigint },
): Promise<PurchaseResult> {
  const item = catalogById(itemId);
  if (!item || item.priceGD == null) throw new AuthError('Unknown item', 400);
  if (item.sellerId !== 'chef' && item.sellerId !== 'smith' && item.sellerId !== 'dealer') {
    throw new AuthError('Item has no merchant', 400);
  }
  if (item.kind === 'gear' || item.kind === 'shard' || item.kind === 'consumable') {
    throw new AuthError('Item cannot be purchased this way', 400);
  }
  const amount = opts?.amountGd ?? BigInt(item.priceGD);
  if (amount <= 0n) throw new AuthError('Amount must be positive', 400);
  const merchant = getMerchant(item.sellerId);
  if (!merchant) throw new AuthError('Unknown merchant', 400);
  return reserveAndTransfer({
    playerId,
    merchantId: item.sellerId,
    merchantAccountId: merchant.account_id,
    itemId: item.id,
    amount,
  });
}

/** Pay MAINTENANCE_GD to the dealer. Extends home_paid_until when the transfer lands. */
export async function payMaintenance(playerId: string): Promise<PurchaseResult> {
  const merchant = getMerchant('dealer');
  if (!merchant) throw new AuthError('Unknown merchant', 400);
  await assertMerchantOpen('dealer');
  if (!(await ownsStudio(playerId))) throw new AuthError('You do not own a studio', 400);
  return reserveAndTransfer({
    playerId,
    merchantId: 'dealer',
    merchantAccountId: merchant.account_id,
    itemId: MAINTENANCE_ITEM,
    amount: BigInt(MAINTENANCE_GD),
  });
}

/** Invest outcome + HUD funds. `settling` is the funds string (not PurchaseResult's settling flag). */
export type MerchantInvestResult = {
  purchaseId: string;
  status: 'delivered' | 'settling';
  closed: boolean;
  gdBalance: string;
  available: string;
  settling: string;
};

/** Player pays GD to a merchant wallet so the shop can reopen at MERCHANT_MIN_BALANCE. */
export async function investInMerchant(
  playerId: string,
  merchantId: string,
  amount: bigint,
): Promise<MerchantInvestResult> {
  if (!isMerchantId(merchantId)) throw new AuthError('Unknown merchant', 400);
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AuthError('Amount must be positive', 400);
  }
  const merchant = getMerchant(merchantId as MerchantId);
  if (!merchant) throw new AuthError(`${merchantId} is not set up`, 503);

  const result = await reserveAndTransfer({
    playerId,
    merchantId,
    merchantAccountId: merchant.account_id,
    itemId: INVEST_ITEM,
    amount,
  });

  let gdBalance = '0';
  try {
    gdBalance = await getGDBalanceCached(merchant.account_id);
  } catch {
    gdBalance = '0';
  }
  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);
  const funds = await fundsView(player);
  return {
    purchaseId: result.purchaseId,
    status: 'ok' in result ? 'delivered' : 'settling',
    closed: !merchantShopOpen(gdBalance),
    gdBalance,
    ...funds,
  };
}

/**
 * Paying purchases whose transfer has landed become paid and are delivered once.
 * Paid rows that still need delivery are finished the same way.
 */
export async function resumePurchases(): Promise<void> {
  const paying = db
    .prepare(`SELECT ${PURCHASE_COLS} FROM purchases WHERE status = 'paying'`)
    .all() as PurchaseRow[];
  for (const row of paying) {
    try {
      const outcome = await pushTransfer(row.outbox_id);
      if (outcome === 'success') {
        markPaid(row.id);
        await deliverPurchase(row.id);
      } else if (outcome === 'failure') {
        markFailed(row.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[purchase] resume ${row.id} failed: ${msg}`);
    }
  }
  const paid = db
    .prepare(`SELECT ${PURCHASE_COLS} FROM purchases WHERE status = 'paid' AND delivered = 0`)
    .all() as PurchaseRow[];
  for (const row of paid) {
    try {
      await deliverPurchase(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[purchase] deliver ${row.id} failed: ${msg}`);
    }
  }
}
