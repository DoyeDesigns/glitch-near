import './admin.css';

const TOKEN_KEY = 'glitch_admin_token';
const POLL_MS = 15_000;

type AccountRow = {
  role: string;
  accountId: string;
  near: string | null;
  status: 'ok' | 'low' | 'critical';
  topUp: string | null;
};

type Health = {
  accounts: AccountRow[];
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

const tokenInput = document.querySelector('#token') as HTMLInputElement;
const errEl = document.querySelector('#err') as HTMLElement;
const outEl = document.querySelector('#out') as HTMLElement;
const updatedEl = document.querySelector('#updated') as HTMLElement;
const form = document.querySelector('#tok') as HTMLFormElement;

let timer = 0;
let seq = 0;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function normalizeToken(raw: string): string {
  return raw
    .trim()
    .replace(/^ADMIN_TOKEN\s*=\s*/i, '')
    .replace(/\s+/g, '');
}

function showError(message: string) {
  errEl.hidden = false;
  errEl.textContent = message;
}

function clearError() {
  errEl.hidden = true;
  errEl.textContent = '';
}

function roleLabel(role: string): string {
  if (role === 'gd') return 'GD';
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function render(data: Health) {
  const accounts = data.accounts
    .map(row => {
      const hint = row.topUp
        ? `<div class="topup"><small>Top up</small><pre>${esc(row.topUp)}</pre><button type="button" data-copy="${esc(row.topUp)}">Copy</button></div>`
        : '';
      return `<article class="acct">
        <header><b>${esc(roleLabel(row.role))}</b><span class="pill ${row.status}">${row.status}</span></header>
        <code>${esc(row.accountId || '—')}</code>
        <div>${row.near == null ? 'Not on chain' : `${esc(row.near)} NEAR`}</div>
        ${hint}
      </article>`;
    })
    .join('');

  const failures =
    data.chainFailures
      .map(
        row => `<tr>
          <td>${esc(new Date(row.createdAt).toLocaleString())}</td>
          <td>${esc(row.label)}</td>
          <td>${esc(row.account ?? '')}</td>
          <td>${esc(row.amount ?? '')}</td>
          <td class="err">${esc(row.error)}</td>
        </tr>`,
      )
      .join('') || '<tr><td colspan="5">None</td></tr>';

  outEl.innerHTML = `
    <section class="stats">
      <div><small>Players</small><b>${data.players}</b></div>
      <div><small>Pending burns</small><b>${esc(data.pendingBurns)}</b></div>
      <div><small>Outbox</small><b>${data.outbox}</b></div>
      <div><small>Failed chain writes, last hour</small><b>${data.chainFailuresLastHour}</b></div>
      <div><small>Signups, last hour</small><b>${data.signups.lastHour} / ${data.signups.hourlyCap}</b></div>
      <div><small>Signup networks, last hour</small><b>${data.signups.distinctIpsLastHour}</b><small>cap ${data.signups.ipPerHourCap} each</small></div>
    </section>
    <h2>Accounts</h2>
    ${accounts}
    <h2>Last 10 chain failures</h2>
    <table>
      <thead><tr><th>When</th><th>Label</th><th>Account</th><th>Amount</th><th>Error</th></tr></thead>
      <tbody>${failures}</tbody>
    </table>`;
}

async function tick() {
  const token = normalizeToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
  if (!token) return;
  const n = ++seq;
  let res: Response;
  try {
    res = await fetch('/admin/health', { headers: { 'x-admin-token': token } });
  } catch {
    if (n !== seq) return;
    showError('Could not reach the server.');
    return;
  }
  if (n !== seq) return;
  if (res.status === 404) {
    stop();
    outEl.innerHTML = '';
    showError('Not found');
    return;
  }
  if (res.status === 401) {
    stop();
    outEl.innerHTML = '';
    showError(
      `That does not match ADMIN_TOKEN in server/.env.local. This box sent ${token.length} characters. Paste the hex value only, not the ADMIN_TOKEN= label and not the other lines in that file.`,
    );
    return;
  }
  let data: Health & { error?: string };
  try {
    data = (await res.json()) as Health & { error?: string };
  } catch {
    showError('Could not read the health response.');
    return;
  }
  if (!res.ok) {
    showError(data.error || 'Health check failed');
    return;
  }
  clearError();
  render(data);
  updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function start() {
  stop();
  void tick();
  timer = window.setInterval(() => void tick(), POLL_MS);
}

function stop() {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const token = normalizeToken(tokenInput.value);
  tokenInput.value = token;
  if (!token) {
    showError('Enter the admin token.');
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  clearError();
  start();
});

document.querySelector('#forget')!.addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  tokenInput.value = '';
  outEl.innerHTML = '';
  updatedEl.textContent = '';
  stop();
  clearError();
});

outEl.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
  if (!btn?.dataset.copy) return;
  void navigator.clipboard.writeText(btn.dataset.copy).then(
    () => {
      btn.textContent = 'Copied';
    },
    () => {
      btn.textContent = 'Could not copy';
    },
  );
});

const saved = normalizeToken(sessionStorage.getItem(TOKEN_KEY) ?? '');
if (saved) {
  tokenInput.value = saved;
  start();
}
