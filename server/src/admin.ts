/** Ops snapshot for the admin dashboard. Responses never include keys. */
import { timingSafeEqual } from 'node:crypto';
import { nearToYocto } from 'near-api-js';
import { config, readAdminToken } from './config';
import { db } from './db';
import { formatNear, getNearBalanceCached } from './near';

const HOUR_MS = 3_600_000;
const LOW_05 = nearToYocto('0.5');
const CRIT_02 = nearToYocto('0.2');
const LOW_01 = nearToYocto('0.1');

export type AccountStatus = 'ok' | 'low' | 'critical';

type WatchRole =
  | 'players'
  | 'gd'
  | 'items'
  | 'market'
  | 'treasury'
  | 'root'
  | 'chef'
  | 'smith'
  | 'dealer';

type WatchAccount = {
  role: WatchRole;
  accountId: string;
  /** NEAR amount in the top-up command when status is not ok. */
  topUpNear: string | null;
};

export type AdminAccount = {
  role: WatchRole;
  accountId: string;
  near: string | null;
  status: AccountStatus;
  topUp: string | null;
};

export type AdminHealth = {
  accounts: AdminAccount[];
  players: number;
  pendingBurns: string;
  outbox: number;
  chainFailuresLastHour: number;
  chainFailures: Array<{
    id: string;
    label: string;
    account: string | null;
    amount: string | null;
    error: string;
    createdAt: number;
  }>;
  signups: {
    lastHour: number;
    hourlyCap: number;
    distinctIpsLastHour: number;
    ipPerHourCap: number;
  };
};

function normalizeToken(raw: string): string {
  return raw
    .trim()
    .replace(/^ADMIN_TOKEN\s*=\s*/i, '')
    .replace(/\s+/g, '');
}

/** 'missing' when ADMIN_TOKEN is unset (caller returns 404). */
export function adminAuth(header: string | undefined): 'ok' | 'missing' | 'bad' {
  const expected = readAdminToken();
  if (!expected) return 'missing';
  const got = Buffer.from(normalizeToken(header ?? ''));
  const want = Buffer.from(expected);
  if (got.length !== want.length) {
    timingSafeEqual(want, want);
    return 'bad';
  }
  return timingSafeEqual(got, want) ? 'ok' : 'bad';
}

function watchedAccounts(): WatchAccount[] {
  return [
    { role: 'players', accountId: config.rootAccount, topUpNear: '1' },
    { role: 'gd', accountId: config.gdContract, topUpNear: '0.5' },
    { role: 'items', accountId: config.itemsContract, topUpNear: '0.5' },
    { role: 'market', accountId: config.marketContract, topUpNear: '0.5' },
    { role: 'treasury', accountId: config.treasuryAccount, topUpNear: '0.5' },
    { role: 'root', accountId: config.chainRoot, topUpNear: '0.5' },
    { role: 'chef', accountId: config.merchantChef, topUpNear: '0.5' },
    { role: 'smith', accountId: config.merchantSmith, topUpNear: '0.5' },
    { role: 'dealer', accountId: config.merchantDealer, topUpNear: '0.5' },
  ];
}

function statusFor(role: WatchRole, yocto: bigint | null): AccountStatus {
  if (yocto == null) return 'critical';
  if (role === 'treasury') return 'ok';
  if (role === 'chef' || role === 'smith' || role === 'dealer') {
    return yocto < LOW_01 ? 'low' : 'ok';
  }
  if (role === 'root') return yocto < CRIT_02 ? 'critical' : 'ok';
  if (yocto < CRIT_02) return 'critical';
  if (yocto < LOW_05) return 'low';
  return 'ok';
}

function topUpCommand(accountId: string, amount: string): string | null {
  const from = config.topupFrom;
  if (!from || !accountId) return null;
  return `near tokens ${from} send-near ${accountId} '${amount} NEAR' network-config testnet sign-with-legacy-keychain send`;
}

function redact(text: string): string {
  let out = text.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, 'ed25519:[redacted]');
  const secret = config.keyEncryptionSecret;
  if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  const key = config.treasuryKey;
  if (key.length >= 8) out = out.split(key).join('[redacted]');
  return out;
}

function sumTextAmounts(sql: string): string {
  const rows = db.prepare(sql).all() as { amount: string }[];
  let n = 0n;
  for (const r of rows) {
    try {
      n += BigInt(r.amount);
    } catch {
      /* skip corrupt rows */
    }
  }
  return n.toString();
}

export async function adminHealth(): Promise<AdminHealth> {
  const since = Date.now() - HOUR_MS;
  const accounts = await Promise.all(
    watchedAccounts().map(async (row): Promise<AdminAccount> => {
      const yocto = row.accountId ? await getNearBalanceCached(row.accountId) : null;
      const status = statusFor(row.role, row.accountId ? yocto : null);
      const showTopUp = status !== 'ok' && row.topUpNear != null && row.role !== 'treasury';
      return {
        role: row.role,
        accountId: row.accountId,
        near: yocto == null ? null : formatNear(yocto),
        status,
        topUp: showTopUp && row.topUpNear ? topUpCommand(row.accountId, row.topUpNear) : null,
      };
    }),
  );

  const players = (db.prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }).n;
  const outbox = (
    db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get() as { n: number }
  ).n;
  const chainFailuresLastHour = (
    db.prepare(`SELECT COUNT(*) AS n FROM chain_failures WHERE created_at > ?`).get(since) as { n: number }
  ).n;
  const failureRows = db
    .prepare(
      `SELECT id, label, account, amount, error, created_at AS createdAt
       FROM chain_failures ORDER BY created_at DESC LIMIT 10`,
    )
    .all() as Array<{
    id: string;
    label: string;
    account: string | null;
    amount: string | null;
    error: string;
    createdAt: number;
  }>;

  const signupsLastHour = (
    db.prepare(`SELECT COUNT(*) AS n FROM signup_log WHERE created_at > ?`).get(since) as { n: number }
  ).n;
  const distinctIps = (
    db
      .prepare(`SELECT COUNT(DISTINCT ip) AS n FROM signup_log WHERE created_at > ?`)
      .get(since) as { n: number }
  ).n;

  return {
    accounts,
    players,
    pendingBurns: sumTextAmounts(`SELECT amount FROM pending_burns`),
    outbox,
    chainFailuresLastHour,
    chainFailures: failureRows.map(r => ({
      id: r.id,
      label: redact(r.label),
      account: r.account,
      amount: r.amount,
      error: redact(r.error),
      createdAt: r.createdAt,
    })),
    signups: {
      lastHour: signupsLastHour,
      hourlyCap: config.signupHourlyCap,
      distinctIpsLastHour: distinctIps,
      ipPerHourCap: config.signupIpPerHour,
    },
  };
}
