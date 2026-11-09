import { catalogById } from '@glitch/shared';
import { AuthError, ledgerTotals } from './auth';
import { config } from './config';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById } from './near/accounts';
import { flushPlayer } from './near/flush';
import { getGDBalanceCached, pushTransfer, type TransferOutcome } from './near/gd';
import { getMerchant } from './near/merchants';
import { resumeOrSend } from './near/mintTx';

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

function getPurchase(id: string): PurchaseRow | undefined {
  return db.prepare(`SELECT ${PURCHASE_COLS} FROM purchases WHERE id = ?`).get(id) as PurchaseRow | undefined;
}

function parseNeeds(raw: string): { energy: number; hunger: number } {
  try {
    const j = JSON.parse(raw) as { energy?: number; hunger?: number };
    return { energy: Number(j.energy) || 0, hunger: Number(j.hunger) || 0 };
  } catch {
    return { energy: 100, hunger: 80 };
  }
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

/**
 * Deliver a paid purchase once. Food updates needs. Furniture/house mints the item.
 * The delivered flag is set in the same SQLite write that records the mint outcome
 * (or the needs update), and mint uses the existing tx-hash resume path.
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

  const item = catalogById(paid.item_id);
  if (!item) throw new Error(`Unknown item ${paid.item_id}`);
  const player = getPlayerById(paid.player_id);
  if (!player?.account_id) throw new Error('Player has no account');

  if (item.kind === 'food') {
    const apply = db.transaction(() => {
      const fresh = getPurchase(purchaseId);
      if (!fresh || fresh.delivered === 1) return;
      const needs = parseNeeds(
        (
          db.prepare(`SELECT needs_json FROM players WHERE id = ?`).get(paid.player_id) as
            | { needs_json: string }
            | undefined
        )?.needs_json ?? '{"energy":100,"hunger":80}',
      );
      const hunger = Math.min(100, needs.hunger + (item.effect.hunger ?? 0));
      const energy = Math.min(100, needs.energy + (item.effect.energy ?? 0));
      db.prepare(`UPDATE players SET needs_json = ? WHERE id = ?`).run(
        JSON.stringify({ energy, hunger }),
        paid.player_id,
      );
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
        db.prepare(
          `UPDATE purchases SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
        ).run(purchaseId);
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

/**
 * Pay a catalog item. Reserves spend in one immediate SQLite transaction, then
 * transfers GD to the merchant. Success means paid and delivered. An ambiguous
 * transfer keeps the escrow and returns settling.
 */
export async function purchase(playerId: string, itemId: string): Promise<PurchaseResult> {
  const item = catalogById(itemId);
  if (!item || item.priceGD == null) throw new AuthError('Unknown item', 400);
  if (item.sellerId !== 'chef' && item.sellerId !== 'smith' && item.sellerId !== 'dealer') {
    throw new AuthError('Item has no merchant', 400);
  }
  if (item.kind === 'gear' || item.kind === 'shard' || item.kind === 'consumable') {
    throw new AuthError('Item cannot be purchased this way', 400);
  }
  const merchant = getMerchant(item.sellerId);
  if (!merchant) throw new AuthError('Unknown merchant', 400);
  const amount = BigInt(item.priceGD);
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
      JSON.stringify({ to: merchant.account_id, amount: amount.toString(), memo: 'glitch' }),
      now,
    );
    db.prepare(
      `INSERT INTO purchases (id, player_id, merchant_id, item_id, amount, outbox_id, status, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'paying', 0, ?)`,
    ).run(purchaseId, playerId, item.sellerId, item.id, amount.toString(), outboxId, now);
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
