/**
 * Data-driven exteriors + far-plot interiors for the city.
 * Gameplay stations live indoors. City doors are lit markers only (no outdoor rings).
 */
import * as THREE from 'three';

export type Vec2 = { x: number; z: number };

export type BuildingProp =
  | { kind: 'counter'; x: number; z: number; color?: number; trim?: number }
  | { kind: 'desk'; x: number; z: number; color?: number; screen?: number }
  | { kind: 'glassWall'; x: number; z: number; w: number; d: number; axis: 'x' | 'z' }
  | { kind: 'anvil'; x: number; z: number }
  | { kind: 'booth'; x: number; z: number; color?: number };

export type BuildingStationDef = {
  id: string;
  name: string;
  /** Absolute world x/z (already includes origin). */
  x: number;
  z: number;
  col: number;
  locked?: string;
};

export type BuildingDef = {
  id: string;
  name: string;
  exterior: {
    x: number;
    z: number;
    w: number;
    h: number;
    d: number;
    color: number;
    edgeColor: number;
    labelColor: string;
  };
  interior: {
    originX: number;
    originZ: number;
    w: number;
    d: number;
    floorColor: number;
    wallColor: number;
    edgeColor: number;
    lightColor: number;
  };
  door: { exterior: Vec2; interior: Vec2 };
  stations: BuildingStationDef[];
  props: BuildingProp[];
};

/** Absolute interior door world position. */
export function interiorDoorWorld(b: BuildingDef): Vec2 {
  return {
    x: b.interior.originX + b.door.interior.x,
    z: b.interior.originZ + b.door.interior.z,
  };
}

export function buildingForStation(stationId: string): BuildingDef | undefined {
  return BUILDINGS.find(b => b.stations.some(s => s.id === stationId));
}

/**
 * All city buildings with interiors.
 * Interior plots are spaced so they do not overlap.
 */
