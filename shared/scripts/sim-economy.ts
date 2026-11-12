/**
 * Headless economy stress sim: 50 bots × 8 weeks against real shared constants.
 *
 *   npm run sim:economy
 *
 * Does not change any economy constants. Merchant COGS rate below is a sim-only
 * assumption (no shared constant yet).
 */
import {
  CATALOG,
  faucetCredit,
  GAS_GD,
  HOMEP_GD,
  MAINTENANCE_GD,
  MAINTENANCE_MS,
  mulberry32,
  POST_BURN,
  POST_COST,
  postProfit,
  postReach,
  skillLevel,
  START_GD,
  tradeFee,
  tradePnl,
  UPKEEP_INTERVAL_S,
  UPKEEP_RATE,
  vaultGross,
  type PostTake,
  type Rng,
  type SkillXp,
} from '@glitch/shared';

const PLAYERS = 50;
const WEEKS = 8;
const DAY_S = 86_400;
const DAYS_PER_WEEK = 7;
/** Sim-only: share of each merchant receipt burned as cost-of-goods. Not a shared constant. */
const MERCHANT_COGS_RATE = 0.4;

const FOOD = CATALOG.filter(i => i.kind === 'food' && i.priceGD != null);
const FURNITURE = CATALOG.filter(i => i.kind === 'furniture' && i.priceGD != null).sort(
  (a, b) => (a.priceGD ?? 0) - (b.priceGD ?? 0),
);
const STAKES = [1_000, 5_000, 10_000, 50_000, 100_000] as const;
const TAKES: PostTake[] = ['hype', 'warn', 'meme'];

type Bot = {
  id: number;
  bal: number;
  xp: SkillXp;
  homeOwned: boolean;
  paidUntil: number; // sim ms
  furn: Set<string>;
  /** Activity knobs 0..1 */
  grind: number;
  tradeBias: number;
  homeDesire: number;
};

type WeekRow = {
  week: number;
  minted: number;
  burned: number;
  net: number;
  circulating: number;
  median: number;
  top10: number;
  lockedHomes: number;
  unstable: boolean;
};

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function topShare(sortedAsc: number[], frac: number): number {
  const total = sortedAsc.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const k = Math.max(1, Math.ceil(sortedAsc.length * frac));
  const top = sortedAsc.slice(-k).reduce((a, b) => a + b, 0);
  return top / total;
}

function applyHoldingTax(bal: number, seconds: number): { bal: number; burned: number } {
  const ticks = Math.floor(seconds / UPKEEP_INTERVAL_S);
  if (ticks <= 0 || bal <= 0) return { bal, burned: 0 };
  const factor = Math.pow(1 - UPKEEP_RATE, ticks);
  const next = bal * factor;
  return { bal: next, burned: bal - next };
}

function makeBots(rng: Rng): Bot[] {
  const bots: Bot[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    bots.push({
      id: i,
      bal: START_GD,
      xp: { trade: 0, sec: 0, comm: 0 },
      homeOwned: false,
      paidUntil: 0,
      furn: new Set(),
      grind: 0.25 + rng.next() * 0.75,
      tradeBias: rng.next(),
      homeDesire: rng.next(),
    });
  }
  return bots;
}

function credit(
  bot: Bot,
  amount: number,
  weak: boolean,
  weekMinted: { n: number },
  totalMinted: { n: number },
): void {
  if (amount <= 0) return;
  const r = faucetCredit(amount, weak);
  bot.bal += r.credited;
  weekMinted.n += r.credited;
  totalMinted.n += r.credited;
}

function payMerchant(
  bot: Bot,
  amount: number,
  weekBurned: { n: number },
  totalBurned: { n: number },
): boolean {
  if (amount <= 0) return true;
  if (bot.bal < amount) return false;
  bot.bal -= amount;
  const cogs = amount * MERCHANT_COGS_RATE;
  weekBurned.n += cogs;
  totalBurned.n += cogs;
  return true;
}

function burnSink(
  bot: Bot,
  amount: number,
  weekBurned: { n: number },
  totalBurned: { n: number },
): boolean {
  if (amount <= 0) return true;
  if (bot.bal < amount) return false;
  bot.bal -= amount;
  weekBurned.n += amount;
  totalBurned.n += amount;
  return true;
}

