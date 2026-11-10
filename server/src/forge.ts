import { catalogById, gearTokenId } from '@glitch/shared';
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

export type ForgeRow = {
  id: string;
  player_id: string;
  item_id: string;
  token_id: string;
  shards_cost: number;
  amount: string;
  outbox_id: string;
  status: string;
  shards_burned: number;
  burn_tx_hash: string | null;
  burn_tx_at: number | null;
  burn_attempts: number;
  token_created: number;
  create_tx_hash: string | null;
  create_tx_at: number | null;
  create_attempts: number;
  delivered: number;
  mint_tx_hash: string | null;
  mint_tx_at: number | null;
  mint_attempts: number;
  created_at: number;
};

export type ForgeMintResult = {
  status: 'delivered' | 'settling';
  forgeId: string;
  itemId: string;
  tokenId: string;
  available: string;
  settling: string;
  items: Record<string, string>;
};

const FORGE_COLS =
  'id, player_id, item_id, token_id, shards_cost, amount, outbox_id, status, shards_burned, burn_tx_hash, burn_tx_at, burn_attempts, token_created, create_tx_hash, create_tx_at, create_attempts, delivered, mint_tx_hash, mint_tx_at, mint_attempts, created_at';

function getForge(id: string): ForgeRow | undefined {
  return db.prepare(`SELECT ${FORGE_COLS} FROM forges WHERE id = ?`).get(id) as ForgeRow | undefined;
}

function markFailed(forgeId: string): void {
  const apply = db.transaction(() => {
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(forgeId);
    db.prepare(`UPDATE forges SET status = 'failed' WHERE id = ? AND status = 'paying'`).run(forgeId);
  });
  apply.immediate();
}

function markPaid(forgeId: string): void {
  const apply = db.transaction(() => {
    const row = getForge(forgeId);
    if (!row || row.status !== 'paying') return;
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(forgeId);
    db.prepare(`UPDATE forges SET status = 'paid' WHERE id = ? AND status = 'paying'`).run(forgeId);
  });
  apply.immediate();
}

/**
 * After GD is paid: burn shards → create_token(gear-…) → mint once.
 * Each step stores a tx hash so resume never double-burns or double-mints.
 */
async function deliverForge(forgeId: string): Promise<boolean> {
  const row = getForge(forgeId);
  if (!row) return false;
  if (row.delivered === 1 || row.status === 'delivered') return true;
  if (row.status !== 'paid' && row.status !== 'paying') return false;
  if (row.status === 'paying') markPaid(forgeId);
  const paid = getForge(forgeId);
  if (!paid || paid.status !== 'paid' || paid.delivered === 1) {
    return getForge(forgeId)?.delivered === 1;
  }

  const player = getPlayerById(paid.player_id);
  if (!player?.account_id) throw new Error('Player has no account');
  if (!config.itemsContract) throw new Error('ITEMS_CONTRACT not set');

  const item = catalogById(paid.item_id);
  if (!item || item.kind !== 'gear') throw new Error(`Unknown gear ${paid.item_id}`);

  await resumeOrSend(
    {
      flag: paid.shards_burned,
      hash: paid.burn_tx_hash,
      txAt: paid.burn_tx_at,
      attempts: paid.burn_attempts ?? 0,
    },
    {
      mark: () => {
        db.prepare(`UPDATE forges SET shards_burned = 1 WHERE id = ? AND shards_burned = 0`).run(forgeId);
      },
      persist: (hash, at, attempts) => {
        db.prepare(
          `UPDATE forges SET burn_tx_hash = ?, burn_tx_at = ?, burn_attempts = ? WHERE id = ?`,
        ).run(hash, at, attempts, forgeId);
      },
      call: {
        contractId: config.itemsContract,
        methodName: 'burn_from',
        args: {
          account_id: player.account_id,
          token_id: 'shard',
          amount: String(paid.shards_cost),
        },
      },
    },
  );

  const afterBurn = getForge(forgeId);
  if (!afterBurn || afterBurn.shards_burned !== 1) return false;

  await resumeOrSend(
    {
      flag: afterBurn.token_created,
      hash: afterBurn.create_tx_hash,
      txAt: afterBurn.create_tx_at,
      attempts: afterBurn.create_attempts ?? 0,
    },
    {
      mark: () => {
        db.prepare(`UPDATE forges SET token_created = 1 WHERE id = ? AND token_created = 0`).run(forgeId);
      },
      persist: (hash, at, attempts) => {
        db.prepare(
          `UPDATE forges SET create_tx_hash = ?, create_tx_at = ?, create_attempts = ? WHERE id = ?`,
        ).run(hash, at, attempts, forgeId);
      },
      call: {
        contractId: config.itemsContract,
        methodName: 'create_token',
        args: {
          token_id: paid.token_id,
          kind: 'gear',
          title: item.title,
          max_supply: '1',
        },
      },
    },
  );

  const afterCreate = getForge(forgeId);
  if (!afterCreate || afterCreate.token_created !== 1) return false;

  await resumeOrSend(
    {
      flag: afterCreate.delivered,
      hash: afterCreate.mint_tx_hash,
      txAt: afterCreate.mint_tx_at,
      attempts: afterCreate.mint_attempts ?? 0,
    },
    {
      mark: () => {
        db.prepare(
          `UPDATE forges SET delivered = 1, status = 'delivered' WHERE id = ? AND delivered = 0`,
        ).run(forgeId);
      },
      persist: (hash, at, attempts) => {
        db.prepare(
          `UPDATE forges SET mint_tx_hash = ?, mint_tx_at = ?, mint_attempts = ? WHERE id = ?`,
        ).run(hash, at, attempts, forgeId);
      },
      call: {
        contractId: config.itemsContract,
        methodName: 'mint',
        args: { account_id: player.account_id, token_id: paid.token_id, amount: '1' },
      },
    },
  );

  return getForge(forgeId)?.delivered === 1;
}

