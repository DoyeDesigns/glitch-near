import {
  chg as sharedChg,
  EVENTS,
  TOKEN_DEFS,
  UPKEEP_RATE,
  type Case,
  type EventStage,
  type FeedPost,
  type MarketState,
  type Pressures,
  type Token,
} from '@glitch/shared';
import { $, clamp, fmtN, pick as pickUi, randn, rnd as rndUi } from './util';
import { bannerT, burn, S, save, setBannerT, setLevelUpHandler } from './state';
import { NPC_NAMES } from './constants';
import { crowdTo, glitchFx, worldFx } from './world';
import { drawScreens, renderSide, sideTab, updateHud } from './hud';
import { chatIn, phoneOpen, phoneRefresh } from './phone';

setLevelUpHandler((skill, level, name) => {
  banner(`${skill} skill up: level ${level}`, 'good');
  post('sys', 'LEVEL UP', `${name} reached ${skill} level ${level}.`);
});

/** Client mirrors of authoritative server state (filled by EventSource). */
export const TOK: Token[] = TOKEN_DEFS.map(d => ({
  ...d,
  base: { ...d.base },
  hype: d.base.hype,
  usage: d.base.usage,
  trust: d.base.trust,
  flow: 0,
  supply: 0,
  hist: [d.price],
}));
export const market: MarketState = { mood: 0, heat: 0 };
export const cases: Case[] = [];
export const feed: FeedPost[] = [];
/** Mirrored from /stream — no Pressure HUD yet. */
export const pressures: Pressures = { euphoria: 0, leverage: 0 };
export let eventStage: EventStage | null = null;

export let serverTick = 0;

export type ActiveEvent = { id: string; kind: string; label: string; at: number };

export type StreamPayload = {
  tick: number;
  tokens: Token[];
  market: MarketState;
  feed: FeedPost[];
  cases: Case[];
  activeEvents: ActiveEvent[];
  pressures?: Pressures;
  eventStage?: EventStage | null;
};

export function applyStreamState(data: StreamPayload): void {
  serverTick = data.tick;
  market.mood = data.market.mood;
  market.heat = data.market.heat;
  if (data.pressures) {
    pressures.euphoria = data.pressures.euphoria;
    pressures.leverage = data.pressures.leverage;
  }
  eventStage = data.eventStage ?? null;

  for (const incoming of data.tokens) {
    const t = TOK.find(x => x.sym === incoming.sym);
    if (!t) continue;
    t.price = incoming.price;
    t.vol = incoming.vol;
    t.hype = incoming.hype;
    t.usage = incoming.usage;
    t.trust = incoming.trust;
    t.flow = incoming.flow;
    t.supply = incoming.supply;
    t.base = { ...incoming.base };
    t.hist = incoming.hist.slice();
  }

  cases.length = 0;
  for (const c of data.cases) cases.push({ ...c });

  // Preserve optimistic local player posts (wall-clock t) until server catches up.
  const localOnly = feed.filter(p => p.t > 1e12 && p.who === S.name);
  feed.length = 0;
  for (const p of data.feed) feed.push({ ...p });
  for (const p of localOnly) {
    if (!feed.some(f => f.who === p.who && f.text === p.text)) feed.unshift(p);
  }
  while (feed.length > 60) feed.pop();
}

export function applyActiveEvents(events: ActiveEvent[]): void {
  for (const e of events) {
    switch (e.kind) {
      case 'banner':
        banner(e.label, e.label.startsWith('RUG') || e.label.startsWith('HACK') || e.label.startsWith('REGULATOR') || e.label.startsWith('CIA') ? 'bad' : e.label.includes('pump') || e.label.includes('audit') ? (e.label.includes('audit') ? 'info' : 'good') : 'bad');
        break;
      case 'crowd': {
        const zone = e.label.startsWith('crowd:') ? e.label.slice(6) : 'trade';
        crowdTo(zone, 20);
        break;
      }
      case 'panic': {
        const n = Number(e.label.split(':')[1] ?? 8);
        worldFx.panic = n;
        worldFx.siren = Math.max(6, n - 1);
        break;
      }
      case 'glitch':
        glitchFx();
        break;
      case 'playerCaught': {
        // Server-authoritative economy later; local fine for presentation parity.
        const loot = 0;
        const fine = Math.min(Math.max(S.bal, 0), loot * 1.25);
        burn(fine);
        S.rep -= 3;
        S.wantedUntil = Date.now() + 120000;
        banner(`CIA caught you. -${fmtN(fine)} GD and -3 rep`, 'bad');
        break;
      }
      case 'playerEscaped':
        banner('CIA case dismissed. You got away with it.', 'info');
        break;
      default:
        break;
    }
  }
  if (events.length) {
    if (sideTab === 'feed') renderSide();
    if (phoneOpen) phoneRefresh();
  }
}

