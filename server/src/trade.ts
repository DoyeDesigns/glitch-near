import {
  faucetCredit,
  payCapFor,
  TRADE_MAX_STAKE,
  TRADE_MIN_STAKE,
  TRADE_OPENS_PER_MIN,
  TRADE_SECS,
  tradeFee,
  tradePnl,
} from '@glitch/shared';
import { AuthError, availableGd } from './auth';
import { randomId } from './crypto';
import { db } from './db';
import { getPlayerById, type PlayerRow } from './near';
import { mintGD } from './near/gd';
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

function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function tokenPrice(sym: string): number | null {
  const token = world.tokens.find(t => t.sym === sym);
  return token && token.price > 0 ? token.price : null;
}

function applyFlow(sym: string, dir: 1 | -1, stake: number): void {
  const token = world.tokens.find(t => t.sym === sym);
  if (!token) return;
  token.flow += dir * Math.min(0.5, stake / 2e6);
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
  timers.set(id, timer);
}

export function resumeTrades(): void {
  const open = db.prepare(`SELECT id, resolves_at FROM trades WHERE status = 'open'`).all() as {
    id: string;
    resolves_at: number;
  }[];
  for (const row of open) schedule(row.id, row.resolves_at);
  if (!retryTimer) retryTimer = setInterval(() => void retryPendingMints(), 20_000);
  void retryPendingMints();
}

export async function tradeSnapshot(player: PlayerRow): Promise<{
  bet: TradeView | null;
  available: string;
  xp: Xp;
  payUsed: number;
}> {
  const fresh = getPlayerById(player.id) ?? player;
  const today = dayKey();
  return {
    bet: tradeViewFor(fresh.id),
    available: (await availableGd(fresh)).toString(),
    xp: parseXp(fresh.xp_json),
    payUsed: fresh.pay_day === today ? fresh.pay_used : 0,
  };
}

export async function openTrade(
  player: PlayerRow,
  input: { sym: string; dir: 1 | -1; stake: number },
): Promise<{ bet: TradeView; available: string; xp: Xp; payUsed: number }> {
  const sym = input.sym.trim().toUpperCase();
  const price = tokenPrice(sym);
  if (!price) throw new AuthError('Unknown coin', 400);
  const { stake, dir } = input;
  if (stake < TRADE_MIN_STAKE || stake > TRADE_MAX_STAKE) {
    throw new AuthError(`Stake must be ${TRADE_MIN_STAKE} to ${TRADE_MAX_STAKE} GD`, 400);
  }
  const fee = tradeFee(stake);
  const available = await availableGd(player);
  if (available < BigInt(stake + fee)) throw new AuthError('Not enough GD', 400);

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
    insert();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) throw new AuthError('You already have a bet running', 409);
    throw err;
  }

  applyFlow(sym, dir, stake);
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
    const fresh = db.prepare(`SELECT minted FROM trades WHERE id = ?`).get(row.id) as { minted: number } | undefined;
    if (!fresh || fresh.minted === 1) return;
    const player = getPlayerById(row.player_id);
    if (!player?.account_id) return;
    await mintGD(player.account_id, credited);
    db.prepare(`UPDATE trades SET minted = 1 WHERE id = ? AND minted = 0`).run(row.id);
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
    const today = dayKey(now);
    const xp = parseXp(player.xp_json);
    const payUsed0 = player.pay_day === today ? player.pay_used : 0;
    let credited = 0;
    let capped = false;
    let payUsed = payUsed0;
    if (pnl > 0) {
      const next = faucetCredit(pnl, isWeak(player.needs_json), payCapFor(xp), payUsed0);
      credited = next.credited;
      capped = next.capped;
      payUsed = next.payUsed;
      xp.trade += 20;
    } else {
      xp.trade += 12;
    }

    const settled = db.transaction(() => {
      const fresh = db.prepare(`SELECT status FROM trades WHERE id = ?`).get(id) as { status: string } | undefined;
      if (!fresh || fresh.status !== 'open') return false;
      db.prepare(`DELETE FROM escrow WHERE id = ?`).run(id);
      if (pnl < 0) {
        db.prepare(
          `INSERT INTO pending_burns (id, player_id, amount, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(`tl-${id}`, row.player_id, String(-pnl), 'trade-loss', now);
      }
      db.prepare(
        `UPDATE players SET xp_json = ?, pay_day = ?, pay_used = ? WHERE id = ?`,
      ).run(JSON.stringify(xp), today, payUsed, row.player_id);
      db.prepare(
        `UPDATE trades SET status = 'settled', price_out = ?, pnl = ?, credited = ?, capped = ?, minted = ? WHERE id = ?`,
      ).run(String(price), String(pnl), String(credited), capped ? 1 : 0, credited > 0 ? 0 : 1, id);
      return true;
    });
    if (!settled()) return;
    if (credited > 0) {
      const paid = db.prepare(`SELECT * FROM trades WHERE id = ?`).get(id) as TradeRow;
      await mintProfit(paid);
    }
  } finally {
    resolving.delete(id);
  }
}
