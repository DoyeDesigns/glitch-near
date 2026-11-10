import * as THREE from 'three';
import { FURN_PRICE_GD } from '@glitch/shared';
import { DEFAULT_LOOK, type Look, type Station } from './types';
import { NPC_NAMES } from './constants';
import { $, clamp, pick, randn, rnd } from './util';
import { S, weak } from './state';
import { market } from './market';
import { introOpen, modalOpen } from './hud';
import { useStation } from './games';

export const lowEnd = (navigator.hardwareConcurrency || 4) <= 4 || matchMedia('(pointer:coarse)').matches;
export const canvas = $('#gl') as HTMLCanvasElement;
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowEnd ? 1.25 : 1.75));
renderer.setClearColor(0x070910);
export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0f22, 0.017);
export const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
scene.add(new THREE.HemisphereLight(0x7088ff, 0x140a1e, 1.0));
const sun = new THREE.DirectionalLight(0x88aaff, 0.4);
sun.position.set(-20, 40, 10);
scene.add(sun);

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
  x.fillStyle = '#0a0e1a';
  x.fillRect(0, 0, w, h);
  x.strokeStyle = '#17304a';
  x.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    x.beginPath();
    x.moveTo((i * w) / 8, 0);
    x.lineTo((i * w) / 8, h);
    x.stroke();
    x.beginPath();
    x.moveTo(0, (i * h) / 8);
    x.lineTo(w, (i * h) / 8);
    x.stroke();
  }
});
groundTex.t.wrapS = groundTex.t.wrapT = THREE.RepeatWrapping;
groundTex.t.repeat.set(20, 20);
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
  const N = lowEnd ? 60 : 100,
    d = new THREE.Object3D();
  const win = canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = '#000';
    x.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      x.fillStyle = pick(['#2ee6ff', '#ff3d9a', '#ffb12e', '#7a8cff']);
      x.fillRect(Math.random() * w, Math.random() * h, 6, 9);
    }
  });
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveMap: win.t, emissiveIntensity: 0.9 });
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2,
      r = rnd(60, 105),
      w = rnd(7, 15),
      h = rnd(14, 55);
    d.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    d.scale.set(w, h, rnd(7, 15));
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
    im.setColorAt(i, new THREE.Color(pick([0x0d1430, 0x160d30, 0x0a1a2a])));
  }
  scene.add(im);
}

const colliders: Array<{ x: number; z: number; hw: number; hd: number }> = [];
function building(x: number, z: number, w: number, h: number, dpt: number, col: number, edge: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dpt), new THREE.MeshLambertMaterial({ color: col }));
  m.position.set(x, h / 2, z);
  scene.add(m);
  colliders.push({ x, z, hw: w / 2 + 0.7, hd: dpt / 2 + 0.7 });
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: edge }));
  e.position.copy(m.position);
  scene.add(e);
  return m;
}
function screen(w: number, h: number, x: number, y: number, z: number, ry: number, tex: TexBag) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex.t, toneMapped: false }));
  m.position.set(x, y, z);
  m.rotation.y = ry;
  scene.add(m);
  return m;
}
building(-26, -9, 14, 9, 12, 0x101a30, 0x2ee6ff);
building(26, -9, 14, 8, 12, 0x0c1a1c, 0xb8ff3d);
building(0, -34, 10, 26, 10, 0x1a1030, 0xff3d9a);
building(34, 28, 10, 6, 8, 0x1a1408, 0xffb12e);
{
  const dl = label('Neon Diner', '#ffb12e', 1.3);
  dl.position.set(34, 8, 28);
  scene.add(dl);
}
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

export const stations: Station[] = [
  { id: 'trade', name: 'Trade Terminal', x: -13, z: -6, col: 0x2ee6ff },
  { id: 'sec', name: 'Vault Cracker', x: 13, z: -6, col: 0xb8ff3d },
  { id: 'comm', name: 'Attention Booth', x: 0, z: -22, col: 0xff3d9a },
  { id: 'build', name: 'Deploy Lab', x: -30, z: 10, col: 0x555f7a, locked: 'Build skill: next update' },
  { id: 'cap', name: 'Allocation Desk', x: 30, z: 10, col: 0x555f7a, locked: 'Capital skill: next update' },
  { id: 'forge', name: 'Gear Forge', x: 0, z: -9, col: 0xff6a3d },
  { id: 'eat', name: 'Diner Counter', x: 27, z: 21, col: 0xffb12e },
  { id: 'rest', name: 'Park Bench', x: 8, z: 15, col: 0x7a8cff },
  { id: 'bed', name: 'Bed', x: 134, z: -2, col: 0x7a8cff },
  { id: 'door', name: 'Front Door', x: 140, z: 6.5, col: 0xffb12e },
];
for (const s of stations) {
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
  const lb = label(s.name, s.locked ? '#8b97b8' : '#ffffff', 1.1);
  lb.position.set(s.x, 5.2, s.z);
  scene.add(lb);
  s.ring = ring;
  s.beam = beam;
}
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
  GEARS = ['None', 'Cap', 'Headphones', 'Chain', 'Backpack', 'Cape', 'Crown'];
