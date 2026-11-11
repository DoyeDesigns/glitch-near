import {
  createWorld,
  stepWorld,
  type Case,
  type EventStage,
  type FeedPost,
  type MarketState,
  type Pressures,
  type SimEffect,
  type Token,
  type World,
} from '@glitch/shared';
import { chargeCiaFine } from './burns';
import { config } from './config';

export type ActiveEvent = {
  id: string;
  kind: string;
  label: string;
  at: number;
  /** GD charged when kind is playerCaught. */
  fine?: number;
};

export type StreamToken = Omit<Token, 'hist'> & { hist: number[] };

export type StreamPayload = {
  tick: number;
  tokens: StreamToken[];
  market: MarketState;
  feed: FeedPost[];
  cases: Case[];
  activeEvents: ActiveEvent[];
  pressures: Pressures;
  eventStage: EventStage | null;
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
      return e.fine != null ? `caught:#${e.caseNo}:${e.fine}` : `caught:#${e.caseNo}`;
    case 'playerEscaped':
      return `escaped:#${e.caseNo}`;
  }
}

/** Drain sim effects into the SSE feed; charge CIA fines before publishing playerCaught. */
export async function drainEffects(): Promise<void> {
  const now = world.time;
  const batch = world.effects.splice(0, world.effects.length);
  for (const e of batch) {
    let fine: number | undefined;
    let effect = e;
    if (e.kind === 'playerCaught' && e.playerId) {
      fine = await chargeCiaFine(e.playerId, e.loot, e.caseNo);
      effect = { ...e, fine };
    }
    effectSeq += 1;
    activeEvents.unshift({
      id: `${Math.floor(now * 1000)}-${effectSeq}`,
      kind: effect.kind,
      label: labelForEffect(effect),
      at: now,
      ...(fine != null ? { fine } : {}),
    });
  }
  while (activeEvents.length > MAX_ACTIVE) activeEvents.pop();
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    if (now - activeEvents[i]!.at > ACTIVE_TTL_SEC) activeEvents.splice(i, 1);
  }
}

/** One sim step + effect drain (tests and the live loop). */
export async function stepSim(dtSeconds = 0.5): Promise<void> {
  stepWorld(world, dtSeconds);
  await drainEffects();
}

export function startSimLoop(): void {
  setInterval(() => {
    void stepSim(0.5);
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
    pressures: { ...world.pressures },
    eventStage: world.eventStage ? { ...world.eventStage } : null,
  };
}

export function getHealth() {
  return {
    ok: true as const,
    tick: Math.floor(world.time * 2),
    seed: world.seed,
    time: world.time,
    chainMode: config.chainMode,
  };
}

/** Test helper: clear active event feed. */
export function clearActiveEventsForTests(): void {
  activeEvents.length = 0;
  effectSeq = 0;
}
