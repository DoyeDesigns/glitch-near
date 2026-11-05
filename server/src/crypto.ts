import { createHash, randomBytes } from 'node:crypto';

export function randomId(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex').slice(0, 32);
}