export const randLook = (): Look => ({
  skin: Math.floor(rnd(0, SKINS.length)),
  hair: Math.floor(rnd(0, HAIRS.length)),
  hairC: Math.floor(rnd(0, HAIRC.length)),
  top: Math.floor(rnd(0, TOPC.length)),
  bot: Math.floor(rnd(0, BOTC.length)),
  glasses: Math.random() < .6,
  glassC: Math.floor(rnd(0, GLASSC.length)),
  gear: Math.floor(rnd(0, GEARS.length)),
});
export const lam = (c: number, e = .22) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: e });
export const bx = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  return o;
};
export function buildLook(g: THREE.Group, L: Look) {
  const rig = g.userData.rig as THREE.Group;
  rig.clear();
  const u = (rig.userData = {} as Record<string, THREE.Group>);
  const skin = lam(SKINS[L.skin]!, .12),
    top = lam(TOPC[L.top]!),
    bot = lam(BOTC[L.bot]!, .1),
    hair = lam(HAIRC[L.hairC]!, .08);
  const mkLeg = (x: number) => {
    const p = new THREE.Group();
    p.position.set(x, .85, 0);
    p.add(bx(.3, .85, .32, bot, 0, -.425, 0), bx(.32, .12, .42, lam(0x0b0f1c, .05), 0, -.82, .05));
    rig.add(p);
    return p;
  };
  u.legL = mkLeg(-.17);
  u.legR = mkLeg(.17);
  rig.add(bx(.74, .82, .4, top, 0, 1.26, 0));
  const mkArm = (x: number) => {
    const p = new THREE.Group();
    p.position.set(x, 1.6, 0);
    p.add(bx(.2, .46, .24, top, 0, -.23, 0), bx(.17, .3, .2, skin, 0, -.61, 0));
    rig.add(p);
    return p;
  };
  u.armL = mkArm(-.48);
  u.armR = mkArm(.48);
  rig.add(bx(.14, .12, .14, skin, 0, 1.72, 0));
  const head = new THREE.Mesh(new THREE.SphereGeometry(.28, 14, 12), skin);
  head.position.y = 1.99;
  rig.add(head);
  if (!L.glasses) {
    rig.add(bx(.06, .06, .04, lam(0x10131f, 0), -.1, 2.02, .26), bx(.06, .06, .04, lam(0x10131f, 0), .1, 2.02, .26));
  }
  if (L.hair === 0) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(.3, 14, 10, 0, Math.PI * 2, 0, Math.PI * .5), hair);
    h.position.set(0, 2.02, -.015);
    rig.add(h);
  }
  if (L.hair === 1) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(.42, 14, 12), hair);
    h.position.set(0, 2.1, -.06);
    rig.add(h);
  }
  if (L.hair === 2) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(.3, 14, 10, 0, Math.PI * 2, 0, Math.PI * .5), hair);
    h.position.set(0, 2.02, -.015);
    rig.add(h);
    for (let i = 0; i < 7; i++) {
      const a = -1.1 + i * .37,
        b = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, .55, 5), hair);
      b.position.set(Math.sin(a) * .27, 1.84, -.2 - Math.abs(Math.sin(a)) * .02);
      rig.add(b);
    }
  }
  if (L.glasses) {
    const gm = new THREE.MeshBasicMaterial({ color: GLASSC[L.glassC]! });
    rig.add(bx(.2, .1, .06, gm, -.1, 2.02, .27), bx(.2, .1, .06, gm, .1, 2.02, .27), bx(.58, .03, .05, gm, 0, 2.03, .26));
  }
  if (L.gear === 1) {
    rig.add(bx(.6, .16, .6, lam(0xe9eefc, .2), 0, 2.24, 0), bx(.4, .04, .34, lam(0xe9eefc, .2), 0, 2.2, .4));
  }
  if (L.gear === 2) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(.31, .035, 6, 16, Math.PI), lam(0x151c33, .3));
    t.position.y = 2.0;
    t.rotation.z = 0;
    rig.add(t, bx(.1, .24, .2, lam(0xff3d9a, .5), -.31, 2.0, 0), bx(.1, .24, .2, lam(0xff3d9a, .5), .31, 2.0, 0));
  }
  if (L.gear === 3) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(.2, .03, 6, 18), lam(0xffb12e, .6));
    t.position.set(0, 1.58, .14);
    t.rotation.x = Math.PI / 2.4;
    rig.add(t);
  }
  if (L.gear === 5) {
    const c = bx(.78, 1.15, .05, lam(0xc4163f, .35), 0, 1.15, -.27);
    c.rotation.x = .08;
    rig.add(c, bx(.8, .1, .1, lam(0xffb12e, .6), 0, 1.68, -.2));
  }
  if (L.gear === 6) {
    const m = lam(0xffb12e, .7),
      cr = new THREE.Mesh(new THREE.CylinderGeometry(.26, .28, .13, 10), m);
    cr.position.y = 2.33;
    rig.add(cr);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2,
        k = new THREE.Mesh(new THREE.ConeGeometry(.06, .18, 5), m);
      k.position.set(Math.sin(a) * .26, 2.46, Math.cos(a) * .26);
      rig.add(k);
    }
  }
  if (L.gear === 4) rig.add(bx(.5, .6, .22, lam(0x2a3150, .3), 0, 1.3, -.31), bx(.46, .1, .24, lam(0x2ee6ff, .4), 0, 1.5, -.31));
}
export function makeAvatar(L: Look, name: string) {
  const g = new THREE.Group(),
    rig = new THREE.Group(),
    lb = label(name, '#e9eefc', 0.8);
  lb.position.y = 2.85;
  g.add(rig, lb);
  g.userData = { rig, lb, phase: Math.random() * 6 };
  buildLook(g, L);
  scene.add(g);
  return g;
}
function walkAnim(a: THREE.Group, sp: number, t: number, ph: number) {
  const r = a.userData.rig as THREE.Group,
    u = r.userData as Record<string, THREE.Object3D>,
    s = Math.sin(t * 9 + ph) * sp * .75;
  u.legL!.rotation.x = s;
  u.legR!.rotation.x = -s;
  u.armL!.rotation.x = -s;
  u.armR!.rotation.x = s;
  r.position.y = sp > .1 ? Math.abs(Math.sin(t * 9 + ph)) * .07 * sp : 0;
}