export const BUILDINGS: BuildingDef[] = [
  {
    id: 'exchange',
    name: 'Exchange',
    exterior: {
      x: -26,
      z: -9,
      w: 14,
      h: 9,
      d: 12,
      color: 0x101a30,
      edgeColor: 0x2ee6ff,
      labelColor: '#2ee6ff',
    },
    interior: {
      originX: 180,
      originZ: 0,
      w: 12,
      d: 12,
      floorColor: 0x121a30,
      wallColor: 0x0c1428,
      edgeColor: 0x2ee6ff,
      lightColor: 0x88e0ff,
    },
    door: { exterior: { x: -17.4, z: -9 }, interior: { x: 0, z: 5 } },
    stations: [
      { id: 'trade', name: 'Trade Terminal', x: 178, z: -2.5, col: 0x2ee6ff },
      { id: 'bdoor-exchange', name: 'Exit', x: 180, z: 5, col: 0x2ee6ff },
    ],
    props: [{ kind: 'desk', x: 178, z: -3.2, color: 0x1a2848, screen: 0x2ee6ff }],
  },
  {
    id: 'vault',
    name: 'Vault Lab',
    exterior: {
      x: 26,
      z: -9,
      w: 14,
      h: 8,
      d: 12,
      color: 0x0c1a1c,
      edgeColor: 0xb8ff3d,
      labelColor: '#b8ff3d',
    },
    interior: {
      originX: 220,
      originZ: 0,
      w: 12,
      d: 12,
      floorColor: 0x0c1814,
      wallColor: 0x081410,
      edgeColor: 0xb8ff3d,
      lightColor: 0xb8ff3d,
    },
    door: { exterior: { x: 17.4, z: -9 }, interior: { x: 0, z: 5 } },
    stations: [
      { id: 'sec', name: 'Vault Cracker', x: 218, z: -2.5, col: 0xb8ff3d },
      { id: 'bdoor-vault', name: 'Exit', x: 220, z: 5, col: 0xb8ff3d },
    ],
    props: [{ kind: 'desk', x: 218, z: -3.2, color: 0x143020, screen: 0xb8ff3d }],
  },
  {
    id: 'tower',
    name: 'Attention Tower',
    exterior: {
      x: 0,
      z: -34,
      w: 10,
      h: 26,
      d: 10,
      color: 0x1a1030,
      edgeColor: 0xff3d9a,
      labelColor: '#ff3d9a',
    },
    interior: {
      originX: 220,
      originZ: 40,
      w: 12,
      d: 12,
      floorColor: 0x1a1020,
      wallColor: 0x140c1c,
      edgeColor: 0xff3d9a,
      lightColor: 0xff6ab0,
    },
    door: { exterior: { x: 0, z: -27.4 }, interior: { x: 0, z: 5 } },
    stations: [
      { id: 'comm', name: 'Attention Booth', x: 220, z: 37.5, col: 0xff3d9a },
      { id: 'bdoor-tower', name: 'Exit', x: 220, z: 45, col: 0xff3d9a },
    ],
    props: [{ kind: 'booth', x: 220, z: 36.8, color: 0x2a1838 }],
  },
  {
    id: 'forge',
    name: 'Gear Forge',
    exterior: {
      x: 0,
      z: -12,
      w: 8,
      h: 5,
      d: 6,
      color: 0x1a1008,
      edgeColor: 0xff6a3d,
      labelColor: '#ff6a3d',
    },
    interior: {
      originX: 260,
      originZ: 0,
      w: 10,
      d: 10,
      floorColor: 0x2a1810,
      wallColor: 0x1a1008,
      edgeColor: 0xff6a3d,
      lightColor: 0xff8040,
    },
    door: { exterior: { x: 0, z: -7.8 }, interior: { x: 0, z: 4 } },
    stations: [
      { id: 'forge', name: 'Gear Forge', x: 260, z: -2, col: 0xff6a3d },
      { id: 'bdoor-forge', name: 'Exit', x: 260, z: 4, col: 0xff6a3d },
    ],
    props: [{ kind: 'anvil', x: 260, z: -2.5 }],
  },
  {
    id: 'diner',
    name: 'Neon Diner',
    exterior: {
      x: 34,
      z: 28,
      w: 10,
      h: 6,
      d: 8,
      color: 0x1a1408,
      edgeColor: 0xffb12e,
      labelColor: '#ffb12e',
    },
    interior: {
      originX: 180,
      originZ: 40,
      w: 10,
      d: 12,
      floorColor: 0x4a3022,
      wallColor: 0x1a120e,
      edgeColor: 0xffb12e,
      lightColor: 0xffb060,
    },
    door: { exterior: { x: 34, z: 22.4 }, interior: { x: 0, z: 5 } },
    stations: [
      // Keep counter deep in the room so enter/exit UI does not fight Use.
      { id: 'eat', name: 'Diner Counter', x: 180, z: 37.5, col: 0xffb12e },
      { id: 'bdoor-diner', name: 'Exit', x: 180, z: 45, col: 0xffb12e },
    ],
    props: [
      { kind: 'counter', x: 180, z: 36.8, color: 0x5a3418, trim: 0xffb12e },
      { kind: 'glassWall', x: 184.9, z: 40, w: 0.08, d: 11.2, axis: 'x' },
    ],
  },
  {
    id: 'home',
    name: 'My Home',
    exterior: {
      x: 22,
      z: 34,
      w: 8,
      h: 7,
      d: 8,
      color: 0x151c33,
      edgeColor: 0xffb12e,
      labelColor: '#ffb12e',
    },
    interior: {
      originX: 140,
      originZ: 0,
      w: 16,
      d: 16,
      floorColor: 0x1a2140,
      wallColor: 0x10172a,
      edgeColor: 0xffb12e,
      lightColor: 0xffc890,
    },
    door: { exterior: { x: 22, z: 28.4 }, interior: { x: 0, z: 6.5 } },
    stations: [
      { id: 'bed', name: 'Bed', x: 134, z: -2, col: 0x7a8cff },
      { id: 'door', name: 'Front Door', x: 140, z: 6.5, col: 0xffb12e },
    ],
    props: [],
  },
];

export function buildingById(id: string): BuildingDef | undefined {
  return BUILDINGS.find(b => b.id === id);
}

export type BuildCtx = {
  scene: THREE.Scene;
  bx: (
    w: number,
    h: number,
    d: number,
    m: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) => THREE.Mesh;
  lam: (c: number, e?: number) => THREE.MeshLambertMaterial;
  label: (text: string, col?: string, scale?: number) => THREE.Sprite;
  addCollider: (x: number, z: number, hw: number, hd: number) => void;
  /** Mark a mesh as the interactable form for a station (no ring). */
  tagInteractable: (mesh: THREE.Object3D, stationId: string) => void;
  /** Fewer façade panes / trim when true. */
  lowEnd?: boolean;
};

