import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  loginWithGoogle,
  playerFromSessionToken,
  setRootFundedCheckForTests,
} from '../src/auth';
import { config } from '../src/config';
import { db } from '../src/db';
import {
  GoogleCredentialError,
  setGoogleVerifyForTests,
  verifyGoogleCredential,
} from '../src/googleAuth';
import {
  getPlayerByGoogleSub,
  getPlayerByName,
  setCreatePlayerAccountForTests,
} from '../src/near/accounts';
import { encryptPrivateKey } from '../src/near/keys';
import { KeyPair } from 'near-api-js';

if (!config.dbPath || config.dbPath.includes('glitch.sqlite')) {
  throw new Error(`refusing to run tests against ${config.dbPath || 'the default database'}`);
}

const originalClientId = config.googleClientId;

function insertGooglePlayer(sub: string, name: string) {
  const id = `g-${randomBytes(4).toString('hex')}`;
  const accountId = `${name}.players.test`;
  db.prepare(
    `INSERT INTO players (id, name, google_sub, account_id, enc_private_key, status, created_at, gd_minted)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
  ).run(id, name, sub, accountId, encryptPrivateKey(KeyPair.fromRandom('ed25519').toString()), Date.now());
  return id;
}

describe('google auth', () => {
  beforeEach(() => {
    (config as { googleClientId: string }).googleClientId = 'test-google-client.apps.googleusercontent.com';
    setGoogleVerifyForTests(null);
    setCreatePlayerAccountForTests(null);
    setRootFundedCheckForTests(null);
  });

  afterEach(() => {
    (config as { googleClientId: string }).googleClientId = originalClientId;
    setGoogleVerifyForTests(null);
    setCreatePlayerAccountForTests(null);
    setRootFundedCheckForTests(null);
  });

  it('rejects when verification fails (bad/expired credential)', async () => {
    setGoogleVerifyForTests(async () => {
      throw new GoogleCredentialError('Invalid Google credential', 401);
    });
    await expect(verifyGoogleCredential('bad-token')).rejects.toMatchObject({
      message: 'Invalid Google credential',
      status: 401,
    });

    setGoogleVerifyForTests(async () => {
      throw new GoogleCredentialError('Google credential expired', 401);
    });
    await expect(
      loginWithGoogle({ credential: 'expired', ip: '127.0.0.1' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects when Google sign-in is not configured', async () => {
    (config as { googleClientId: string }).googleClientId = '';
    await expect(loginWithGoogle({ credential: 'x', ip: '127.0.0.1' })).rejects.toMatchObject({
      message: 'Google sign-in is not configured',
      status: 503,
    });
  });

  it('known sub issues a session for that player', async () => {
    const sub = `sub-${randomBytes(4).toString('hex')}`;
    const name = `gok${randomBytes(2).toString('hex')}`;
    insertGooglePlayer(sub, name);
    setGoogleVerifyForTests(async () => ({ sub }));

    const { token, player } = await loginWithGoogle({ credential: 'tok', ip: '127.0.0.1' });
    expect(player.name).toBe(name);
    expect(player.google_sub).toBe(sub);
    expect(playerFromSessionToken(token)?.id).toBe(player.id);
  });

  it('new sub without name returns needsName', async () => {
    setGoogleVerifyForTests(async () => ({ sub: `new-${randomBytes(4).toString('hex')}` }));
    try {
      await loginWithGoogle({ credential: 'tok', ip: '127.0.0.1' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect(err).toMatchObject({
        message: 'Choose a player name',
        status: 400,
        extra: { needsName: true },
      });
    }
  });

  it('new sub + name creates player with google_sub', async () => {
    const sub = `new-${randomBytes(4).toString('hex')}`;
    const name = `gn${randomBytes(3).toString('hex')}`;
    setGoogleVerifyForTests(async () => ({ sub }));
    setRootFundedCheckForTests(async () => {});
    setCreatePlayerAccountForTests(async (n, opts) => {
      const id = `gcreate-${randomBytes(3).toString('hex')}`;
      const accountId = `${n}.players.test`;
      db.prepare(
        `INSERT INTO players (id, name, google_sub, account_id, enc_private_key, status, created_at, gd_minted)
         VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
      ).run(
        id,
        n,
        opts?.googleSub ?? null,
        accountId,
        encryptPrivateKey(KeyPair.fromRandom('ed25519').toString()),
        Date.now(),
      );
      return accountId;
    });

    const { token, player } = await loginWithGoogle({
      credential: 'tok',
      name,
      ip: '127.0.0.1',
    });
    expect(player.name).toBe(name);
    expect(player.google_sub).toBe(sub);
    expect(getPlayerByGoogleSub(sub)?.name).toBe(name);
    expect(getPlayerByName(name)?.google_sub).toBe(sub);
    expect(playerFromSessionToken(token)?.google_sub).toBe(sub);
  });
});
