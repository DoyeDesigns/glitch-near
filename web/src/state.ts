import { payCapFor, skillLevel, START_GD } from '@glitch/shared';
import { DEFAULT_LOOK, type S as PlayerState, type TxEntry } from './types';

export const START = START_GD;
export const SAVE = 'glitch-proto-v1';
export { DEFAULT_LOOK };

type LevelUpFn = (skill: string, level: number, name: string) => void;
let onLevelUp: LevelUpFn = () => {};
export const setLevelUpHandler = (fn: LevelUpFn) => {
  onLevelUp = fn;
};

export const S: PlayerState = {
  name: 'Newcomer',
  bal: START,
  rep: 0,
  followers: 0,
  created: 0,
  burned: 0,
  payDay: '',
  payUsed: 0,
  xp: { trade: 0, sec: 0, comm: 0 },
  stats: { trades: 0, wins: 0, found: 0, posts: 0, exploits: 0, reports: 0 },
  wantedUntil: 0,
  follows: [],
  needs: { energy: 100, hunger: 80 },
  shards: 0,
  nfts: [],
  home: { owned: false, paidUntil: 0, items: [] },
  look: { ...DEFAULT_LOOK },
};

try {
  const j = JSON.parse(localStorage.getItem(SAVE) || 'null') as Partial<PlayerState> | null;
  if (j) {
    Object.assign(S, j);
    S.xp = Object.assign({ trade: 0, sec: 0, comm: 0 }, j.xp);
    S.stats = Object.assign(S.stats, j.stats);
  }
} catch {
  /* ignore */
}
S.follows = S.follows || [];
S.needs = Object.assign({ energy: 100, hunger: 80 }, S.needs || {});
S.shards = S.shards || 0;
delete (S as { usdg?: number }).usdg;
S.nfts = S.nfts || [];
S.home = Object.assign({ owned: false, paidUntil: 0, items: [] }, S.home || {});
S.look = Object.assign({}, DEFAULT_LOOK, S.look || {});

export const weak = () => S.needs.energy < 15 || S.needs.hunger < 10;
export const save = () => {
  try {
    localStorage.setItem(SAVE, JSON.stringify(S));
  } catch {
    /* ignore */
  }
};

export let bannerT = 0;
export const setBannerT = (t: number) => {
  bannerT = t;
};

export const SK: Record<string, string> = { trade: 'Trade', sec: 'Security', comm: 'Community' };
export const lvl = skillLevel;
export const L = (k: keyof PlayerState['xp']) => lvl(S.xp[k]);

export function addXp(k: keyof PlayerState['xp'], n: number) {
  const before = L(k);
  S.xp[k] += n;
  if (L(k) > before) onLevelUp(SK[k]!, L(k), S.name);
}

export const dayKey = () => new Date().toISOString().slice(0, 10);
export const payCap = () => payCapFor(S.xp);
export const txlog: TxEntry[] = [];
export function logTx(kind: string, amt: number, note: string) {
  txlog.unshift({
    kind,
    amt,
    note,
    h: '0x' + Math.random().toString(16).slice(2, 6) + '…' + Math.random().toString(16).slice(2, 6),
  });
  if (txlog.length > 40) txlog.pop();
}

export function earn(amount: number) {
  if (weak()) amount *= 0.6;
  if (S.payDay !== dayKey()) {
    S.payDay = dayKey();
    S.payUsed = 0;
  }
  const full = Math.min(amount, Math.max(0, payCap() - S.payUsed));
  const over = amount - full;
  const credited = full + over * 0.2;
  S.payUsed += full;
  S.bal += credited;
  S.created += credited;
  logTx('in', credited, 'Skill pay');
  return { credited, capped: over > 0 };
}

export const escrow = (stake: number) => {
  S.bal -= stake;
};

export function settle(stake: number, pnl: number) {
  if (pnl >= 0) {
    S.bal += stake;
    return earn(pnl);
  }
  S.bal += stake + pnl;
  S.burned += -pnl;
  logTx('out', -pnl, 'Trade loss');
  return { credited: pnl, capped: false };
}

export const burn = (n: number) => {
  S.bal -= n;
  S.burned += n;
};

export function roleName() {
  if (Date.now() < S.wantedUntil) return 'Wanted';
  const t = L('trade'),
    s = L('sec'),
    c = L('comm');
  if (s >= 3 && S.stats.exploits > S.stats.reports) return 'Hacker';
  if (s >= 3 && S.stats.reports > 0) return 'Whitehat';
  const mx = Math.max(t, s, c);
  if (mx < 2) return 'Newcomer';
  return mx === t ? 'Trader' : mx === s ? 'Auditor' : 'Shiller';
}
