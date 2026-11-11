import * as THREE from 'three';
import { FURN_PRICE_GD } from '@glitch/shared';
import {
  BUILDINGS,
  buildingById,
  buildExterior,
  buildInterior,
  interiorDoorWorld,
  type BuildingDef,
} from './buildings';
import { DEFAULT_LOOK, type Look, type Station } from './types';
import { $, clamp, pick, randn, rnd } from './util';
import { S, weak } from './state';
import { market } from './market';
import { introOpen, modalOpen } from './hud';
import { useStation } from './games';

export { BUILDINGS, buildingById } from './buildings';

export const lowEnd = (navigator.hardwareConcurrency || 4) <= 4 || matchMedia('(pointer:coarse)').matches;
export const canvas = $('#gl') as HTMLCanvasElement;
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowEnd ? 1.25 : 1.75));
renderer.setClearColor(0x04060e);
export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x060a18, 0.016);
export const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
scene.add(new THREE.HemisphereLight(0x6a7cff, 0x0c0818, 1.05));
const sun = new THREE.DirectionalLight(0x88aaff, 0.42);
sun.position.set(-20, 40, 10);
scene.add(sun);
const streetCyan = new THREE.PointLight(0x2ee6ff, 120, 10);
streetCyan.position.set(-7, 1.35, 5);
const streetMag = new THREE.PointLight(0xff3d9a, 120, 10);
streetMag.position.set(8, 1.35, 6);
const plazaWarm = new THREE.PointLight(0xffb12e, 80, 14);
plazaWarm.position.set(0, 3.2, 4);
scene.add(streetCyan, streetMag, plazaWarm);

type TexBag = {
  c: HTMLCanvasElement;
  x: CanvasRenderingContext2D;
  t: THREE.CanvasTexture;
  redraw: (fn: (x: CanvasRenderingContext2D, w: number, h: number) => void) => void;
};

export function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D, w: number, h: number) => void): TexBag {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  return {
    c,
    x,
    t,
    redraw(fn) {
      x.clearRect(0, 0, w, h);
      fn(x, w, h);
      t.needsUpdate = true;
    },
  };
}
const labelDraw = (text: string, col: string) => (x: CanvasRenderingContext2D, w: number, _h: number) => {
  x.font = '600 28px "Chakra Petch",sans-serif';
  x.textAlign = 'center';
  const tw = Math.min(w - 8, x.measureText(text).width + 26);
  x.fillStyle = 'rgba(7,9,16,.7)';
  x.fillRect(w / 2 - tw / 2, 8, tw, 48);
  x.fillStyle = col;
  x.fillText(text, w / 2, 44);
};
export function label(text: string, col = '#e9eefc', scale = 1) {
  const t = canvasTex(256, 64, labelDraw(text, col));
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.t, transparent: true, depthTest: false }));
  s.scale.set(4 * scale, scale, 1);
  s.renderOrder = 10;
  s.userData.tex = t;
  return s;
}

const groundTex = canvasTex(512, 512, (x, w, h) => {
  x.fillStyle = '#05070f';
  x.fillRect(0, 0, w, h);
  // Subtle asphalt noise
  for (let i = 0; i < 900; i++) {
    const n = 8 + ((i * 17) % 18);
    x.fillStyle = `rgba(${n},${n + 2},${n + 10},0.35)`;
    x.fillRect((i * 37) % w, (i * 53) % h, 2, 2);
  }
  // Cyan / pink neon grid
  x.strokeStyle = 'rgba(46,230,255,0.22)';
  x.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    x.beginPath();
    x.moveTo((i * w) / 8, 0);
    x.lineTo((i * w) / 8, h);
    x.stroke();
  }
  x.strokeStyle = 'rgba(255,61,154,0.16)';
  for (let i = 0; i <= 8; i++) {
    x.beginPath();
    x.moveTo(0, (i * h) / 8);
    x.lineTo(w, (i * h) / 8);
    x.stroke();
  }
  // Wet sheen stripes
  x.strokeStyle = 'rgba(180,220,255,0.08)';
  x.lineWidth = 6;
  for (let i = 0; i < 6; i++) {
    const y = ((i * 89) % h) + 20;
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(w, y + 12);
    x.stroke();
  }
});
groundTex.t.wrapS = groundTex.t.wrapT = THREE.RepeatWrapping;
groundTex.t.repeat.set(18, 18);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ map: groundTex.t }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const logoTex = canvasTex(512, 256, (x, w, _h) => {
  x.font = '700 120px "Chakra Petch",sans-serif';
  x.textAlign = 'center';
  x.shadowColor = '#ff3d9a';
  x.shadowBlur = 30;
  x.fillStyle = '#ff3d9a';
  x.fillText('GLITCH', w / 2, 150);
  x.shadowColor = '#2ee6ff';
  x.fillStyle = '#2ee6ff';
  x.fillText('GLITCH', w / 2 - 4, 146);
});
const logo = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), new THREE.MeshBasicMaterial({ map: logoTex.t, transparent: true }));
logo.rotation.x = -Math.PI / 2;
logo.position.set(0, 0.04, 2);
scene.add(logo);

{
  const N = lowEnd ? 70 : 120,
    d = new THREE.Object3D();
  const win = canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = '#000';
    x.fillRect(0, 0, w, h);
    for (let i = 0; i < 110; i++) {
      x.fillStyle = pick(['#2ee6ff', '#ff3d9a', '#ffb12e', '#7a8cff', '#b8ff3d']);
      x.fillRect(Math.random() * w, Math.random() * h, 5, 10);
    }
  });
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveMap: win.t,
    emissiveIntensity: 1.15,
  });
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2,
      r = rnd(55, 110),
      w = rnd(6, 16),
      h = rnd(18, 72);
    d.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    d.scale.set(w, h, rnd(6, 16));
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
    im.setColorAt(i, new THREE.Color(pick([0x0a1228, 0x140c28, 0x081820, 0x101030])));
  }
  scene.add(im);
}

const colliders: Array<{ x: number; z: number; hw: number; hd: number }> = [];
function screen(w: number, h: number, x: number, y: number, z: number, ry: number, tex: TexBag) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex.t, toneMapped: false }));
  m.position.set(x, y, z);
  m.rotation.y = ry;
  scene.add(m);
  return m;
}
/* City blocks come from BUILDINGS (exchange/vault/tower/forge/diner/home). */
export const exTex = canvasTex(512, 280, () => {});
export const labTex = canvasTex(512, 280, () => {});
export const towTex = canvasTex(512, 512, () => {});
screen(11, 6, -18.9, 6, -9, Math.PI / 2, exTex);
screen(11, 6, 18.9, 6, -9, -Math.PI / 2, labTex);
screen(9, 9, 0, 15, -28.9, 0, towTex);
export const adTex = [0, 1, 2].map(() => canvasTex(512, 256, () => {}));
([[-15, 15, 0.5], [15, 15, -0.5], [0, 27, 0]] as const).forEach(([x, z, ry], i) => {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), new THREE.MeshLambertMaterial({ color: 0x151c33 }));
  post.position.set(x, 2, z);
  scene.add(post);
  const s = screen(8, 4, x, 5.2, z, ry, adTex[i]!);
  s.rotation.y = Math.atan2(0 - x, 6 - z);
});

/** Filled after bx/lam + BUILDINGS builders run below. */
export const stations: Station[] = [];

const sirenA = new THREE.PointLight(0xff2040, 0, 40),
  sirenB = new THREE.PointLight(0x2060ff, 0, 40);
sirenA.position.set(-26, 14, -9);
sirenB.position.set(-26, 14, -9);
scene.add(sirenA, sirenB);