/** Shared façade materials (keyed by edge color) to keep draw cost low. */
const facadeMats = new Map<
  number,
  {
    neon: THREE.MeshLambertMaterial;
    glass: THREE.MeshLambertMaterial;
    dark: THREE.MeshLambertMaterial;
    plinth: THREE.MeshLambertMaterial;
  }
>();

function facadeKit(edge: number, bodyColor: number) {
  let kit = facadeMats.get(edge);
  if (kit) return kit;
  kit = {
    neon: new THREE.MeshLambertMaterial({ color: edge, emissive: edge, emissiveIntensity: 1.2 }),
    glass: new THREE.MeshLambertMaterial({
      color: 0x0a101c,
      emissive: edge,
      emissiveIntensity: 0.75,
    }),
    dark: new THREE.MeshLambertMaterial({ color: 0x04060c, emissive: 0x04060c, emissiveIntensity: 0.05 }),
    plinth: new THREE.MeshLambertMaterial({
      color: (bodyColor & 0xfefefe) >> 1,
      emissive: bodyColor,
      emissiveIntensity: 0.08,
    }),
  };
  facadeMats.set(edge, kit);
  return kit;
}

function addWindowBand(
  g: THREE.Group,
  bx: BuildCtx['bx'],
  kit: ReturnType<typeof facadeKit>,
  along: number,
  wall: number,
  faceW: number,
  axis: 'x' | 'z',
  sign: 1 | -1,
  bandY: number,
  panes: number,
) {
  const gap = 0.14;
  const span = faceW * 0.72;
  const paneW = (span - gap * (panes - 1)) / panes;
  const start = along - span / 2 + paneW / 2;
  const proud = 0.09;
  for (let i = 0; i < panes; i++) {
    const at = start + i * (paneW + gap);
    const px = axis === 'x' ? wall + sign * proud : at;
    const pz = axis === 'z' ? wall + sign * proud : at;
    g.add(bx(axis === 'x' ? 0.07 : paneW, 0.55, axis === 'z' ? 0.07 : paneW, kit.glass, px, bandY, pz));
  }
}

