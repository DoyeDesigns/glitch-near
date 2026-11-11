import {
  GAS_GD,
  isPlayerListableToken,
  listableTokenTitle,
  MARKET_LIST_MAX_GD,
  MARKET_LIST_MIN_GD,
} from '@glitch/shared';
import { $, esc, fmt, fmtN, pick, rnd } from './util';
import { burn, L, logTx, payCap, roleName, SAVE, save, S, txlog, weak } from './state';
import { banner, feed, post, serverTick } from './market';
import {
  assistantScreenPos,
  cam,
  clearInterior,
  currentInterior,
  heldPoseId,
  player,
  poseFromDraft,
  POSE_PRESETS,
  setAssistantClickHandler,
  setHeldPose,
  vel,
  type Pose,
  type PoseLimbDraft,
} from './world';
import { NEUTRAL_POSE, poseSvgMarkup } from './posePreview';
import { closeModal, introOpen, modalOpen, openModal, sheet, updateHud } from './hud';
import {
  cityDay,
  citySimPlaying,
  homeAct,
  homeHtml,
  loadMerchantQuotes,
  openCustomizer,
  playCityDaySim,
  type CityDayBoard,
  type CityDayRow,
} from './games';
import { hudAvailable } from './hud';
import { fetchChainProof, me, refreshMe, type ChainProof } from './session';

type MarketListing = {
  id: string;
  tokenId: string;
  title: string;
  price: string;
  sellerName: string;
  sellerId: string;
};

let marketListings: MarketListing[] = [];
let marketErr = '';
let marketBusy = false;

async function loadMarket(): Promise<void> {
  try {
    const res = await fetch('/market', { credentials: 'include' });
    const data = (await res.json()) as { listings?: MarketListing[]; error?: string };
    if (!res.ok) throw new Error(data.error || 'Could not load market');
    marketListings = data.listings ?? [];
    marketErr = '';
  } catch (err) {
    marketErr = err instanceof Error ? err.message : 'Could not load market';
  } finally {
    if (phoneOpen && phoneApp === 'shop') phoneRefresh();
  }
}

export const LOCS = [
  { id: 'plaza', name: 'Central Plaza', x: 0, z: 6, r: 14, sp: [0, 10] as [number, number], note: 'The main square. Everyone passes through.' },
  { id: 'wall', name: 'Wall Street', x: -20, z: -4, r: 12, sp: [-15.5, -9] as [number, number], note: 'Trade coins at the Exchange.' },
  { id: 'lab', name: 'Vault Lab', x: 20, z: -4, r: 12, sp: [15.5, -9] as [number, number], note: 'Crack vaults and watch the bounty board.' },
  { id: 'tower', name: 'Attention Tower', x: 0, z: -26, r: 10, sp: [0, -25] as [number, number], note: 'Post, trend and gain followers.' },
  { id: 'forge', name: 'Gear Forge', x: 0, z: -10, r: 8, sp: [0, -6] as [number, number], note: 'Forge gear from shards.' },
  { id: 'diner', name: 'Neon Diner', x: 34, z: 24, r: 10, sp: [34, 20.5] as [number, number], note: 'Eat here. Paid in GD.' },
  { id: 'home', name: 'My Home', x: 22, z: 32, r: 10, sp: [22, 26.5] as [number, number], note: 'Your place.' },
];
export const GAS = GAS_GD;
export const locAt = (x: number, z: number) => {
  let b = LOCS[0]!,
    bd = 1e9;
  for (const l of LOCS) {
    const d = Math.hypot(x - l.x, z - l.z) - l.r;
    if (d < bd) {
      bd = d;
      b = l;
    }
  }
  return b;
};
export const here = () => {
  if (currentInterior === 'home') return LOCS.find(l => l.id === 'home')!;
  if (currentInterior === 'diner') return LOCS.find(l => l.id === 'diner')!;
  if (currentInterior === 'exchange') return LOCS.find(l => l.id === 'wall')!;
  if (currentInterior === 'vault') return LOCS.find(l => l.id === 'lab')!;
  if (currentInterior === 'tower') return LOCS.find(l => l.id === 'tower')!;
  if (currentInterior === 'forge') return LOCS.find(l => l.id === 'forge')!;
  return locAt(player.position.x, player.position.z);
};
/** Real multiplayer presence is not wired — only you count as “here”. */
export const peopleAt = (_id: string) => [] as Array<{ userData: { npc: { name: string } } }>;
const chatLog: Record<string, Array<{ who: string; text: string; t: number; me?: boolean }>> = {};
LOCS.forEach(l => {
  chatLog[l.id] = [];
});
const dms: Record<string, Array<{ text: string; me?: boolean; t: number }>> = {};
let unread = 0;
export let phoneOpen = false;
let advancedOpen = false;
let chainProof: ChainProof | null = null;
let chainErr = '';
let chainAt = 0;

function fmtUnits(raw: string): string {
  try {
    return BigInt(raw).toLocaleString('en-US');
  } catch {
    return raw;
  }
}

