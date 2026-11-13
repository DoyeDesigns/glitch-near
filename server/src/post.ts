import { randomBytes } from 'node:crypto';
import {
  bumpEuphoria,
  clamp,
  EUPHORIA_POST_BUMP,
  faucetCredit,
  mulberry32,
  POST_BURN,
  POST_COOLDOWN_MS,
  POST_COST,
  POST_ESCROW,
  POST_PER_MIN,
  POST_XP,
  postFollowers,
  postProfit,
  postReach,
  postViral,
  rnd,
  skillLevel,
  type PostTake,
  type Rng,
  type SkillXp,
} from '@glitch/shared';
import { AuthError, fundsView, ledgerTotals } from './auth';
import { config } from './config';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById, type PlayerRow } from './near';
import { getGDBalanceCached, readGdBalanceForLog } from './near/gd';
import { resumeOrSend } from './near/mintTx';
import { world } from './sim';

const MINUTE_MS = 60_000;
const minting = new Set<string>();
let retryTimer: ReturnType<typeof setInterval> | null = null;

type PostRow = {
  id: string;
  player_id: string;
  sym: string;
  take: string;
  reach: string;
  followers: number;
  pnl: string;
  credited: string;
  capped: number;
  minted: number;
  created_at: number;
  chain_before: string | null;
  mint_tx_hash: string | null;
  mint_tx_at: number | null;
  mint_attempts: number;
};

export type PostResult = {
  sym: string;
  take: PostTake;
  reach: number;
  viral: boolean;
  followers: number;
  followerTotal: number;
  pnl: string;
  credited: string;
  capped: boolean;
  available: string;
  settling: string;
  xp: SkillXp;
  payUsed: number;
};

function parseXp(raw: string): SkillXp {
  try {
    const j = JSON.parse(raw) as Partial<SkillXp>;
    return { trade: Number(j.trade) || 0, sec: Number(j.sec) || 0, comm: Number(j.comm) || 0 };
  } catch {
    return { trade: 0, sec: 0, comm: 0 };
  }
}

function isWeak(raw: string): boolean {
  try {
    const j = JSON.parse(raw) as { energy?: number; hunger?: number };
    return (Number(j.energy) || 0) < 15 || (Number(j.hunger) || 0) < 10;
  } catch {
    return false;
  }
}

export function parsePostTake(take: unknown): PostTake | null {
  if (take === 'hype' || take === 'warn' || take === 'meme') return take;
  return null;
}

function postText(sym: string, take: PostTake): string {
  if (take === 'hype') return `${sym} to the moon`;
  if (take === 'warn') return `careful: ${sym} looks like a rug`;
  return `me explaining ${sym} to my landlord`;
}

function pushFeed(kind: string, who: string, text: string, rng: Rng): void {
  world.feed.unshift({
    kind,
    who,
    text,
    t: world.time,
    likes: Math.floor(rnd(rng, 0, 30)),
  });
  if (world.feed.length > 60) world.feed.pop();
}

function nudgeToken(sym: string, take: PostTake, reach: number): void {
  const token = world.tokens.find(t => t.sym === sym);
  if (!token) return;
  if (take === 'hype') {
    token.hype = clamp(token.hype + 0.06 * reach, 0, 1);
    token.flow += 0.15 * reach;
  } else if (take === 'warn') {
    token.trust = clamp(token.trust - 0.05 * reach, 0, 1);
    token.flow -= 0.1 * reach;
  }
}

async function accountView(
  player: PlayerRow,
): Promise<{ available: string; settling: string; xp: SkillXp; payUsed: number; followerTotal: number }> {
  const fresh = getPlayerById(player.id) ?? player;
  const funds = await fundsView(fresh);
  return {
    available: funds.available,
    settling: funds.settling,
    xp: parseXp(fresh.xp_json),
    payUsed: 0,
    followerTotal: fresh.followers || 0,
  };
}

function resultOf(
  row: PostRow,
  account: { available: string; settling: string; xp: SkillXp; payUsed: number; followerTotal: number },
): PostResult {
  const take = parsePostTake(row.take) ?? 'meme';
  const reach = Number(row.reach);
  return {
    sym: row.sym,
    take,
    reach,
    viral: postViral(reach),
    followers: row.followers,
    followerTotal: account.followerTotal,
    pnl: row.pnl,
    credited: row.credited,
    capped: row.capped === 1,
    available: account.available,
    settling: account.settling,
    xp: account.xp,
    payUsed: account.payUsed,
  };
}

