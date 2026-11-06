import { MERCHANT_IDS, setupMerchants } from '../src/near/merchants';
import { ChainWriteError } from '../src/near/retry';

try {
  const result = await setupMerchants();
  console.log(`[merchants] created ${result.created.join(', ') || 'none'}`);
  console.log(`[merchants] skipped ${result.skipped.join(', ') || 'none'}`);
  for (const id of MERCHANT_IDS) {
    console.log(`[merchants] ${id} ${result.balances[id]}`);
  }
} catch (err) {
  if (!(err instanceof ChainWriteError)) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[merchants] ${message.slice(0, 200)}`);
  }
  process.exit(1);
}