export const SKINS = [0xf1c8a0, 0xd9a273, 0xb07a4f, 0x8a5a3a, 0x5e3a24, 0x3b2416];
export const HAIRC = [0x0b0b10, 0x3a2414, 0x7a4a22, 0xe8d27a, 0xff3d9a, 0x2ee6ff];
export const TOPC = [0x2ee6ff, 0xff3d9a, 0xb8ff3d, 0xffb12e, 0xe9eefc, 0x7a8cff, 0x2a3150];
export const BOTC = [0x10172a, 0x2a3150, 0x4a3a2a, 0x6a6f85, 0x1a3a2a];
export const GLASSC = [0x2ee6ff, 0xff3d9a, 0xb8ff3d, 0xffb12e];
export const HAIRS = ['Short', 'Afro', 'Braids', 'Bald'],
  GEARS = ['None', 'Cap', 'Headphones', 'Chain', 'Backpack', 'Cape', 'Crown'],
  CAPDIRS = ['Front', 'Back', 'Left', 'Right'];
export const randLook = (): Look => ({
  skin: Math.floor(rnd(0, SKINS.length)),
  hair: Math.floor(rnd(0, HAIRS.length)),
  hairC: Math.floor(rnd(0, HAIRC.length)),
  top: Math.floor(rnd(0, TOPC.length)),
  bot: Math.floor(rnd(0, BOTC.length)),
  glasses: Math.random() < .6,
  glassC: Math.floor(rnd(0, GLASSC.length)),
  gear: Math.floor(rnd(0, GEARS.length)),
  capDir: Math.floor(rnd(0, CAPDIRS.length)),
});
export const lam = (c: number, e = .22) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: e });
export const bx = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  return o;
};
/** Meshes highlighted in their own shape when the matching station is near. */
const interactables: THREE.Object3D[] = [];

export function tagInteractable(root: THREE.Object3D, stationId: string): void {
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    o.userData.stationId = stationId;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m && 'emissiveIntensity' in m) {
        o.userData.baseEmissive = (m as THREE.MeshLambertMaterial).emissiveIntensity;
        if (!(m as THREE.MeshLambertMaterial).emissive) {
          (m as THREE.MeshLambertMaterial).emissive = new THREE.Color(
            (m as THREE.MeshLambertMaterial).color?.getHex?.() ?? 0xffffff,
          );
        }
      }
    }
    interactables.push(o);
  });
}

function untagStation(stationId: string): void {
  for (let i = interactables.length - 1; i >= 0; i--) {
    if (interactables[i]!.userData.stationId === stationId) interactables.splice(i, 1);
  }
}

function pulseInteractables(activeId: string | null, t: number): void {
  const pulse = 0.45 + Math.sin(t * 6) * 0.25;
  for (const o of interactables) {
    const id = o.userData.stationId as string;
    const mats = Array.isArray((o as THREE.Mesh).material)
      ? ((o as THREE.Mesh).material as THREE.Material[])
      : [(o as THREE.Mesh).material as THREE.Material];
    for (const m of mats) {
      if (!m || !('emissiveIntensity' in m)) continue;
      const mat = m as THREE.MeshLambertMaterial;
      const base = (o.userData.baseEmissive as number | undefined) ?? 0.2;
      mat.emissiveIntensity = id === activeId ? base + pulse : base;
    }
  }
}

const buildCtx = {
  scene,
  bx,
  lam,
  label,
  addCollider: (x: number, z: number, hw: number, hd: number) => {
    colliders.push({ x, z, hw, hd });
  },
  tagInteractable,
  lowEnd,
};
export const interiorGroups = new Map<string, THREE.Group>();
for (const b of BUILDINGS) {
  buildExterior(b, buildCtx);
  interiorGroups.set(b.id, buildInterior(b, buildCtx));
}
/** Home room group (furniture attaches relative to world; shell is the home interior). */
export const ROOMC = interiorGroups.get('home') ?? new THREE.Group();

export const HOME_PAINT_PRESETS: { id: string; name: string; floor: number; wall: number; accent: number }[] = [
  { id: 'midnight', name: 'Midnight', floor: 0x1a2140, wall: 0x10172a, accent: 0xffb12e },
  { id: 'coral', name: 'Coral loft', floor: 0x2a1820, wall: 0x1a1018, accent: 0xff3d9a },
  { id: 'mint', name: 'Mint chill', floor: 0x142820, wall: 0x0e1a16, accent: 0x3dffb0 },
  { id: 'cyan', name: 'Cyan grid', floor: 0x102028, wall: 0x0a141c, accent: 0x2ee6ff },
  { id: 'violet', name: 'Violet den', floor: 0x1c1630, wall: 0x120e22, accent: 0x7a8cff },
  { id: 'sand', name: 'Warm sand', floor: 0x2a2418, wall: 0x1a1610, accent: 0xffc890 },
  { id: 'slate', name: 'Cool slate', floor: 0x1a1e28, wall: 0x12161e, accent: 0x8b97b8 },
  { id: 'lime', name: 'Acid lime', floor: 0x182414, wall: 0x101810, accent: 0xb8ff3d },
];

/** Apply saved / chosen room paint onto the home shell (client-only). */
export function applyHomePaint(paint?: { floor: number; wall: number; accent: number } | null) {
  const p = paint ?? HOME_PAINT_PRESETS[0]!;
  const g = interiorGroups.get('home');
  if (!g) return;
  g.traverse(obj => {
    const tag = (obj as THREE.Object3D).userData?.homePaint as string | undefined;
    if (!tag) return;
    if (obj instanceof THREE.PointLight && tag === 'light') {
      obj.color.setHex(p.accent);
      return;
    }
    const mat = (obj as THREE.Mesh).material;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const m of mats) {
      if (!m || !('color' in m)) continue;
      const c = (m as THREE.MeshLambertMaterial | THREE.LineBasicMaterial).color;
      if (tag === 'floor') c.setHex(p.floor);
      else if (tag === 'wall') {
        c.setHex(p.wall);
        if ('emissive' in m) (m as THREE.MeshLambertMaterial).emissive.setHex(p.wall);
      } else if (tag === 'accent') c.setHex(p.accent);
    }
  });
}

applyHomePaint(S.home.paint ?? null);

function registerStation(s: Station, opts?: { ring?: boolean }): void {
  stations.push(s);
  // Indoors: no circular glow — object meshes + EXIT signs carry the highlight.
  if (!opts?.ring) return;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 2.0, 40),
    new THREE.MeshBasicMaterial({ color: s.col, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(s.x, 0.06, s.z);
  scene.add(ring);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 7, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: s.col,
      transparent: true,
      opacity: s.locked ? 0.05 : 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  beam.position.set(s.x, 3.5, s.z);
  scene.add(beam);
  s.ring = ring;
  s.beam = beam;
}

/* Park bench outdoors uses object highlight (no ring). Indoor stations: object / EXIT only. */
registerStation({ id: 'rest', name: 'Park Bench', x: 8, z: 15, col: 0x7a8cff });
for (const b of BUILDINGS) {
  for (const s of b.stations) {
    registerStation({
      id: s.id,
      name: s.name,
      x: s.x,
      z: s.z,
      col: s.col,
      locked: s.locked,
    });
  }
}
function parkedCar(x: number, z: number, body: number, cab: number, ry = 0) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wheelM = lam(0x10131c, 0.05);
  g.add(bx(2.4, 0.55, 1.25, lam(body, 0.22), 0, 0.58, 0));
  g.add(bx(1.25, 0.48, 1.05, lam(cab, 0.75), -0.12, 1.02, 0));
  for (const wx of [-0.82, 0.82]) {
    for (const wz of [-0.78, 0.78]) g.add(bx(0.4, 0.42, 0.28, wheelM, wx, 0.22, wz));
  }
  scene.add(g);
}
parkedCar(31.4, 18.6, 0x2a4a88, 0xd7f6ff);
parkedCar(37.4, 18.6, 0x8a2860, 0xffb3d6);
parkedCar(-28, 14, 0x1a3a50, 0x2ee6ff, 0.4);
parkedCar(12, 22, 0x3a2040, 0xff3d9a, -0.9);
if (!lowEnd) {
  parkedCar(-14, -18, 0x2a4020, 0xb8ff3d, 1.2);
  parkedCar(22, -12, 0x402818, 0xffb12e, -0.3);
}

