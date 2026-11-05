import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { adminAuth, adminHealth } from './admin';
import { AuthError, SESSION_COOKIE, SESSION_MAX_AGE_S, chainProofFor, loginPlayer, meForPlayer, playerFromSessionToken } from './auth';
import { config } from './config';
import { getHealth, getStreamPayload } from './sim';

function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim() || 'unknown';
  return headers.get('x-real-ip') || 'unknown';
}

export function createApp() {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: config.corsOrigin,
      credentials: true,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-admin-token'],
    }),
  );

  app.get('/health', c => c.json(getHealth()));

  app.post('/auth/login', async c => {
    let body: { name?: string; pin?: string; guest?: boolean; signup?: boolean; inviteCode?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    try {
      const { token, player } = await loginPlayer({
        name: body.name,
        pin: body.pin,
        guest: body.guest === true,
        signup: body.signup === true,
        inviteCode: body.inviteCode,
        ip: clientIp(c.req.raw.headers),
      });
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_S,
        secure: config.isProd,
      });
      return c.json({ name: player.name, accountId: player.account_id });
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[auth] login failed:', message);
      return c.json({ error: message }, 502);
    }
  });

  /**
   * Session snapshot. available = chainBalance − pendingBurns − escrowed (floored at 0).
   */
  /** On-chain proof for Settings. Session required. Chain values cached 5s. */
  app.get('/me/chain', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await chainProofFor(player));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[me/chain] chain read failed');
      return c.json({ error: 'NEAR read failed' }, 502);
    }
  });

  /**
   * Ops snapshot. 404 when ADMIN_TOKEN is unset. Header: x-admin-token.
   * Never returns keys or the encryption secret.
   */
  app.get('/admin/health', async c => {
    const auth = adminAuth(c.req.header('x-admin-token'));
    if (auth === 'missing') return c.json({ error: 'Not found' }, 404);
    if (auth === 'bad') return c.json({ error: 'Unauthorized' }, 401);
    try {
      return c.json(await adminHealth());
    } catch {
      console.error('[admin] health failed');
      return c.json({ error: 'Health check failed' }, 502);
    }
  });

  app.get('/me', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await meForPlayer(player));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[me] chain read failed:', message);
      return c.json({ error: 'NEAR read failed', message }, 502);
    }
  });

  app.get('/stream', c =>
    streamSSE(c, async stream => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      while (!closed) {
        const payload = getStreamPayload();
        await stream.writeSSE({
          event: 'state',
          data: JSON.stringify(payload),
        });
        await stream.sleep(1000);
      }
    }),
  );

  return app;
}
