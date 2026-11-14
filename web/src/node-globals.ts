import { Buffer } from 'buffer';

/**
 * Wallet signing still uses Node globals. Browsers only have globalThis.
 * `buffer` is the small polyfill MyNearWallet needs to base64 the payment transaction.
 */
const g = globalThis as typeof globalThis & {
  global?: typeof globalThis;
  process?: { env: Record<string, string | undefined> };
  Buffer?: typeof Buffer;
};
g.global = globalThis;
g.process = g.process ?? { env: {} };
g.Buffer = Buffer;
