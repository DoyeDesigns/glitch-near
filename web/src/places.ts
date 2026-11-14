/** Shared city place ids for map, chat, and multiplayer presence. */

export type Loc = {
  id: string;
  name: string;
  x: number;
  z: number;
  r: number;
  sp: [number, number];
  note: string;
};

export const LOCS: Loc[] = [
  { id: 'plaza', name: 'Central Plaza', x: 0, z: 6, r: 14, sp: [0, 10], note: 'The main square. Everyone passes through.' },
  { id: 'wall', name: 'Wall Street', x: -20, z: -4, r: 12, sp: [-15.5, -9], note: 'Trade coins at the Exchange.' },
  { id: 'lab', name: 'Vault Lab', x: 20, z: -4, r: 12, sp: [15.5, -9], note: 'Crack vaults and watch the bounty board.' },
  { id: 'tower', name: 'Attention Tower', x: 0, z: -26, r: 10, sp: [0, -25], note: 'Post, trend and gain followers.' },
  { id: 'forge', name: 'Gear Forge', x: 0, z: -10, r: 8, sp: [0, -6], note: 'Forge gear from shards.' },
  { id: 'diner', name: 'Neon Diner', x: 34, z: 24, r: 10, sp: [34, 20.5], note: 'Eat here. Paid in GD.' },
  { id: 'home', name: 'My Home', x: 22, z: 32, r: 10, sp: [22, 26.5], note: 'Your place.' },
];

export function locAt(x: number, z: number): Loc {
  let best = LOCS[0]!;
  let bestD = 1e9;
  for (const l of LOCS) {
    const d = Math.hypot(x - l.x, z - l.z) - l.r;
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

/** Map interior room id → public place id used by map / presence / chat. */
export function placeFromInterior(interior: string | null | undefined): string | null {
  if (!interior) return null;
  if (interior === 'home') return 'home';
  if (interior === 'diner') return 'diner';
  if (interior === 'exchange') return 'wall';
  if (interior === 'vault') return 'lab';
  if (interior === 'tower') return 'tower';
  if (interior === 'forge') return 'forge';
  return interior;
}

/** Canonical place for presence: interior when inside, else nearest outdoor LOC. */
export function placeId(interior: string | null | undefined, x: number, z: number): string {
  return placeFromInterior(interior) ?? locAt(x, z).id;
}

export function locById(id: string): Loc | undefined {
  return LOCS.find(l => l.id === id);
}
