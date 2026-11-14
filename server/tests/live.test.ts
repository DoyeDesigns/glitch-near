import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db';
import {
  createPose,
  createPosePost,
  heartbeat,
  likePosePost,
  listPresence,
  notificationsFor,
  parsePose,
  postChat,
} from '../src/live';
import type { PlayerRow } from '../src/near/accounts';

const ids = ['live-a', 'live-b'];

function player(id: string, name: string): PlayerRow {
  return { id, name } as PlayerRow;
}

const look = {
  skin: 1,
  hair: 0,
  hairC: 0,
  top: 2,
  bot: 1,
  glasses: false,
  glassC: 0,
  gear: 0,
  capDir: 0,
};

const pose = {
  armL: { x: 1, y: 0, z: 0.2 },
  armR: { x: 1, y: 0, z: -0.2 },
  legL: { x: 0, y: 0, z: 0 },
  legR: { x: 0, y: 0, z: 0 },
  elbowL: 0.4,
  elbowR: 0.4,
  kneeL: 0,
  kneeR: 0,
};

describe('live city', () => {
  afterAll(() => {
    for (const id of ids) {
      db.prepare(`DELETE FROM notifications WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM pose_likes WHERE player_id = ? OR post_id IN (SELECT id FROM pose_posts WHERE player_id = ?)`).run(id, id);
      db.prepare(`DELETE FROM pose_posts WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM poses WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM place_chat WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM presence WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM cooldowns WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM players WHERE id = ?`).run(id);
    }
  });

  it('rejects a broken pose and keeps a valid one', () => {
    expect(parsePose({ armL: { x: 1 } })).toBeNull();
    expect(parsePose(pose)?.elbowL).toBe(0.4);
  });

  it('shows the other player, chats, and notifies likes', () => {
    const now = Date.now();
    for (const id of ids) {
      db.prepare(`DELETE FROM players WHERE id = ?`).run(id);
      db.prepare(`INSERT INTO players (id, name, account_id, status, created_at) VALUES (?, ?, ?, 'active', ?)`).run(
        id,
        id === 'live-a' ? 'ada' : 'bea',
        `${id}.test`,
        now,
      );
    }
    const a = player('live-a', 'ada');
    const b = player('live-b', 'bea');
    heartbeat(a, { x: 1, z: 2, place: 'diner', look, pose });
    heartbeat(b, { x: 4, z: 5, place: 'diner', look, pose: null });
    const seen = listPresence(a.id);
    expect(seen.map(p => p.name)).toEqual(['bea']);
    expect(seen[0]?.place).toBe('diner');
    expect(seen[0]?.pose).toBeNull();

    const thread = postChat(a, { place: 'diner', text: 'suya?' });
    expect(thread.messages.at(-1)?.text).toBe('suya?');
    const notes = notificationsFor(b.id);
    expect(notes.count).toBe(1);
    expect(notes.items[0]?.kind).toBe('chat');

    const saved = createPose(a, { name: 'Victory', pose });
    const post = createPosePost(a, { poseId: saved.id, caption: 'hold this' });
    likePosePost(b, post.id);
    const likes = notificationsFor(a.id);
    expect(likes.items.some(n => n.kind === 'like')).toBe(true);
    expect(() => postChat(a, { place: 'diner', text: 'again' })).toThrow(/Slow down/);
  });
});