export async function publishPost(player: PlayerRow, input: { sym: string; take: PostTake }): Promise<PostResult> {
  const sym = input.sym.trim().toUpperCase();
  const token = world.tokens.find(t => t.sym === sym);
  if (!token) throw new AuthError('Unknown coin', 400);
  if (!player.account_id) throw new AuthError('Player has no account', 503);
  const chain = BigInt(await getGDBalanceCached(player.account_id));

  const rng = mulberry32(randomBytes(4).readUInt32LE(0));
  const level = skillLevel(parseXp(player.xp_json).comm);
  const mood = world.market.mood;
  const heat = world.market.heat;
  const reach = postReach(input.take, mood, heat, level, rng);
  const pnl = Math.round(postProfit(reach));
  const gained = Math.max(0, postFollowers(reach, level));

  const now = Date.now();
  const id = randomId();
  const take = input.take;
  const chainBefore = await readGdBalanceForLog(player.account_id);
  const insert = db.transaction(() => {
    const recent = db
      .prepare(`SELECT COUNT(*) AS n FROM posts WHERE player_id = ? AND created_at > ?`)
      .get(player.id, now - MINUTE_MS) as { n: number };
    if (recent.n >= POST_PER_MIN) throw new AuthError('Too many posts. Wait a moment.', 429);
    const last = db
      .prepare(`SELECT created_at FROM posts WHERE player_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(player.id) as { created_at: number } | undefined;
    if (last && now - last.created_at < POST_COOLDOWN_MS) throw new AuthError('Wait before the next post', 429);
    const held = ledgerTotals(player.id);
    const available = chain - held.pending - held.escrowed + held.settling;
    if (available < BigInt(POST_COST)) throw new AuthError('Not enough GD', 400);
    const progress = db
      .prepare(`SELECT xp_json, needs_json FROM players WHERE id = ?`)
      .get(player.id) as { xp_json: string; needs_json: string } | undefined;
    if (!progress) throw new AuthError('Player has no account', 503);
    const xp = parseXp(progress.xp_json);
    xp.comm += POST_XP;
    let credited = 0;
    if (pnl > 0) {
      credited = faucetCredit(pnl, isWeak(progress.needs_json)).credited;
    }
    db.prepare(
      `INSERT INTO posts (id, player_id, sym, take, reach, followers, pnl, credited, capped, minted, created_at, chain_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      player.id,
      sym,
      take,
      String(reach),
      gained,
      String(pnl),
      String(credited),
      0,
      credited > 0 ? 0 : 1,
      now,
      chainBefore,
    );
    db.prepare(
      `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(`pc-${id}`, player.id, String(POST_BURN), 'post-cost', now);
    db.prepare(
      `INSERT INTO escrow (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, player.id, String(POST_ESCROW), 'post', now);
    db.prepare(`DELETE FROM escrow WHERE id = ?`).run(id);
    if (pnl < 0) {
      db.prepare(
        `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(`pl-${id}`, player.id, String(-pnl), 'post-loss', now);
    }
    db.prepare(`UPDATE players SET xp_json = ?, followers = followers + ? WHERE id = ?`).run(
      JSON.stringify(xp),
      gained,
      player.id,
    );
  });
  try {
    insert.immediate();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw err;
  }

  nudgeToken(sym, take, reach);
  if (take === 'hype') {
    world.pressures.euphoria = bumpEuphoria(world.pressures.euphoria, EUPHORIA_POST_BUMP);
  }
  pushFeed('npc', player.name, postText(sym, take), rng);
  if (postViral(reach)) pushFeed('sys', 'TRENDING', `${player.name}'s ${sym} post is going viral.`, rng);

  const row = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as PostRow;
  if (BigInt(row.credited || '0') > 0n) await mintProfit(row);
  const paid = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as PostRow;
  return resultOf(paid, await accountView(player));
}

async function mintProfit(row: PostRow): Promise<void> {
  if (row.minted === 1) return;
  const credited = BigInt(row.credited || '0');
  if (credited <= 0n) {
    db.prepare(`UPDATE posts SET minted = 1 WHERE id = ?`).run(row.id);
    return;
  }
  if (minting.has(row.id)) return;
  minting.add(row.id);
  try {
    const fresh = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(row.id) as PostRow | undefined;
    if (!fresh || fresh.minted === 1) return;
    const player = getPlayerById(fresh.player_id);
    if (!player?.account_id) return;
    const accountId = player.account_id;
    await resumeOrSend(
      {
        flag: fresh.minted,
        hash: fresh.mint_tx_hash,
        txAt: fresh.mint_tx_at,
        attempts: fresh.mint_attempts ?? 0,
      },
      {
        mark: () => {
          db.prepare(`UPDATE posts SET minted = 1 WHERE id = ? AND minted = 0`).run(fresh.id);
        },
        persist: (hash, at, attempts) => {
          db.prepare(`UPDATE posts SET mint_tx_hash = ?, mint_tx_at = ?, mint_attempts = ? WHERE id = ?`).run(
            hash,
            at,
            attempts,
            fresh.id,
          );
        },
        call: {
          contractId: config.gdContract,
          methodName: 'mint',
          args: { account_id: accountId, amount: String(credited) },
        },
      },
    );
  } catch {
    console.error('[post] profit mint failed');
  } finally {
    minting.delete(row.id);
  }
}

async function retryPendingMints(): Promise<void> {
  const due = db.prepare(`SELECT * FROM posts WHERE minted = 0`).all() as PostRow[];
  for (const row of due) await mintProfit(row);
}

/**
 * A stored mint_tx_hash is looked up for the treasury signer.
 * Success only sets minted. Failure may sign one fresh transaction.
 * Unknown waits 3 minutes, then signs a fresh transaction.
 * Signed bytes are not stored, so a sent transaction is never broadcast again.
 * chain_before is diagnostic only.
 */
export function resumePosts(): Promise<void> {
  if (!retryTimer && !process.env.VITEST) retryTimer = setInterval(() => void retryPendingMints(), 20_000);
  return retryPendingMints();
}
