export interface Look {
  skin: number;
  hair: number;
  hairC: number;
  top: number;
  bot: number;
  glasses: boolean;
  glassC: number;
  gear: number;
  /** Cap brim facing: 0 front, 1 back, 2 left, 3 right. */
  capDir: number;
}

export const DEFAULT_LOOK: Look = {
  skin: 3,
  hair: 0,
  hairC: 0,
  top: 0,
  bot: 0,
  glasses: true,
  glassC: 0,
  gear: 0,
  capDir: 0,
};

export interface Needs {
  energy: number;
  hunger: number;
}

/** Client-only room paint (floor / wall / accent). */
export interface HomePaint {
  id: string;
  floor: number;
  wall: number;
  accent: number;
}

export interface Home {
  owned: boolean;
  paidUntil: number;
  items: string[];
  /** Visual room colors; not on-chain. */
  paint?: HomePaint;
}

export interface Nft {
  g: number;
  /** On-chain token id (`gear-<type>-<uuid>`). */
  id: string;
  rar: string;
}

export interface Stats {
  trades: number;
  wins: number;
  found: number;
  posts: number;
  exploits: number;
  reports: number;
}

export interface Xp {
  trade: number;
  sec: number;
  comm: number;
}

export interface S {
  name: string;
  bal: number;
  rep: number;
  followers: number;
  created: number;
  burned: number;
  payDay: string;
  payUsed: number;
  xp: Xp;
  stats: Stats;
  wantedUntil: number;
  follows: string[];
  needs: Needs;
  shards: number;
  nfts: Nft[];
  home: Home;
  look: Look;
  styled?: number;
}

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

export interface Station {
  id: string;
  name: string;
  x: number;
  z: number;
  col: number;
  locked?: string;
  /** Outdoor-only legacy ring (park bench). Indoors use object highlights. */
  ring?: import('three').Mesh;
  beam?: import('three').Mesh;
  label?: import('three').Sprite;
  /** Exit / enter sign sprite for doors. */
  sign?: import('three').Sprite;
}

export interface Event {
  w: number;
  run: () => void;
}

/** Alias used by some modules */
export type GameEvent = Event;

export interface Case {
  no: number;
  title: string;
  suspect: string | null;
  at: number;
  caught?: boolean;
  loot?: number;
  playerId?: string;
}

export interface FeedPost {
  kind: string;
  who: string;
  text: string;
  t: number;
  likes: number;
  me?: boolean;
}

export interface TxEntry {
  kind: string;
  amt: number;
  note: string;
  h: string;
}

export interface MarketState {
  mood: number;
  heat: number;
}

declare global {
  interface Window {
    __g: Record<string, unknown>;
  }
}
