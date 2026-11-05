/**
 * near:smoke — create a test player, mint 100 GD, print balance.
 *
 *   npm run near:smoke -w @glitch/server
 */
import { createPlayerAccount, getGDBalance, mintGD } from '../src/near';

async function main() {
  const name = `smk${Date.now().toString(36).slice(-8)}`;
  console.log(`[near:smoke] creating player "${name}"…`);
  const accountId = await createPlayerAccount(name);
  console.log(`[near:smoke] account ${accountId}`);

  console.log('[near:smoke] minting 100 GD…');
  await mintGD(accountId, 100);
  const bal = await getGDBalance(accountId);
  console.log(`[near:smoke] balance: ${bal}`);

  if (bal !== 100n) {
    console.error(`[near:smoke] FAIL expected 100, got ${bal}`);
    process.exitCode = 1;
    return;
  }
  console.log('[near:smoke] OK');
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[near:smoke] error:', message);
  process.exitCode = 1;
});
