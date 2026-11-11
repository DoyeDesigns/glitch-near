import { ledgerTotals } from './auth';
import { db } from './db';
import { getGDBalanceCached } from './near/gd';

export type LeaderboardEntry = { rank: number; name: string; balance: string };
export type LeaderboardPayload = { players: LeaderboardEntry[] };

const CACHE_MS = 15_000;

type Cache = { at: number; payload: LeaderboardPayload };
let cache: Cache | null = null;

type ActivePlayer = { id: string; name: string; account_id: string };

async function computeLeaderboard(): Promise<LeaderboardPayload> {
  const rows = db
    .prepare(
      `SELECT id, name, account_id FROM players
       WHERE status = 'active' AND account_id IS NOT NULL`,
    )
    .all() as ActivePlayer[];

  const scored = await Promise.all(
    rows.map(async row => {
      const chain = BigInt(await getGDBalanceCached(row.account_id));
      const { pending, escrowed } = ledgerTotals(row.id);
      const raw = chain - pending - escrowed;
      const balance = raw < 0n ? 0n : raw;
      return { name: row.name, balance };
    }),
  );

  scored.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
  const top = scored.slice(0, 20);
  return {
    players: top.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      balance: p.balance.toString(),
    })),
  };
}

/** Top-20 active players by spendable GD. Response cached 15s. */
export async function getLeaderboard(): Promise<LeaderboardPayload> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.payload;
  const payload = await computeLeaderboard();
  cache = { at: now, payload };
  return payload;
}