export const player = makeAvatar(DEFAULT_LOOK, 'You');
player.position.set(0, 0, 10);
const WAY = [[-13, -2], [13, -2], [0, -17], [0, 10], [-14, 12], [14, 12], [-6, 3], [6, 3], [0, -4], [-20, 2], [20, 2]] as const;
export const npcs = NPC_NAMES.map(n => {
  const a = makeAvatar(randLook(), n);
  const w = pick([...WAY]);
  a.position.set(w[0] + rnd(-2, 2), 0, w[1] + rnd(-2, 2));
  a.userData.npc = { name: n, tx: a.position.x, tz: a.position.z, wait: rnd(0, 3), bubble: null as THREE.Sprite | null, bt: 0 };
  return a;
});
export function say(a: THREE.Group, text: string) {
  const n = a.userData.npc as { bubble: THREE.Sprite | null; bt: number };
  if (n.bubble) {
    a.remove(n.bubble);
    (n.bubble.material as THREE.SpriteMaterial).dispose();
  }
  n.bubble = label(text, '#2ee6ff', 1.05);
  n.bubble.position.y = 3.6;
  a.add(n.bubble);
  n.bt = 3.2;
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
  if ((k === 'e' || k === 'enter') && nearStation && !nearStation.locked) {
    e.preventDefault();
    useStation();
  }
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const ptrs = new Map<number, { x: number; y: number }>();
let pinch0 = 1;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
  if (ptrs.size === 1) {
    cam.yaw -= dx * 0.006;
    cam.pitch = clamp(cam.pitch + dy * 0.005, 0.06, 1.5);
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
    cam.dist = clamp(cam.dist * (pinch0 / d), 6, 36);
    pinch0 = d;
  }
});
const endPtr = (e: PointerEvent) => ptrs.delete(e.pointerId);
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
const touchUI = matchMedia('(pointer:coarse)').matches;
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
export let customizing = false;
export const setCustomizing = (v: boolean) => {
  customizing = v;
};

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
  if (p.x > 100) {
    p.x = clamp(p.x, 132.8, 147.2);
    p.z = clamp(p.z, -7.2, 7.8);
  } else {
    const r = Math.hypot(p.x, p.z);
    if (r > 46) {
      p.x *= 46 / r;
      p.z *= 46 / r;
    }
  }
  const sp = Math.hypot(vel.x, vel.z);
  if (sp > 0.4) {
    let d = Math.atan2(vel.x, vel.z) - player.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    player.rotation.y += d * Math.min(1, dt * 12);
  }
  walkAnim(player, Math.min(1, sp / 4), clockT, 0);
}
function stepNpcs(dt: number) {
  for (const a of npcs) {
    const n = a.userData.npc as {
      tx: number;
      tz: number;
      wait: number;
      bubble: THREE.Sprite | null;
      bt: number;
    };
    if (n.bubble) {
      n.bt -= dt;
      if (n.bt <= 0) {
        a.remove(n.bubble);
        n.bubble.material.map?.dispose();
        n.bubble.material.dispose();
        n.bubble = null;
      }
    }
    const dx = n.tx - a.position.x,
      dz = n.tz - a.position.z,
      d = Math.hypot(dx, dz);
    if (d < 0.5) {
      walkAnim(a, 0, clockT, 0);
      n.wait -= dt;
      if (n.wait <= 0) {
        let w = pick([...WAY]),
          tx = w[0],
          tz = w[1];
        if (worldFx.crowd && Math.random() < 0.75) {
          const s = stations.find(s => s.id === worldFx.crowd)!;
          tx = s.x + rnd(-4, 4);
          tz = s.z + rnd(1, 5);
        }
        n.tx = tx + rnd(-1.5, 1.5);
        n.tz = tz + rnd(-1.5, 1.5);
        n.wait = rnd(1, 5);
      }
    } else {
      const sp = (worldFx.panic > 0 ? 5.5 : 2.6) * dt;
      a.position.x += (dx / d) * sp;
      a.position.z += (dz / d) * sp;
      a.rotation.y = Math.atan2(dx, dz);
      walkAnim(a, 1, clockT, a.userData.phase as number);
    }
  }
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
  stepNpcs(dt);
  worldFx.crowdT -= dt;
  if (worldFx.crowdT <= 0) worldFx.crowd = null;
  worldFx.panic = Math.max(0, worldFx.panic - dt);
  worldFx.shake = Math.max(0, worldFx.shake - dt * 1.2);
  worldFx.siren = Math.max(0, worldFx.siren - dt);
  for (const s of stations) {
    const k = 1 + Math.sin(clockT * 3 + s.x) * 0.06;
    s.ring!.scale.set(k, k, k);
    s.beam!.rotation.y += dt * 0.5;
  }
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
  for (const s of stations) {
    const d = Math.hypot(p.x - s.x, p.z - s.z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  nearStation = best;
  const b = $('#prompt') as HTMLButtonElement,
    show = !!best && !modalOpen() && !introOpen();
  const txt = best ? (best.locked ? `${best.name}: ${best.locked}` : `Use ${best.name}`) : '';
  if (b.hidden === show) b.hidden = !show;
  if (show && b.textContent !== txt) {
    b.textContent = txt;
    b.disabled = !!best!.locked;
  }
}

/* Home room geometry */
export const ROOMC = new THREE.Group();
scene.add(ROOMC);
{
  const fl = bx(16, .2, 16, lam(0x1a2140, .25), 140, -.1, 0);
  ROOMC.add(fl);
  ([[16, 3.2, .3, 140, 1.6, -8], [.3, 3.2, 16, 132, 1.6, 0], [.3, 3.2, 16, 148, 1.6, 0]] as const).forEach(w => {
    const m = bx(w[0], w[1], w[2], new THREE.MeshLambertMaterial({ color: 0x10172a, transparent: true, opacity: .85 }), w[3], w[4], w[5]);
    ROOMC.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0xffb12e }));
    e.position.copy(m.position);
    ROOMC.add(e);
  });
  const pl = new THREE.PointLight(0xffc890, 40, 40);
  pl.position.set(140, 5, 0);
  ROOMC.add(pl);
  const bench = bx(3, .5, .9, lam(0x4a3a2a, .15), 8, .35, 17.5),
    back = bx(3, .8, .15, lam(0x4a3a2a, .15), 8, .9, 17.95);
  scene.add(bench, back);
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
  if (!S.home.owned) return;
  if (!hasF('bed2')) furnG.add(bx(1.8, .4, 3, lam(0x3a4a7a, .25), 134, .4, -5), bx(1.6, .2, .8, lam(0xe9eefc, .3), 134, .7, -6.2));
  for (const f of FURN) if (hasF(f.id)) f.b(furnG);
}
export const comfort = () => 1 + S.home.items.reduce((a, id) => a + FURN.find(f => f.id === id)!.pts, 0);
export const maintenanceLeft = () => S.home.paidUntil - Date.now();
/** @deprecated Use maintenanceLeft */
export const rentLeft = maintenanceLeft;
export const overdue = () => S.home.owned && maintenanceLeft() < 0;
