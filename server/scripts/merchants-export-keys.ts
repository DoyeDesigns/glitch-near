/**
 * Print MERCHANT_*_KEY lines for Render env (plaintext secrets).
 * Run locally: npm run merchants:export-keys -w @glitch/server
 * Never commit the output. Paste into Render Environment, then redeploy.
 */
import { MERCHANT_IDS, getMerchant } from '../src/near/merchants';
import { decryptPrivateKey } from '../src/near/keys';

const envName: Record<(typeof MERCHANT_IDS)[number], string> = {
  chef: 'MERCHANT_CHEF_KEY',
  smith: 'MERCHANT_SMITH_KEY',
  dealer: 'MERCHANT_DEALER_KEY',
};

for (const id of MERCHANT_IDS) {
  const row = getMerchant(id);
  if (!row?.enc_private_key) {
    console.error(`# missing ${id} in local merchants table`);
    continue;
  }
  const secret = decryptPrivateKey(row.enc_private_key);
  console.log(`${envName[id]}=${secret}`);
}
