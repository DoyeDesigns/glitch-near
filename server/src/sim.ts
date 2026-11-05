import {
  createWorld,
  stepWorld,
  type Case,
  type FeedPost,
  type MarketState,
  type SimEffect,
  type Token,
  type World,
} from '@glitch/shared';
import { config } from './config';

export type ActiveEvent = {
  id: string;
  kind: string;
  label: string;
  at: number;
};

export type StreamToken = Omit<Token, 'hist'> & { hist: number[] };

export type StreamPayload = {
  tick: number;
  tokens: StreamToken[];
  market: MarketState;
  feed: FeedPost[];
  cases: Case[];
  activeEvents: ActiveEvent[];
};

export const world: World = createWorld(config.seed);

const MAX_ACTIVE = 32;
const ACTIVE_TTL_SEC = 30;
let effectSeq = 0;
const activeEvents: ActiveEvent[] = [];

function labelForEffect(e: SimEffect): string {
  switch (e.kind) {
    case 'banner':
      return e.text;
    case 'crowd':
      return `crowd:${e.zone}`;
    case 'panic':
      return `panic:${e.panic}`;
    case 'glitch':
      return 'glitch';
    case 'playerCaught':
      return `caught:#${e.caseNo}`;
    case 'playerEscaped':
      return `escaped:#${e.caseNo}`;
  }
}

function drainEffects(): void {
  const now = world.time;
  for (const e of world.effects) {
    effectSeq += 1;
    activeEvents.unshift({
      id: `${Math.floor(now * 1000)}-${effectSeq}`,
      kind: e.kind,
      label: labelForEffect(e),
      at: now,
    });
  }
  world.effects.length = 0;
  while (activeEvents.length > MAX_ACTIVE) activeEvents.pop();
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    if (now - activeEvents[i]!.at > ACTIVE_TTL_SEC) activeEvents.splice(i, 1);
  }
}

export function startSimLoop(): void {
  setInterval(() => {
    stepWorld(world, 0.5);
    drainEffects();
  }, 500);
  console.log(`[sim] stepping world seed=${config.seed} every 500ms`);
}

export function getStreamPayload(): StreamPayload {
  return {
    tick: Math.floor(world.time * 2), // 0.5s ticks
    tokens: world.tokens.map(t => ({
      sym: t.sym,
      name: t.name,
      price: t.price,
      vol: t.vol,
      base: { ...t.base },
      hype: t.hype,
      usage: t.usage,
      trust: t.trust,
      flow: t.flow,
      supply: t.supply,
      hist: t.hist.slice(-60),
    })),
    market: { mood: world.market.mood, heat: world.market.heat },
    feed: world.feed.slice(0, 40).map(f => ({ ...f })),
    cases: world.cases.map(c => ({ ...c })),
    activeEvents: activeEvents.map(e => ({ ...e })),
  };
}

export function getHealth() {
  return {
    ok: true as const,
    tick: Math.floor(world.time * 2),
    seed: world.seed,
    time: world.time,
  };
}
