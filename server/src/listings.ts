/**
 * Player-to-player item market. List furniture/gear, buy via purchase-like
 * pay-then-deliver (ft_transfer → admin_transfer), 2% fee as pending burn.
 */
import {
  isPlayerListableToken,
  listableTokenTitle,
  MARKET_LIST_MAX_GD,
  MARKET_LIST_MIN_GD,
  marketFeeGd,
} from '@glitch/shared';
import { AuthError, ledgerTotals } from './auth';
import { config } from './config';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById } from './near/accounts';
import { flushPlayer } from './near/flush';
import { getGDBalanceCached, pushTransfer, type TransferOutcome } from './near/gd';
import { getItemBalances } from './near/items';
import { resumeOrSend } from './near/mintTx';

export type ListingRow = {
  id: string;
  seller_id: string;
  token_id: string;
  qty: number;
  price: string;
  status: string;
  created_at: number;
};

export type ListingSaleRow = {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  token_id: string;
  amount: string;
  fee: string;
  outbox_id: string;
  status: string;
  delivered: number;
  deliver_tx_hash: string | null;
  deliver_tx_at: number | null;
  deliver_attempts: number;
  created_at: number;
};

export type ListingView = {
  id: string;
  tokenId: string;
  title: string;
  price: string;
  qty: number;
  sellerName: string;
  sellerId: string;
  createdAt: number;
};

export type ListingSaleResult =
  | { ok: true; saleId: string; status: 'delivered' }
  | { settling: true; saleId: string };

const LISTING_COLS = 'id, seller_id, token_id, qty, price, status, created_at';
const SALE_COLS =
  'id, listing_id, buyer_id, seller_id, token_id, amount, fee, outbox_id, status, delivered, deliver_tx_hash, deliver_tx_at, deliver_attempts, created_at';

function getListing(id: string): ListingRow | undefined {
  return db.prepare(`SELECT ${LISTING_COLS} FROM listings WHERE id = ?`).get(id) as ListingRow | undefined;
}

function getSale(id: string): ListingSaleRow | undefined {
  return db.prepare(`SELECT ${SALE_COLS} FROM listing_sales WHERE id = ?`).get(id) as
    | ListingSaleRow
    | undefined;
}

/** Qty held in open or in-flight sold listings (not yet delivered). */
export function heldListingQty(sellerId: string, tokenId: string): number {
  const open = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM listings
       WHERE seller_id = ? AND token_id = ? AND status = 'open'`,
    )
    .get(sellerId, tokenId) as { n: number };
  const inFlight = db
    .prepare(
      `SELECT COALESCE(SUM(l.qty), 0) AS n
       FROM listings l
       JOIN listing_sales s ON s.listing_id = l.id
       WHERE l.seller_id = ? AND l.token_id = ? AND l.status = 'sold'
         AND s.status IN ('paying', 'paid') AND s.delivered = 0`,
    )
    .get(sellerId, tokenId) as { n: number };
  return Number(open.n) + Number(inFlight.n);
}

async function freeBalance(sellerId: string, tokenId: string): Promise<bigint> {
  const player = getPlayerById(sellerId);
  if (!player?.account_id) return 0n;
  const items = await getItemBalances(player.account_id);
  const onChain = BigInt(items[tokenId] ?? '0');
  const held = BigInt(heldListingQty(sellerId, tokenId));
  const free = onChain - held;
  return free < 0n ? 0n : free;
}

function parsePrice(raw: unknown): bigint {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (!Number.isInteger(raw)) throw new AuthError('Price must be a whole GD amount', 400);
    return BigInt(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  throw new AuthError('Bad price', 400);
}

function assertPrice(price: bigint): void {
  if (price < BigInt(MARKET_LIST_MIN_GD) || price > BigInt(MARKET_LIST_MAX_GD)) {
    throw new AuthError(
      `Price must be ${MARKET_LIST_MIN_GD}–${MARKET_LIST_MAX_GD} GD`,
      400,
    );
  }
}

export async function createListing(
  sellerId: string,
  tokenId: string,
  priceRaw: unknown,
): Promise<ListingView> {
  const token = tokenId.trim();
  if (!isPlayerListableToken(token)) {
    throw new AuthError('Only furniture and gear tokens can be listed', 400);
  }
  const price = parsePrice(priceRaw);
  assertPrice(price);

  const free = await freeBalance(sellerId, token);
  if (free < 1n) throw new AuthError('You do not hold that item (or it is already listed)', 400);

  const id = randomId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO listings (id, seller_id, token_id, qty, price, status, created_at)
     VALUES (?, ?, ?, 1, ?, 'open', ?)`,
  ).run(id, sellerId, token, price.toString(), now);

  const seller = getPlayerById(sellerId);
  return {
    id,
    tokenId: token,
    title: listableTokenTitle(token),
    price: price.toString(),
    qty: 1,
    sellerName: seller?.name ?? 'player',
    sellerId,
    createdAt: now,
  };
}

