/**
 * Single source of truth for every item a player can buy, craft, earn, or use.
 * Numbers from legacy/glitch-prototype-v2c.html / web ports, with ECONOMY.md
 * adjustments applied via shared/economy.ts. MVP has no USDG: former USDG
 * prices convert via USDG_TO_GD (prototype swap RATE).
 */

import { FURN_PRICE_GD, HOMEP_GD, MAINTENANCE_GD, MAINTENANCE_MS, USDG_TO_GD } from './economy';

export { USDG_TO_GD } from './economy';

export type CatalogKind = 'gear' | 'furniture' | 'food' | 'shard' | 'house' | 'consumable';

/** Merchants: chef (food), smith (forge/gear), dealer (furniture/housing). */
export type CatalogSeller = 'chef' | 'smith' | 'dealer' | 'vault' | 'system';

export type CatalogEffect = {
  description: string;
  comfortPts?: number;
  hunger?: number;
  energy?: number;
  /** Gear Forge mint cost in shards (unchanged from prototype). */
  shardsCost?: number;
  /** Gear Forge mint cost in GD (= former USDG × USDG_TO_GD). */
  gdCost?: number;
  rarity?: string;
  gearIndex?: number;
  /** Recurring studio maintenance in GD (= former USDG × USDG_TO_GD). */
  maintenanceGD?: number;
  /** Maintenance period in ms. */
  maintenanceMs?: number;
};

export type CatalogItem = {
  id: string;
  kind: CatalogKind;
  title: string;
  /** GD list price (converted from USDG where needed), or null if not buyable. */
  priceGD: number | null;
  sellerId: CatalogSeller;
  /** null = fungible; 1 = unique gear (minted as gear-<type>-<uuid>). */
  maxSupply: number | null;
  effect: CatalogEffect;
  source: string;
  proposed?: true;
};

/** On-chain id for a unique gear NFT: `gear-<type>-<uuid>`. */
export function gearTokenId(type: string, uuid: string): string {
  return `gear-${type}-${uuid}`;
}

/**
 * Full catalog. Gear rows are templates — mint creates `gear-<type>-<uuid>`
 * with max_supply 1. Do not seed gear types.
 */