function explorerHref(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${encodeURIComponent(accountId)}`;
}

function proofHtml(): string {
  if (chainErr) return `<p class="hint">${esc(chainErr)}</p>`;
  if (!chainProof) return `<p class="hint">Loading on-chain proof…</p>`;
  const p = chainProof;
  const mock = p.chainMode === 'mock';
  const items = Object.entries(p.items);
  const itemRows =
    items.map(([id, n]) => `<li><code>${esc(id)}</code> ${esc(fmtUnits(n))}</li>`).join('') ||
    '<li>None</li>';
  const explorers = mock
    ? '<p class="hint">Local mock ledger — no testnet explorer.</p>'
    : `<p class="hint">
      <a href="${explorerHref(p.accountId)}" target="_blank" rel="noopener">Account</a>
      ${p.gdContract ? ` · <a href="${explorerHref(p.gdContract)}" target="_blank" rel="noopener">GD contract</a>` : ''}
      ${p.itemsContract ? ` · <a href="${explorerHref(p.itemsContract)}" target="_blank" rel="noopener">Items contract</a>` : ''}
    </p>`;
  return `<div class="proof">
    <div class="proof-id"><code>${esc(p.accountId)}</code><button type="button" data-a="copyacct">Copy</button></div>
    <div><span>GD on chain</span><b>${esc(fmtUnits(p.gdOnChain))}</b></div>
    <div><span>Available</span><b>${esc(fmtUnits(p.available))}</b></div>
    <div><span>Pending</span><b>${esc(fmtUnits(p.pending))}</b></div>
    <div class="proof-items"><span>Items</span><ul>${itemRows}</ul></div>
    <div><span>Network fees, covered by the game</span><b>${esc(p.nearBalance)} NEAR</b></div>
    ${explorers}
  </div>`;
}

function loadChainProof(): void {
  void fetchChainProof()
    .then(data => {
      chainProof = data;
      chainErr = '';
      chainAt = Date.now();
    })
    .catch(err => {
      chainErr = err instanceof Error ? err.message : 'Could not load on-chain proof';
    })
    .finally(() => {
      if (phoneOpen && phoneApp === 'set') phoneRefresh();
    });
}
/** v5: arm raise 0 = ribs hang; spread aims lift out. */
const CUSTOM_POSE_KEY = 'glitch-custom-pose-v5';
type PoseLimbId = 'armL' | 'armR' | 'legL' | 'legR';
type CustomPoseDraft = Record<PoseLimbId, PoseLimbDraft>;

const emptyLimbDraft = (): PoseLimbDraft => ({ raise: 0, spread: 0, bend: 0 });
const emptyPoseDraft = (): CustomPoseDraft => ({
  armL: emptyLimbDraft(),
  armR: emptyLimbDraft(),
  legL: emptyLimbDraft(),
  legR: emptyLimbDraft(),
});

function readLimbDraft(raw: unknown): PoseLimbDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const raise = Number(o.raise),
    spread = Number(o.spread),
    bend = Number(o.bend);
  if (![raise, spread, bend].every(Number.isFinite)) return null;
  return { raise, spread, bend };
}

function loadCustomPoseDraft(): CustomPoseDraft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_POSE_KEY) || 'null') as Partial<CustomPoseDraft> | null;
    if (!raw || typeof raw !== 'object') return null;
    const armL = readLimbDraft(raw.armL),
      armR = readLimbDraft(raw.armR),
      legL = readLimbDraft(raw.legL),
      legR = readLimbDraft(raw.legR);
    if (!armL || !armR || !legL || !legR) return null;
    return { armL, armR, legL, legR };
  } catch {
    return null;
  }
}

function saveCustomPoseDraft(xs: CustomPoseDraft) {
  localStorage.setItem(CUSTOM_POSE_KEY, JSON.stringify(xs));
}

function customPose(): Pose | null {
  const xs = loadCustomPoseDraft();
  return xs ? poseFromDraft(xs) : null;
}

let phoneApp: string | null = null,
  socialTab = 'all',
  chatTab = 'here',
  dmWith: string | null = null,
  profOf: string | null = null,
  poseEdit = false,
  poseLimb: PoseLimbId = 'armL',
  poseDraft: CustomPoseDraft = emptyPoseDraft();
const hash = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};
const BIOS = [
  'Early to everything. Late to nothing.',
  'Probably rugged once. Learned a lot.',
  'Building in public, sleeping in private.',
  'Number go up enthusiast.',
  'Audit first, ape later.',
  'gm from Lagos.',
];
const followersOf = (n: string) => 200 + (hash(n) % 9000);
const isFol = (n: string) => S.follows.includes(n);
export function chatIn(id: string, who: string, text: string, me?: boolean) {
  const a = chatLog[id]!;
  a.push({ who, text, t: Date.now(), me });
  if (a.length > 40) a.shift();
  if (phoneOpen && phoneApp === 'chat' && chatTab === 'here' && id === here().id) phoneRefresh();
}
function dmIn(name: string, text: string, me?: boolean) {
  (dms[name] = dms[name] || []).push({ text, me, t: Date.now() });
  if (!me && !(phoneOpen && phoneApp === 'chat' && dmWith === name)) {
    unread++;
    badge();
    banner(`${name} sent you a message`, 'info');
  }
  if (phoneOpen) phoneRefresh();
}
const REPLY: Array<[RegExp, string[]]> = [
  [/gm/i, ['gm gm', 'gm fren', 'gm, you early today']],
  [/buy|sell|price|trade|coin|moon/i, ['careful, markets are moody today', 'i only buy when everyone is scared', 'check the Exchange screen first', 'not financial advice but... send it']],
  [/hack|rug|scam|cia/i, ['stay safe out here, the CIA is watching', 'always check the audit first']],
  [/.*/, ['lol true', 'haha same', 'tell me more', 'you should come to Wall Street', 'nice, follow me back']],
];
function npcReply(name: string, text: string) {
  const r = REPLY.find(x => x[0].test(text))![1];
  setTimeout(() => dmIn(name, pick(r), false), rnd(1500, 3500));
}
function badge() {
  /* Unread shows on the Chat module; no HUD phone button. */
}
export function travel(id: string) {
  const l = LOCS.find(x => x.id === id);
  if (!l) return;
  if (S.bal < GAS) return banner('Not enough GD to travel', 'bad');
  if (currentInterior) clearInterior();
  burn(GAS);
  logTx('out', GAS, 'Fast travel');
  player.position.set(l.sp[0], 0, l.sp[1]);
  vel.x = vel.z = 0;
  cam.tx = l.sp[0];
  cam.tz = l.sp[1];
  closeModal();
  banner(`Arrived at ${l.name}. ${GAS} GD`, 'info');
  updateHud();
  save();
}

function refreshMyHomeQuotes() {
  if (phoneApp !== 'myhome') return;
  void loadMerchantQuotes()
    .then(() => {
      if (phoneOpen && phoneApp === 'myhome') phoneRefresh();
    })
    .catch(() => {});
}

export function openPhone(app?: string) {
  if (introOpen() || (modalOpen() && !phoneOpen)) return;
  if (phoneOpen) {
    phoneApp = app || null;
    renderPhone();
    if (phoneApp === 'myhome') refreshMyHomeQuotes();
    return;
  }
  phoneOpen = true;
  phoneApp = app || null;
  profOf = null;
  dmWith = null;
  openModal('', () => {
    phoneOpen = false;
    poseEdit = false;
    sheet.classList.remove('phonesheet', 'assist-sheet');
    sheet.onclick = null;
    sheet.onkeydown = null;
    sheet.oninput = null;
    updateAssistHint();
  });
  sheet.classList.add('phonesheet', 'assist-sheet');
  renderPhone();
  if (phoneApp === 'myhome') refreshMyHomeQuotes();
}
export function phoneRefresh() {
  if (!phoneOpen) return;
  const scr = sheet.querySelector('.ph-scr') as HTMLElement | null;
  const top = scr?.scrollTop ?? 0;
  const i = $('#pin') as HTMLInputElement | null,
    v = i && i.value,
    f = i && document.activeElement === i;
  renderPhone();
  const scr2 = sheet.querySelector('.ph-scr') as HTMLElement | null;
  if (scr2 && top) scr2.scrollTop = top;
  if (i) {
    const n = $('#pin') as HTMLInputElement | null;
    if (n && v != null) {
      n.value = v;
      if (f) {
        n.focus();
        n.setSelectionRange(v.length, v.length);
      }
    }
  }
}
const ago2 = (t: number) => {
  const s = t > 1e12 ? Math.floor((Date.now() - t) / 1000) : Math.max(0, Math.floor(serverTick / 2 - t));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h';
};
const clampMap = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const hdr = (title: string, back?: string) =>
  `<div class="ph-h">${back ? `<button data-a="${back}">‹</button>` : ''}<b>${title}</b></div>`;

const BEGINNER_HINTS = [
  'Neon Diner east — walk in and Use the counter to eat.',
  'Vault Lab — Use a terminal to crack vaults for shards.',
  'Gear Forge — spend shards to mint wearable gear.',
  'My Home — buy a studio, then sleep to restore energy.',
  'Step to a lit door, press Use to enter. E also works.',
  'Hold-drag to look. Click me anytime for modules.',
];
const MID_HINTS = [
  'Skill pay caps daily — after the meter fills you only get 20%.',
  'Market module lists furniture or gear for GD (2% sale fee).',
  'Forge mint prices follow the smith quote — check GD before minting.',
  'Home maintenance is due each period or the bed locks.',
  'Trade / Security / Community XP shapes your role.',
];
const HIGH_HINTS = [
  'Tired or hungry cuts skill pay by 40% — eat and rest first.',
  'Listing fee is 2% — price above the floor for a clean sale.',
  'Daily skill cap is based on your levels; bank wins as settling.',
  'Wanted status overrides your role until it expires.',
];

function skillTier(): 'beginner' | 'mid' | 'high' {
  const mx = Math.max(L('trade'), L('sec'), L('comm'));
  if (mx < 2) return 'beginner';
  if (mx <= 3) return 'mid';
  return 'high';
}

function contextHint(): string | null {
  const p = player.position;
  const near = (x: number, z: number, r: number) => Math.hypot(p.x - x, p.z - z) < r;
  if (near(34, 24, 14)) return 'Diner: Use the counter to buy food and refill hunger.';
  if (near(20, -4, 14)) return 'Vault Lab: Use a terminal — locks pay GD and shards.';
  if (near(0, -10, 12)) return 'Forge: mint gear NFTs when you have shards + GD.';
  if (near(0, 6, 12)) return 'Plaza: check the Exchange screens, then open Map for places.';
  if (S.home.owned && near(22, 32, 14)) return 'Home: Use the bed to sleep. Pay maintenance if overdue.';
  return null;
}

const HINTS_KEY = 'glitch-assist-hints';

export function assistHintsEnabled(): boolean {
  try {
    return localStorage.getItem(HINTS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAssistHintsEnabled(on: boolean) {
  try {
    localStorage.setItem(HINTS_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  updateAssistHint();
}

export function currentAssistHint(): string {
  const ctx = contextHint();
  if (ctx && skillTier() === 'beginner') return ctx;
  const pool = skillTier() === 'beginner' ? BEGINNER_HINTS : skillTier() === 'mid' ? MID_HINTS : HIGH_HINTS;
  const i = Math.floor(Date.now() / 12000) % pool.length;
  return pool[i]!;
}

export function updateAssistHint() {
  const el = $('#assistHint') as HTMLElement | null;
  const text = $('#assistHintText') as HTMLElement | null;
  if (!el) return;
  const coach = $('#coach') as HTMLElement | null;
  if (!assistHintsEnabled() || phoneOpen || introOpen() || (coach && !coach.hidden)) {
    el.hidden = true;
    return;
  }
  const pos = assistantScreenPos();
  if (!pos) {
    el.hidden = true;
    return;
  }
  const app = $('#app') as HTMLElement;
  const ar = app.getBoundingClientRect();
  el.hidden = false;
  if (text) text.textContent = currentAssistHint();
  // Sit above-right of the bot (away from the player). Flip to left only if it would leave the screen.
  const localX = pos.x - ar.left;
  const localY = pos.y - ar.top;
  const flipLeft = localX > ar.width * 0.62;
  el.dataset.side = flipLeft ? 'left' : 'right';
  el.style.left = `${Math.round(localX)}px`;
  el.style.top = `${Math.round(localY - 10)}px`;
}

const dayClockSpan = (hours: number) => {
  const h = Math.max(0, Math.floor(hours));
  return `${String(h).padStart(2, '0')}:00`;
};

function dayMove(open: number, price: number): { text: string; cls: 'up' | 'dn' | 'flat' } {
  if (!(open > 0)) return { text: '—', cls: 'flat' };
  const p = ((price - open) / open) * 100;
  if (Math.abs(p) < 0.05) return { text: '0%', cls: 'flat' };
  const digits = Math.abs(p) >= 10 ? 0 : 1;
  return { text: `${p > 0 ? '+' : ''}${p.toFixed(digits)}%`, cls: p > 0 ? 'up' : 'dn' };
}

function daySentence(d: CityDayBoard): string {
  if (d.phase === 'loading') return 'Building a seeded 24-hour city.';
  if (d.phase === 'error') return d.error || 'Could not simulate.';
  const rows = d.shops.flatMap(s => s.rows);
  let best: CityDayRow | null = null;
  let bestAbs = 0;
  for (const row of rows) {
    const abs = row.open > 0 ? Math.abs(row.high - row.open) / row.open : 0;
    if (abs > bestAbs) {
      bestAbs = abs;
      best = row;
    }
  }
  const soFar = d.phase === 'done' ? '' : ' so far';
  const head =
    d.pumps + d.rugs === 0
      ? `No pumps or rugs${soFar}`
      : `${fmtN(d.pumps + d.rugs)} headlines${soFar} (${d.pumps} pump${d.pumps === 1 ? '' : 's'}, ${d.rugs} rug${d.rugs === 1 ? '' : 's'})`;
  if (!best || bestAbs < 0.01) return `${head}. Nothing moved more than 1%.`;
  return `${head}. Biggest spike: ${best.title} ${dayMove(best.open, best.high).text}.`;
}

function citySimBtn(): string {
  if (cityDay.phase === 'loading') return 'Fetching the day…';
  if (citySimPlaying) return 'Playing the day…';
  if (cityDay.phase === 'done') return 'Play this day again';
  return 'Simulate 1 day';
}

function cityDayHtml(): string {
  const d = cityDay;
  const end = dayClockSpan(d.hours);
  const shown = d.headlines.slice(0, d.shownHeadlines);
  const recent = shown.slice(-3).reverse();
  const movedRows = d.shops.flatMap(shop =>
    shop.rows
      .filter(row => row.open > 0 && Math.abs(row.high - row.open) / row.open >= 0.01)
      .map(row => ({ shop: shop.name, row })),
  );
  const quiet = d.shops.reduce((n, shop) => n + shop.rows.length, 0) - movedRows.length;
  const byShop = new Map<string, typeof movedRows>();
  for (const item of movedRows) {
    const list = byShop.get(item.shop) ?? [];
    list.push(item);
    byShop.set(item.shop, list);
  }
  const shops = [...byShop.entries()]
    .map(([name, items]) => {
      items.sort((a, b) => {
        const aa = Math.abs(a.row.high - a.row.open) / a.row.open;
        const bb = Math.abs(b.row.high - b.row.open) / b.row.open;
        return bb - aa || b.row.sales - a.row.sales;
      });
      const rows = items
        .map(({ row }) => {
          const mv = dayMove(row.open, row.high);
          const sold = row.sales === 1 ? '1 sale' : `${row.sales} sales`;
          const closed =
            d.phase === 'done' && row.open > 0 && Math.abs(row.close - row.open) / row.open >= 0.01
              ? `<small>Closed ${fmtN(row.close)} ${dayMove(row.open, row.close).text}</small>`
              : '';
          return `<div class="day-row"><div class="day-name"><b>${esc(row.title)}</b><small>${sold}</small>${closed}</div><div class="day-end"><span class="px">${fmtN(row.high)} peak</span><span class="day-chip ${mv.cls}">${mv.text}</span></div></div>`;
        })
        .join('');
      return `<section class="day-shop"><b>${esc(name)}</b>${rows}</section>`;
    })
    .join('');
  const quietLine =
    movedRows.length === 0
      ? `<p class="hint">${d.phase === 'loading' ? 'Waiting for the first sales.' : 'No price moved more than 1% from the open.'}</p>`
      : quiet > 0
        ? `<p class="hint">${quiet} other good${quiet === 1 ? '' : 's'} stayed within 1% of the open.</p>`
        : '';
  const headlines =
    recent.length === 0
      ? `<p class="hint">${d.phase === 'done' ? 'No pumps or rugs this day.' : 'No headlines yet.'}</p>`
      : recent
          .map(h => {
            const sec = Math.max(0, Math.floor(h.t));
            const clock = `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
            const kind = h.kind === 'pump' ? 'pump' : 'rug';
            const label = h.kind === 'pump' ? 'Pump' : 'Rug';
            return `<div class="day-h"><time>${clock}</time><span class="pill ${kind}">${label}</span><span>${esc(h.title)}</span></div>`;
          })
          .join('') +
        (shown.length > recent.length ? `<p class="hint">Latest ${recent.length} of ${fmtN(shown.length)}.</p>` : '');
  const title = d.phase === 'done' ? 'Day recap' : d.phase === 'error' ? 'Day sim' : 'Today in the city';
  const sub =
    d.phase === 'done'
      ? 'Percents are the day’s peak, not the close. Shops restock, so most prices finish near the open. Playback only.'
      : 'Peaks versus the morning open. Playback only — your balance stays real.';
  return `<article class="day" aria-live="polite">
    <div class="day-top"><b>${title}</b><span class="day-clock">${esc(d.clock)} / ${end}</span></div>
    <div class="day-meter" aria-hidden="true"><i style="width:${Math.round(d.progress * 100)}%"></i></div>
    <p class="day-line">${esc(daySentence(d))}</p>
    <div class="day-stats"><span><b>${fmtN(d.sales)}</b><small>Sales</small></span><span><b class="pos">${d.pumps}</b><small>Pumps</small></span><span><b class="neg">${d.rugs}</b><small>Rugs</small></span></div>
    ${d.latest ? `<p class="hint">${esc(d.latest)}</p>` : ''}
    ${shops}
    ${quietLine}
    <section class="day-shop"><b>Headlines</b>${headlines}</section>
    <p class="hint">${sub}</p>
  </article>`;
}