function dayVault(bot: Bot, rng: Rng, weekMinted: { n: number }, totalMinted: { n: number }): void {
  const attempts = Math.floor(rng.next() * (1 + bot.grind * 4));
  for (let i = 0; i < attempts; i++) {
    const roll = rng.next();
    const hits = roll < 0.12 ? 3 : roll < 0.35 ? 2 : roll < 0.7 ? 1 : 0;
    const gross = vaultGross(hits);
    credit(bot, gross, false, weekMinted, totalMinted);
    bot.xp.sec += 8 + hits * 6;
  }
}

function dayTrade(
  bot: Bot,
  rng: Rng,
  weekMinted: { n: number },
  totalMinted: { n: number },
  weekBurned: { n: number },
  totalBurned: { n: number },
): void {
  const n = Math.floor(rng.next() * (1 + bot.grind * bot.tradeBias * 10));
  for (let i = 0; i < n; i++) {
    const stake = STAKES[Math.floor(rng.next() * STAKES.length)]!;
    const fee = tradeFee(stake);
    if (bot.bal < stake + fee) continue;
    bot.bal -= stake + fee;
    weekBurned.n += fee;
    totalBurned.n += fee;

    const dir: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
    const p0 = 100;
    const price = p0 * (1 + (rng.next() - 0.5) * 0.04);
    const pnl = tradePnl(stake, dir, p0, price);

    if (pnl >= 0) {
      bot.bal += stake;
      credit(bot, pnl, false, weekMinted, totalMinted);
    } else {
      const loss = -pnl;
      weekBurned.n += loss;
      totalBurned.n += loss;
      bot.bal += stake - loss;
    }
    bot.xp.trade += 6;
  }
}

function dayPost(
  bot: Bot,
  rng: Rng,
  weekMinted: { n: number },
  totalMinted: { n: number },
  weekBurned: { n: number },
  totalBurned: { n: number },
): void {
  const n = Math.floor(rng.next() * (1 + bot.grind * 3));
  for (let i = 0; i < n; i++) {
    if (bot.bal < POST_COST) break;
    bot.bal -= POST_COST;
    weekBurned.n += POST_BURN;
    totalBurned.n += POST_BURN;
    // escrow half is settled against payout; net profit via faucet
    const take = TAKES[Math.floor(rng.next() * TAKES.length)]!;
    const mood = rng.next() * 2 - 1;
    const heat = rng.next() * 0.4;
    const reach = postReach(take, mood, heat, skillLevel(bot.xp.comm), rng);
    const profit = postProfit(reach);
    // release escrow into bal, then apply profit (may be negative → burn remainder of escrow)
    bot.bal += POST_COST - POST_BURN;
    if (profit >= 0) {
      credit(bot, profit, false, weekMinted, totalMinted);
    } else {
      const lost = Math.min(bot.bal, -profit);
      bot.bal -= lost;
      weekBurned.n += lost;
      totalBurned.n += lost;
    }
    bot.xp.comm += 14;
  }
}

function daySpend(
  bot: Bot,
  rng: Rng,
  weekBurned: { n: number },
  totalBurned: { n: number },
): void {
  const meals = 1 + Math.floor(rng.next() * (1 + bot.grind * 2));
  for (let i = 0; i < meals; i++) {
    const food = FOOD[Math.floor(rng.next() * FOOD.length)]!;
    payMerchant(bot, food.priceGD!, weekBurned, totalBurned);
  }

  // occasional fast travel
  if (rng.next() < 0.3 * bot.grind) {
    burnSink(bot, GAS_GD, weekBurned, totalBurned);
  }

  if (!bot.homeOwned && bot.homeDesire > 0.35 && bot.bal >= HOMEP_GD + MAINTENANCE_GD) {
    if (rng.next() < 0.15 + bot.homeDesire * 0.25) {
      payMerchant(bot, HOMEP_GD, weekBurned, totalBurned);
      payMerchant(bot, MAINTENANCE_GD, weekBurned, totalBurned);
      bot.homeOwned = true;
      // paidUntil set by caller with sim time
    }
  }

  if (bot.homeOwned && rng.next() < 0.2 * bot.grind) {
    const next = FURNITURE.find(f => !bot.furn.has(f.id) && bot.bal >= (f.priceGD ?? Infinity));
    if (next && payMerchant(bot, next.priceGD!, weekBurned, totalBurned)) {
      bot.furn.add(next.id);
    }
  }
}

function billMaintenance(
  bot: Bot,
  nowMs: number,
  weekBurned: { n: number },
  totalBurned: { n: number },
): void {
  if (!bot.homeOwned) return;
  // Catch up periods while funded; stop when broke → locked
  while (bot.paidUntil <= nowMs) {
    if (!payMerchant(bot, MAINTENANCE_GD, weekBurned, totalBurned)) {
      // locked: paidUntil stays in the past
      return;
    }
    bot.paidUntil += MAINTENANCE_MS;
  }
}

