/**
 * Push local merchant private keys to a remote Glitch server (Render).
 * Uses ADMIN_TOKEN from .env.local. Never prints key material.
 *
 *   REMOTE_URL=https://glitch-near.onrender.com npm run merchants:restore-remote -w @glitch/server
 */
import { MERCHANT_IDS, getMerchant } from '../src/near/merchants';
import { decryptPrivateKey } from '../src/near/keys';
import { config } from '../src/config';

const remote = (process.env.REMOTE_URL || 'https://glitch-near.onrender.com').replace(/\/$/, '');
const token = config.adminToken?.trim();
if (!token) {
  console.error('ADMIN_TOKEN missing in server/.env.local');
  process.exit(1);
}

const body: Record<string, string> = {};
for (const id of MERCHANT_IDS) {
  const row = getMerchant(id);
  if (!row?.enc_private_key) {
    console.error(`local merchants table missing ${id}`);
    process.exit(1);
  }
  body[id] = decryptPrivateKey(row.enc_private_key);
}

const res = await fetch(`${remote}/admin/merchants/restore-keys`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-admin-token': token,
  },
  body: JSON.stringify(body),
});
const text = await res.text();
let json: unknown = text;
try {
  json = JSON.parse(text) as unknown;
} catch {
  /* keep text */
}
if (!res.ok) {
  console.error(`restore failed ${res.status}`, json);
  process.exit(1);
}
console.log(`restored on ${remote}:`, json);
