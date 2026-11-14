import { BOTC, HAIRC, HAIRS, SKINS, TOPC, emptyPose, type LimbRot, type Pose } from './world';
import type { Look } from './types';

/**
 * Front-view tip offset. Pose `x` is face-forward positive; `z` spreads
 * (−sin(z) sends left-arm +z outward for T-pose).
 */
function tip(len: number, r: LimbRot): { x: number; y: number } {
  const x = -Math.sin(r.z) * len + Math.sin(r.y) * len * 0.28;
  const y = Math.cos(r.x) * Math.cos(r.z) * len;
  return { x, y };
}

/** Segment polygon from pivot → tip. */
function segPath(px: number, py: number, ex: number, ey: number, thick: number): string {
  const dx = ex - px;
  const dy = ey - py;
  const d = Math.hypot(dx, dy) || 1;
  const nx = (-dy / d) * (thick / 2);
  const ny = (dx / d) * (thick / 2);
  return `M${px + nx} ${py + ny} L${ex + nx} ${ey + ny} L${ex - nx} ${ey - ny} L${px - nx} ${py - ny} Z`;
}

/** Two-bone limb: root rotation then bend. */
function jointedLimb(
  px: number,
  py: number,
  upperLen: number,
  lowerLen: number,
  thick: number,
  root: LimbRot,
  bend: number,
  kneeStyle: boolean,
): string {
  const u = tip(upperLen, root);
  const mx = px + u.x;
  const my = py + u.y;
  const ang = Math.atan2(u.x, u.y);
  const b = kneeStyle ? bend : -bend;
  const a2 = ang + b;
  const lx = mx + Math.sin(a2) * lowerLen;
  const ly = my + Math.cos(a2) * lowerLen;
  return `${segPath(px, py, mx, my, thick)}${segPath(mx, my, lx, ly, thick * 0.88)}`;
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function lookColors(look?: Look): {
  skin: string;
  top: string;
  bot: string;
  hair: string;
  glass: string;
  hairStyle: number;
  glasses: boolean;
  gear: number;
} {
  const skin = SKINS[look?.skin ?? 3] ?? SKINS[3]!;
  const top = TOPC[look?.top ?? 0] ?? TOPC[0]!;
  const bot = BOTC[look?.bot ?? 0] ?? BOTC[0]!;
  const hair = HAIRC[look?.hairC ?? 0] ?? HAIRC[0]!;
  const glass = [0x2ee6ff, 0xff3d9a, 0xb8ff3d, 0xffb12e][look?.glassC ?? 0] ?? 0x2ee6ff;
  return {
    skin: hex(skin),
    top: hex(top),
    bot: hex(bot),
    hair: hex(hair),
    glass: hex(glass),
    hairStyle: look?.hair ?? 0,
    glasses: !!look?.glasses,
    gear: look?.gear ?? 0,
  };
}

function hairMarkup(hx: number, hy: number, style: number, fill: string): string {
  // 0 Short, 1 Afro, 2 Braids, 3 Bald — matches HAIRS in world.ts
  if (style === 3 || style >= HAIRS.length) return '';
  if (style === 1) {
    return `<circle cx="${hx}" cy="${hy - 2}" r="14" fill="${fill}"/>`;
  }
  if (style === 2) {
    return `<circle cx="${hx - 8}" cy="${hy + 2}" r="4.5" fill="${fill}"/><circle cx="${hx + 8}" cy="${hy + 2}" r="4.5" fill="${fill}"/><path d="M${hx - 10} ${hy - 2} Q${hx} ${hy - 14} ${hx + 10} ${hy - 2}" fill="${fill}"/>`;
  }
  return `<path d="M${hx - 11} ${hy - 2} Q${hx} ${hy - 16} ${hx + 11} ${hy - 2} L${hx + 9} ${hy + 2} Q${hx} ${hy - 6} ${hx - 9} ${hy + 2} Z" fill="${fill}"/>`;
}

export function poseSvgMarkup(
  pose: Pose,
  opts?: { size?: number; className?: string; accent?: string; look?: Look },
): string {
  const size = opts?.size ?? 72;
  const cls = opts?.className ? ` class="${opts.className}"` : '';
  const c = lookColors(opts?.look);
  const fill = opts?.accent ?? c.skin;
  const useLook = !!opts?.look;
  const skin = useLook ? c.skin : fill;
  const top = useLook ? c.top : fill;
  const bot = useLook ? c.bot : fill;
  const hx = 50;
  const hy = 18;
  const torsoTop = 28;
  const torsoBot = 52;
  const armL = jointedLimb(40, 32, 12, 11, 5.2, pose.armL, pose.elbowL, false);
  const armR = jointedLimb(60, 32, 12, 11, 5.2, pose.armR, pose.elbowR, false);
  const legL = jointedLimb(44, 52, 14, 13, 6.2, pose.legL, pose.kneeL, true);
  const legR = jointedLimb(56, 52, 14, 13, 6.2, pose.legR, pose.kneeR, true);
  const glasses = useLook && c.glasses
    ? `<g fill="none" stroke="${c.glass}" stroke-width="1.6"><circle cx="${hx - 4.5}" cy="${hy + 1}" r="3.2"/><circle cx="${hx + 4.5}" cy="${hy + 1}" r="3.2"/><path d="M${hx - 1.2} ${hy + 1} H${hx + 1.2}"/></g>`
    : '';
  const gear =
    useLook && c.gear > 0
      ? `<circle cx="78" cy="22" r="7" fill="#0a1424" stroke="#2ee6ff" stroke-width="1.2"/><text x="78" y="25" text-anchor="middle" font-size="8" fill="#2ee6ff" font-family="monospace">G</text>`
      : '';
  const hair = useLook ? hairMarkup(hx, hy, c.hairStyle, c.hair) : '';
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <rect x="38" y="${torsoTop}" width="24" height="${torsoBot - torsoTop}" rx="3" fill="${top}" opacity=".95"/>
  ${hair}
  <circle cx="${hx}" cy="${hy}" r="10" fill="${skin}"/>
  ${glasses}
  <path d="${armL}" fill="${skin}" opacity=".9"/>
  <path d="${armR}" fill="${skin}" opacity=".9"/>
  <path d="${legL}" fill="${bot}" opacity=".92"/>
  <path d="${legR}" fill="${bot}" opacity=".92"/>
  ${gear}
</svg>`;
}

export const NEUTRAL_POSE: Pose = emptyPose();