function run(): void {
  const rng = mulberry32(0x61e70c17);
  const bots = makeBots(rng);
  const totalMinted = { n: START_GD * PLAYERS };
  const totalBurned = { n: 0 };
  let prevCirculating = totalMinted.n;
  const rows: WeekRow[] = [];

  let simMs = 0;

  for (let week = 1; week <= WEEKS; week++) {
    const weekMinted = { n: 0 };
    const weekBurned = { n: 0 };

    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      for (const bot of bots) {
        dayVault(bot, rng, weekMinted, totalMinted);
        dayTrade(bot, rng, weekMinted, totalMinted, weekBurned, totalBurned);
        dayPost(bot, rng, weekMinted, totalMinted, weekBurned, totalBurned);
        daySpend(bot, rng, weekBurned, totalBurned);

        if (bot.homeOwned && bot.paidUntil === 0) {
          bot.paidUntil = simMs + MAINTENANCE_MS;
        }

        // Maintenance billed each MAINTENANCE_MS period through end of day
        const endDay = simMs + DAY_S * 1000;
        billMaintenance(bot, endDay, weekBurned, totalBurned);

        const tax = applyHoldingTax(bot.bal, DAY_S);
        bot.bal = tax.bal;
        weekBurned.n += tax.burned;
        totalBurned.n += tax.burned;
      }
      simMs += DAY_S * 1000;
    }

    const bals = bots.map(b => b.bal).sort((a, b) => a - b);
    const circulating = totalMinted.n - totalBurned.n;
    const net = weekMinted.n - weekBurned.n;
    const growth = prevCirculating > 0 ? (circulating - prevCirculating) / prevCirculating : 0;
    const top10 = topShare(bals, 0.1);
    const lockedHomes = bots.filter(b => b.homeOwned && b.paidUntil < simMs).length;
    const unstable = growth > 0.1 || top10 > 0.6;

    rows.push({
      week,
      minted: weekMinted.n,
      burned: weekBurned.n,
      net,
      circulating,
      median: median(bals),
      top10,
      lockedHomes,
      unstable,
    });
    prevCirculating = circulating;
  }

  const homes = bots.filter(b => b.homeOwned).length;
  console.log(`Glitch economy sim — ${PLAYERS} bots, ${WEEKS} weeks`);
  console.log(
    `Constants: START=${START_GD} HOMEP=${HOMEP_GD} MAINT=${MAINTENANCE_GD}/${MAINTENANCE_MS}ms UPKEEP=${UPKEEP_RATE}/${UPKEEP_INTERVAL_S}s`,
  );
  console.log(`Sim-only COGS rate: ${MERCHANT_COGS_RATE} (not a shared constant)`);
  console.log(`Homes owned by end: ${homes}/${PLAYERS}`);
  console.log('');

  const head = [
    'Week',
    'Minted',
    'Burned',
    'Net',
    'Supply',
    'Median',
    'Top10%',
    'Locked',
    'Flag',
  ];
  const widths = [4, 10, 10, 10, 10, 10, 8, 6, 10];
  const pad = (s: string, w: number) => s.padStart(w);
  console.log(head.map((h, i) => pad(h, widths[i]!)).join('  '));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));

  for (const r of rows) {
    const flag = r.unstable ? 'UNSTABLE' : 'ok';
    console.log(
      [
        pad(String(r.week), widths[0]!),
        pad(fmt(r.minted), widths[1]!),
        pad(fmt(r.burned), widths[2]!),
        pad((r.net >= 0 ? '+' : '') + fmt(r.net), widths[3]!),
        pad(fmt(r.circulating), widths[4]!),
        pad(fmt(r.median), widths[5]!),
        pad(pct(r.top10), widths[6]!),
        pad(String(r.lockedHomes), widths[7]!),
        pad(flag, widths[8]!),
      ].join('  '),
    );
  }

  const bad = rows.filter(r => r.unstable);
  console.log('');
  if (bad.length) {
    console.log(
      `Unstable weeks: ${bad.map(r => r.week).join(', ')} (net supply +>10% vs prior week, or top 10% >60% of GD)`,
    );
  } else {
    console.log('No week flagged unstable (net supply growth ≤10% and top 10% ≤60%).');
  }
}

run();
