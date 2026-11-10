import { catalogById, catalogByKind } from '@glitch/shared';
import { S } from './state';
import type { Nft } from './types';

const FURNITURE_IDS = new Set(catalogByKind('furniture').map(i => i.id));

/** Map GET /me `items` into shards, home furniture, studio, and gear NFTs. */
export function applyChainItems(items: Record<string, string> | null | undefined): void {
  if (!items) return;

  S.shards = Number(items.shard ?? '0') || 0;
  if (BigInt(items['studio-apartment'] ?? '0') > 0n) S.home.owned = true;

  const furn: string[] = [];
  for (const [id, amt] of Object.entries(items)) {
    if (FURNITURE_IDS.has(id) && BigInt(amt) > 0n) furn.push(id);
  }
  S.home.items = furn;

  const nfts: Nft[] = [];
  for (const [tokenId, amt] of Object.entries(items)) {
    if (BigInt(amt) <= 0n) continue;
    const m = /^gear-([a-z0-9]+)-(.+)$/i.exec(tokenId);
    if (!m) continue;
    const cat = catalogById(m[1]!);
    if (!cat || cat.kind !== 'gear' || cat.effect.gearIndex == null) continue;
    nfts.push({
      g: cat.effect.gearIndex,
      id: tokenId,
      rar: cat.effect.rarity ?? '',
    });
  }
  S.nfts = nfts;
}

/** Catalog gear id for a forge gear index (1=cap, 3=chain, …). */
export function forgeItemIdForGear(g: number): string | null {
  for (const item of catalogByKind('gear')) {
    if (item.effect.gearIndex === g && item.effect.shardsCost != null && item.effect.gdCost != null) {
      return item.id;
    }
  }
  return null;
}
