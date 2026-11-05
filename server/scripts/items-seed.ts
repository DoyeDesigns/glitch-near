/**
 * Idempotent seed of catalog token types on ITEMS_CONTRACT.
 * Skips unique gear (minted later as gear-<type>-<uuid>) and proposed entries.
 *
 *   npm run items:seed -w @glitch/server
 */
import { catalogSeedEntries } from '@glitch/shared';
import { createToken, getToken } from '../src/near';

async function main() {
  const entries = catalogSeedEntries();
  let created = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`[items:seed] seeding ${entries.length} catalog token types…`);

  for (const item of entries) {
    try {
      const existing = await getToken(item.id);
      if (existing) {
        skipped += 1;
        console.log(`[items:seed] skip  ${item.id} (exists)`);
        continue;
      }
      await createToken(item.id, item.kind, item.title, item.maxSupply);
      created += 1;
      console.log(`[items:seed] create ${item.id} (${item.kind})`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[items:seed] fail  ${item.id}: ${msg}`);
    }
  }

  console.log(`[items:seed] done — created=${created} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[items:seed] error:', message);
  process.exitCode = 1;
});