export function cancelListing(sellerId: string, listingId: string): { ok: true } {
  const row = getListing(listingId);
  if (!row || row.seller_id !== sellerId) throw new AuthError('Listing not found', 400);
  if (row.status !== 'open') throw new AuthError('Listing is not open', 400);
  const r = db
    .prepare(`UPDATE listings SET status = 'cancelled' WHERE id = ? AND status = 'open'`)
    .run(listingId);
  if (r.changes === 0) throw new AuthError('Listing is not open', 400);
  return { ok: true };
}

export function listOpenListings(): ListingView[] {
  const rows = db
    .prepare(
      `SELECT ${LISTING_COLS} FROM listings WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as ListingRow[];
  return rows.map(row => {
    const seller = getPlayerById(row.seller_id);
    return {
      id: row.id,
      tokenId: row.token_id,
      title: listableTokenTitle(row.token_id),
      price: row.price,
      qty: row.qty,
      sellerName: seller?.name ?? 'player',
      sellerId: row.seller_id,
      createdAt: row.created_at,
    };
  });
}

function markSaleFailed(saleId: string): void {
  const apply = db.transaction(() => {
    const sale = getSale(saleId);
    if (!sale || sale.status !== 'paying') return;
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(saleId);
    db.prepare(`UPDATE listing_sales SET status = 'failed' WHERE id = ? AND status = 'paying'`).run(
      saleId,
    );
    db.prepare(`UPDATE listings SET status = 'open' WHERE id = ? AND status = 'sold'`).run(
      sale.listing_id,
    );
  });
  apply.immediate();
}

function markSalePaid(saleId: string): void {
  const apply = db.transaction(() => {
    const sale = getSale(saleId);
    if (!sale || sale.status !== 'paying') return;
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(saleId);
    db.prepare(`UPDATE listing_sales SET status = 'paid' WHERE id = ? AND status = 'paying'`).run(
      saleId,
    );
    const fee = BigInt(sale.fee);
    if (fee > 0n) {
      db.prepare(
        `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(randomId(), sale.seller_id, fee.toString(), 'market_fee', Date.now());
    }
  });
  apply.immediate();
}

