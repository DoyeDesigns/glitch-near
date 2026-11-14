import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth';
import { parseWithdrawAccount, parseWithdrawAmount } from '../src/withdraw';

const own = 'ada.players.glitch-edoye.testnet';

describe('withdraw parse', () => {
  it('accepts a testnet account and a whole amount', () => {
    expect(parseWithdrawAccount('Edoye.testnet', own)).toBe('edoye.testnet');
    expect(parseWithdrawAmount('1500')).toBe(1500n);
  });

  it('rejects the player account, a mainnet name, and a blank amount', () => {
    expect(() => parseWithdrawAccount(own, own)).toThrow(AuthError);
    expect(() => parseWithdrawAccount('edoye.near', own)).toThrow(/testnet account/);
    expect(() => parseWithdrawAmount('0')).toThrow(/whole number/);
    expect(() => parseWithdrawAmount('1.5')).toThrow(/whole number/);
  });
});
