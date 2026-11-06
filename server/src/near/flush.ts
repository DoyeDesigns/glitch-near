import { db } from '../db';
import { getPlayerById } from './accounts';
import { burnGD, getGDBalance } from './gd';

function pendingRows(playerId: string): { id: string; amount: string }[] {
  return db
    .prepare(`SELECT id, amount FROM pending_burns WHERE player_id = ? ORDER BY created_at ASC, id ASC`)
    .all(playerId) as { id: string; amount: string }[];
}

function pendingTotal(playerId: string): bigint {
  let n = 0n;
  for (const row of pendingRows(playerId)) n += BigInt(row.amount);
  return n;
}

/** Drop burned GD from the oldest pending rows. Called only after burn_from lands. */
function consumePending(playerId: string, amount: bigint): void {
  const del = db.prepare(`DELETE FROM pending_burns WHERE id = ?`);
  const upd = db.prepare(`UPDATE pending_burns SET amount = ? WHERE id = ?`);
  const apply = db.transaction(() => {
    let left = amount;
    for (const row of pendingRows(playerId)) {
      if (left <= 0n) break;
      const n = BigInt(row.amount);
      if (n <= left) {
        del.run(row.id);
        left -= n;
      } else {
        upd.run((n - left).toString(), row.id);
        left = 0n;
      }
    }
  });
  apply();
}

/**
 * One treasury burn_from of min(pending, chain balance). Pending rows change
 * only after that burn lands. A failed burn leaves them as they are.
 */
export async function flushPlayer(playerId: string): Promise<void> {
  const player = getPlayerById(playerId);
  if (!player?.account_id) return;
  const pending = pendingTotal(playerId);
  if (pending <= 0n) return;
  const chain = await getGDBalance(player.account_id);
  const burn = pending < chain ? pending : chain;
  if (burn <= 0n) return;
  await burnGD(player.account_id, burn);
  consumePending(playerId, burn);
}
