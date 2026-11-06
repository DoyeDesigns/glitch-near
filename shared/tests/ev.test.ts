import { describe, expect, it } from 'vitest';
import {
  applyFlow,
  createWorld,
  mulberry32,
  POST_REACH_FLOOR,
  postProfit,
  postReach,
  stepWorld,
  TRADE_MAX_STAKE,
  tradePnl,
  type PostTake,
} from '../src/index';

const N = 10_000;

function settleBet(seed: number, dir: 1 | -1, stake: number, nudge: boolean): { pnl: number; ret: number } {
  const world = createWorld(seed);
  const token = world.tokens.find(t => t.sym === 'BTX');
  if (!token) throw new Error('BTX missing');
  const p0 = token.price;
  if (nudge) applyFlow(token, dir, stake);
  for (let tick = 0; tick < 20; tick++) stepWorld(world, 0.5);
  return { pnl: tradePnl(stake, dir, p0, token.price), ret: token.price / p0 - 1 };
}

function summarize(values: number[]): { mean: number; median: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  return { mean, median: sorted[Math.floor(sorted.length / 2)]! };
}

describe('expected value', () => {
  it('keeps a level-1 post from a large expected profit', () => {
    // Floor 0.25 paid hype mean 4259.35 (median 3460), warn 2355.61 (1876), meme 3783.41 (3064).
    const takes: PostTake[] = ['hype', 'warn', 'meme'];
    for (const take of takes) {
      const profits: number[] = [];
      for (let i = 0; i < N; i++) profits.push(Math.round(postProfit(postReach(take, 0, 0, 1, mulberry32(i + 1)))));
      const { mean, median } = summarize(profits);
      console.log(`post ${take} floor ${POST_REACH_FLOOR} mean ${mean.toFixed(2)} median ${median}`);
      expect(mean).toBeLessThan(100);
    }
  }, 60_000);

  it('prints the 10s trade mean from stepWorld', () => {
    const stake = 1_000;
    let withSum = 0;
    let withoutSum = 0;
    let favour = 0;
    let maxFavour = 0;
    for (let i = 0; i < N; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const nudged = settleBet(i + 1, dir, stake, true);
      const plain = settleBet(i + 1, dir, stake, false);
      const maxNudge = settleBet(i + 1, dir, TRADE_MAX_STAKE, true);
      const maxPlain = settleBet(i + 1, dir, TRADE_MAX_STAKE, false);
      withSum += nudged.pnl;
      withoutSum += plain.pnl;
      favour += dir * (nudged.ret - plain.ret);
      maxFavour += dir * (maxNudge.ret - maxPlain.ret);
    }
    const meanWith = withSum / N;
    const meanWithout = withoutSum / N;
    const meanFavour = favour / N;
    const meanMaxFavour = maxFavour / N;
    // Old nudge stake/2e6: stake 1000 mean 0.9333 (favour 0.00131%);
    // stake 100000 mean 2668.6877 (favour 0.13137%). Without that nudge:
    // stake 1000 mean 0.6803, stake 100000 mean 67.6142.
    console.log(
      `trade mean pnl with nudge ${meanWith.toFixed(4)} without ${meanWithout.toFixed(4)} favour ${(meanFavour * 100).toFixed(5)}% max-stake favour ${(meanMaxFavour * 100).toFixed(5)}%`,
    );
    expect(meanMaxFavour).toBeLessThan(0.001);
    expect(meanWith).toBeLessThan(20);
  }, 60_000);
});