export function buildExterior(b: BuildingDef, ctx: BuildCtx): THREE.Group {
  const { scene, bx, lam, label, addCollider } = ctx;
  const g = new THREE.Group();
  g.name = `ext-${b.id}`;
  const { x, z, w, h, d, color, edgeColor, labelColor } = b.exterior;
  const kit = facadeKit(edgeColor, color);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.12 }),
  );
  body.position.set(x, h / 2, z);
  g.add(body);

  // Dark plinth
  const plinthH = Math.min(0.55, h * 0.12);
  g.add(bx(w + 0.25, plinthH, d + 0.25, kit.plinth, x, plinthH / 2, z));

  // Neon cornice + vertical accents
  const trim = 0.12;
  g.add(bx(w + 0.2, trim, d + 0.2, kit.neon, x, h + trim / 2, z));
  g.add(bx(trim, h * 0.7, trim, kit.neon, x - w / 2, h * 0.55, z - d / 2));
  g.add(bx(trim, h * 0.7, trim, kit.neon, x + w / 2, h * 0.55, z - d / 2));
  g.add(bx(trim, h * 0.7, trim, kit.neon, x - w / 2, h * 0.55, z + d / 2));
  g.add(bx(trim, h * 0.7, trim, kit.neon, x + w / 2, h * 0.55, z + d / 2));

  const doorX = b.door.exterior.x;
  const doorZ = b.door.exterior.z;
  const dx = doorX - x;
  const dz = doorZ - z;
  const doorOnX = Math.abs(dx) > Math.abs(dz);
  const faceSign = doorOnX ? (Math.sign(dx) as 1 | -1) : (Math.sign(dz || 1) as 1 | -1);

  // Window bands on door face + one side face
  const doorFaceW = doorOnX ? d : w;
  const doorWall = doorOnX ? x + faceSign * (w / 2) : z + faceSign * (d / 2);
  const doorAlong = doorOnX ? z : x;
  const lean = !!ctx.lowEnd;
  const panes = lean ? 3 : h > 12 ? 5 : 4;
  addWindowBand(
    g,
    bx,
    kit,
    doorAlong,
    doorWall,
    doorFaceW,
    doorOnX ? 'x' : 'z',
    faceSign,
    Math.min(h * 0.42, 4.2),
    panes,
  );
  if (!lean && h > 8) {
    addWindowBand(
      g,
      bx,
      kit,
      doorAlong,
      doorWall,
      doorFaceW * 0.9,
      doorOnX ? 'x' : 'z',
      faceSign,
      Math.min(h * 0.68, 9),
      Math.max(3, panes - 1),
    );
  }
  // Side face windows (skip on lowEnd)
  if (!lean) {
    const sideAxis: 'x' | 'z' = doorOnX ? 'z' : 'x';
    const sideSign: 1 | -1 = 1;
    const sideWall = sideAxis === 'x' ? x + w / 2 : z + d / 2;
    const sideAlong = sideAxis === 'x' ? z : x;
    const sideFaceW = sideAxis === 'x' ? d : w;
    addWindowBand(g, bx, kit, sideAlong, sideWall, sideFaceW, sideAxis, sideSign, Math.min(h * 0.4, 3.8), 3);
  }

  // Door recess on façade
  const doorMat = lam(edgeColor, 1.45);
  g.add(bx(1.35, 2.25, 0.14, kit.dark, doorX, 1.15, doorZ));
  g.add(bx(1.45, 0.1, 0.16, kit.neon, doorX, 2.35, doorZ));
  g.add(bx(1.45, 0.1, 0.16, kit.neon, doorX, 0.12, doorZ));
  g.add(bx(0.1, 2.25, 0.16, kit.neon, doorX - 0.7, 1.15, doorZ));
  g.add(bx(0.1, 2.25, 0.16, kit.neon, doorX + 0.7, 1.15, doorZ));
  g.add(bx(1.05, 2.05, 0.1, doorMat, doorX, 1.15, doorZ));

  // Sign on door face + floating label
  const sign = label(b.name.toUpperCase(), labelColor, 0.95);
  if (doorOnX) {
    sign.position.set(x + faceSign * (w / 2 + 0.25), Math.min(h * 0.55, 5.5), z);
  } else {
    sign.position.set(x, Math.min(h * 0.55, 5.5), z + faceSign * (d / 2 + 0.25));
  }
  g.add(sign);

  const lb = label(b.name, labelColor, 1.35);
  lb.position.set(x, h + 1.35, z);
  g.add(lb);

  addCollider(x, z, w / 2 + 0.7, d / 2 + 0.7);
  scene.add(g);
  return g;
}

