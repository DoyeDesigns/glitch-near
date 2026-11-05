import type { Rng } from './rng';

export interface TokenBase {
  hype: number;
  usage: number;
  trust: number;
}

export interface Token {
  sym: string;
  name: string;
  price: number;
  vol: number;
  base: TokenBase;
  hype: number;
  usage: number;
  trust: number;
  flow: number;
  supply: number;
  hist: number[];
}

export interface MarketState {
  mood: number;
  heat: number;
}

export interface Case {
  no: number;
  title: string;
  suspect: string | null;
  at: number;
  caught?: boolean;
  loot?: number;
}

export interface FeedPost {
  kind: string;
  who: string;
  text: string;
  /** Logical sim time in seconds (deterministic). */
  t: number;
  likes: number;
  me?: boolean;
}

/** Presentation / host side-effects produced by the sim (no DOM). */
export type SimEffect =
  | { kind: 'banner'; text: string; tone: 'bad' | 'good' | 'info' }
  | { kind: 'crowd'; zone: string; secs: number }
  | { kind: 'panic'; panic: number; siren: number }
  | { kind: 'glitch' }
  | { kind: 'playerCaught'; caseNo: number; loot: number }
  | { kind: 'playerEscaped'; caseNo: number };

export interface World {
  seed: number;
  rng: Rng;
  /** Elapsed sim time in seconds (was clockT). */
  time: number;
  /** Accumulator for 0.5s market ticks. */
  marketAcc: number;
  /** Seconds until next weighted event. */
  nextEv: number;
  tokens: Token[];
  market: MarketState;
  cases: Case[];
  caseNo: number;
  feed: FeedPost[];
  /** Drained by the host after each step. */
  effects: SimEffect[];
}

export type WorldSnapshot = {
  seed: number;
  rngState: number;
  time: number;
  marketAcc: number;
  nextEv: number;
  market: MarketState;
  tokens: Token[];
  cases: Case[];
  caseNo: number;
  feed: FeedPost[];
};

export type EventDef = {
  w: number;
  run: (world: World) => void;
};
