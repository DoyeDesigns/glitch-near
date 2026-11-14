import type { Pose } from './world';
import type { Look } from './types';
import { me } from './session';
import { S } from './state';
import {
  applyPoseTo,
  buildLook,
  clockT,
  currentInterior,
  heldPose,
  makeAvatar,
  player,
  scene,
  walkAnim,
} from './world';
import { placeId } from './places';

export type RemotePlayer = {
  id: string;
  name: string;
  x: number;
  z: number;
  place: string;
  look: Look;
  pose: Pose | null;
};

export type PlaceMessage = { id: string; name: string; text: string; at: number };
export type SavedPose = { id: string; name: string; pose: Pose; updatedAt: number };
export type PosePost = {
  id: string;
  name: string;
  caption: string;
  pose: Pose;
  at: number;
  likes: number;
  liked: boolean;
};

export let placeMessages: PlaceMessage[] = [];
export let myPoses: SavedPose[] = [];
export let posePosts: PosePost[] = [];
export let noteCount = 0;

/** Latest presence snapshot (all places). Used for map / “N here” counts. */
export let presenceOthers: RemotePlayer[] = [];

const REMOTE_WALK_SPD = 4.2;
const REMOTE_SNAP_DIST = 28;

type AvatarSlot = { lookKey: string; phase: number; moving: boolean };
const avatars = new Map<string, AvatarSlot>();

export function currentPlace(): string {
  return placeId(currentInterior, player.position.x, player.position.z);
}

export function peopleAtPlace(place: string): RemotePlayer[] {
  return presenceOthers.filter(o => o.place === place);
}

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

let beat = 0;
let noteBeat = 0;
export function tickLive(dt: number) {
  stepRemotes(dt);
  if (!me) return;
  beat += dt;
  noteBeat += dt;
  if (beat >= 1) {
    beat = 0;
    void heartbeat();
  }
  if (noteBeat >= 4) {
    noteBeat = 0;
    void loadNotes();
  }
}

async function heartbeat() {
  const data = await api<{ others: RemotePlayer[] }>('/presence', {
    method: 'POST',
    body: JSON.stringify({
      x: player.position.x,
      z: player.position.z,
      place: currentPlace(),
      look: S.look,
      pose: heldPose,
    }),
  });
  if (!data) return;
  presenceOthers = data.others;
  syncAvatars(data.others);
}

function syncAvatars(others: RemotePlayer[]) {
  const place = currentPlace();
  const keep = new Set<string>();
  for (const o of others) {
    if (o.place !== place) continue;
    keep.add(o.id);
    let g = scene.getObjectByName(`live-${o.id}`) as import('three').Group | undefined;
    const lookKey = JSON.stringify(o.look);
    let slot = avatars.get(o.id);
    if (!g) {
      g = makeAvatar(o.look, o.name, scene);
      g.name = `live-${o.id}`;
      g.position.set(o.x, 0, o.z);
      slot = { lookKey, phase: Math.random() * 6, moving: false };
      avatars.set(o.id, slot);
    } else if (slot && slot.lookKey !== lookKey) {
      buildLook(g, o.look);
      slot.lookKey = lookKey;
    }
    if (!slot) {
      slot = { lookKey, phase: Math.random() * 6, moving: false };
      avatars.set(o.id, slot);
    }
    g.userData.tx = o.x;
    g.userData.tz = o.z;
    g.userData.rpose = o.pose;
    g.visible = true;
  }
  for (const [id, slot] of [...avatars]) {
    if (keep.has(id)) continue;
    const g = scene.getObjectByName(`live-${id}`);
    if (g) scene.remove(g);
    avatars.delete(id);
    void slot;
  }
}

function stepRemotes(dt: number) {
  for (const [id, slot] of avatars) {
    const g = scene.getObjectByName(`live-${id}`) as import('three').Group | undefined;
    if (!g) continue;
    const tx = g.userData.tx as number;
    const tz = g.userData.tz as number;
    const dx = tx - g.position.x;
    const dz = tz - g.position.z;
    const dist = Math.hypot(dx, dz);
    const pose = g.userData.rpose as Pose | null;

    if (dist > REMOTE_SNAP_DIST) {
      g.position.x = tx;
      g.position.z = tz;
      slot.moving = false;
      if (pose) applyPoseTo(g, pose, 0);
      else walkAnim(g, 0, clockT, slot.phase);
      continue;
    }

    if (dist > 0.06) {
      const step = Math.min(dist, REMOTE_WALK_SPD * dt);
      g.position.x += (dx / dist) * step;
      g.position.z += (dz / dist) * step;
      let yawErr = Math.atan2(dx, dz) - g.rotation.y;
      yawErr = Math.atan2(Math.sin(yawErr), Math.cos(yawErr));
      g.rotation.y += yawErr * Math.min(1, dt * 10);
      slot.moving = true;
      // Walk cycle while chasing the last presence sample (not a slide).
      walkAnim(g, 0.9, clockT, slot.phase);
      continue;
    }

    g.position.x = tx;
    g.position.z = tz;
    slot.moving = false;
    if (pose) applyPoseTo(g, pose, 0);
    else walkAnim(g, 0, clockT, slot.phase);
  }
}

export async function loadPlaceChat() {
  const data = await api<{ messages: PlaceMessage[] }>(`/chat?place=${encodeURIComponent(currentPlace())}`);
  if (data) placeMessages = data.messages;
  return placeMessages;
}

export async function sendPlaceChat(text: string) {
  const data = await api<{ messages: PlaceMessage[] }>('/chat', {
    method: 'POST',
    body: JSON.stringify({ place: currentPlace(), text }),
  });
  if (data) placeMessages = data.messages;
  return data != null;
}

export async function loadPoses() {
  const data = await api<{ poses: SavedPose[] }>('/poses');
  if (data) myPoses = data.poses;
  return myPoses;
}

export async function saveServerPose(id: string | null, name: string, pose: Pose) {
  const data = await api<SavedPose>(id ? `/poses/${id}` : '/poses', {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify({ name, pose }),
  });
  if (data) await loadPoses();
  return data;
}

export async function deleteServerPose(id: string) {
  const data = await api<{ ok: boolean }>(`/poses/${id}`, { method: 'DELETE' });
  if (data) await loadPoses();
  return data != null;
}

export async function loadPoseFeed() {
  const data = await api<{ posts: PosePost[] }>('/pose-feed');
  if (data) posePosts = data.posts;
  return posePosts;
}

export async function publishPose(poseId: string, caption: string) {
  const data = await api<PosePost>('/pose-posts', {
    method: 'POST',
    body: JSON.stringify({ poseId, caption }),
  });
  if (data) await loadPoseFeed();
  return data != null;
}

export async function likePose(id: string) {
  const data = await api<{ likes: number; liked: boolean }>(`/pose-posts/${id}/like`, { method: 'POST' });
  if (data) {
    const post = posePosts.find(p => p.id === id);
    if (post) {
      post.likes = data.likes;
      post.liked = !!data.liked;
    }
  }
  return data != null;
}

export async function loadNotes() {
  const data = await api<{ count: number }>('/notifications');
  if (data) noteCount = data.count;
  return noteCount;
}

export async function markNotesRead() {
  const data = await api<{ count: number }>('/notifications/read', { method: 'POST' });
  if (data) noteCount = data.count;
}