/* Plaza curb / glowing ring around logo */
{
  const ringMat = lam(0x2ee6ff, 0.85);
  const curbMat = lam(0x12182a, 0.1);
  const segs = lowEnd ? 12 : 16;
  const r = 9.5;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r + 2;
    scene.add(bx(1.4, 0.22, 0.35, curbMat, x, 0.11, z));
    if (i % 2 === 0) scene.add(bx(1.1, 0.06, 0.12, ringMat, x, 0.24, z));
  }
}

/* Street lamps along plaza edge */
{
  const lampColors = [0x2ee6ff, 0xff3d9a, 0xffb12e, 0xb8ff3d];
  const posts: Array<[number, number]> = [
    [-10, 12],
    [10, 12],
    [-12, -4],
    [12, -4],
    [-6, 18],
    [6, 18],
    [-16, 6],
    [16, 6],
  ];
  const count = lowEnd ? 4 : posts.length;
  const postM = lam(0x151c33, 0.08);
  for (let i = 0; i < count; i++) {
    const [lx, lz] = posts[i]!;
    const col = lampColors[i % lampColors.length]!;
    const topM = lam(col, 1.3);
    scene.add(bx(0.12, 3.2, 0.12, postM, lx, 1.6, lz));
    scene.add(bx(0.35, 0.22, 0.35, topM, lx, 3.3, lz));
    if (!lowEnd) {
      const pl = new THREE.PointLight(col, 40, 8);
      pl.position.set(lx, 3.2, lz);
      scene.add(pl);
    }
  }
}

function bollard(x: number, z: number, col = 0x2ee6ff) {
  scene.add(bx(0.22, 0.85, 0.22, lam(0x12182a, 0.08), x, 0.42, z));
  scene.add(bx(0.26, 0.08, 0.26, lam(col, 1.1), x, 0.88, z));
}
bollard(-16.5, -2, 0x2ee6ff);
bollard(-16.5, 0, 0x2ee6ff);
bollard(16.5, -2, 0xb8ff3d);
bollard(16.5, 0, 0xb8ff3d);
bollard(-2, -26.5, 0xff3d9a);
bollard(2, -26.5, 0xff3d9a);

function planter(x: number, z: number) {
  const box = lam(0x1a2238, 0.1);
  const leaf = lam(0x2a6040, 0.35);
  scene.add(bx(1.1, 0.45, 1.1, box, x, 0.22, z));
  scene.add(bx(0.7, 0.55, 0.7, leaf, x, 0.7, z));
}
planter(28, 14);
planter(42, 14);
planter(32, 24);
planter(-8, 20);
export function buildLook(g: THREE.Group, L: Look) {
  const rig = g.userData.rig as THREE.Group;
  rig.clear();
  const u = (rig.userData = {} as Record<string, THREE.Group>);
  const skin = lam(SKINS[L.skin]!, .12),
    top = lam(TOPC[L.top]!),
    bot = lam(BOTC[L.bot]!, .1),
    hair = lam(HAIRC[L.hairC]!, .08);
  const shoe = lam(0x0b0f1c, 0.05);
  const mkLeg = (x: number, side: 'L' | 'R') => {
    const thigh = new THREE.Group();
    thigh.position.set(x, 0.85, 0);
    thigh.add(bx(0.3, 0.44, 0.32, bot, 0, -0.22, 0));
    const knee = new THREE.Group();
    knee.position.set(0, -0.44, 0);
    knee.add(bx(0.28, 0.4, 0.3, bot, 0, -0.2, 0), bx(0.32, 0.12, 0.42, shoe, 0, -0.42, 0.05));
    thigh.add(knee);
    rig.add(thigh);
    u[`knee${side}`] = knee;
    return thigh;
  };
  u.legL = mkLeg(-0.17, 'L');
  u.legR = mkLeg(0.17, 'R');
  rig.add(bx(0.74, 0.82, 0.4, top, 0, 1.26, 0));
  const mkArm = (x: number, side: 'L' | 'R') => {
    const upper = new THREE.Group();
    upper.position.set(x, 1.6, 0);
    upper.add(bx(0.2, 0.4, 0.24, top, 0, -0.2, 0));
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.4, 0);
    elbow.add(bx(0.17, 0.28, 0.2, skin, 0, -0.14, 0), bx(0.15, 0.12, 0.16, skin, 0, -0.32, 0.02));
    upper.add(elbow);
    rig.add(upper);
    u[`elbow${side}`] = elbow;
    return upper;
  };
  u.armL = mkArm(-0.48, 'L');
  u.armR = mkArm(0.48, 'R');
  rig.add(bx(.14, .12, .14, skin, 0, 1.72, 0));
  const head = new THREE.Mesh(new THREE.SphereGeometry(.28, 14, 12), skin);
  head.position.y = 1.99;
  rig.add(head);
  if (!L.glasses) {
    rig.add(bx(.06, .06, .04, lam(0x10131f, 0), -.1, 2.02, .26), bx(.06, .06, .04, lam(0x10131f, 0), .1, 2.02, .26));
  }
  const wearingCap = L.gear === 1;
  // Short — clean pop crown; faded temples only (no back strip)
  if (L.hair === 0) {
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(0.295, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
      hair,
    );
    // Sit snug on skull; slight forward bias so the nape is hair, not a flat box
    crown.position.set(0, 2.01, 0.01);
    crown.scale.set(1.02, 0.92, 1.08);
    rig.add(crown);
    // Soft temple fade only — short sides, not ear muffs
    for (const sx of [-1, 1]) {
      const fade = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), hair);
      fade.position.set(sx * 0.24, 2.02, 0.02);
      fade.scale.set(0.45, 0.7, 0.85);
      rig.add(fade);
    }
  }
  // Afro — top puff only (never side slabs); hide bulk under Cap
  if (L.hair === 1) {
    if (!wearingCap) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), hair);
      puff.position.set(0, 2.3, 0);
      puff.scale.set(1.08, 0.72, 1.08);
      rig.add(puff);
    }
  }
  // Braids — soft scalp dome + hanging braids with beads (no flat top ridges)
  if (L.hair === 2) {
    if (!wearingCap) {
      const scalp = new THREE.Mesh(
        new THREE.SphereGeometry(0.29, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
        hair,
      );
      scalp.position.set(0, 2.02, 0);
      scalp.scale.set(1.02, 0.9, 1.02);
      rig.add(scalp);
    }
    const bead = lam(0xffb12e, 0.55);
    for (let i = 0; i < 8; i++) {
      const a = -1.2 + i * 0.34;
      const x = Math.sin(a) * 0.26;
      const z = -0.12 - Math.cos(a) * 0.12;
      for (let s = 0; s < 3; s++) {
        const seg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.035 - s * 0.005, 0.03 - s * 0.005, 0.2, 6),
          hair,
        );
        seg.position.set(x, 1.95 - s * 0.2, z - s * 0.02);
        seg.rotation.x = 0.25;
        rig.add(seg);
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), bead);
      tip.position.set(x, 1.32, z - 0.08);
      rig.add(tip);
    }
  }
  if (L.glasses) {
    const gm = new THREE.MeshBasicMaterial({ color: GLASSC[L.glassC]! });
    rig.add(
      bx(0.2, 0.1, 0.06, gm, -0.1, 2.02, 0.27),
      bx(0.2, 0.1, 0.06, gm, 0.1, 2.02, 0.27),
      bx(0.58, 0.03, 0.05, gm, 0, 2.03, 0.26),
    );
  }
  // Cap — fitted baseball; brim Front / Back / Left / Right via capDir
  if (L.gear === 1) {
    const capMat = lam(0xe9eefc, 0.22);
    const cap = new THREE.Group();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.31, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      capMat,
    );
    dome.position.set(0, 0.09, -0.01);
    dome.scale.set(1.02, 0.72, 1.05);
    dome.rotation.x = -0.12;
    cap.add(dome);
    const brim = bx(0.42, 0.035, 0.28, capMat, 0, 0.13, 0.28);
    brim.rotation.x = -0.18;
    cap.add(brim);
    cap.add(bx(0.08, 0.05, 0.08, lam(0xc8d0e0, 0.25), 0, 0.33, -0.02));
    // 0 front, 1 back, 2 left, 3 right
    const dir = ((L.capDir ?? 0) % 4 + 4) % 4;
    cap.rotation.y = [0, Math.PI, Math.PI / 2, -Math.PI / 2][dir]!;
    cap.position.set(0, 2.0, 0);
    rig.add(cap);
  }
  // Headphones — band over crown, cups at ear level
  if (L.gear === 2) {
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.032, 6, 18, Math.PI),
      lam(0x151c33, 0.35),
    );
    band.position.set(0, 2.12, 0);
    band.rotation.x = 0.05;
    const cupM = lam(0xff3d9a, 0.55);
    const padM = lam(0x2a3150, 0.2);
    // Head center ~1.99, ears ~2.0
    rig.add(
      band,
      bx(0.14, 0.2, 0.16, cupM, -0.32, 2.0, 0),
      bx(0.14, 0.2, 0.16, cupM, 0.32, 2.0, 0),
      bx(0.06, 0.14, 0.12, padM, -0.25, 2.0, 0),
      bx(0.06, 0.14, 0.12, padM, 0.25, 2.0, 0),
    );
  }
  if (L.gear === 3) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 18), lam(0xffb12e, 0.6));
    t.position.set(0, 1.58, 0.14);
    t.rotation.x = Math.PI / 2.4;
    rig.add(t);
  }
  if (L.gear === 5) {
    const c = bx(0.78, 1.15, 0.05, lam(0xc4163f, 0.35), 0, 1.15, -0.27);
    c.rotation.x = 0.08;
    rig.add(c, bx(0.8, 0.1, 0.1, lam(0xffb12e, 0.6), 0, 1.68, -0.2));
  }
  if (L.gear === 6) {
    const m = lam(0xffb12e, 0.7),
      cr = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.13, 10), m);
    cr.position.y = 2.33;
    rig.add(cr);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2,
        k = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 5), m);
      k.position.set(Math.sin(a) * 0.26, 2.46, Math.cos(a) * 0.26);
      rig.add(k);
    }
  }
  // Backpack — body, flap, shoulder straps
  if (L.gear === 4) {
    const pack = lam(0x1a2438, 0.28);
    const accent = lam(0x2ee6ff, 0.45);
    rig.add(bx(0.48, 0.62, 0.28, pack, 0, 1.28, -0.36));
    rig.add(bx(0.5, 0.12, 0.3, accent, 0, 1.58, -0.36));
    rig.add(bx(0.42, 0.08, 0.06, lam(0x0b0f1c, 0.15), 0, 1.05, -0.36));
    // Shoulder straps
    for (const sx of [-1, 1]) {
      rig.add(bx(0.08, 0.55, 0.06, lam(0x2a3150, 0.25), sx * 0.22, 1.45, -0.12));
      rig.add(bx(0.08, 0.06, 0.28, lam(0x2a3150, 0.25), sx * 0.22, 1.7, -0.22));
    }
  }
  if (heldPose && g.userData.isPlayer) applyHeldPose(g);
}

