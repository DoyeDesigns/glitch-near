import type { LimbRot, Pose } from './world';

/**
 * Front-view silhouette tip. Pose `x` is face-forward positive (same as presets).
 * −sin(z) sends left-arm +z outward (T-pose).
 */
function tip(len: number, r: LimbRot): { x: number; y: number } {
  const x = -Math.sin(r.z) * len + Math.sin(r.y) * len * 0.28;
  const y = Math.cos(r.x) * Math.cos(r.z) * len;
  return { x, y };
}

function limbPath(
  px: number,
  py: number,
  len: number,
  thick: number,
  r: LimbRot,
): string {
  const t = tip(len, r);
  const ex = px + t.x;
  const ey = py + t.y;
  const dx = ex - px;
  const dy = ey - py;
  const d = Math.hypot(dx, dy) || 1;
  const nx = (-dy / d) * (thick / 2);
  const ny = (dx / d) * (thick / 2);
  return `M${px + nx} ${py + ny} L${ex + nx} ${ey + ny} L${ex - nx} ${ey - ny} L${px - nx} ${py - ny} Z`;
}

export function poseSvgMarkup(
  pose: Pose,
  opts?: { size?: number; className?: string; accent?: string },
): string {
  const size = opts?.size ?? 72;
  const cls = opts?.className ? ` class="${opts.className}"` : '';
  const fill = opts?.accent ?? 'currentColor';
  // Body layout in viewBox 0..100 (y down).
  const hx = 50;
  const hy = 18;
  const torsoTop = 28;
  const torsoBot = 52;
  const armPy = 32;
  const armLen = 22;
  const legPy = 52;
  const legLen = 26;
  const armL = limbPath(40, armPy, armLen, 5.5, pose.armL);
  const armR = limbPath(60, armPy, armLen, 5.5, pose.armR);
  const legL = limbPath(44, legPy, legLen, 6.5, pose.legL);
  const legR = limbPath(56, legPy, legLen, 6.5, pose.legR);
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <rect x="38" y="${torsoTop}" width="24" height="${torsoBot - torsoTop}" rx="3" fill="${fill}" opacity=".92"/>
  <circle cx="${hx}" cy="${hy}" r="10" fill="${fill}"/>
  <path d="${armL}" fill="${fill}" opacity=".88"/>
  <path d="${armR}" fill="${fill}" opacity=".88"/>
  <path d="${legL}" fill="${fill}" opacity=".88"/>
  <path d="${legR}" fill="${fill}" opacity=".88"/>
</svg>`;
}

export const NEUTRAL_POSE: Pose = {
  armL: { x: 0, y: 0, z: 0 },
  armR: { x: 0, y: 0, z: 0 },
  legL: { x: 0, y: 0, z: 0 },
  legR: { x: 0, y: 0, z: 0 },
};
