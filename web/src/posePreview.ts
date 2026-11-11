import { emptyPose, type LimbRot, type Pose } from './world';

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

/**
 * Two-bone limb: root rotation then bend.
 * Elbow bend curls toward face (reduces down-component); knee curls back (same SVG cue via +bend).
 */
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
  // Continue from upper tip: bend rotates the lower segment in the plane of the upper.
  const ang = Math.atan2(u.x, u.y);
  const b = kneeStyle ? bend : -bend;
  const a2 = ang + b;
  const lx = mx + Math.sin(a2) * lowerLen;
  const ly = my + Math.cos(a2) * lowerLen;
  return `${segPath(px, py, mx, my, thick)}${segPath(mx, my, lx, ly, thick * 0.88)}`;
}

export function poseSvgMarkup(
  pose: Pose,
  opts?: { size?: number; className?: string; accent?: string },
): string {
  const size = opts?.size ?? 72;
  const cls = opts?.className ? ` class="${opts.className}"` : '';
  const fill = opts?.accent ?? 'currentColor';
  const hx = 50;
  const hy = 18;
  const torsoTop = 28;
  const torsoBot = 52;
  const armPy = 32;
  const legPy = 52;
  const armL = jointedLimb(40, armPy, 12, 11, 5.2, pose.armL, pose.elbowL, false);
  const armR = jointedLimb(60, armPy, 12, 11, 5.2, pose.armR, pose.elbowR, false);
  const legL = jointedLimb(44, legPy, 14, 13, 6.2, pose.legL, pose.kneeL, true);
  const legR = jointedLimb(56, legPy, 14, 13, 6.2, pose.legR, pose.kneeR, true);
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <rect x="38" y="${torsoTop}" width="24" height="${torsoBot - torsoTop}" rx="3" fill="${fill}" opacity=".92"/>
  <circle cx="${hx}" cy="${hy}" r="10" fill="${fill}"/>
  <path d="${armL}" fill="${fill}" opacity=".88"/>
  <path d="${armR}" fill="${fill}" opacity=".88"/>
  <path d="${legL}" fill="${fill}" opacity=".88"/>
  <path d="${legR}" fill="${fill}" opacity=".88"/>
</svg>`;
}

export const NEUTRAL_POSE: Pose = emptyPose();