/** Shoulder/hip euler. `x` = face-forward raise; `z` = spread (left +out, right −out). */
export type LimbRot = { x: number; y: number; z: number };
/** Elbow/knee bend is radians, 0 = straight. Elbow curls forward; knee curls back. */
export type Pose = {
  armL: LimbRot;
  armR: LimbRot;
  legL: LimbRot;
  legR: LimbRot;
  elbowL: number;
  elbowR: number;
  kneeL: number;
  kneeR: number;
};

const NEUTRAL: LimbRot = { x: 0, y: 0, z: 0 };
const lr = (x: number, y: number, z: number): LimbRot => ({ x, y, z });
const pose = (
  armL: LimbRot,
  armR: LimbRot,
  legL: LimbRot,
  legR: LimbRot,
  elbowL = 0,
  elbowR = 0,
  kneeL = 0,
  kneeR = 0,
): Pose => ({ armL, armR, legL, legR, elbowL, elbowR, kneeL, kneeR });

function clonePose(p: Pose): Pose {
  return {
    armL: { ...p.armL },
    armR: { ...p.armR },
    legL: { ...p.legL },
    legR: { ...p.legR },
    elbowL: p.elbowL,
    elbowR: p.elbowR,
    kneeL: p.kneeL,
    kneeR: p.kneeR,
  };
}

export function emptyPose(): Pose {
  return pose(NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL);
}

/**
 * Built-in poses. Limb `x` is face-forward positive (toward the head’s +Z).
 * `applyHeldPose` negates shoulder/hip x for Three.js.
 */
export const POSE_PRESETS: { id: string; name: string; pose: Pose }[] = [
  {
    id: 'crossed',
    name: 'Arms crossed',
    pose: pose(lr(1.1, 0.2, 0.85), lr(1.1, -0.2, -0.85), NEUTRAL, NEUTRAL, 1.55, 1.55),
  },
  {
    id: 'victory',
    name: 'Victory',
    pose: pose(lr(2.35, 0.15, 0.95), lr(2.35, -0.15, -0.95), lr(0, 0, 0.2), lr(0, 0, -0.2), 0.35, 0.35),
  },
  {
    id: 'tpose',
    name: 'T-pose',
    pose: pose(lr(0, 0, 1.55), lr(0, 0, -1.55), NEUTRAL, NEUTRAL),
  },
  {
    id: 'wave',
    name: 'Wave hello',
    pose: pose(lr(-0.1, 0, 0.15), lr(2.05, -0.35, -1.05), NEUTRAL, lr(0.12, 0, -0.1), 0.2, 0.85),
  },
  {
    id: 'think',
    name: 'Thinking',
    pose: pose(lr(-0.1, 0, 0.2), lr(1.35, -0.75, -0.45), lr(0.3, 0, 0.12), NEUTRAL, 0.15, 1.65),
  },
  {
    id: 'flex',
    name: 'Flex',
    pose: pose(lr(1.25, 0.45, 1.15), lr(1.25, -0.45, -1.15), lr(0, 0, 0.35), lr(0, 0, -0.35), 2.05, 2.05),
  },
  {
    id: 'sit',
    name: 'Sit',
    pose: pose(lr(0.75, 0.1, 0.3), lr(0.75, -0.1, -0.3), lr(1.45, 0.08, 0.2), lr(1.45, -0.08, -0.2), 0.55, 0.55, 1.55, 1.55),
  },
  {
    id: 'point',
    name: 'Point forward',
    pose: pose(lr(-0.1, 0, 0.2), lr(1.45, 0, -0.15), NEUTRAL, lr(0.4, 0, -0.12), 0.15, 0.25),
  },
  {
    id: 'akimbo',
    name: 'Hands on hips',
    pose: pose(lr(-0.55, 0.55, 0.95), lr(-0.55, -0.55, -0.95), lr(0, 0, 0.5), lr(0, 0, -0.5), 1.45, 1.45),
  },
  {
    id: 'kneel',
    name: 'One knee',
    pose: pose(lr(0.35, 0, 0.25), lr(0.35, 0, -0.25), lr(1.35, 0.15, 0.3), lr(0.2, 0, -0.15), 0.35, 0.35, 1.85, 0.2),
  },
];

export let heldPose: Pose | null = null;
/** Preset id, `custom`, or null when no pose held. */
export let heldPoseId: string | null = null;