export const px = (p: number) => (p >= 1000 ? fmtN(p) : p >= 1 ? p.toFixed(2) : p.toFixed(4));
export const chg = (t: Token, n = 60) => sharedChg(t, n);

const serverOnly = (name: string) => {
  console.warn(`[glitch] ${name} is server-authoritative; use the SSE stream`);
};

export function tickMarket() {
  serverOnly('tickMarket');
}

export function openCase(_title: string, _suspect: string | null, _extra?: Partial<Case>) {
  serverOnly('openCase');
}

export function resolveCases() {
  serverOnly('resolveCases');
}

export function runEvent() {
  serverOnly('runEvent');
}

export { EVENTS };

export function post(kind: string, who: string, text: string) {
  feed.unshift({ kind, who, text, t: Date.now(), likes: Math.floor(rndUi(0, 30)) });
  if (feed.length > 60) feed.pop();
  if (sideTab === 'feed') renderSide();
  if (typeof phoneRefresh === 'function' && phoneOpen) phoneRefresh();
}
export const sysPost = (text: string) => post('sys', 'NEWS', text);

export function banner(text: string, kind = 'bad') {
  const b = $('#banner') as HTMLElement;
  b.textContent = text;
  b.className = kind === 'bad' ? '' : kind;
  b.hidden = false;
  setBannerT(4);
}

const CHAT: Array<(t: Token) => string> = [
  t => `${t.sym} looks cooked`,
  t => `buying the ${t.sym} dip`,
  t => `gm. ${t.sym} to the moon`,
  t => `who audited ${t.sym}?`,
  () => 'rug season again',
  () => 'gm',
  () => 'wagmi (maybe)',
  () => 'sent it',
  () => 'not financial advice',
];

export function chatter() {
  /* No walking NPCs — ambient feed lines only (demo chrome). */
  const name = pickUi(NPC_NAMES);
  const loc = pickUi(['plaza', 'wall', 'lab', 'tower', 'diner', 'forge'] as const);
  const txt = pickUi(CHAT)(pickUi(TOK));
  chatIn(loc, name, txt);
  if (Math.random() < 0.35) post('npc', name, txt);
}

export const metrics = { on: 1280, vis: 48213 };
export let tickT = 0;
export const addTickT = (_dt: number) => {
  /* market ticks come from the server stream */
};

let upkeepT = 0,
  saveT = 0,
  chatT = 5,
  metricsT = 0,
  drawT = 0;

/** Client-local economy chrome only — market/events/cases/feed come from SSE. */
export function economyUpdate(dt: number) {
  tickT = serverTick;

  chatT -= dt;
  if (chatT <= 0) {
    chatter();
    chatT = rndUi(6, 11);
  }
  upkeepT += dt;
  if (upkeepT >= 10) {
    upkeepT = 0;
    burn(Math.max(0, S.bal) * UPKEEP_RATE);
  }
  metricsT += dt;
  if (metricsT >= 4) {
    metricsT = 0;
    metrics.on = clamp(metrics.on + randn() * 22, 700, 2600);
    metrics.vis += Math.floor(rndUi(0, 4));
  }
  saveT += dt;
  if (saveT >= 5) {
    saveT = 0;
    save();
  }
  const nextBanner = bannerT - dt;
  setBannerT(nextBanner);
  if (nextBanner <= 0) ($('#banner') as HTMLElement).hidden = true;
  drawT += dt;
  if (drawT >= 0.35) {
    drawT = 0;
    drawScreens();
    updateHud();
  }
}
