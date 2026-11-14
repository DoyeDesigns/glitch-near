import { applyNeedsDecay, type NeedsState } from '@glitch/shared';
import { db } from './db';
import { getPlayerById, type PlayerRow } from './near/accounts';

/** New accounts do not lose hunger while a judge is still learning the city. */
export const NEEDS_GRACE_MS = 8 * 60 * 1000;

export function parseNeeds(raw: string): NeedsState {
  try {
    const j = JSON.parse(raw) as Partial<NeedsState>;
    return { energy: Number(j.energy) || 0, hunger: Number(j.hunger) || 0 };
  } catch {
    return { energy: 100, hunger: 80 };
  }
}

/** Unlocked studio: deed delivered and maintenance not overdue. */
export function hasUnlockedHome(player: PlayerRow): boolean {
  if ((player.home_paid_until ?? 0) <= Date.now()) return false;
  const deed = db
    .prepare(
      `SELECT id FROM purchases
       WHERE player_id = ? AND item_id = 'studio-apartment' AND delivered = 1
       LIMIT 1`,
    )
    .get(player.id) as { id: string } | undefined;
  return !!deed;
}

/**
 * Apply timestamp decay, persist needs_json and needs_updated_at, return the fresh needs.
 * atHome uses unlocked studio (no client position on the server).
 */
export function syncNeedsDecay(playerId: string, now = Date.now()): NeedsState {
  const player = getPlayerById(playerId);
  if (!player) return { energy: 100, hunger: 80 };
  const created = player.created_at ?? 0;
  const inGrace = created > 0 && now - created < NEEDS_GRACE_MS;
  const prev = player.needs_updated_at ?? 0;
  const elapsedSec = inGrace ? 0 : prev > 0 ? Math.max(0, (now - prev) / 1000) : 0;
  const atHome = hasUnlockedHome(player);
  const next = applyNeedsDecay(parseNeeds(player.needs_json), elapsedSec, atHome);
  db.prepare(`UPDATE players SET needs_json = ?, needs_updated_at = ? WHERE id = ?`).run(
    JSON.stringify(next),
    now,
    playerId,
  );
  return next;
}

export function writeNeeds(playerId: string, needs: NeedsState, now = Date.now()): void {
  db.prepare(`UPDATE players SET needs_json = ?, needs_updated_at = ? WHERE id = ?`).run(
    JSON.stringify(needs),
    now,
    playerId,
  );
}
