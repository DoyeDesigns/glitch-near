import { AuthError } from './auth';
import { randomId } from './crypto';
import { db } from './db';
import type { PlayerRow } from './near/accounts';

const FRESH_MS = 15_000;
const MAX_POSES = 24;
const CHAT_GAP_MS = 1_500;
const POST_GAP_MS = 5_000;

export type LimbRot = { x: number; y: number; z: number };
export type PoseJson = {
  armL: LimbRot;
  armR: LimbRot;
  legL: LimbRot;
  legR: LimbRot;
  elbowL: number;
  elbowR: number;
  kneeL: number;
  kneeR: number;
};

export type LookJson = {
  skin: number;
  hair: number;
  hairC: number;
  top: number;
  bot: number;
  glasses: boolean;
  glassC: number;
  gear: number;
  capDir: number;
};

function num(v: unknown, absMax: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > absMax) return null;
  return v;
}

function limb(v: unknown): LimbRot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const x = num(o.x, 8);
  const y = num(o.y, 8);
  const z = num(o.z, 8);
  if (x == null || y == null || z == null) return null;
  return { x, y, z };
}

export function parsePose(v: unknown): PoseJson | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const armL = limb(o.armL);
  const armR = limb(o.armR);
  const legL = limb(o.legL);
  const legR = limb(o.legR);
  const elbowL = num(o.elbowL, 8);
  const elbowR = num(o.elbowR, 8);
  const kneeL = num(o.kneeL, 8);
  const kneeR = num(o.kneeR, 8);
  if (!armL || !armR || !legL || !legR || elbowL == null || elbowR == null || kneeL == null || kneeR == null) return null;
  return { armL, armR, legL, legR, elbowL, elbowR, kneeL, kneeR };
}

export function parseLook(v: unknown): LookJson | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const skin = num(o.skin, 20);
  const hair = num(o.hair, 20);
  const hairC = num(o.hairC, 20);
  const top = num(o.top, 20);
  const bot = num(o.bot, 20);
  const glassC = num(o.glassC, 20);
  const gear = num(o.gear, 20);
  const capDir = num(o.capDir, 8);
  if ([skin, hair, hairC, top, bot, glassC, gear, capDir].some(n => n == null || !Number.isInteger(n) || n < 0)) return null;
  if (typeof o.glasses !== 'boolean') return null;
  return {
    skin: skin!,
    hair: hair!,
    hairC: hairC!,
    top: top!,
    bot: bot!,
    glasses: o.glasses,
    glassC: glassC!,
    gear: gear!,
    capDir: capDir!,
  };
}

function placeOf(v: unknown): string {
  if (typeof v !== 'string') return 'plaza';
  const s = v.trim().slice(0, 32);
  if (!/^[a-z0-9_-]+$/i.test(s)) return 'plaza';
  return s;
}

function tooSoon(playerId: string, kind: string, gap: number): boolean {
  const row = db
    .prepare(`SELECT until_ts FROM cooldowns WHERE player_id = ? AND kind = ?`)
    .get(playerId, kind) as { until_ts: number } | undefined;
  return !!row && row.until_ts > Date.now();
}

function markCooldown(playerId: string, kind: string, gap: number) {
  db.prepare(
    `INSERT INTO cooldowns (player_id, kind, until_ts) VALUES (?, ?, ?)
     ON CONFLICT(player_id, kind) DO UPDATE SET until_ts = excluded.until_ts`,
  ).run(playerId, kind, Date.now() + gap);
}

