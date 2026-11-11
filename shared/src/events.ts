import {
  decayPressures,
  drawSeverity,
  EVENT_CHECK_S,
  EVENT_COOLDOWN_S,
  rollArchetype,
  rumorForArchetype,
  RUMOR_LEAD_S,
} from './events.rules';
import { clamp, pick, rnd } from './rng';
import type { Case, EventDef, FeedPost, World } from './types';

export const NPC_NAMES = [
  'NgozGM',
  '0xSade',
  'Tola_Bags',
  'MikkyRug',
  'BisiFloor',
  'ChukaAudit',
  'ZainabHODL',
  'DapoShill',
  'KemiBuilder',
  'Amaka_LP',
  'OluwaAlpha',
] as const;

export function pushFeed(world: World, kind: string, who: string, text: string): FeedPost {
  const post: FeedPost = {
    kind,
    who,
    text,
    t: world.time,
    likes: Math.floor(rnd(world.rng, 0, 30)),
  };
  world.feed.unshift(post);
  if (world.feed.length > 60) world.feed.pop();
  return post;
}

export function openCase(world: World, title: string, suspect: string | null, extra?: Partial<Case>): Case {
  world.caseNo++;
  const c: Case = Object.assign(
    { no: world.caseNo, title, suspect, at: world.time + rnd(world.rng, 22, 36) },
    extra,
  );
  world.cases.push(c);
  pushFeed(world, 'sys', 'CIA', `Case #${world.caseNo} opened: ${title}. Investigators are on it.`);
  return c;
}

export function resolveCases(world: World): void {
  for (const c of [...world.cases]) {
    if (world.time < c.at) continue;
    world.cases.splice(world.cases.indexOf(c), 1);
    if (c.suspect === 'player') {
      // Host applies pending burns / banners from these effects (playerId for custodial charge).
      if (c.caught) {
        world.effects.push({
          kind: 'playerCaught',
          caseNo: c.no,
          loot: c.loot ?? 0,
          playerId: c.playerId,
        });
      } else world.effects.push({ kind: 'playerEscaped', caseNo: c.no });
    } else if (world.rng.next() < 0.65) {
      const name = pick(world.rng, NPC_NAMES);
      pushFeed(world, 'sys', 'CIA', `Case #${c.no} closed: ${name} found guilty. Victims refunded with interest.`);
      world.market.heat = clamp(world.market.heat - 0.05, 0, 1);
    } else {
      pushFeed(world, 'sys', 'CIA', `Case #${c.no} closed: not enough evidence. Dismissed.`);
    }
  }
}

const memes = (world: World) => world.tokens.filter(t => t.sym !== 'BTX');