export const CATALOG: readonly CatalogItem[] = [
  /* ---------- gear (smith / forge) ---------- */
  {
    id: 'cap',
    kind: 'gear',
    title: 'Cap',
    // was 2 USDG (+ 3 shards)
    priceGD: 2 * USDG_TO_GD,
    sellerId: 'smith',
    maxSupply: 1,
    effect: {
      description: 'Wearable NFT. Mint at Gear Forge: 3 shards + gdCost (Common).',
      shardsCost: 3,
      gdCost: 2 * USDG_TO_GD, // was 2 USDG
      rarity: 'Common',
      gearIndex: 1,
    },
    source: 'legacy GEARINFO[1]; web/src/games.ts GEARINFO',
  },
  {
    id: 'headphones',
    kind: 'gear',
    title: 'Headphones',
    priceGD: null,
    sellerId: 'system',
    maxSupply: null,
    effect: {
      description: 'Free starter gear (always owned). Wearable in the look customizer.',
      gearIndex: 2,
    },
    source: 'legacy FREEGEAR includes 2; GEARS[2]',
  },
  {
    id: 'chain',
    kind: 'gear',
    title: 'Chain',
    // was 10 USDG (+ 8 shards)
    priceGD: 10 * USDG_TO_GD,
    sellerId: 'smith',
    maxSupply: 1,
    effect: {
      description: 'Wearable NFT. Mint at Gear Forge: 8 shards + gdCost (Rare).',
      shardsCost: 8,
      gdCost: 10 * USDG_TO_GD, // was 10 USDG
      rarity: 'Rare',
      gearIndex: 3,
    },
    source: 'legacy GEARINFO[3]; web/src/games.ts GEARINFO',
  },
  {
    id: 'backpack',
    kind: 'gear',
    title: 'Backpack',
    // was 5 USDG (+ 5 shards)
    priceGD: 5 * USDG_TO_GD,
    sellerId: 'smith',
    maxSupply: 1,
    effect: {
      description: 'Wearable NFT. Mint at Gear Forge: 5 shards + gdCost (Common).',
      shardsCost: 5,
      gdCost: 5 * USDG_TO_GD, // was 5 USDG
      rarity: 'Common',
      gearIndex: 4,
    },
    source: 'legacy GEARINFO[4]; web/src/games.ts GEARINFO',
  },
  {
    id: 'cape',
    kind: 'gear',
    title: 'Cape',
    // was 20 USDG (+ 15 shards)
    priceGD: 20 * USDG_TO_GD,
    sellerId: 'smith',
    maxSupply: 1,
    effect: {
      description: 'Wearable NFT. Mint at Gear Forge: 15 shards + gdCost (Epic).',
      shardsCost: 15,
      gdCost: 20 * USDG_TO_GD, // was 20 USDG
      rarity: 'Epic',
      gearIndex: 5,
    },
    source: 'legacy GEARINFO[5]; web/src/games.ts GEARINFO',
  },
  {
    id: 'crown',
    kind: 'gear',
    title: 'Crown',
    // was 40 USDG (+ 30 shards)
    priceGD: 40 * USDG_TO_GD,
    sellerId: 'smith',
    maxSupply: 1,
    effect: {
      description: 'Wearable NFT. Mint at Gear Forge: 30 shards + gdCost (Legendary).',
      shardsCost: 30,
      gdCost: 40 * USDG_TO_GD, // was 40 USDG
      rarity: 'Legendary',
      gearIndex: 6,
    },
    source: 'legacy GEARINFO[6]; web/src/games.ts GEARINFO',
  },

  /* ---------- furniture (dealer) ---------- */
  {
    id: 'bed2',
    kind: 'furniture',
    title: 'Royal Bed',
    priceGD: FURN_PRICE_GD.bed2!, // was 150000
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Sleep faster. +5 comfort.', comfortPts: 5 },
    source: 'legacy FURN bed2; web/src/world.ts FURN; ECONOMY.md',
  },
  {
    id: 'rug',
    kind: 'furniture',
    title: 'Neon Rug',
    priceGD: 15000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Comfy underfoot. +2 comfort.', comfortPts: 2 },
    source: 'legacy FURN rug; web/src/world.ts FURN',
  },
  {
    id: 'sofa',
    kind: 'furniture',
    title: 'Sofa',
    priceGD: 40000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Seat for visitors. +3 comfort.', comfortPts: 3 },
    source: 'legacy FURN sofa; web/src/world.ts FURN',
  },
  {
    id: 'plant',
    kind: 'furniture',
    title: 'Plant',
    priceGD: 8000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Fresh air. +1 comfort.', comfortPts: 1 },
    source: 'legacy FURN plant; web/src/world.ts FURN',
  },
  {
    id: 'lamp',
    kind: 'furniture',
    title: 'Floor Lamp',
    priceGD: 12000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Warm light. +1 comfort.', comfortPts: 1 },
    source: 'legacy FURN lamp; web/src/world.ts FURN',
  },
  {
    id: 'tv',
    kind: 'furniture',
    title: 'Big TV',
    priceGD: 60000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Watch the charts. +4 comfort.', comfortPts: 4 },
    source: 'legacy FURN tv; web/src/world.ts FURN',
  },
  {
    id: 'pc',
    kind: 'furniture',
    title: 'Gaming PC',
    priceGD: 90000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'RGB everything. +5 comfort.', comfortPts: 5 },
    source: 'legacy FURN pc; web/src/world.ts FURN',
  },
  {
    id: 'neon',
    kind: 'furniture',
    title: 'Neon Sign',
    priceGD: 50000,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Your name in lights. +3 comfort.', comfortPts: 3 },
    source: 'legacy FURN neon; web/src/world.ts FURN',
  },
  {
    id: 'trophy',
    kind: 'furniture',
    title: 'Trophy Shelf',
    priceGD: FURN_PRICE_GD.trophy!, // was 120000
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Show off. +6 comfort.', comfortPts: 6 },
    source: 'legacy FURN trophy; web/src/world.ts FURN; ECONOMY.md',
  },

  /* ---------- food (chef) — was USDG at Neon Diner ---------- */
  {
    id: 'jollof-and-chicken',
    kind: 'food',
    title: 'Jollof and chicken',
    // was 8 USDG
    priceGD: 8 * USDG_TO_GD,
    sellerId: 'chef',
    maxSupply: null,
    effect: {
      description: 'A full meal. +45 hunger.',
      hunger: 45,
      energy: 0,
    },
    source: 'legacy MENU[0]; web/src/games.ts MENU',
  },
  {
    id: 'suya-skewer',
    kind: 'food',
    title: 'Suya skewer',
    // was 4 USDG
    priceGD: 4 * USDG_TO_GD,
    sellerId: 'chef',
    maxSupply: null,
    effect: {
      description: 'Quick bite. +25 hunger.',
      hunger: 25,
      energy: 0,
    },
    source: 'legacy MENU[1]; web/src/games.ts MENU',
  },
  {
    id: 'zobo-drink',
    kind: 'food',
    title: 'Zobo drink',
    // was 2 USDG
    priceGD: 2 * USDG_TO_GD,
    sellerId: 'chef',
    maxSupply: null,
    effect: {
      description: 'Cold and refreshing. +8 hunger, +12 energy.',
      hunger: 8,
      energy: 12,
    },
    source: 'legacy MENU[2]; web/src/games.ts MENU',
  },

  /* ---------- shard (vault earn) ---------- */
  {
    id: 'shard',
    kind: 'shard',
    title: 'Shard',
    priceGD: null,
    sellerId: 'vault',
    maxSupply: null,
    effect: {
      description:
        'Earned from Vault Cracker: +1 shard per lock opened, +1 bonus on perfect 3/3. Spent at Gear Forge with gdCost.',
    },
    source: 'legacy secGame S.shards; web/src/games.ts secGame',
  },

  /* ---------- house (dealer) ---------- */
  {
    id: 'studio-apartment',
    kind: 'house',
    title: 'Studio apartment',
    priceGD: HOMEP_GD, // was 200000
    sellerId: 'dealer',
    maxSupply: null,
    effect: {
      description:
        'Own a home: sleep to restore energy and decorate. Maintenance is billed each period; if it can’t be paid, the home is locked until it is.',
      // was 15 USDG (= 7500 GD) every 600000 ms
      maintenanceGD: MAINTENANCE_GD,
      maintenanceMs: MAINTENANCE_MS,
    },
    source: 'legacy HOMEP/RENT/RENT_MS → MAINTENANCE_*; ECONOMY.md applied',
  },
  {
    id: 'penthouse',
    kind: 'house',
    title: 'Penthouse',
    priceGD: null,
    sellerId: 'dealer',
    maxSupply: null,
    effect: { description: 'Bigger rooms. Coming later (UI placeholder only).' },
    source: 'legacy homeHtml Penthouse Soon; web/src/games.ts homeHtml',
    proposed: true,
  },
] as const;

export function catalogByKind(kind: CatalogKind): CatalogItem[] {
  return CATALOG.filter(i => i.kind === kind);
}

export function catalogById(id: string): CatalogItem | undefined {
  return CATALOG.find(i => i.id === id);
}

/** Entries that should exist as on-chain token types (not unique gear, not proposed). */
export function catalogSeedEntries(): CatalogItem[] {
  return CATALOG.filter(i => i.kind !== 'gear' && !i.proposed);
}