const ROOT_LIMBS = ['armL', 'armR', 'legL', 'legR'] as const;
const BEND_JOINTS = ['elbowL', 'elbowR', 'kneeL', 'kneeR'] as const;

function poseRigDrop(id: string | null): number {
  if (id === 'sit') return -0.55;
  if (id === 'kneel') return -0.32;
  return 0;
}

/** Draft → pose. Spread is outward-positive on both sides (right maps to −z). */
export function poseFromDraft(d: {
  armL: { raise: number; spread: number; bend: number };
  armR: { raise: number; spread: number; bend: number };
  legL: { raise: number; spread: number; bend: number };
  legR: { raise: number; spread: number; bend: number };
}): Pose {
  return pose(
    lr(d.armL.raise, 0, d.armL.spread),
    lr(d.armR.raise, 0, -d.armR.spread),
    lr(d.legL.raise, 0, d.legL.spread),
    lr(d.legR.raise, 0, -d.legR.spread),
    Math.max(0, d.armL.bend),
    Math.max(0, d.armR.bend),
    Math.max(0, d.legL.bend),
    Math.max(0, d.legR.bend),
  );
}

export function draftFromPose(p: Pose) {
  return {
    armL: { raise: p.armL.x, spread: p.armL.z, bend: p.elbowL },
    armR: { raise: p.armR.x, spread: -p.armR.z, bend: p.elbowR },
    legL: { raise: p.legL.x, spread: p.legL.z, bend: p.kneeL },
    legR: { raise: p.legR.x, spread: -p.legR.z, bend: p.kneeR },
  };
}

export function applyHeldPose(g: THREE.Group = player) {
  if (!heldPose) return;
  const rig = g.userData.rig as THREE.Group;
  const u = rig.userData as Record<string, THREE.Object3D>;
  for (const k of ROOT_LIMBS) {
    const limb = u[k];
    if (!limb) return;
    const r = heldPose[k];
    // Face is +Z; Three +Rx swings a hanging limb to −Z — negate stored face-forward x.
    limb.rotation.set(-r.x, r.y, r.z);
  }
  // Elbow curls forward (−Rx); knee curls back (+Rx).
  if (u.elbowL) u.elbowL.rotation.set(-heldPose.elbowL, 0, 0);
  if (u.elbowR) u.elbowR.rotation.set(-heldPose.elbowR, 0, 0);
  if (u.kneeL) u.kneeL.rotation.set(heldPose.kneeL, 0, 0);
  if (u.kneeR) u.kneeR.rotation.set(heldPose.kneeR, 0, 0);
  rig.position.y = poseRigDrop(g === player ? heldPoseId : null);
}

function resetPoseJoints(g: THREE.Group) {
  const rig = g.userData.rig as THREE.Group;
  const u = rig.userData as Record<string, THREE.Object3D>;
  for (const k of ROOT_LIMBS) {
    const limb = u[k];
    if (limb) limb.rotation.set(0, 0, 0);
  }
  for (const k of BEND_JOINTS) {
    const joint = u[k];
    if (joint) joint.rotation.set(0, 0, 0);
  }
  rig.position.y = 0;
}

export function setHeldPose(poseIn: Pose | null, id: string | null = null) {
  heldPose = poseIn ? clonePose(poseIn) : null;
  heldPoseId = heldPose ? id : null;
  if (heldPose) applyHeldPose(player);
  else resetPoseJoints(player);
}

export function clearHeldPose() {
  if (!heldPose) return;
  setHeldPose(null, null);
}

export function makeAvatar(L: Look, name: string, parent: THREE.Object3D = scene) {
  const g = new THREE.Group(),
    rig = new THREE.Group(),
    lb = label(name, '#e9eefc', 0.8);
  lb.position.y = 2.85;
  g.add(rig, lb);
  g.userData = { rig, lb, phase: Math.random() * 6 };
  buildLook(g, L);
  parent.add(g);
  return g;
}
function walkAnim(a: THREE.Group, sp: number, t: number, ph: number) {
  const r = a.userData.rig as THREE.Group,
    u = r.userData as Record<string, THREE.Object3D>;
  if (a === player && heldPose && sp <= 0.4) {
    applyHeldPose(a);
    return;
  }
  const s = Math.sin(t * 9 + ph) * sp * .75;
  u.legL!.rotation.set(s, 0, 0);
  u.legR!.rotation.set(-s, 0, 0);
  u.armL!.rotation.set(-s, 0, 0);
  u.armR!.rotation.set(s, 0, 0);
  if (u.elbowL) u.elbowL.rotation.set(-0.15 * sp, 0, 0);
  if (u.elbowR) u.elbowR.rotation.set(-0.15 * sp, 0, 0);
  if (u.kneeL) u.kneeL.rotation.set(Math.max(0, s) * 0.35, 0, 0);
  if (u.kneeR) u.kneeR.rotation.set(Math.max(0, -s) * 0.35, 0, 0);
  r.position.y = sp > .1 ? Math.abs(Math.sin(t * 9 + ph)) * .07 * sp : 0;
}

export const player = makeAvatar(DEFAULT_LOOK, 'You');
player.userData.isPlayer = true;
player.position.set(0, 0, 10);

/** Floating square AI companion — click opens the assist panel. */
export const assistant = new THREE.Group();
{
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(0.38, 0.38, 0.38),
    new THREE.MeshStandardMaterial({
      color: 0x151c33,
      emissive: 0x2ee6ff,
      emissiveIntensity: 0.55,
      metalness: 0.4,
      roughness: 0.35,
    }),
  );
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.46, 0.1),
    new THREE.MeshBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.35 }),
  );
  frame.position.z = 0.18;
  const eye = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.06),
    new THREE.MeshBasicMaterial({ color: 0xb8ff3d }),
  );
  eye.position.set(0, 0.04, 0.2);
  const glow = new THREE.PointLight(0x2ee6ff, 0.55, 4);
  glow.position.set(0, 0, 0.2);
  assistant.add(core, frame, eye, glow);
  assistant.position.set(0.9, 1.7, 10);
  scene.add(assistant);
}

let onAssistantClick: (() => void) | null = null;
export function setAssistantClickHandler(fn: (() => void) | null) {
  onAssistantClick = fn;
}

const assistRay = new THREE.Raycaster();
const assistNdc = new THREE.Vector2();
const assistProj = new THREE.Vector3();
/** Larger invisible hit target so short clicks register without fighting look. */
{
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.name = 'assistHit';
  assistant.add(hit);
}

export function tryPickAssistant(clientX: number, clientY: number): boolean {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  assistNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  assistNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  assistRay.setFromCamera(assistNdc, camera);
  return assistRay.intersectObject(assistant, true).length > 0;
}

/** Screen position of the assistant (CSS px in the app viewport). null if off-camera. */
export function assistantScreenPos(): { x: number; y: number } | null {
  assistProj.set(assistant.position.x, assistant.position.y + 0.35, assistant.position.z);
  assistProj.project(camera);
  if (assistProj.z > 1) return null;
  const rect = canvas.getBoundingClientRect();
  const x = (assistProj.x * 0.5 + 0.5) * rect.width + rect.left;
  const y = (-assistProj.y * 0.5 + 0.5) * rect.height + rect.top;
  if (x < -40 || y < -40 || x > innerWidth + 40 || y > innerHeight + 40) return null;
  return { x, y };
}

function tickAssistant(dt: number) {
  const rightX = Math.cos(cam.yaw),
    rightZ = -Math.sin(cam.yaw);
  const bob = Math.sin(clockT * 2.4) * 0.08;
  const tx = player.position.x + rightX * 0.95;
  const ty = 1.65 + bob;
  const tz = player.position.z + rightZ * 0.95;
  const k = Math.min(1, dt * 6);
  assistant.position.x += (tx - assistant.position.x) * k;
  assistant.position.y += (ty - assistant.position.y) * k;
  assistant.position.z += (tz - assistant.position.z) * k;
  const dx = camera.position.x - assistant.position.x;
  const dz = camera.position.z - assistant.position.z;
  assistant.rotation.y = Math.atan2(dx, dz);
}