/** Theme décor for interiors — never tagged as interactables (stations stay on props/door). */
function dressInteriorTheme(
  b: BuildingDef,
  g: THREE.Group,
  ctx: BuildCtx,
  ox: number,
  oz: number,
  w: number,
  d: number,
  wallH: number,
  edge: number,
) {
  const { bx, lam, label } = ctx;
  const lean = !!ctx.lowEnd;
  const neon = lam(edge, 1.15);
  const dark = lam(0x0a0e18, 0.08);
  const mid = lam(0x151c2e, 0.12);

  // Shared shell trim: baseboard, cornice, ceiling strip, floor runes
  g.add(bx(w - 0.4, 0.08, 0.08, neon, ox, 0.12, oz - d / 2 + 0.2));
  g.add(bx(w - 0.4, 0.08, 0.08, neon, ox, wallH - 0.12, oz - d / 2 + 0.2));
  g.add(bx(0.08, 0.08, d - 0.4, neon, ox - w / 2 + 0.2, 0.12, oz));
  g.add(bx(0.08, 0.08, d - 0.4, neon, ox + w / 2 - 0.2, 0.12, oz));
  g.add(bx(w * 0.55, 0.06, d * 0.55, lam(edge, 0.35), ox, 0.02, oz));

  // Ceiling light bars
  const barCount = lean ? 1 : 2;
  for (let i = 0; i < barCount; i++) {
    const zx = oz + (i === 0 ? -d * 0.18 : d * 0.18);
    g.add(bx(w * 0.5, 0.08, 0.28, neon, ox, wallH - 0.15, zx));
  }

  if (b.id === 'exchange') {
    // Trading floor: ticker wall, side terminals, rail
    g.add(bx(w * 0.72, 1.4, 0.1, lam(0x061018, 0.2), ox, 2.1, oz - d / 2 + 0.22));
    g.add(bx(w * 0.66, 1.1, 0.06, lam(0x2ee6ff, 0.95), ox, 2.1, oz - d / 2 + 0.28));
    const tick = label('BTX · ETHR · PIZZ', '#2ee6ff', 0.7);
    tick.position.set(ox, 2.85, oz - d / 2 + 0.4);
    g.add(tick);
    for (const sx of [-3.2, 3.2]) {
      g.add(bx(1.6, 0.1, 0.9, mid, ox + sx, 0.9, oz + 1.2));
      g.add(bx(1.2, 0.7, 0.06, lam(0x2ee6ff, 0.7), ox + sx, 1.45, oz + 0.7));
      g.add(bx(0.1, 0.85, 0.7, dark, ox + sx - 0.7, 0.45, oz + 1.2));
      g.add(bx(0.1, 0.85, 0.7, dark, ox + sx + 0.7, 0.45, oz + 1.2));
    }
    g.add(bx(4.5, 0.55, 0.18, mid, ox, 0.35, oz + 2.8));
    g.add(bx(4.5, 0.06, 0.1, neon, ox, 0.65, oz + 2.8));
    if (!lean) {
      g.add(bx(0.35, 1.6, 0.35, dark, ox - 4.5, 0.8, oz - 3.5));
      g.add(bx(0.5, 0.2, 0.5, neon, ox - 4.5, 1.7, oz - 3.5));
      g.add(bx(0.35, 1.6, 0.35, dark, ox + 4.5, 0.8, oz - 3.5));
      g.add(bx(0.5, 0.2, 0.5, neon, ox + 4.5, 1.7, oz - 3.5));
    }
  } else if (b.id === 'vault') {
    // Server lab: rack wall, hazard strips, cable tray
    for (let i = 0; i < (lean ? 3 : 5); i++) {
      const zx = oz - 3.5 + i * 1.4;
      g.add(bx(1.1, 2.4, 0.7, dark, ox + 4.4, 1.2, zx));
      g.add(bx(0.9, 0.35, 0.08, lam(0xb8ff3d, 0.9), ox + 3.85, 1.8, zx));
      g.add(bx(0.9, 0.2, 0.08, lam(0x2ee6ff, 0.55), ox + 3.85, 1.2, zx));
      g.add(bx(0.9, 0.2, 0.08, lam(0xff3d9a, 0.45), ox + 3.85, 0.7, zx));
    }
    g.add(bx(w * 0.8, 0.12, 0.12, neon, ox, 2.9, oz));
    g.add(bx(0.35, 0.08, d * 0.7, neon, ox - 4.2, 0.15, oz));
    g.add(bx(0.35, 0.08, d * 0.7, neon, ox + 4.2, 0.15, oz));
    const secure = label('SECURE', '#b8ff3d', 0.65);
    secure.position.set(ox - 3.5, 2.6, oz - d / 2 + 0.45);
    g.add(secure);
    if (!lean) {
      g.add(bx(2.2, 1.8, 0.08, lam(0x143020, 0.4), ox - 4.7, 1.5, oz));
      g.add(bx(1.8, 1.2, 0.05, lam(0xb8ff3d, 0.7), ox - 4.65, 1.5, oz));
    }
  } else if (b.id === 'tower') {
    // Attention studio: backdrop, soft boxes, camera stands
    g.add(bx(w * 0.7, 2.4, 0.12, lam(0x1a0c22, 0.3), ox, 1.5, oz - d / 2 + 0.25));
    g.add(bx(w * 0.55, 1.6, 0.08, lam(0xff3d9a, 0.75), ox, 1.6, oz - d / 2 + 0.32));
    const onAir = label('ON AIR', '#ff3d9a', 0.8);
    onAir.position.set(ox, 2.85, oz - d / 2 + 0.45);
    g.add(onAir);
    for (const sx of [-3.6, 3.6]) {
      g.add(bx(0.15, 1.8, 0.15, dark, ox + sx, 0.9, oz + 2.2));
      g.add(bx(0.7, 0.35, 0.5, lam(0xff6ab0, 1.0), ox + sx, 1.95, oz + 2.2));
    }
    g.add(bx(2.8, 0.35, 1.4, lam(0x2a1838, 0.3), ox, 0.25, oz + 0.5));
    if (!lean) {
      g.add(bx(0.4, 1.2, 0.4, dark, ox - 4.2, 0.6, oz - 1));
      g.add(bx(0.55, 0.25, 0.35, neon, ox - 4.2, 1.35, oz - 1));
      g.add(bx(1.8, 0.7, 0.7, lam(0x241430, 0.25), ox + 3.8, 0.4, oz - 2.5));
    }
  } else if (b.id === 'forge') {
    // Workshop: tool wall, barrels, ember pits, shelves
    g.add(bx(w * 0.65, 1.8, 0.12, dark, ox, 1.4, oz - d / 2 + 0.22));
    for (let i = 0; i < (lean ? 3 : 5); i++) {
      g.add(bx(0.12, 0.9, 0.12, lam(0x8a909a, 0.2), ox - 2.4 + i * 1.2, 1.5, oz - d / 2 + 0.35));
      g.add(bx(0.5, 0.08, 0.12, lam(0xff6a3d, 0.7), ox - 2.4 + i * 1.2, 1.95, oz - d / 2 + 0.35));
    }
    g.add(bx(2.6, 0.9, 1.0, lam(0x2a1a10, 0.25), ox - 2.5, 0.5, oz + 2.2));
    g.add(bx(2.7, 0.08, 1.1, neon, ox - 2.5, 0.98, oz + 2.2));
    for (const sx of [2.2, 3.4]) {
      g.add(bx(0.7, 0.85, 0.7, lam(0x3a2818, 0.2), ox + sx, 0.45, oz + 2.4));
      g.add(bx(0.55, 0.12, 0.55, neon, ox + sx, 0.95, oz + 2.4));
    }
    if (!lean) {
      g.add(bx(1.2, 0.15, 1.2, lam(0xff3d20, 1.2), ox + 0.5, 0.12, oz - 2.8));
      g.add(bx(0.8, 0.5, 0.8, lam(0xff8040, 0.9), ox + 0.5, 0.4, oz - 2.8));
    }
  } else if (b.id === 'diner') {
    // Neon diner: stools, booths, menu board, checker accents
    g.add(bx(3.2, 1.5, 0.1, dark, ox - 3.2, 1.8, oz - d / 2 + 0.22));
    g.add(bx(2.8, 1.1, 0.06, lam(0xffb12e, 0.85), ox - 3.2, 1.8, oz - d / 2 + 0.28));
    const menu = label('MENU', '#ffb12e', 0.7);
    menu.position.set(ox - 3.2, 2.7, oz - d / 2 + 0.4);
    g.add(menu);
    // Stools at the counter (back of room, away from exit at +z)
    for (const sx of [-2.2, -0.6, 1.0]) {
      g.add(bx(0.35, 0.55, 0.35, lam(0x2a1810, 0.2), ox + sx, 0.45, oz - 2.4));
      g.add(bx(0.45, 0.08, 0.45, neon, ox + sx, 0.75, oz - 2.4));
    }
    for (const [bx0, bz0] of [
      [-3.2, 0.8],
      [3.0, 0.8],
      [3.0, 2.8],
    ] as const) {
      g.add(bx(2.0, 1.1, 1.5, lam(0x3a2218, 0.28), ox + bx0, 0.55, oz + bz0));
      g.add(bx(1.8, 0.7, 0.12, lam(0xff3d9a, 0.55), ox + bx0, 1.35, oz + bz0 - 0.6));
    }
    if (!lean) {
      for (let i = 0; i < 4; i++) {
        const col = i % 2 === 0 ? 0xffb12e : 0x1a120e;
        g.add(bx(1.1, 0.04, 1.1, lam(col, 0.25), ox - 3.3 + i * 2.2, 0.03, oz - 4));
      }
      const open = label('OPEN', '#ff3d9a', 0.85);
      open.position.set(ox + 2.8, 2.8, oz - d / 2 + 0.4);
      g.add(open);
    }
  } else if (b.id === 'home') {
    // Lived-in loft shell (purchased furniture still comes from buildFurn)
    g.add(bx(5.5, 0.05, 4.5, lam(0x2a3150, 0.35), ox + 1, 0.01, oz + 1));
    g.add(bx(0.2, 2.2, 3.5, mid, ox - w / 2 + 0.35, 1.2, oz - 1));
    g.add(bx(3.5, 1.8, 0.12, dark, ox + 2, 1.6, oz - d / 2 + 0.25));
    g.add(bx(3.0, 1.3, 0.06, lam(0x7a8cff, 0.45), ox + 2, 1.6, oz - d / 2 + 0.32));
    g.add(bx(1.0, 0.9, 0.9, lam(0x1a2140, 0.2), ox + 5.5, 0.5, oz + 4));
    g.add(bx(0.7, 0.7, 0.7, lam(0x2dbd5a, 0.4), ox + 5.5, 1.2, oz + 4));
    if (!lean) {
      g.add(bx(2.4, 0.9, 0.5, mid, ox - 5, 0.5, oz + 5));
      g.add(bx(0.15, 2.0, 0.15, lam(0x8b97b8, 0.15), ox + 5.8, 1.1, oz - 4));
      g.add(bx(0.45, 0.35, 0.45, lam(0xffe0a0, 0.9), ox + 5.8, 2.2, oz - 4));
      const welcome = label('HOME', '#ffb12e', 0.7);
      welcome.position.set(ox, 2.9, oz - d / 2 + 0.4);
      g.add(welcome);
    }
  }
}

