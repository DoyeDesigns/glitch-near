import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { adminAuth, adminHealth } from './admin';
import { AuthError, SESSION_COOKIE, SESSION_MAX_AGE_S, chainProofFor, loginPlayer, meForPlayer, playerFromSessionToken } from './auth';
import { config } from './config';
import { getHealth, getStreamPayload } from './sim';
import { openTrade, parseTradeDir, parseTradeStake, tradeSnapshot } from './trade';
import { parsePostTake, publishPost } from './post';
import { merchantsView } from './chef';
import { forgeMint } from './forge';
import { homeBuy, homePayRent } from './home';
import { restPlayer } from './rest';
import { shopBuy } from './shop';
import { cancelVault, finishVault, parseVaultStops, startVault } from './vault';

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

  app.post('/trade/open', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    let body: { sym?: string; dir?: unknown; stake?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const dir = parseTradeDir(body.dir);
    const stake = parseTradeStake(body.stake);
    if (typeof body.sym !== 'string' || !dir || stake == null) {
      return c.json({ error: 'Bad bet' }, 400);
    }
    try {
      return c.json(await openTrade(player, { sym: body.sym, dir, stake }));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[trade] open failed');
      return c.json({ error: 'Could not open bet' }, 502);
    }
  });

  /** Latest bet. While open, `markPnl` follows the server price. */
  app.get('/trade', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await tradeSnapshot(player));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[trade] read failed');
      return c.json({ error: 'Could not load bet' }, 502);
    }
  });

  app.post('/vault/start', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await startVault(player));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[vault] start failed');
      return c.json({ error: 'Could not open the vault' }, 502);
    }
  });

  app.post('/vault/finish', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const stops = parseVaultStops(body);
    if (!stops) return c.json({ error: 'Bad vault stop' }, 400);
    try {
      return c.json(await finishVault(player, stops));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[vault] finish failed');
      return c.json({ error: 'Could not score that stop' }, 502);
    }
  });

  app.post('/vault/cancel', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await cancelVault(player));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[vault] cancel failed');
      return c.json({ error: 'Could not leave the vault' }, 502);
    }
  });

  app.post('/post', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    let body: { sym?: unknown; take?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const take = parsePostTake(body.take);
    if (typeof body.sym !== 'string' || !take) return c.json({ error: 'Bad post' }, 400);
    try {
      return c.json(await publishPost(player, { sym: body.sym, take }));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[post] publish failed');
      return c.json({ error: 'Could not post' }, 502);
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

  app.get('/merchants', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await merchantsView());
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[merchants] failed');
      return c.json({ error: 'Could not load merchants' }, 502);
    }
  });

  app.post('/shop/buy', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    let body: { itemId?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    if (typeof body.itemId !== 'string') return c.json({ error: 'Bad item' }, 400);
    try {
      return c.json(await shopBuy(player.id, body.itemId));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[shop] buy failed');
      return c.json({ error: 'Could not buy' }, 502);
    }
  });

  app.post('/home/buy', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await homeBuy(player.id));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[home] buy failed');
      return c.json({ error: 'Could not buy home' }, 502);
    }
  });

  app.post('/home/pay-rent', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    try {
      return c.json(await homePayRent(player.id));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[home] pay-rent failed');
      return c.json({ error: 'Could not pay maintenance' }, 502);
    }
  });

  app.post('/rest', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    let body: { kind?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    if (body.kind !== 'bench' && body.kind !== 'sleep') return c.json({ error: 'Bad rest kind' }, 400);
    try {
      return c.json(await restPlayer(player.id, body.kind));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[rest] failed');
      return c.json({ error: 'Could not rest' }, 502);
    }
  });

  app.post('/forge/mint', async c => {
    const player = playerFromSessionToken(getCookie(c, SESSION_COOKIE));
    if (!player) return c.json({ error: 'Not signed in' }, 401);
    let body: { itemId?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    if (typeof body.itemId !== 'string') return c.json({ error: 'Bad item' }, 400);
    try {
      return c.json(await forgeMint(player.id, body.itemId));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      console.error('[forge] mint failed');
      return c.json({ error: 'Could not mint gear' }, 502);
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