export const EVENTS: EventDef[] = [
  {
    w: 3,
    run(world) {
      const t = pick(world.rng, memes(world));
      t.hype = clamp(t.hype + 0.4, 0, 1);
      t.flow += 0.7;
      world.market.mood = clamp(world.market.mood + 0.15, -1, 1);
      world.effects.push({ kind: 'crowd', zone: 'trade', secs: 25 });
      world.effects.push({ kind: 'banner', text: `${t.sym} is pumping`, tone: 'good' });
      pushFeed(world, 'sys', 'NEWS', `${t.sym} (${t.name}) is trending. Timelines are screaming "send it".`);
    },
  },
  {
    w: 2,
    run(world) {
      const t = world.tokens[3]!;
      t.trust = clamp(t.trust - 0.5, 0, 1);
      t.hype = clamp(t.hype - 0.3, 0, 1);
      t.flow -= 1.4;
      t.price *= 0.7;
      world.market.mood = clamp(world.market.mood - 0.25, -1, 1);
      world.market.heat = clamp(world.market.heat + 0.12, 0, 1);
      world.effects.push({ kind: 'panic', panic: 8, siren: 6 });
      world.effects.push({ kind: 'crowd', zone: 'comm', secs: 20 });
      world.effects.push({ kind: 'banner', text: `RUG: ${t.sym} liquidity pulled`, tone: 'bad' });
      pushFeed(world, 'sys', 'NEWS', `${t.sym} dev wallet drained the pool. ${t.name} holders are not okay.`);
      openCase(world, `${t.sym} rug pull`, null);
    },
  },
  {
    w: 2,
    run(world) {
      const t = pick(world.rng, [world.tokens[1]!, world.tokens[4]!]);
      t.trust = clamp(t.trust - 0.4, 0, 1);
      t.price *= 0.82;
      t.flow -= 0.9;
      world.market.mood = clamp(world.market.mood - 0.3, -1, 1);
      world.market.heat = clamp(world.market.heat + 0.1, 0, 1);
      world.effects.push({ kind: 'panic', panic: 8, siren: 7 });
      world.effects.push({ kind: 'glitch' });
      world.effects.push({ kind: 'banner', text: `HACK: ${t.sym} contract exploited`, tone: 'bad' });
      pushFeed(world, 'sys', 'NEWS', `${t.name} contract exploited. Contagion fears spread across the city.`);
      openCase(world, `${t.sym} exploit`, null);
    },
  },
  {
    w: 2,
    run(world) {
      const t = pick(world.rng, world.tokens);
      const up = world.rng.next() < 0.5;
      t.flow += up ? 0.8 : -0.8;
      const hex = Math.floor(rnd(world.rng, 0, 1e6)).toString(16);
      pushFeed(
        world,
        'sys',
        'NEWS',
        `Dormant wallet 0x${hex} just moved 12,000 ${t.sym} ${up ? 'off an exchange' : 'onto an exchange'}.`,
      );
    },
  },
  {
    w: 2,
    run(world) {
      const t = pick(world.rng, memes(world));
      t.supply = 1;
      pushFeed(world, 'sys', 'NEWS', `Team tokens for ${t.sym} unlock soon. Sell pressure incoming.`);
    },
  },
  {
    w: 2,
    run(world) {
      const t = pick(world.rng, memes(world));
      t.trust = clamp(t.trust + 0.25, 0, 1);
      world.market.heat = clamp(world.market.heat - 0.04, 0, 1);
      world.effects.push({ kind: 'banner', text: `${t.sym} passed a security audit`, tone: 'info' });
      pushFeed(world, 'sys', 'NEWS', `Auditors cleared ${t.sym}. Trust is back up.`);
    },
  },
  {
    w: 1,
    run(world) {
      if (world.market.heat < 0.35) return EVENTS[0]!.run(world);
      world.market.heat = 0.3;
      world.effects.push({ kind: 'banner', text: 'REGULATOR: launch fees up, rules tightened', tone: 'bad' });
      pushFeed(
        world,
        'sys',
        'NEWS',
        'The Regulator announced new rules after a wave of rugs and hacks. Launch costs rise for everyone.',
      );
    },
  },
];

/** @deprecated Flat weighted pick — kept for tests/legacy; scheduling uses tickEventSchedule. */
export function runEvent(world: World): void {
  const tot = EVENTS.reduce((a, e) => a + e.w, 0);
  let r = world.rng.next() * tot;
  for (const e of EVENTS) {
    if ((r -= e.w) <= 0) {
      e.run(world);
      break;
    }
  }
}

function fireArchetype(world: World, archetype: 'pump' | 'rugPull'): void {
  if (archetype === 'pump') EVENTS[0]!.run(world);
  else EVENTS[1]!.run(world);
}

/**
 * Pressure-driven schedule: decay → finish rumor → roll pump/rug when idle.
 * Existing EVENTS[0]/[1] bodies run unchanged after the rumor lead.
 */
export function tickEventSchedule(world: World, dt: number): void {
  world.pressures = decayPressures(world.pressures.euphoria, world.pressures.leverage, dt);

  const stage = world.eventStage;
  if (stage?.phase === 'rumor' && world.time >= stage.fireAt) {
    stage.phase = 'live';
    fireArchetype(world, stage.archetype);
    world.eventCooldownUntil = world.time + EVENT_COOLDOWN_S;
    world.eventStage = null;
    world.eventCheckIn = EVENT_CHECK_S;
    return;
  }

  if (world.eventStage) return;
  if (world.time < world.eventCooldownUntil) return;

  world.eventCheckIn -= dt;
  if (world.eventCheckIn > 0) return;

  const hit = rollArchetype(world.rng, world.pressures.euphoria, world.pressures.leverage);
  if (!hit) {
    world.eventCheckIn = EVENT_CHECK_S;
    return;
  }

  const severity = drawSeverity(world.rng);
  const { rumor, sym } = rumorForArchetype(world.rng, hit, world.tokens);
  pushFeed(world, 'sys', 'RUMOR', rumor);
  world.eventStage = {
    archetype: hit,
    phase: 'rumor',
    severity,
    rumor,
    fireAt: world.time + RUMOR_LEAD_S,
    sym,
  };
  world.eventCheckIn = EVENT_CHECK_S;
}