async function deliverSale(saleId: string): Promise<boolean> {
  const row = getSale(saleId);
  if (!row) return false;
  if (row.delivered === 1 || row.status === 'delivered') return true;
  if (row.status !== 'paid' && row.status !== 'paying') return false;
  if (row.status === 'paying') markSalePaid(saleId);
  const paid = getSale(saleId);
  if (!paid || paid.status !== 'paid' || paid.delivered === 1) {
    return getSale(saleId)?.delivered === 1;
  }

  const seller = getPlayerById(paid.seller_id);
  const buyer = getPlayerById(paid.buyer_id);
  if (!seller?.account_id || !buyer?.account_id) throw new Error('Missing account');

  // Seller must still hold the token on chain (minus other holds excluding this sale).
  const items = await getItemBalances(seller.account_id);
  const onChain = BigInt(items[paid.token_id] ?? '0');
  if (onChain < 1n) {
    throw new AuthError('Seller no longer holds the item', 400);
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
          `UPDATE listing_sales SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
        ).run(saleId);
      },
      persist: (hash, at, attempts) => {
        db.prepare(
          `UPDATE listing_sales SET deliver_tx_hash = ?, deliver_tx_at = ?, deliver_attempts = ? WHERE id = ?`,
        ).run(hash, at, attempts, saleId);
      },
      call: {
        contractId: config.itemsContract,
        methodName: 'admin_transfer',
        args: {
          from: seller.account_id,
          to: buyer.account_id,
          token_id: paid.token_id,
          amount: '1',
        },
      },
    },
  );
  return getSale(saleId)?.delivered === 1;
}

async function settleSale(saleId: string, outcome: TransferOutcome): Promise<ListingSaleResult> {
  if (outcome === 'success') {
    markSalePaid(saleId);
    const delivered = await deliverSale(saleId);
    if (!delivered) return { settling: true, saleId };
    return { ok: true, saleId, status: 'delivered' };
  }
  if (outcome === 'failure') {
    markSaleFailed(saleId);
    throw new AuthError('Purchase did not go through. Try again.', 400);
  }
  return { settling: true, saleId };
}

export async function buyListing(buyerId: string, listingId: string): Promise<ListingSaleResult> {
  const listing = getListing(listingId);
  if (!listing || listing.status !== 'open') throw new AuthError('Listing not available', 400);
  if (listing.seller_id === buyerId) throw new AuthError('Cannot buy your own listing', 400);

  const price = BigInt(listing.price);
  const fee = marketFeeGd(price);
  const seller = getPlayerById(listing.seller_id);
  const buyer = getPlayerById(buyerId);
  if (!seller?.account_id || !buyer?.account_id) throw new AuthError('Account not ready', 400);

  // Seller still holds free of other holds (this listing is still open, so free includes it).
  const items = await getItemBalances(seller.account_id);
  const onChain = BigInt(items[listing.token_id] ?? '0');
  const otherHeld = heldListingQty(listing.seller_id, listing.token_id) - listing.qty;
  if (onChain - BigInt(Math.max(0, otherHeld)) < BigInt(listing.qty)) {
    throw new AuthError('Seller no longer holds the item', 400);
  }

  await flushPlayer(buyerId);
  const chain = BigInt(await getGDBalanceCached(buyer.account_id));

  const saleId = randomId();
  const outboxId = randomId();
  const now = Date.now();

  const reserve = db.transaction(() => {
    const claim = db
      .prepare(`UPDATE listings SET status = 'sold' WHERE id = ? AND status = 'open'`)
      .run(listingId);
    if (claim.changes === 0) throw new AuthError('Listing not available', 409);

    const held = ledgerTotals(buyerId);
    const spendable = chain - held.pending - held.escrowed;
    if (spendable < price) {
      db.prepare(`UPDATE listings SET status = 'open' WHERE id = ? AND status = 'sold'`).run(listingId);
      if (spendable + held.settling >= price) {
        throw new AuthError('Some of your GD is still on the way. Wait a moment and try again.', 400);
      }
      throw new AuthError('Not enough GD', 400);
    }

    db.prepare(
      `INSERT INTO escrow (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, 'listing', ?)`,
    ).run(saleId, buyerId, price.toString(), now);
    db.prepare(
      `INSERT INTO outbox (id, player_id, kind, payload, status, created_at, attempts)
       VALUES (?, ?, 'ft_transfer', ?, 'pending', ?, 0)`,
    ).run(
      outboxId,
      buyerId,
      JSON.stringify({ to: seller.account_id, amount: price.toString(), memo: 'glitch-market' }),
      now,
    );
    db.prepare(
      `INSERT INTO listing_sales
         (id, listing_id, buyer_id, seller_id, token_id, amount, fee, outbox_id, status, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paying', 0, ?)`,
    ).run(
      saleId,
      listingId,
      buyerId,
      listing.seller_id,
      listing.token_id,
      price.toString(),
      fee.toString(),
      outboxId,
      now,
    );
  });

  try {
    reserve.immediate();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw err;
  }

  const outcome = await pushTransfer(outboxId);
  return settleSale(saleId, outcome);
}

export async function resumeListingSales(): Promise<void> {
  const paying = db
    .prepare(`SELECT ${SALE_COLS} FROM listing_sales WHERE status = 'paying'`)
    .all() as ListingSaleRow[];
  for (const row of paying) {
    try {
      const outcome = await pushTransfer(row.outbox_id);
      if (outcome === 'success') {
        markSalePaid(row.id);
        await deliverSale(row.id);
      } else if (outcome === 'failure') {
        markSaleFailed(row.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[listings] resume ${row.id} failed: ${msg}`);
    }
  }
  const paid = db
    .prepare(`SELECT ${SALE_COLS} FROM listing_sales WHERE status = 'paid' AND delivered = 0`)
    .all() as ListingSaleRow[];
  for (const row of paid) {
    try {
      await deliverSale(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[listings] deliver ${row.id} failed: ${msg}`);
    }
  }
}

/** Test helper: force a seller-missing-item path without waiting on chain. */
export function getListingSaleForTests(id: string): ListingSaleRow | undefined {
  return getSale(id);
}

export function getListingForTests(id: string): ListingRow | undefined {
  return getListing(id);
}
