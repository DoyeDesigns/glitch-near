import type { KeyPairString } from 'near-api-js';
import { config, isMockChain, requireNearConfig } from '../config';
import { ONE_YOCTO, ensurePlayerNear, enqueueSignerWrite } from './client';
import { getGDBalance, invalidateGdCache, transferGdViaHook } from './gd';
import { decryptPrivateKey } from './keys';
import { getMerchant } from './merchants';
import { deliverSigned, signAccountCall } from './mintTx';
import { ChainWriteError, recordChainFailure } from './retry';

const MOCK_SECRET = 'ed25519:mock' as KeyPairString;
const MEMO = 'glitch-supply';

function merchantSecret(enc: string): KeyPairString {
  if (isMockChain() && enc === 'mock') return MOCK_SECRET;
  return decryptPrivateKey(enc) as KeyPairString;
}

/**
 * Merchant-signed NEP-141 ft_transfer on the existing gd contract.
 * Mock/test uses the GD ledger hook; testnet signs with the custodial merchant key.
 */
export async function merchantFtTransfer(
  fromMerchantId: string,
  toAccountId: string,
  amount: bigint,
): Promise<'success' | 'failure'> {
  if (amount <= 0n) return 'failure';
  const from = getMerchant(fromMerchantId);
  if (!from?.account_id || !from.enc_private_key) return 'failure';
  const fromAccount = from.account_id;
  if (fromAccount === toAccountId) return 'failure';

  const bal = await getGDBalance(fromAccount);
  if (bal < amount) return 'failure';

  if (await transferGdViaHook(fromAccount, toAccountId, amount)) return 'success';

  requireNearConfig();
  const secret = merchantSecret(from.enc_private_key);
  return enqueueSignerWrite(fromAccount, async () => {
    try {
      await ensurePlayerNear(fromAccount);
      const outcome = await deliverSigned({
        sign: () =>
          signAccountCall({
            accountId: fromAccount,
            secretKey: secret,
            contractId: config.gdContract,
            methodName: 'ft_transfer',
            args: {
              receiver_id: toAccountId,
              amount: amount.toString(),
              memo: MEMO,
            },
            deposit: ONE_YOCTO,
          }),
        persistHash: () => undefined,
      });
      if (outcome !== 'success') return 'failure';
      // Mock broadcast may not move balances; hooks already handled above.
      invalidateGdCache(fromAccount);
      invalidateGdCache(toAccountId);
      return 'success';
    } catch (err) {
      const cwe =
        err instanceof ChainWriteError
          ? err
          : new ChainWriteError({
              label: 'merchant.ft_transfer',
              account: fromAccount,
              amount: amount.toString(),
              cause: err,
            });
      if (!(err instanceof ChainWriteError)) recordChainFailure(cwe);
      return 'failure';
    }
  });
}
