import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { db } from '../src/db';
import { mintGD, getGDBalance } from '../src/near/gd';
import { getCurrentAdResolved } from '../src/near/market';
import {
  installMockChain,
  readMockGd,
  resetMockChainInstallForTests,
  seedMockAd,
} from '../src/near/mockLedger';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

describe('mock ledger', () => {
  beforeEach(() => {
    resetMockChainInstallForTests();
    installMockChain();
  });

  afterEach(() => {
    resetMockChainInstallForTests();
  });

  it('persists GD mint in SQLite', async () => {
    const accountId = `persist.${config.rootAccount}`;
    await mintGD(accountId, 12345n);
    expect(await getGDBalance(accountId)).toBe(12345n);
    expect(readMockGd(accountId)).toBe(12345n);
    const row = db.prepare(`SELECT amount FROM mock_gd WHERE account_id = ?`).get(accountId) as
      | { amount: string }
      | undefined;
    expect(row?.amount).toBe('12345');
  });

  it('serves seeded ads via get_current_ad', async () => {
    expect(await getCurrentAdResolved(0)).toBeNull();
    seedMockAd(0, {
      advertiser: 'adv.test',
      projectName: 'MockBillboard',
      creativeUrl: 'https://cdn.example/ad.png',
    });
    const ad = await getCurrentAdResolved(0);
    expect(ad?.project_name).toBe('MockBillboard');
    expect(ad?.creative_url).toBe('https://cdn.example/ad.png');
  });
});
