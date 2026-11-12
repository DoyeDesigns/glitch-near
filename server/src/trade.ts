import {
  bumpLeverage,
  faucetCredit,
  LARGE_STAKE_GD,
  LEVERAGE_LARGE_BUMP,
  TRADE_MAX_STAKE,
  TRADE_MIN_STAKE,
  TRADE_OPENS_PER_MIN,
  TRADE_SECS,
  applyFlow,
  tradeFee,
  tradePnl,
} from '@glitch/shared';
import { AuthError, fundsView, ledgerTotals } from './auth';
import { config } from './config';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById, type PlayerRow } from './near';
import { getGDBalanceCached, invalidateGdCache, readGdBalanceForLog } from './near/gd';
import { resumeOrSend } from './near/mintTx';
import { world } from './sim';

const MINUTE_MS = 60_000;
const minting = new Set<string>();
const resolving = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let retryTimer: ReturnType<typeof setInterval> | null = null;

type TradeRow = {
  id: string;
  player_id: string;
  sym: string;
  dir: number;
  stake: string;
  fee: string;
  p0: string;
  opened_at: number;
  resolves_at: number;
  status: string;
  price_out: string | null;
  pnl: string | null;
  credited: string | null;
  capped: number;
  minted: number;
  chain_before: string | null;
  mint_tx_hash: string | null;
  mint_tx_at: number | null;
  mint_attempts: number;
};

export type TradeView = {
  id: string;
  sym: string;
  dir: 1 | -1;
  stake: string;
  fee: string;
  p0: string;
  openedAt: number;
  resolvesAt: number;
  status: 'open' | 'settled';
  price: string;
  markPnl: string;
  pnl: string | null;
  credited: string | null;
  capped: boolean;
  minted: boolean;
};

type Xp = { trade: number; sec: number; comm: number };