/** No walking NPCs — real multiplayer presence is not wired yet. */
export const npcs: THREE.Group[] = [];

/** Visual-only merchant staff inside far-plot interiors (no colliders / economy). */
export const staff: THREE.Group[] = [];

function spawnStaff(
  buildingId: string,
  role: string,
  look: Look,
  x: number,
  z: number,
  yaw: number,
): void {
  const parent = interiorGroups.get(buildingId);
  if (!parent) return;
  const g = makeAvatar(look, role, parent);
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  g.userData.homeYaw = yaw;
  g.userData.idleUntil = Math.random() * 3;
  g.userData.idleKind = 0;
  g.userData.idleT = 0;
  staff.push(g);
}

spawnStaff(
  'diner',
  'Chef',
  { skin: 4, hair: 0, hairC: 1, top: 4, bot: 0, glasses: false, glassC: 0, gear: 1, capDir: 0 },
  180,
  35.6,
  Math.PI, // face +z toward the counter / customers
);
spawnStaff(
  'forge',
  'Smith',
  { skin: 3, hair: 1, hairC: 0, top: 3, bot: 2, glasses: false, glassC: 0, gear: 0, capDir: 0 },
  261.8,
  -2.2,
  Math.PI * 0.65,
);

function tickStaffIdle(dt: number): void {
  for (const g of staff) {
    const ud = g.userData as {
      rig: THREE.Group;
      phase: number;
      homeYaw: number;
      idleUntil: number;
      idleKind: number;
      idleT: number;
    };
    const arms = ud.rig.userData as Record<string, THREE.Object3D>;
    ud.idleUntil -= dt;
    if (ud.idleUntil <= 0) {
      ud.idleKind = Math.random() < 0.5 ? 0 : 1; // 0 = arms, 1 = turn
      ud.idleT = 0;
      ud.idleUntil = 3.5 + Math.random() * 3.5;
    }
    if (ud.idleT < 1.2) {
      ud.idleT += dt;
      const u = Math.min(1, ud.idleT / 1.2);
      const wave = Math.sin(u * Math.PI);
      if (ud.idleKind === 0) {
        const a = wave * 0.45;
        arms.armL!.rotation.x = -a;
        arms.armR!.rotation.x = a * 0.35;
        g.rotation.y = ud.homeYaw;
      } else {
        arms.armL!.rotation.x = 0;
        arms.armR!.rotation.x = 0;
        g.rotation.y = ud.homeYaw + wave * 0.55 * (ud.phase % 2 < 1 ? 1 : -1);
      }
    } else {
      arms.armL!.rotation.x *= Math.max(0, 1 - dt * 4);
      arms.armR!.rotation.x *= Math.max(0, 1 - dt * 4);
      g.rotation.y += (ud.homeYaw - g.rotation.y) * Math.min(1, dt * 3);
    }
  }
}
export const worldFx = { crowd: null as string | null, crowdT: 0, shake: 0, siren: 0, panic: 0 };
export function crowdTo(zone: string, secs: number) {
  worldFx.crowd = zone;
  worldFx.crowdT = secs;
}
export function glitchFx() {
  canvas.classList.remove('glitch');
  void canvas.offsetWidth;
  canvas.classList.add('glitch');
  worldFx.shake = 0.9;
}

export const cam = { yaw: 0, pitch: 0.5, dist: 16, tx: 0, ty: 1.2, tz: 10 };
export const keys = new Set<string>();
const hideCoach = () => {
  ($('#coach') as HTMLElement).hidden = true;
};
addEventListener('keydown', e => {
  if (modalOpen() || introOpen()) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'q', 'r'].includes(k)) {
    keys.add(k);
    hideCoach();
    e.preventDefault();
  }
  if ((k === 'e' || k === 'enter') && !e.repeat && nearStation && !nearStation.locked) {
    e.preventDefault();
    useStation();
  }
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

type LookPtr = { x: number; y: number; sx: number; sy: number; look: boolean; onAssist: boolean };
const ptrs = new Map<number, LookPtr>();
let pinch0 = 1;
const touchUI = matchMedia('(pointer:coarse)').matches;
/** Only used when the press started on the assistant (click vs drag-open). */
const ASSIST_CLICK_PX = 10;

/** Exit leftover pointer lock from older sessions; look is click-and-hold now. */
export function releaseLookLock(): void {
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}

/*
 * Hold-drag to look everywhere except a short click on the assistant.
 * Presses that miss the bot look immediately — no click threshold delay.
 */
canvas.addEventListener('pointerdown', e => {
  if (modalOpen() || introOpen()) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  canvas.setPointerCapture(e.pointerId);
  const onAssist = tryPickAssistant(e.clientX, e.clientY);
  ptrs.set(e.pointerId, {
    x: e.clientX,
    y: e.clientY,
    sx: e.clientX,
    sy: e.clientY,
    look: !onAssist,
    onAssist,
  });
  hideCoach();
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch0 = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
  }
});
canvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x,
    dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (!p.look && Math.hypot(p.x - p.sx, p.y - p.sy) >= ASSIST_CLICK_PX) p.look = true;
  if (ptrs.size === 1) {
    if (!p.look) return;
    cam.yaw -= dx * 0.006;
    cam.pitch = clamp(cam.pitch + dy * 0.005, 0.06, 1.5);
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
    cam.dist = clamp(cam.dist * (pinch0 / d), 6, 36);
    pinch0 = d;
  }
});
function endPtr(e: PointerEvent) {
  const p = ptrs.get(e.pointerId);
  ptrs.delete(e.pointerId);
  if (!p || p.look || !p.onAssist || modalOpen() || introOpen()) return;
  if (ptrs.size > 0) return;
  if (e.type === 'pointercancel') return;
  if (tryPickAssistant(e.clientX, e.clientY) || Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < ASSIST_CLICK_PX) {
    onAssistantClick?.();
  }
}
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener(
  'wheel',
  e => {
    e.preventDefault();
    cam.dist = clamp(cam.dist + e.deltaY * 0.012, 6, 36);
  },
  { passive: false },
);

const joy = $('#joy') as HTMLElement,
  knob = $('#joy i') as HTMLElement,
  joyV = { x: 0, y: 0 };
let joyId: number | null = null;
joy.hidden = !touchUI;
function joyMove(e: PointerEvent) {
  const r = joy.getBoundingClientRect(),
    max = 44;
  let dx = e.clientX - (r.left + r.width / 2),
    dy = e.clientY - (r.top + r.height / 2);
  const m = Math.hypot(dx, dy);
  if (m > max) {
    dx *= max / m;
    dy *= max / m;
  }
  knob.style.transform = `translate(${dx}px,${dy}px)`;
  joyV.x = dx / max;
  joyV.y = -dy / max;
}
joy.addEventListener('pointerdown', e => {
  joyId = e.pointerId;
  joy.setPointerCapture(e.pointerId);
  joyMove(e);
  hideCoach();
});
joy.addEventListener('pointermove', e => {
  if (e.pointerId === joyId) joyMove(e);
});
const joyEnd = (e: PointerEvent) => {
  if (e.pointerId === joyId) {
    joyId = null;
    joyV.x = joyV.y = 0;
    knob.style.transform = '';
  }
};
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);

function collide(p: THREE.Vector3) {
  for (const c of colliders) {
    const dx = p.x - c.x,
      dz = p.z - c.z,
      ox = c.hw - Math.abs(dx),
      oz = c.hd - Math.abs(dz);
    if (ox > 0 && oz > 0) {
      if (ox < oz) p.x += Math.sign(dx || 1) * ox;
      else p.z += Math.sign(dz || 1) * oz;
    }
  }
}
const SPEED = 7.5;
export const vel = { x: 0, z: 0 };
export let clockT = 0;
export let nearStation: Station | null = null;
/** Active far-plot interior id, or null when in the plaza. */
export let currentInterior: string | null = null;
let savedCamDist = 16;
let fadeBusy = false;
export let customizing = false;
export const setCustomizing = (v: boolean) => {
  customizing = v;
};