async function settleOutcome(forgeId: string, outcome: TransferOutcome): Promise<{
  settling: boolean;
  delivered: boolean;
}> {
  if (outcome === 'success') {
    markPaid(forgeId);
    const delivered = await deliverForge(forgeId);
    return { settling: !delivered, delivered };
  }
  if (outcome === 'failure') {
    markFailed(forgeId);
    throw new AuthError('Forge payment failed on chain', 400);
  }
  return { settling: true, delivered: false };
}

/**
 * Mint unique gear: check shards + GD, pay smith, burn shards, create_token, mint.
 * Does not create shard/furniture/studio token types.
 */
export async function forgeMint(playerId: string, itemId: string): Promise<ForgeMintResult> {
  const item = catalogById(itemId);
  if (
    !item ||
    item.kind !== 'gear' ||
    item.effect.shardsCost == null ||
    item.effect.gdCost == null ||
    item.sellerId !== 'smith'
  ) {
    throw new AuthError('Unknown forge item', 400);
  }

  const merchant = getMerchant('smith');
  if (!merchant) throw new AuthError('Unknown merchant', 400);

  const shardsCost = item.effect.shardsCost;
  const gdCost = BigInt(item.effect.gdCost);
  if (shardsCost <= 0 || gdCost <= 0n) throw new AuthError('Invalid forge cost', 400);

  await flushPlayer(playerId);
  const player = getPlayerById(playerId);
  if (!player?.account_id) throw new AuthError('Player not found', 400);

  const items = await getItemBalances(player.account_id);
  const shards = BigInt(items.shard ?? '0');
  if (shards < BigInt(shardsCost)) throw new AuthError('Not enough shards', 400);

  const chain = BigInt(await getGDBalanceCached(player.account_id));
  const forgeId = randomId();
  const outboxId = randomId();
  const tokenId = gearTokenId(item.id, randomId());
  const now = Date.now();

  const reserve = db.transaction(() => {
    const held = ledgerTotals(playerId);
    const spendable = chain - held.pending - held.escrowed;
    if (spendable < gdCost) {
      if (spendable + held.settling >= gdCost) {
        throw new AuthError('Winnings are still landing on chain. Wait and try again.', 400);
      }
      throw new AuthError('Not enough GD', 400);
    }
    db.prepare(
      `INSERT INTO escrow (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, 'forge', ?)`,
    ).run(forgeId, playerId, gdCost.toString(), now);
    db.prepare(
      `INSERT INTO outbox (id, player_id, kind, payload, status, created_at, attempts)
       VALUES (?, ?, 'ft_transfer', ?, 'pending', ?, 0)`,
    ).run(
      outboxId,
      playerId,
      JSON.stringify({ to: merchant.account_id, amount: gdCost.toString(), memo: 'glitch' }),
      now,
    );
    db.prepare(
      `INSERT INTO forges (
         id, player_id, item_id, token_id, shards_cost, amount, outbox_id, status,
         shards_burned, token_created, delivered, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'paying', 0, 0, 0, ?)`,
    ).run(forgeId, playerId, item.id, tokenId, shardsCost, gdCost.toString(), outboxId, now);
  });
  try {
    reserve.immediate();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw err;
  }

  const outcome = await pushTransfer(outboxId);
  const settled = await settleOutcome(forgeId, outcome);
  const funds = await fundsView(getPlayerById(playerId)!);
  const nextItems = await getItemBalances(player.account_id);
  return {
    status: settled.delivered ? 'delivered' : 'settling',
    forgeId,
    itemId: item.id,
    tokenId,
    ...funds,
    items: nextItems,
  };
}

/** Finish paying and unpaid forge deliveries after reboot. */
export async function resumeForges(): Promise<void> {
  const paying = db
    .prepare(`SELECT ${FORGE_COLS} FROM forges WHERE status = 'paying'`)
    .all() as ForgeRow[];
  for (const row of paying) {
    try {
      const outcome = await pushTransfer(row.outbox_id);
      if (outcome === 'success') {
        markPaid(row.id);
        await deliverForge(row.id);
      } else if (outcome === 'failure') {
        markFailed(row.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[forge] resume ${row.id} failed: ${msg}`);
    }
  }
  const paid = db
    .prepare(
      `SELECT ${FORGE_COLS} FROM forges WHERE status = 'paid' AND delivered = 0`,
    )
    .all() as ForgeRow[];
  for (const row of paid) {
    try {
      await deliverForge(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[forge] deliver ${row.id} failed: ${msg}`);
    }
  }
}