function parseXp(raw: string): Xp {
  try {
    const j = JSON.parse(raw) as Partial<Xp>;
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

function tokenPrice(sym: string): number | null {
  const token = world.tokens.find(t => t.sym === sym);
  return token && token.price > 0 ? token.price : null;
}

function nudgeCoin(sym: string, dir: 1 | -1, stake: number): void {
  const token = world.tokens.find(t => t.sym === sym);
  if (!token) return;
  applyFlow(token, dir, stake);
}

export function parseTradeDir(dir: unknown): 1 | -1 | null {
  if (dir === 1 || dir === 'up' || dir === 'UP') return 1;
  if (dir === -1 || dir === 'down' || dir === 'DOWN') return -1;
  return null;
}

export function parseTradeStake(stake: unknown): number | null {
  const n = typeof stake === 'string' && /^\d+$/.test(stake) ? Number(stake) : stake;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  return n;
}

function viewOf(row: TradeRow, priceNow: number): TradeView {
  const dir = row.dir < 0 ? -1 : 1;
  const stake = Number(row.stake);
  const p0 = Number(row.p0);
  const settled = row.status === 'settled';
  const price = settled && row.price_out != null ? Number(row.price_out) : priceNow;
  const mark = settled && row.pnl != null ? Number(row.pnl) : tradePnl(stake, dir, p0, price);
  return {
    id: row.id,
    sym: row.sym,
    dir,
    stake: row.stake,
    fee: row.fee,
    p0: row.p0,
    openedAt: row.opened_at,
    resolvesAt: row.resolves_at,
    status: settled ? 'settled' : 'open',
    price: String(price),
    markPnl: String(mark),
    pnl: row.pnl,
    credited: row.credited,
    capped: row.capped === 1,
    minted: row.minted === 1,
  };
}

function latestTrade(playerId: string): TradeRow | undefined {
  return db
    .prepare(`SELECT * FROM trades WHERE player_id = ? ORDER BY opened_at DESC LIMIT 1`)
    .get(playerId) as TradeRow | undefined;
}

export function tradeViewFor(playerId: string): TradeView | null {
  const row = latestTrade(playerId);
  if (!row) return null;
  const price = tokenPrice(row.sym) ?? Number(row.p0);
  return viewOf(row, price);
}

function schedule(id: string, resolvesAt: number): void {
  const prev = timers.get(id);
  if (prev) clearTimeout(prev);
  const delay = Math.max(0, resolvesAt - Date.now());
  const timer = setTimeout(() => {
    timers.delete(id);
    void resolveTrade(id);
  }, delay);
  timer.unref();
  timers.set(id, timer);
}

/**
 * A stored mint_tx_hash is looked up for the treasury signer.
 * Success only sets minted. Failure may sign one fresh transaction.
 * Unknown waits 3 minutes, then signs a fresh transaction.
 * Signed bytes are not stored, so a sent transaction is never broadcast again.
 * chain_before is diagnostic only.
 */
export function resumeTrades(): Promise<void> {
  const open = db.prepare(`SELECT id, resolves_at FROM trades WHERE status = 'open'`).all() as {
    id: string;
    resolves_at: number;
  }[];
  for (const row of open) schedule(row.id, row.resolves_at);
  if (!retryTimer && !process.env.VITEST) retryTimer = setInterval(() => void retryPendingMints(), 20_000);
  return retryPendingMints();
}

export async function tradeSnapshot(player: PlayerRow): Promise<{
  bet: TradeView | null;
  available: string;
  settling: string;
  xp: Xp;
  payUsed: number;
}> {
  const fresh = getPlayerById(player.id) ?? player;
  const funds = await fundsView(fresh);
  return {
    bet: tradeViewFor(fresh.id),
    available: funds.available,
    settling: funds.settling,
    xp: parseXp(fresh.xp_json),
    payUsed: 0,
  };
}

export async function openTrade(
  player: PlayerRow,
  input: { sym: string; dir: 1 | -1; stake: number },
): Promise<{ bet: TradeView; available: string; settling: string; xp: Xp; payUsed: number }> {
  const sym = input.sym.trim().toUpperCase();
  const price = tokenPrice(sym);
  if (!price) throw new AuthError('Unknown coin', 400);
  const { stake, dir } = input;
  if (stake < TRADE_MIN_STAKE || stake > TRADE_MAX_STAKE) {
    throw new AuthError(`Stake must be ${TRADE_MIN_STAKE} to ${TRADE_MAX_STAKE} GD`, 400);
  }
  const fee = tradeFee(stake);
  if (!player.account_id) throw new AuthError('Player has no account', 503);
  const chain = BigInt(await getGDBalanceCached(player.account_id));

  const id = randomId();
  const now = Date.now();
  const resolvesAt = now + TRADE_SECS * 1000;
  const insert = db.transaction(() => {
    const open = db
      .prepare(`SELECT id FROM trades WHERE player_id = ? AND status = 'open'`)
      .get(player.id) as { id: string } | undefined;
    if (open) throw new AuthError('You already have a bet running', 409);
    const recent = db
      .prepare(`SELECT COUNT(*) AS n FROM trades WHERE player_id = ? AND opened_at > ?`)
      .get(player.id, now - MINUTE_MS) as { n: number };
    if (recent.n >= TRADE_OPENS_PER_MIN) throw new AuthError('Too many bets. Wait a moment.', 429);
    const held = ledgerTotals(player.id);
    const available = chain - held.pending - held.escrowed + held.settling;
    if (available < BigInt(stake + fee)) throw new AuthError('Not enough GD', 400);
    db.prepare(
      `INSERT INTO trades (id, player_id, sym, dir, stake, fee, p0, opened_at, resolves_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    ).run(id, player.id, sym, dir, String(stake), String(fee), String(price), now, resolvesAt);
    db.prepare(
      `INSERT INTO escrow (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, player.id, String(stake), 'trade', now);
    if (fee > 0) {
      db.prepare(
        `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(`tf-${id}`, player.id, String(fee), 'trade-fee', now);
    }
  });
  try {
    insert.immediate();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) throw new AuthError('You already have a bet running', 409);
    throw err;
  }

  nudgeCoin(sym, dir, stake);
  if (stake >= LARGE_STAKE_GD) {
    world.pressures.leverage = bumpLeverage(world.pressures.leverage, LEVERAGE_LARGE_BUMP);
  }
  schedule(id, resolvesAt);
  const snap = await tradeSnapshot(player);
  if (!snap.bet) throw new AuthError('Bet was not recorded', 503);
  return { ...snap, bet: snap.bet };
}

async function mintProfit(row: TradeRow): Promise<void> {
  if (row.minted === 1) return;
  const credited = BigInt(row.credited ?? '0');
  if (credited <= 0n) {
    db.prepare(`UPDATE trades SET minted = 1 WHERE id = ?`).run(row.id);
    return;
  }
  if (minting.has(row.id)) return;
  minting.add(row.id);
  try {
    const fresh = db.prepare(`SELECT * FROM trades WHERE id = ?`).get(row.id) as TradeRow | undefined;
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
          db.prepare(`UPDATE trades SET minted = 1 WHERE id = ? AND minted = 0`).run(fresh.id);
          invalidateGdCache(accountId);
        },
        persist: (hash, at, attempts) => {
          db.prepare(`UPDATE trades SET mint_tx_hash = ?, mint_tx_at = ?, mint_attempts = ? WHERE id = ?`).run(
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
    console.error('[trade] profit mint failed');
  } finally {
    minting.delete(row.id);
  }
}

async function retryPendingMints(): Promise<void> {
  const due = db
    .prepare(`SELECT * FROM trades WHERE status = 'settled' AND minted = 0`)
    .all() as TradeRow[];
  for (const row of due) await mintProfit(row);
}

export async function resolveTrade(id: string): Promise<void> {
  if (resolving.has(id)) return;
  resolving.add(id);
  try {
    const row = db.prepare(`SELECT * FROM trades WHERE id = ?`).get(id) as TradeRow | undefined;
    if (!row || row.status !== 'open') return;
    const price = tokenPrice(row.sym) ?? Number(row.p0);
    const dir = row.dir < 0 ? -1 : 1;
    const stake = Number(row.stake);
    const pnl = tradePnl(stake, dir, Number(row.p0), price);
    const player = getPlayerById(row.player_id);
    if (!player) return;

    const now = Date.now();
    const chainBefore = await readGdBalanceForLog(player.account_id);

    const settled = db.transaction(() => {
      const fresh = db.prepare(`SELECT status FROM trades WHERE id = ?`).get(id) as { status: string } | undefined;
      if (!fresh || fresh.status !== 'open') return null;
      const progress = db
        .prepare(`SELECT xp_json, needs_json FROM players WHERE id = ?`)
        .get(row.player_id) as { xp_json: string; needs_json: string } | undefined;
      if (!progress) return null;
      const xp = parseXp(progress.xp_json);
      let credited = 0;
      if (pnl > 0) {
        credited = faucetCredit(pnl, isWeak(progress.needs_json)).credited;
        xp.trade += 20;
      } else {
        xp.trade += 12;
      }
      db.prepare(`DELETE FROM escrow WHERE id = ?`).run(id);
      if (pnl < 0) {
        db.prepare(
          `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(`tl-${id}`, row.player_id, String(-pnl), 'trade-loss', now);
      }
      db.prepare(`UPDATE players SET xp_json = ? WHERE id = ?`).run(JSON.stringify(xp), row.player_id);
      db.prepare(
        `UPDATE trades SET status = 'settled', price_out = ?, pnl = ?, credited = ?, capped = ?, minted = ?, chain_before = ? WHERE id = ?`,
      ).run(String(price), String(pnl), String(credited), 0, credited > 0 ? 0 : 1, chainBefore, id);
      return credited;
    });
    const credited = settled.immediate();
    if (credited == null) return;
    if (credited > 0) {
      const paid = db.prepare(`SELECT * FROM trades WHERE id = ?`).get(id) as TradeRow;
      await mintProfit(paid);
    }
  } finally {
    resolving.delete(id);
  }
}