export function isInside(): boolean {
  return currentInterior != null;
}

function interiorBounds(b: BuildingDef): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const m = 0.8;
  return {
    minX: b.interior.originX - b.interior.w / 2 + m,
    maxX: b.interior.originX + b.interior.w / 2 - m,
    minZ: b.interior.originZ - b.interior.d / 2 + m,
    maxZ: b.interior.originZ + b.interior.d / 2 - m,
  };
}

function setFx(on: boolean): void {
  const el = $('#fx');
  if (!el) return;
  el.classList.toggle('on', on);
}

function fadeThen(fn: () => void): void {
  if (fadeBusy) return;
  fadeBusy = true;
  setFx(true);
  window.setTimeout(() => {
    fn();
    window.setTimeout(() => {
      setFx(false);
      fadeBusy = false;
    }, 180);
  }, 220);
}

export function enterBuilding(id: string): void {
  const b = buildingById(id);
  if (!b || currentInterior === id) return;
  fadeThen(() => {
    currentInterior = id;
    savedCamDist = cam.dist;
    const door = interiorDoorWorld(b);
    const spawnZ = door.z - 1.2;
    player.position.set(door.x, 0, spawnZ);
    player.rotation.y = Math.PI;
    vel.x = vel.z = 0;
    cam.tx = door.x;
    cam.ty = 1.2;
    cam.tz = spawnZ;
    cam.yaw = Math.PI + 0.35;
    cam.pitch = 0.42;
    cam.dist = 4;
  });
}

export function exitBuilding(opts?: { immediate?: boolean }): void {
  if (!currentInterior) return;
  const b = buildingById(currentInterior);
  if (!b) {
    currentInterior = null;
    return;
  }
  const place = () => {
    currentInterior = null;
    const d = b.door.exterior;
    player.position.set(d.x, 0, d.z + 1.4);
    vel.x = vel.z = 0;
    cam.tx = d.x;
    cam.ty = 1.2;
    cam.tz = d.z + 1.4;
    cam.dist = savedCamDist;
  };
  if (opts?.immediate) place();
  else fadeThen(place);
}

/** Drop interior state without moving (fast travel / warp). */
export function clearInterior(): void {
  if (!currentInterior) return;
  currentInterior = null;
  cam.dist = savedCamDist;
}

/** Enter if outside, exit if already in this building. */
export function toggleBuilding(id: string): void {
  if (currentInterior === id) exitBuilding();
  else if (!currentInterior) enterBuilding(id);
}

/** Teleport into home interior without requiring the exterior door (phone Go home). */
export function warpIntoBuilding(id: string, x: number, z: number): void {
  const b = buildingById(id);
  if (!b) return;
  currentInterior = id;
  savedCamDist = cam.dist;
  player.position.set(x, 0, z);
  vel.x = vel.z = 0;
  cam.tx = x;
  cam.ty = 1.2;
  cam.tz = z;
  cam.yaw = 0;
  cam.dist = 4;
}

function stepPlayer(dt: number) {
  if (introOpen()) {
    cam.yaw += dt * 0.12;
    return;
  }
  if (customizing) {
    cam.yaw += dt * 0.5;
    walkAnim(player, 0, clockT, 0);
    return;
  }
  const frozen = modalOpen();
  let ix = frozen ? 0 : (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0) + joyV.x;
  let iy = frozen ? 0 : (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0) + joyV.y;
  if (!frozen) {
    if (keys.has('q')) cam.yaw += dt * 1.8;
    if (keys.has('r')) cam.yaw -= dt * 1.8;
  }
  const m = Math.hypot(ix, iy);
  if (m > 1) {
    ix /= m;
    iy /= m;
  }
  const SPD = SPEED * (weak() ? 0.7 : 1);
  const fx = -Math.sin(cam.yaw),
    fz = -Math.cos(cam.yaw),
    rx = Math.cos(cam.yaw),
    rz = -Math.sin(cam.yaw);
  const k = Math.min(1, dt * 10);
  vel.x += ((fx * iy + rx * ix) * SPD - vel.x) * k;
  vel.z += ((fz * iy + rz * ix) * SPD - vel.z) * k;
  const p = player.position;
  p.x += vel.x * dt;
  p.z += vel.z * dt;
  collide(p);
  if (currentInterior) {
    const b = buildingById(currentInterior);
    if (b) {
      const box = interiorBounds(b);
      p.x = clamp(p.x, box.minX, box.maxX);
      p.z = clamp(p.z, box.minZ, box.maxZ);
    }
  } else {
    const r = Math.hypot(p.x, p.z);
    if (r > 46) {
      p.x *= 46 / r;
      p.z *= 46 / r;
    }
  }
  const sp = Math.hypot(vel.x, vel.z);
  if (sp > 0.4) {
    clearHeldPose();
    let d = Math.atan2(vel.x, vel.z) - player.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    player.rotation.y += d * Math.min(1, dt * 12);
  }
  walkAnim(player, Math.min(1, sp / 4), clockT, 0);
}
const FOG_FEAR = new THREE.Color(0x2a0818),
  FOG_MID = new THREE.Color(0x0a0f22),
  FOG_GREED = new THREE.Color(0x06262e),
  tmpC = new THREE.Color();
const RN = lowEnd ? 250 : 500,
  rp = new Float32Array(RN * 3);
for (let i = 0; i < RN; i++) {
  rp[i * 3] = rnd(-40, 40);
  rp[i * 3 + 1] = rnd(0, 30);
  rp[i * 3 + 2] = rnd(-40, 40);
}
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
export const rain = new THREE.Points(
  rainGeo,
  new THREE.PointsMaterial({ color: 0x7fd8ff, size: 0.12, transparent: true, opacity: 0.55, depthWrite: false }),
);
rain.frustumCulled = false;
scene.add(rain);