function renderPhone() {
  const t = new Date().toTimeString().slice(0, 5),
    L0 = here();
  let body = '';
  if (!phoneApp) {
    const ap = (id: string, nm: string, col: string, ch: string, soon?: number) =>
      `<button class="ap ${soon ? 'soon' : ''}" ${soon ? 'disabled' : `data-a="app" data-v="${id}"`}><i style="background:${col}">${ch}${id === 'chat' && unread ? `<u>${unread}</u>` : ''}</i><span>${nm}</span></button>`;
    body =
      `<div class="ph-h"><b>Modules</b></div>` +
      (assistHintsEnabled()
        ? `<p class="assist-tip">${esc(currentAssistHint())}</p>`
        : `<p class="assist-tip muted">Hints hidden. <button type="button" class="lnk" data-a="hintsOn">Show hints</button></p>`) +
      `<div class="apps">${ap('social', 'Social', '#2ee6ff', 'S')}${ap('chat', 'Chat', '#b8ff3d', 'C')}${ap('map', 'Map', '#ffb12e', 'M')}${ap('wallet', 'Balance', '#ff3d9a', 'W')}${ap('me', 'Profile', '#7a8cff', 'P')}${ap('pose', 'Pose', '#ff7a59', '◇')}${ap('set', 'Settings', '#8b97b8', '⚙')}${ap('myhome', 'My Home', '#3dffb0', 'H')}${ap('shop', 'Market', '#26324f', '$')}</div>`;
  } else if (phoneApp === 'pose') {
    if (poseEdit) {
      const draftPose = poseFromDraft(poseDraft);
      const limb = poseDraft[poseLimb];
      const isArm = poseLimb === 'armL' || poseLimb === 'armR';
      const bendLabel = isArm ? 'Elbow' : 'Knee';
      const chip = (id: PoseLimbId, label: string) =>
        `<button type="button" class="pose-chip${poseLimb === id ? ' on' : ''}" data-a="poseLimb" data-v="${id}">${label}</button>`;
      const row = (key: keyof PoseLimbDraft, label: string, min: number, max: number) => {
        const v = limb[key];
        const deg = Math.round((v * 180) / Math.PI);
        return `<label class="pose-row"><span>${label} <small>${deg}°</small></span><input type="range" data-pose-axis="${key}" min="${min}" max="${max}" step="0.05" value="${v}"></label>`;
      };
      body =
        hdr('Make a pose', 'poseList') +
        `<p class="hint">${isArm ? 'Raise 0 = arm at ribs; higher lifts. Spread aims the lift out (T-pose = raise + spread).' : 'Raise / spread the leg.'} ${bendLabel} bends.</p>` +
        `<div class="pose-stage" id="poseLive">${poseSvgMarkup(draftPose, { size: 148, className: 'pose-fig pose-fig-lg' })}</div>` +
        `<div class="pose-chips">${chip('armL', 'Arm L')}${chip('armR', 'Arm R')}${chip('legL', 'Leg L')}${chip('legR', 'Leg R')}</div>` +
        row('raise', isArm ? 'Raise (0 = ribs)' : 'Raise', isArm ? -0.8 : -2.4, 2.4) +
        row('spread', 'Spread out', 0, 1.7) +
        row('bend', bendLabel, isArm ? -2.3 : 0, 2.3) +
        `<div class="acts"><button class="pri" data-a="poseSave">Save pose</button><button data-a="poseList">Cancel</button></div>`;
    } else {
      const custom = loadCustomPoseDraft();
      const customP = customPose();
      const activePreset = POSE_PRESETS.find(p => p.id === heldPoseId);
      const activePose: Pose =
        heldPoseId === 'custom' && customP
          ? customP
          : activePreset?.pose ?? NEUTRAL_POSE;
      const activeName =
        heldPoseId === 'custom'
          ? 'Your pose'
          : activePreset?.name ?? 'Standing';
      const card = (id: string, name: string, p: Pose, badge?: string) => {
        const on = heldPoseId === id ? ' on' : '';
        const tag = badge ? `<em class="pose-badge">${esc(badge)}</em>` : '';
        return `<button type="button" class="pose-card${on}" data-a="posePick" data-v="${esc(id)}">
          <span class="pose-thumb">${poseSvgMarkup(p, { size: 88, className: 'pose-fig' })}</span>
          <span class="pose-card-name">${esc(name)}${tag}</span>
        </button>`;
      };
      const cards = POSE_PRESETS.map(p => card(p.id, p.name, p.pose)).join('');
      const customCard = customP
        ? card('custom', 'Your pose', customP, 'saved')
        : '';
      body =
        hdr('Pose', 'home') +
        `<p class="hint">Tap a silhouette. Holds until you walk.</p>` +
        `<div class="pose-now${heldPoseId ? ' live' : ''}">
          <div class="pose-stage sm">${poseSvgMarkup(activePose, { size: 112, className: 'pose-fig pose-fig-lg' })}</div>
          <div class="pose-now-meta"><small>Now</small><b>${esc(activeName)}</b></div>
        </div>` +
        `<div class="pose-grid">${customCard}${cards}</div>` +
        `<div class="acts"><button class="pri" data-a="poseEdit">${custom ? 'Edit my pose' : 'Make a pose'}</button>${heldPoseId ? '<button data-a="poseClear">Clear</button>' : ''}</div>`;
    }
  } else if (phoneApp === 'shop') {
    void loadMarket();
    void refreshMe().catch(() => {});
    const owned = Object.entries(me?.items ?? {}).filter(
      ([id, n]) => isPlayerListableToken(id) && BigInt(n) > 0n,
    );
    const mine = marketListings.filter(l => l.sellerName === S.name);
    const others = marketListings.filter(l => l.sellerName !== S.name);
    const opt =
      owned
        .map(
          ([id]) =>
            `<option value="${esc(id)}">${esc(listableTokenTitle(id))}</option>`,
        )
        .join('') || '<option value="">No listable items</option>';
    body =
      hdr('Market', 'home') +
      `<p class="hint">List furniture or gear for ${MARKET_LIST_MIN_GD}–${fmtN(MARKET_LIST_MAX_GD)} GD. Fee 2% on sale.</p>` +
      (marketErr ? `<p class="hint" style="color:var(--pink)">${esc(marketErr)}</p>` : '') +
      `<div class="cmp"><select id="mktToken">${opt}</select></div>` +
      `<div class="cmp"><input id="mktPrice" type="number" min="${MARKET_LIST_MIN_GD}" max="${MARKET_LIST_MAX_GD}" value="500" placeholder="Price GD"><button class="pri" data-a="mktlist" ${marketBusy || !owned.length ? 'disabled' : ''}>List</button></div>` +
      `<h3>Open listings</h3>` +
      (others.length
        ? others
            .map(
              l =>
                `<div class="row"><span><b>${esc(l.title)}</b><small>${esc(l.sellerName)} · ${esc(fmtN(Number(l.price)))} GD</small></span><button class="pri" data-a="mktbuy" data-v="${esc(l.id)}" ${marketBusy ? 'disabled' : ''}>Buy</button></div>`,
            )
            .join('')
        : '<p class="hint">No open listings yet.</p>') +
      (mine.length
        ? `<h3>Your listings</h3>` +
          mine
            .map(
              l =>
                `<div class="row"><span><b>${esc(l.title)}</b><small>${esc(fmtN(Number(l.price)))} GD</small></span><button data-a="mktcancel" data-v="${esc(l.id)}" ${marketBusy ? 'disabled' : ''}>Cancel</button></div>`,
            )
            .join('')
        : '');
  } else if (phoneApp === 'social') {
    const list = feed.filter(p => socialTab === 'all' || isFol(p.who) || p.who === S.name).slice(0, 30);
    body =
      hdr('Social', 'home') +
      `<div class="chips"><button data-a="stab" data-v="all" class="${socialTab === 'all' ? 'on' : ''}">For you</button><button data-a="stab" data-v="fol" class="${socialTab === 'fol' ? 'on' : ''}">Following</button></div>
    <div class="cmp"><input id="pin" type="text" maxlength="120" placeholder="What's happening in the city?" autocomplete="off"><button class="pri" data-a="post">Post</button></div>` +
      (list
        .map(p => {
          const i = feed.indexOf(p),
            me = p.who === S.name,
            clk = p.kind === 'npc' || me;
          return `<div class="post ${p.kind}"><time>${ago2(p.t)}</time>${clk ? `<button class="lnk" data-a="prof" data-v="${esc(p.who)}">${esc(p.who)}</button>` : `<span class="who">${esc(p.who)}</span>`}<div>${esc(p.text)}</div><button class="lnk lk ${p.me ? 'liked' : ''}" data-a="like" data-v="${i}">♥ ${p.likes + (p.me ? 1 : 0)}</button></div>`;
        })
        .join('') || '<p class="hint">Nothing yet. Follow people to fill this tab.</p>');
  } else if (phoneApp === 'prof') {
    const n = profOf!,
      me = n === S.name || n === 'me';
    const mine = feed.filter(p => p.who === (me ? S.name : n)).slice(0, 5);
    body =
      hdr(me ? S.name : n, 'social') +
      `<div class="pf"><i>${esc((me ? S.name : n)[0]!.toUpperCase())}</i><div><b>${esc(me ? S.name : n)}</b><div class="hint">${me ? roleName() + ' · Rep ' + S.rep : BIOS[hash(n) % BIOS.length]}</div></div></div>
    <div class="pstats"><span><b>${fmtN(me ? S.followers : followersOf(n))}</b><small>Followers</small></span><span><b>${me ? S.follows.length : 20 + (hash(n) % 300)}</b><small>Following</small></span></div>` +
      (me
        ? ''
        : `<div class="acts"><button class="${isFol(n) ? '' : 'pri'}" data-a="fol" data-v="${esc(n)}">${isFol(n) ? 'Following' : 'Follow'}</button><button data-a="dm" data-v="${esc(n)}">Message</button></div>`) +
      mine.map(p => `<div class="post"><time>${ago2(p.t)}</time><div>${esc(p.text)}</div></div>`).join('');
  } else if (phoneApp === 'chat' && dmWith) {
    const th = dms[dmWith] || [];
    if (unread) {
      unread = 0;
      badge();
    }
    body =
      hdr(esc(dmWith), 'inbox') +
      `<div class="msgs">${th.map(m => `<div class="m ${m.me ? 'me' : ''}">${esc(m.text)}</div>`).join('') || '<p class="hint">Say hi.</p>'}</div><div class="cmp"><input id="pin" type="text" maxlength="120" placeholder="Message" autocomplete="off"><button class="pri" data-a="sendDM">Send</button></div>`;
  } else if (phoneApp === 'chat') {
    const pp = peopleAt(L0.id);
    body =
      hdr('Chat', 'home') +
      `<div class="chips"><button data-a="ctab" data-v="here" class="${chatTab === 'here' ? 'on' : ''}">Here</button><button data-a="ctab" data-v="inbox" class="${chatTab === 'inbox' ? 'on' : ''}">Messages${unread ? ' (' + unread + ')' : ''}</button></div>`;
    if (chatTab === 'here')
      body += `<div class="hint"><b>${L0.name}</b> · ${pp.length + 1} here. Messages go to everyone in this place. Tap a name to message one person.</div>
      <div class="chips">${pp.map(a => `<button data-a="dm" data-v="${esc((a.userData.npc as { name: string }).name)}">${esc((a.userData.npc as { name: string }).name)}</button>`).join('') || '<small>Nobody else here yet</small>'}</div>
      <div class="msgs">${chatLog[L0.id]!.slice(-14).map(m => `<div class="m ${m.me ? 'me' : ''}"><small>${esc(m.who)}</small>${esc(m.text)}</div>`).join('') || '<p class="hint">Quiet here. Say something.</p>'}</div><div class="cmp"><input id="pin" type="text" maxlength="120" placeholder="Message everyone here" autocomplete="off"><button class="pri" data-a="sendLoc">Send</button></div>`;
    else
      body +=
        Object.keys(dms)
          .map(n => {
            const l = dms[n]![dms[n]!.length - 1]!;
            return `<button class="thr" data-a="dm" data-v="${esc(n)}"><b>${esc(n)}</b><span>${esc(l.text)}</span></button>`;
          })
          .join('') || '<p class="hint">No messages yet. Tap a name in Here to start one.</p>';
  } else if (phoneApp === 'map') {
    // Plaza-focused map (home exterior is on the rim; far-plot interiors are not drawn).
    const X = (x: number) => 150 + x * 2.6,
      Z = (z: number) => 118 + z * 2.2;
    const pin = (cx: number, cy: number, here: boolean, count: number, id: string, name: string) => {
      const fill = here ? '#2ee6ff' : '#7a8cff';
      const tip = cy + 14;
      return `<g data-a="go" data-v="${id}" style="cursor:pointer">
        <path d="M${cx} ${cy - 10} C${cx + 8} ${cy - 10} ${cx + 8} ${cy + 2} ${cx} ${tip} C${cx - 8} ${cy + 2} ${cx - 8} ${cy - 10} ${cx} ${cy - 10}Z" fill="${fill}" stroke="${here ? '#e9eefc' : '#26324f'}" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy - 4}" r="3.2" fill="#04060c"/>
        <text x="${cx}" y="${cy - 18}" text-anchor="middle" fill="#e9eefc" font-size="8" font-family="Chakra Petch,sans-serif">${esc(name)}</text>
        <text x="${cx + 10}" y="${cy - 2}" fill="#b8ff3d" font-size="8" font-family="sans-serif">${count}</text>
      </g>`;
    };
    const mapLocs = LOCS;
    const px = clampMap(X(player.position.x), 12, 288),
      pz = clampMap(Z(player.position.z), 12, 208);
    body =
      hdr('Map', 'home') +
      `<svg viewBox="0 0 300 220" class="map"><rect width="300" height="220" fill="#04060c"/>
      <circle cx="150" cy="130" r="42" fill="none" stroke="#1a2440" stroke-width="1"/>
      ${mapLocs
        .map(l => {
          const n = peopleAt(l.id).length + (l.id === L0.id ? 1 : 0);
          return pin(X(l.x), Z(l.z), l.id === L0.id, n, l.id, l.name.split(' ')[0]!);
        })
        .join('')}
      <circle cx="${px}" cy="${pz}" r="5" fill="#b8ff3d" stroke="#041008" stroke-width="2"/>
      <text x="${px}" y="${pz - 9}" text-anchor="middle" fill="#b8ff3d" font-size="7" font-family="sans-serif">you</text>
      </svg>
    <p class="hint">Walking is free. Fast travel costs ${GAS} GD.</p>` +
      mapLocs
        .map(l => {
          const n = peopleAt(l.id).length + (l.id === L0.id ? 1 : 0);
          return `<div class="loc"><div><b>${l.name}</b> ${l.id === L0.id ? '<span class="tag">You are here</span>' : ''}<div class="hint">${l.note} · ${n} people</div></div>${l.id === L0.id ? '' : `<button data-a="go" data-v="${l.id}">Go</button>`}</div>`;
        })
        .join('');
  } else if (phoneApp === 'wallet') {
    body =
      hdr('Balance', 'home') +
      `<div class="res win" style="padding:6px 0"><small>Balance</small><b>${fmtN(hudAvailable ?? S.bal)} GD</b></div><div class="pstats"><span><b>${S.shards}</b><small>Shards</small></span><span><b>${S.nfts.length}</b><small>NFTs</small></span></div><div class="hint">Daily skill pay: ${fmt(S.payUsed)} of ${fmt(payCap())} used. After that it pays only 20%.${weak() ? ' <b class="neg">Tired or hungry: skill pay is cut by 40%.</b>' : ''}</div><div class="meter"><i style="width:${Math.min(100, (S.payUsed / payCap()) * 100)}%"></i></div>
    <div class="acts" style="margin-top:10px"><button data-a="citysim" ${citySimPlaying ? 'disabled' : ''}>${citySimBtn()}</button></div>
    ${cityDay.phase === 'idle' ? '<p class="hint">One minute of playback for 24 hours. Your balance and live shop prices stay real.</p>' : cityDayHtml()}` +
      `<small style="display:block;margin-top:10px">Activity (every move is recorded, like a block explorer)</small>` +
      (txlog
        .slice(0, 12)
        .map(
          x =>
            `<div class="tx"><span class="${x.kind === 'in' ? 'pos' : 'neg'}">${x.kind === 'in' ? '+' : '-'}${fmtN(Math.abs(x.amt))}</span><span>${esc(x.note)}</span><code>${x.h}</code></div>`,
        )
        .join('') || '<p class="hint">No activity yet. Play a game.</p>');
  } else if (phoneApp === 'myhome') {
    body = homeHtml(hdr);
  } else if (phoneApp === 'me') {
    profOf = 'me';
    phoneApp = 'prof';
    return renderPhone();
  } else if (phoneApp === 'set') {
    if (!chainProof && !chainErr) loadChainProof();
    body =
      hdr('Settings', 'home') +
      (chainProof?.chainMode === 'mock'
        ? `<p class="tag mock-chain" style="margin:0 0 8px">Mock chain (no testnet)</p>`
        : '') +
      `<small>Display name</small><div class="cmp"><input id="pin" type="text" maxlength="14" value="${esc(S.name)}"><button class="pri" data-a="name">Save</button></div>` +
      `<div class="acts"><button data-a="style">Change my look</button>` +
      `<button data-a="${assistHintsEnabled() ? 'hintsOff' : 'hintsOn'}">${assistHintsEnabled() ? 'Hide floating hints' : 'Show floating hints'}</button></div>` +
      `<details class="adv"${advancedOpen ? ' open' : ''}><summary>Advanced</summary><h3>Onchain proof</h3>${proofHtml()}</details><div class="acts"><button class="dn" data-a="reset">Reset progress</button></div>`;
  }
  sheet.innerHTML = `<div class="ph-bar"><span>ASSIST · ONLINE</span><span>${esc(L0.name)}</span><span>${t}</span></div><div class="ph-scr">${body}</div><div class="ph-nav"><button data-a="home" aria-label="Modules home"></button></div>`;
  sheet.onclick = e => {
    const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const a = b.dataset.a!,
      v = b.dataset.v,
      inp = $('#pin') as HTMLInputElement | null;
    if (a === 'home') {
      phoneApp = null;
      dmWith = null;
      poseEdit = false;
    } else if (a === 'app') {
      phoneApp = v!;
      poseEdit = false;
      if (v === 'chat') {
        chatTab = 'here';
        dmWith = null;
      }
      if (v === 'pose') {
        const xs = loadCustomPoseDraft();
        poseDraft = xs
          ? {
              armL: { ...xs.armL },
              armR: { ...xs.armR },
              legL: { ...xs.legL },
              legR: { ...xs.legR },
            }
          : emptyPoseDraft();
        poseLimb = 'armL';
      }
    } else if (a === 'hintsOn') {
      setAssistHintsEnabled(true);
    } else if (a === 'hintsOff') {
      setAssistHintsEnabled(false);
    } else if (a === 'poseList') {
      poseEdit = false;
      phoneApp = 'pose';
    } else if (a === 'poseLimb' && v && ['armL', 'armR', 'legL', 'legR'].includes(v)) {
      poseLimb = v as PoseLimbId;
      phoneApp = 'pose';
      poseEdit = true;
    } else if (a === 'poseEdit') {
      const xs = loadCustomPoseDraft();
      poseDraft = xs
        ? {
            armL: { ...xs.armL },
            armR: { ...xs.armR },
            legL: { ...xs.legL },
            legR: { ...xs.legR },
          }
        : emptyPoseDraft();
      poseLimb = 'armL';
      setHeldPose(poseFromDraft(poseDraft), 'custom');
      poseEdit = true;
      phoneApp = 'pose';
    } else if (a === 'posePick') {
      if (v === 'custom') {
        const p = customPose();
        if (p) setHeldPose(p, 'custom');
      } else {
        const preset = POSE_PRESETS.find(p => p.id === v);
        if (preset) setHeldPose(preset.pose, preset.id);
      }
    } else if (a === 'poseClear') {
      setHeldPose(null, null);
    } else if (a === 'poseSave') {
      saveCustomPoseDraft({
        armL: { ...poseDraft.armL },
        armR: { ...poseDraft.armR },
        legL: { ...poseDraft.legL },
        legR: { ...poseDraft.legR },
      });
      setHeldPose(poseFromDraft(poseDraft), 'custom');
      poseEdit = false;
      banner('Pose saved', 'good');
    } else if (a === 'social') phoneApp = 'social';
    else if (a === 'inbox') {
      dmWith = null;
      chatTab = 'inbox';
      phoneApp = 'chat';
    } else if (a === 'stab') socialTab = v!;
    else if (a === 'ctab') chatTab = v!;
    else if (a === 'like') {
      const p = feed[+v!]!;
      if (p) p.me = !p.me;
    } else if (a === 'prof') {
      profOf = v!;
      phoneApp = 'prof';
    } else if (a === 'fol') {
      if (isFol(v!)) S.follows = S.follows.filter(x => x !== v);
      else {
        S.follows.push(v!);
        S.rep += 0;
      }
      save();
    } else if (a === 'dm') {
      dmWith = v!;
      phoneApp = 'chat';
      chatTab = 'inbox';
      if (v === S.name) return;
    } else if (a === 'post') {
      const x = inp!.value.trim();
      if (!x) return;
      post('npc', S.name, x);
      S.stats.posts++;
      S.followers += Math.floor(rnd(0, 3));
      save();
    } else if (a === 'sendLoc') {
      const x = inp!.value.trim();
      if (!x) return;
      chatIn(here().id, S.name, x, true);
    } else if (a === 'sendDM') {
      const x = inp!.value.trim();
      if (!x) return;
      dmIn(dmWith!, x, true);
      npcReply(dmWith!, x);
    } else if (a === 'go') return travel(v!);
    else if (['buyhome', 'paymaintenance', 'furn', 'gohome', 'homepaint'].includes(a)) {
      if (homeAct(a, v)) return;
    } else if (a === 'copyacct') {
      const id = chainProof?.accountId;
      if (!id) return;
      void navigator.clipboard.writeText(id).then(
        () => banner('Copied', 'good'),
        () => banner('Could not copy', 'bad'),
      );
      return;
    } else if (a === 'mktlist') {
      if (marketBusy) return;
      const tokenEl = $('#mktToken') as HTMLSelectElement | null;
      const priceEl = $('#mktPrice') as HTMLInputElement | null;
      const tokenId = tokenEl?.value?.trim() ?? '';
      const price = Number(priceEl?.value ?? 0);
      if (!tokenId) {
        banner('Pick an item to list', 'bad');
        return;
      }
      marketBusy = true;
      void fetch('/market/list', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenId, price }),
      })
        .then(async res => {
          const data = (await res.json()) as { error?: string };
          if (!res.ok) throw new Error(data.error || 'List failed');
          banner('Listed', 'good');
          await loadMarket();
          await refreshMe();
        })
        .catch(err => banner(err instanceof Error ? err.message : 'List failed', 'bad'))
        .finally(() => {
          marketBusy = false;
          phoneRefresh();
        });
      return;
    } else if (a === 'mktbuy') {
      if (marketBusy || !v) return;
      marketBusy = true;
      void fetch('/market/buy', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: v }),
      })
        .then(async res => {
          const data = (await res.json()) as { error?: string; settling?: boolean };
          if (!res.ok) throw new Error(data.error || 'Buy failed');
          banner(data.settling ? 'Settling…' : 'Bought', 'good');
          await loadMarket();
          await refreshMe();
          updateHud();
        })
        .catch(err => banner(err instanceof Error ? err.message : 'Buy failed', 'bad'))
        .finally(() => {
          marketBusy = false;
          phoneRefresh();
        });
      return;
    } else if (a === 'mktcancel') {
      if (marketBusy || !v) return;
      marketBusy = true;
      void fetch('/market/cancel', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: v }),
      })
        .then(async res => {
          const data = (await res.json()) as { error?: string };
          if (!res.ok) throw new Error(data.error || 'Cancel failed');
          banner('Listing cancelled', 'good');
          await loadMarket();
        })
        .catch(err => banner(err instanceof Error ? err.message : 'Cancel failed', 'bad'))
        .finally(() => {
          marketBusy = false;
          phoneRefresh();
        });
      return;
    } else if (a === 'name') {
      const x = inp!.value.trim().slice(0, 14);
      if (x) {
        S.name = x;
        save();
        updateHud();
      }
    } else if (a === 'citysim') {
      if (citySimPlaying) return;
      void playCityDaySim(() => {
        if (phoneOpen && phoneApp === 'wallet') phoneRefresh();
      }).catch(err => banner(err instanceof Error ? err.message : 'Could not simulate', 'bad'));
      return;
    } else if (a === 'style') {
      closeModal();
      return openCustomizer();
    } else if (a === 'reset') {
      try {
        localStorage.removeItem(SAVE);
      } catch {
        /* ignore */
      }
      return location.reload();
    }
    renderPhone();
    if ((a === 'app' && v === 'myhome') || a === 'buyhome' || a === 'furn') refreshMyHomeQuotes();
    const n = $('#pin') as HTMLInputElement | null;
    if (n && (a === 'post' || a === 'sendLoc' || a === 'sendDM')) {
      n.value = '';
      n.focus();
    }
  };
  sheet.onkeydown = e => {
    if (e.key === 'Enter' && (e.target as HTMLElement).id === 'pin') {
      const b = sheet.querySelector('.cmp .pri') as HTMLButtonElement | null;
      if (b) b.click();
    }
  };
  const adv = sheet.querySelector('details.adv') as HTMLDetailsElement | null;
  adv?.addEventListener('toggle', () => {
    advancedOpen = adv.open;
    if (advancedOpen && Date.now() - chainAt > 5000) loadChainProof();
  });
  sheet.oninput = e => {
    const t = e.target as HTMLInputElement | null;
    if (!t || t.type !== 'range' || !t.dataset.poseAxis) return;
    const axis = t.dataset.poseAxis as keyof PoseLimbDraft;
    const val = Number(t.value);
    if (!Number.isFinite(val)) return;
    const isLeg = poseLimb === 'legL' || poseLimb === 'legR';
    poseDraft[poseLimb][axis] = axis === 'bend' && isLeg ? Math.max(0, val) : val;
    const live = poseFromDraft(poseDraft);
    setHeldPose(live, 'custom');
    const label = t.closest('label')?.querySelector('small');
    if (label) label.textContent = `${Math.round((val * 180) / Math.PI)}°`;
    const stage = sheet.querySelector('#poseLive');
    if (stage) stage.innerHTML = poseSvgMarkup(live, { size: 148, className: 'pose-fig pose-fig-lg' });
  };
}

setAssistantClickHandler(() => {
  if (phoneOpen) closeModal();
  else openPhone();
});
($('#assistHintHide') as HTMLButtonElement | null)?.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  setAssistHintsEnabled(false);
});
addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'p' && !((e.target as HTMLElement)?.tagName === 'INPUT')) {
    if (phoneOpen) closeModal();
    else if (!modalOpen()) openPhone();
  }
});

let phT = 0;
const phoneUpdateState = { last: '' as string };
export function phoneUpdate(dt: number) {
  phT += dt;
  if (phT > 20 && phoneOpen && !(document.activeElement as HTMLElement | null)?.matches?.('#pin')) {
    phT = 0;
    if (phoneApp === 'set' && advancedOpen && Date.now() - chainAt > 5000) loadChainProof();
    phoneRefresh();
  }
  updateAssistHint();
  const l = here();
  if (l.id !== phoneUpdateState.last) phoneUpdateState.last = l.id;
  ($('#loc') as HTMLElement).textContent = `${l.name} · 1 here`;
}