export function buildInterior(b: BuildingDef, ctx: BuildCtx): THREE.Group {
  const { scene, bx, lam, label, tagInteractable } = ctx;
  const g = new THREE.Group();
  g.name = `int-${b.id}`;
  const { originX: ox, originZ: oz, w, d, floorColor, wallColor, edgeColor, lightColor } = b.interior;
  const wallH = 3.4;
  const floorY = b.id === 'home' ? -0.1 : 0.08;
  const floorThick = b.id === 'home' ? 0.2 : 0.16;
  const floorMat = lam(floorColor, b.id === 'diner' ? 0.22 : 0.28);
  const floorMesh = bx(w, floorThick, d, floorMat, ox, floorY, oz);
  if (b.id === 'home') floorMesh.userData.homePaint = 'floor';
  g.add(floorMesh);
  // No roof — open top so the camera can see the full room.

  const wallMat = new THREE.MeshLambertMaterial({
    color: wallColor,
    emissive: wallColor,
    emissiveIntensity: 0.06,
    transparent: b.id === 'home',
    opacity: b.id === 'home' ? 0.9 : 1,
  });
  if (b.id === 'home') wallMat.userData.homePaint = 'wall';
  const wallDefs: Array<[number, number, number, number, number, number]> = [
    [w, wallH, 0.3, ox, wallH / 2, oz - d / 2],
    [0.3, wallH, d, ox - w / 2, wallH / 2, oz],
    [0.3, wallH, d, ox + w / 2, wallH / 2, oz],
  ];
  if (b.door.interior.z <= 0) {
    wallDefs.push([w, wallH, 0.3, ox, wallH / 2, oz + d / 2]);
  }
  for (const wd of wallDefs) {
    const m = bx(wd[0], wd[1], wd[2], wallMat, wd[3], wd[4], wd[5]);
    g.add(m);
    const edgeMat = new THREE.LineBasicMaterial({ color: edgeColor });
    if (b.id === 'home') edgeMat.userData.homePaint = 'accent';
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat);
    e.position.copy(m.position);
    g.add(e);
  }

  dressInteriorTheme(b, g, ctx, ox, oz, w, d, wallH, edgeColor);

  const light = new THREE.PointLight(lightColor, b.id === 'diner' ? 100 : 48, b.id === 'diner' ? 16 : 28);
  light.position.set(ox, b.id === 'diner' ? 2.6 : 3.4, oz);
  if (b.id === 'home') light.userData.homePaint = 'light';
  g.add(light);
  if (!ctx.lowEnd && b.id !== 'home') {
    const fill = new THREE.PointLight(edgeColor, 28, 12);
    fill.position.set(ox, 2.2, oz - d * 0.25);
    g.add(fill);
  }

  const useId = b.stations.find(s => s.id !== 'door' && !s.id.startsWith('bdoor-'))?.id;
  const exitId = b.stations.find(s => s.id === 'door' || s.id.startsWith('bdoor-'))?.id;

  for (const p of b.props) {
    const propG = new THREE.Group();
    if (p.kind === 'counter') {
      propG.add(bx(3.6, 0.95, 0.8, lam(p.color ?? 0x5a3418, 0.28), p.x, 0.52, p.z));
      propG.add(bx(3.8, 0.1, 0.95, lam(p.trim ?? 0xffb12e, 0.7), p.x, 1.02, p.z));
      propG.add(bx(0.5, 0.35, 0.5, lam(0xff3d9a, 0.6), p.x + 1.4, 1.25, p.z));
    } else if (p.kind === 'desk') {
      propG.add(bx(2.6, 0.14, 1.3, lam(p.color ?? 0x1a2848, 0.35), p.x, 0.95, p.z));
      propG.add(bx(0.14, 0.9, 1.1, lam(0x0a101c, 0.12), p.x - 1.15, 0.45, p.z));
      propG.add(bx(0.14, 0.9, 1.1, lam(0x0a101c, 0.12), p.x + 1.15, 0.45, p.z));
      propG.add(bx(1.8, 1.0, 0.1, lam(p.screen ?? 0x2ee6ff, 1.0), p.x, 1.6, p.z - 0.45));
      propG.add(bx(0.5, 0.12, 0.4, lam(0x2a3150, 0.3), p.x - 0.6, 1.05, p.z + 0.2));
      propG.add(bx(0.35, 0.08, 0.5, lam(edgeColor, 0.8), p.x + 0.7, 1.05, p.z + 0.15));
    } else if (p.kind === 'booth') {
      propG.add(bx(2.4, 0.45, 1.6, lam(p.color ?? 0x2a1838, 0.3), p.x, 0.35, p.z));
      propG.add(bx(2.4, 1.1, 0.35, lam(p.color ?? 0x2a1838, 0.3), p.x, 1.0, p.z - 0.7));
      propG.add(bx(1.8, 1.0, 0.1, lam(0xff3d9a, 1.05), p.x, 1.7, p.z - 0.55));
      propG.add(bx(0.4, 0.9, 0.4, lam(0x151018, 0.2), p.x + 1.5, 0.5, p.z + 0.4));
    } else if (p.kind === 'anvil') {
      propG.add(bx(1.6, 0.55, 0.9, lam(0x3a3a44, 0.25), p.x, 0.55, p.z));
      propG.add(bx(1.0, 0.4, 0.6, lam(0xff6a3d, 0.7), p.x, 1.0, p.z));
      propG.add(bx(0.4, 1.2, 0.4, lam(0x2a1810, 0.2), p.x + 1.35, 0.6, p.z));
      propG.add(bx(0.55, 0.15, 0.55, lam(0xff8040, 0.9), p.x + 1.35, 1.25, p.z));
      propG.add(bx(0.9, 0.7, 0.5, lam(0x4a3020, 0.2), p.x - 1.3, 0.4, p.z));
    } else if (p.kind === 'glassWall') {
      const glass = new THREE.MeshLambertMaterial({
        color: 0xc5ecff,
        emissive: 0x2ee6ff,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      });
      if (p.axis === 'x') propG.add(bx(p.w, 2.8, p.d, glass, p.x, 1.45, p.z));
      else propG.add(bx(p.d, 2.8, p.w, glass, p.x, 1.45, p.z));
    }
    if (useId && p.kind !== 'glassWall') tagInteractable(propG, useId);
    g.add(propG);
  }

  const idoor = interiorDoorWorld(b);
  // Door recess frame
  g.add(bx(1.4, 2.3, 0.12, lam(0x04060c, 0.08), idoor.x, 1.15, idoor.z));
  g.add(bx(1.5, 0.1, 0.14, lam(edgeColor, 1.1), idoor.x, 2.35, idoor.z));
  g.add(bx(0.1, 2.3, 0.14, lam(edgeColor, 1.1), idoor.x - 0.72, 1.15, idoor.z));
  g.add(bx(0.1, 2.3, 0.14, lam(edgeColor, 1.1), idoor.x + 0.72, 1.15, idoor.z));
  const doorPanel = bx(1.05, 2.05, 0.1, lam(edgeColor, 1.0), idoor.x, 1.15, idoor.z);
  if (exitId) tagInteractable(doorPanel, exitId);
  g.add(doorPanel);
  const exitSign = label('EXIT', '#ffb12e', 0.8);
  exitSign.position.set(idoor.x, 2.55, idoor.z);
  g.add(exitSign);

  scene.add(g);
  return g;
}