export function worldUpdate(dt: number) {
  clockT += dt;
  stepPlayer(dt);
  tickAssistant(dt);
  tickStaffIdle(dt);
  worldFx.crowdT -= dt;
  if (worldFx.crowdT <= 0) worldFx.crowd = null;
  worldFx.panic = Math.max(0, worldFx.panic - dt);
  worldFx.shake = Math.max(0, worldFx.shake - dt * 1.2);
  worldFx.siren = Math.max(0, worldFx.siren - dt);
  const on = worldFx.siren > 0,
    ph = Math.sin(clockT * 12) > 0;
  sirenA.intensity = on ? (ph ? 70 : 6) : 0;
  sirenB.intensity = on ? (ph ? 6 : 70) : 0;
  const m = market.mood;
  tmpC.copy(FOG_MID).lerp(m < 0 ? FOG_FEAR : FOG_GREED, Math.min(1, Math.abs(m)));
  (scene.fog as THREE.FogExp2).color.lerp(tmpC, 0.04);
  renderer.setClearColor((scene.fog as THREE.FogExp2).color);
  for (let i = 0; i < RN; i++) {
    rp[i * 3 + 1] -= dt * 22;
    if (rp[i * 3 + 1]! < 0) rp[i * 3 + 1] = 30;
  }
  rainGeo.attributes.position!.needsUpdate = true;
  rain.position.set(player.position.x, 0, player.position.z);
  const p = player.position,
    k = Math.min(1, dt * 9);
  cam.tx += (p.x - cam.tx) * k;
  cam.tz += (p.z - cam.tz) * k;
  const cp = Math.cos(cam.pitch);
  let x = cam.tx + Math.sin(cam.yaw) * cp * cam.dist,
    y = cam.ty + Math.sin(cam.pitch) * cam.dist,
    z = cam.tz + Math.cos(cam.yaw) * cp * cam.dist;
  if (worldFx.shake > 0) {
    x += randn() * 0.12 * worldFx.shake;
    y += randn() * 0.12 * worldFx.shake;
  }
  camera.position.set(x, Math.max(0.7, y), z);
  camera.lookAt(cam.tx, cam.ty + 0.8, cam.tz);
  let best: Station | null = null,
    bd = 3.6;
  const inB = currentInterior ? buildingById(currentInterior) : null;
  const inBox = inB ? interiorBounds(inB) : null;

  // Outside: enter via lit door proximity (no outdoor rings).
  if (!currentInterior) {
    for (const b of BUILDINGS) {
      const d = Math.hypot(p.x - b.door.exterior.x, p.z - b.door.exterior.z);
      if (d < Math.min(bd, 2.5)) {
        bd = d;
        best = {
          id: `bdoor-${b.id}`,
          name: `Enter ${b.name}`,
          x: b.door.exterior.x,
          z: b.door.exterior.z,
          col: b.exterior.edgeColor,
        };
      }
    }
  }

  for (const s of stations) {
    if (inBox) {
      if (s.x < inBox.minX - 2.5 || s.x > inBox.maxX + 2.5 || s.z < inBox.minZ - 2.5 || s.z > inBox.maxZ + 2.5)
        continue;
    } else {
      // Only outdoor stations (park bench) while in the plaza.
      let inAnyInterior = false;
      for (const b of BUILDINGS) {
        const box = interiorBounds(b);
        if (s.x >= box.minX - 1 && s.x <= box.maxX + 1 && s.z >= box.minZ - 1 && s.z <= box.maxZ + 1) {
          inAnyInterior = true;
          break;
        }
      }
      if (inAnyInterior) continue;
    }
    const d = Math.hypot(p.x - s.x, p.z - s.z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  nearStation = best;
  pulseInteractables(best && !best.locked ? best.id : null, clockT);
  const btn = $('#prompt') as HTMLButtonElement,
    show = !!best && !modalOpen() && !introOpen();
  const isDoor = !!best && (best.id === 'door' || best.id.startsWith('bdoor-'));
  const txt = !best
    ? ''
    : best.locked
      ? `${best.name}: ${best.locked}`
      : isDoor && !currentInterior
        ? best.name
        : isDoor
          ? `Exit ${buildingById(currentInterior!)?.name ?? 'building'}`
          : `Use ${best.name}`;
  if (btn.hidden === show) btn.hidden = !show;
  if (show && btn.textContent !== txt) {
    btn.textContent = txt;
    btn.disabled = !!best!.locked;
  }
}

/* Park bench mesh (outdoor rest) — highlighted as the bench, not a ring. */
{
  const benchG = new THREE.Group();
  benchG.add(
    bx(3, .5, .9, lam(0x4a3a2a, .15), 8, .35, 17.5),
    bx(3, .8, .15, lam(0x4a3a2a, .15), 8, .9, 17.95),
  );
  tagInteractable(benchG, 'rest');
  scene.add(benchG);
}

export type FurnDef = {
  id: string;
  name: string;
  price: number;
  pts: number;
  d: string;
  b: (g: THREE.Group) => void;
};
export const FURN: FurnDef[] = [
  { id: 'bed2', name: 'Royal Bed', price: FURN_PRICE_GD.bed2 ?? 70000, pts: 5, d: 'Sleep faster', b: g => { g.add(bx(2.2, .5, 3.2, lam(0x7a1d3a, .3), 134, .45, -5), bx(2, .25, 1, lam(0xe9eefc, .3), 134, .85, -6.2), bx(2.4, 1.4, .2, lam(0xffb12e, .4), 134, 1.1, -6.7)); } },
  { id: 'rug', name: 'Neon Rug', price: 15000, pts: 2, d: 'Comfy underfoot', b: g => { const m = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, .04, 24), lam(0xff3d9a, .5)); m.position.set(140, .03, 0); g.add(m); } },
  { id: 'sofa', name: 'Sofa', price: 40000, pts: 3, d: 'Seat for visitors', b: g => { g.add(bx(3.2, .8, 1.3, lam(0x2a3150, .25), 144.5, .4, -5.8), bx(3.2, 1, .3, lam(0x2a3150, .25), 144.5, .9, -6.5)); } },
  { id: 'plant', name: 'Plant', price: 8000, pts: 1, d: 'Fresh air', b: g => { g.add(bx(.7, .7, .7, lam(0x8a5a3a, .1), 146.5, .35, 5), new THREE.Mesh(new THREE.SphereGeometry(.8, 10, 8), lam(0x2dbd5a, .3))); g.children[g.children.length - 1]!.position.set(146.5, 1.4, 5); } },
  { id: 'lamp', name: 'Floor Lamp', price: 12000, pts: 1, d: 'Warm light', b: g => { g.add(bx(.12, 2.6, .12, lam(0x8b97b8, .1), 134, 1.3, 3), bx(.6, .5, .6, lam(0xffe0a0, 1), 134, 2.7, 3)); } },
  { id: 'tv', name: 'Big TV', price: 60000, pts: 4, d: 'Watch the charts', b: g => { g.add(bx(4, 2.2, .2, lam(0x050810, .1), 140, 1.9, -7.7), bx(3.7, 1.9, .05, new THREE.MeshBasicMaterial({ color: 0x2ee6ff }), 140, 1.9, -7.55), bx(4.5, .5, .8, lam(0x151c33, .1), 140, .25, -7.4)); } },
  { id: 'pc', name: 'Gaming PC', price: 90000, pts: 5, d: 'RGB everything', b: g => { g.add(bx(2.6, .15, 1.2, lam(0x151c33, .2), 136, .9, 5.5), bx(1.2, .8, .1, new THREE.MeshBasicMaterial({ color: 0xb8ff3d }), 136, 1.5, 5.2), bx(.5, .8, .8, lam(0xff3d9a, .8), 137.6, .4, 5.5)); } },
  { id: 'neon', name: 'Neon Sign', price: 50000, pts: 3, d: 'Your name in lights', b: g => { const l = label(S.name.toUpperCase().slice(0, 12), '#ff3d9a', 2.4); l.position.set(140, 3.3, -7.5); g.add(l); } },
  { id: 'trophy', name: 'Trophy Shelf', price: FURN_PRICE_GD.trophy ?? 60000, pts: 6, d: 'Show off', b: g => { g.add(bx(.4, 2.2, 3, lam(0x151c33, .1), 147.6, 1.1, 0)); for (let i = 0; i < 3; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(.2, .12, .5, 8), lam(0xffb12e, .8)); c.position.set(147.5, 1.5, -1 + i); g.add(c); } } },
];
export const furnG = new THREE.Group();
scene.add(furnG);
export const hasF = (id: string) => S.home.items.includes(id);
export function buildFurn() {
  furnG.clear();
  untagStation('bed');
  if (!S.home.owned) return;
  const bedG = new THREE.Group();
  if (!hasF('bed2')) {
    bedG.add(
      bx(1.8, .4, 3, lam(0x3a4a7a, .25), 134, .4, -5),
      bx(1.6, .2, .8, lam(0xe9eefc, .3), 134, .7, -6.2),
    );
  }
  for (const f of FURN) {
    if (!hasF(f.id)) continue;
    if (f.id === 'bed2') f.b(bedG);
    else f.b(furnG);
  }
  if (bedG.children.length) {
    tagInteractable(bedG, 'bed');
    furnG.add(bedG);
  }
}
export const comfort = () => 1 + S.home.items.reduce((a, id) => a + FURN.find(f => f.id === id)!.pts, 0);
export const maintenanceLeft = () => S.home.paidUntil - Date.now();
/** @deprecated Use maintenanceLeft */
export const rentLeft = maintenanceLeft;
export const overdue = () => S.home.owned && maintenanceLeft() < 0;