function notify(playerId: string, kind: 'chat' | 'like', text: string) {
  db.prepare(
    `INSERT INTO notifications (id, player_id, kind, text, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(randomId(), playerId, kind, text.slice(0, 160), Date.now());
}

export function heartbeat(
  player: PlayerRow,
  body: { x?: unknown; z?: unknown; place?: unknown; look?: unknown; pose?: unknown },
) {
  const x = num(body.x, 5000);
  const z = num(body.z, 5000);
  if (x == null || z == null) throw new AuthError('Bad position', 400);
  const look = parseLook(body.look);
  if (!look) throw new AuthError('Bad look', 400);
  const pose = body.pose == null ? null : parsePose(body.pose);
  if (body.pose != null && !pose) throw new AuthError('Bad pose', 400);
  const place = placeOf(body.place);
  const now = Date.now();
  db.prepare(
    `INSERT INTO presence (player_id, x, z, place, look_json, pose_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       x = excluded.x, z = excluded.z, place = excluded.place,
       look_json = excluded.look_json, pose_json = excluded.pose_json, updated_at = excluded.updated_at`,
  ).run(player.id, x, z, place, JSON.stringify(look), pose ? JSON.stringify(pose) : null, now);
  return listPresence(player.id);
}

export function listPresence(exceptId: string) {
  const since = Date.now() - FRESH_MS;
  const rows = db
    .prepare(
      `SELECT p.player_id, pl.name, p.x, p.z, p.place, p.look_json, p.pose_json, p.updated_at
       FROM presence p JOIN players pl ON pl.id = p.player_id
       WHERE p.updated_at > ? AND p.player_id != ? AND pl.status = 'active'`,
    )
    .all(since, exceptId) as {
    player_id: string;
    name: string;
    x: number;
    z: number;
    place: string;
    look_json: string;
    pose_json: string | null;
  }[];
  return rows.map(r => ({
    id: r.player_id,
    name: r.name,
    x: r.x,
    z: r.z,
    place: r.place,
    look: JSON.parse(r.look_json) as LookJson,
    pose: r.pose_json ? (JSON.parse(r.pose_json) as PoseJson) : null,
  }));
}

export function listChat(placeRaw: unknown) {
  const place = placeOf(placeRaw);
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.created_at, pl.name
       FROM place_chat c JOIN players pl ON pl.id = c.player_id
       WHERE c.place = ? ORDER BY c.created_at DESC LIMIT 40`,
    )
    .all(place) as { id: string; text: string; created_at: number; name: string }[];
  return { place, messages: rows.reverse().map(r => ({ id: r.id, name: r.name, text: r.text, at: r.created_at })) };
}

export function postChat(player: PlayerRow, body: { place?: unknown; text?: unknown }) {
  if (tooSoon(player.id, 'place_chat', CHAT_GAP_MS)) throw new AuthError('Slow down', 429);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 160) throw new AuthError('Bad message', 400);
  const place = placeOf(body.place);
  const now = Date.now();
  db.prepare(`INSERT INTO place_chat (id, place, player_id, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    randomId(),
    place,
    player.id,
    text,
    now,
  );
  markCooldown(player.id, 'place_chat', CHAT_GAP_MS);
  const since = now - FRESH_MS;
  const others = db
    .prepare(`SELECT player_id FROM presence WHERE place = ? AND player_id != ? AND updated_at > ?`)
    .all(place, player.id, since) as { player_id: string }[];
  for (const o of others) notify(o.player_id, 'chat', `${player.name}: ${text}`);
  return listChat(place);
}

export function listPoses(playerId: string) {
  const rows = db
    .prepare(`SELECT id, name, pose_json, updated_at FROM poses WHERE player_id = ? ORDER BY updated_at DESC`)
    .all(playerId) as { id: string; name: string; pose_json: string; updated_at: number }[];
  return rows.map(r => ({ id: r.id, name: r.name, pose: JSON.parse(r.pose_json) as PoseJson, updatedAt: r.updated_at }));
}

export function createPose(player: PlayerRow, body: { name?: unknown; pose?: unknown }) {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM poses WHERE player_id = ?`).get(player.id) as { n: number };
  if (count.n >= MAX_POSES) throw new AuthError('Pose limit reached', 400);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  if (!name) throw new AuthError('Name the pose', 400);
  const pose = parsePose(body.pose);
  if (!pose) throw new AuthError('Bad pose', 400);
  const id = randomId();
  const now = Date.now();
  db.prepare(`INSERT INTO poses (id, player_id, name, pose_json, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    player.id,
    name,
    JSON.stringify(pose),
    now,
  );
  return { id, name, pose, updatedAt: now };
}

export function updatePose(player: PlayerRow, id: string, body: { name?: unknown; pose?: unknown }) {
  const row = db.prepare(`SELECT id FROM poses WHERE id = ? AND player_id = ?`).get(id, player.id) as
    | { id: string }
    | undefined;
  if (!row) throw new AuthError('Pose not found', 404);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  const pose = parsePose(body.pose);
  if (!name || !pose) throw new AuthError('Bad pose', 400);
  const now = Date.now();
  db.prepare(`UPDATE poses SET name = ?, pose_json = ?, updated_at = ? WHERE id = ?`).run(name, JSON.stringify(pose), now, id);
  return { id, name, pose, updatedAt: now };
}

export function deletePose(player: PlayerRow, id: string) {
  const info = db.prepare(`DELETE FROM poses WHERE id = ? AND player_id = ?`).run(id, player.id);
  if (!info.changes) throw new AuthError('Pose not found', 404);
  return { ok: true };
}

export function poseFeed(viewerId: string) {
  const rows = db
    .prepare(
      `SELECT p.id, p.caption, p.pose_json, p.created_at, pl.name,
              (SELECT COUNT(*) FROM pose_likes l WHERE l.post_id = p.id) AS likes,
              (SELECT COUNT(*) FROM pose_likes l WHERE l.post_id = p.id AND l.player_id = ?) AS mine
       FROM pose_posts p JOIN players pl ON pl.id = p.player_id
       ORDER BY p.created_at DESC LIMIT 40`,
    )
    .all(viewerId) as {
    id: string;
    caption: string;
    pose_json: string;
    created_at: number;
    name: string;
    likes: number;
    mine: number;
  }[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    caption: r.caption,
    pose: JSON.parse(r.pose_json) as PoseJson,
    at: r.created_at,
    likes: r.likes,
    liked: r.mine > 0,
  }));
}

export function createPosePost(player: PlayerRow, body: { poseId?: unknown; caption?: unknown; pose?: unknown }) {
  if (tooSoon(player.id, 'pose_post', POST_GAP_MS)) throw new AuthError('Slow down', 429);
  const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 140) : '';
  let pose = parsePose(body.pose);
  if (typeof body.poseId === 'string') {
    const row = db.prepare(`SELECT pose_json FROM poses WHERE id = ? AND player_id = ?`).get(body.poseId, player.id) as
      | { pose_json: string }
      | undefined;
    if (!row) throw new AuthError('Pose not found', 404);
    pose = JSON.parse(row.pose_json) as PoseJson;
  }
  if (!pose) throw new AuthError('Pick a pose', 400);
  const id = randomId();
  const now = Date.now();
  db.prepare(`INSERT INTO pose_posts (id, player_id, pose_json, caption, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    player.id,
    JSON.stringify(pose),
    caption,
    now,
  );
  markCooldown(player.id, 'pose_post', POST_GAP_MS);
  return { id, name: player.name, caption, pose, at: now, likes: 0, liked: false };
}

export function likePosePost(player: PlayerRow, postId: string) {
  const post = db.prepare(`SELECT player_id, caption FROM pose_posts WHERE id = ?`).get(postId) as
    | { player_id: string; caption: string }
    | undefined;
  if (!post) throw new AuthError('Post not found', 404);
  const ins = db
    .prepare(`INSERT OR IGNORE INTO pose_likes (post_id, player_id, created_at) VALUES (?, ?, ?)`)
    .run(postId, player.id, Date.now());
  if (ins.changes && post.player_id !== player.id) {
    notify(post.player_id, 'like', `${player.name} liked your pose`);
  }
  const likes = db.prepare(`SELECT COUNT(*) AS n FROM pose_likes WHERE post_id = ?`).get(postId) as { n: number };
  return { id: postId, likes: likes.n, liked: true };
}

export function notificationsFor(playerId: string) {
  const unread = db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE player_id = ? AND read_at IS NULL`)
    .get(playerId) as { n: number };
  const rows = db
    .prepare(
      `SELECT id, kind, text, created_at FROM notifications
       WHERE player_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 20`,
    )
    .all(playerId) as { id: string; kind: string; text: string; created_at: number }[];
  return {
    count: unread.n,
    items: rows.map(r => ({ id: r.id, kind: r.kind, text: r.text, at: r.created_at })),
  };
}

export function markNotificationsRead(playerId: string) {
  db.prepare(`UPDATE notifications SET read_at = ? WHERE player_id = ? AND read_at IS NULL`).run(Date.now(), playerId);
  return { count: 0 };
}
