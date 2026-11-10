import { applyRestEffect } from '@glitch/shared';
import { AuthError, fundsView } from './auth';
import { getPlayerById } from './near/accounts';
import { hasUnlockedHome, syncNeedsDecay, writeNeeds } from './needs';
import { ownsStudio } from './purchase';

export type RestResult = {
  needs: { energy: number; hunger: number };
  homePaidUntil: number;
  available: string;
  settling: string;
};

export async function restPlayer(
  playerId: string,
  kind: 'bench' | 'sleep',
): Promise<RestResult> {
  if (kind !== 'bench' && kind !== 'sleep') throw new AuthError('Bad rest kind', 400);
  const before = syncNeedsDecay(playerId);
  const player = getPlayerById(playerId);
  if (!player) throw new AuthError('Player not found', 400);

  if (kind === 'sleep') {
    if (!(await ownsStudio(playerId))) throw new AuthError('You need a studio to sleep', 400);
    if (!hasUnlockedHome(player)) {
      throw new AuthError('Your bed is locked: pay maintenance first', 400);
    }
  }

  const needs = applyRestEffect(before, kind);
  writeNeeds(playerId, needs);
  const funds = await fundsView(player);
  const fresh = getPlayerById(playerId)!;
  return {
    needs,
    homePaidUntil: fresh.home_paid_until ?? 0,
    ...funds,
  };
}
