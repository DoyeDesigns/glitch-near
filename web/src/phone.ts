import {
  GAS_GD,
  isPlayerListableToken,
  listableTokenTitle,
  MARKET_LIST_MAX_GD,
  MARKET_LIST_MIN_GD,
} from '@glitch/shared';
import { $, esc, fmtN, pick, rnd } from './util';
import { L, logTx, roleName, SAVE, save, S, txlog, weak } from './state';
import { banner, cityTradeGlance, feed, post, serverTick } from './market';
import {
  assistantScreenPos,
  cam,
  camera,
  clearInterior,
  currentInterior,
  DRIP_LINE,
  draftFromPose,
  heldPoseId,
  overdue,
  player,
  poseFromDraft,
  POSE_PRESETS,
  renderer,
  scene,
  setAssistantClickHandler,
  setHeldPose,
  vel,
  type Pose,
  type PoseLimbDraft,
} from './world';
import { NEUTRAL_POSE, poseSvgMarkup } from './posePreview';
import {
  deleteServerPose,
  likePose,
  loadPlaceChat,
  loadPoseFeed,
  loadPoses,
  markNotesRead,
  myPoses,
  noteCount,
  peopleAtPlace,
  placeMessages,
  posePosts,
  publishPose,
  saveServerPose,
  sendPlaceChat,
} from './live';
import {
  closeModal,
  hudAvailable,
  introOpen,
  modalEl,
  modalOpen,
  openModal,
  resultCard,
  setHudAvailable,
  setHudSettling,
  sheet,
  updateHud,
} from './hud';
import {
  cityDay,
  citySimPlaying,
  homeAct,
  homeHtml,
  chefShop,
  dealerShop,
  loadMerchantQuotes,
  openCustomizer,
  playCityDaySim,
  smithShop,
  startMerchantPoll,
  type CityDayBoard,
  type CityDayRow,
} from './games';
import { fetchChainProof, me, refreshMe, type ChainProof } from './session';
import { LOCS, locAt, placeId } from './places';
import { NEAR_AD_APPS } from './nearAds';

type MarketListing = {
  id: string;
  tokenId: string;
  title: string;
  price: string;
  sellerName: string;
  sellerId: string;
};

type MarketSale = MarketListing & { soldAt: number };

const MARKET_SALES_SEEN_KEY = 'glitch_market_sales_seen';

let marketListings: MarketListing[] = [];
let marketMySales: MarketSale[] = [];
let marketErr = '';
/** '' idle, or `list` / `buy:<id>` / `cancel:<id>` while a market request is in flight. */
let marketBusyKey = '';
let bankBusy = false;
let marketFetchGen = 0;

function readSalesSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(MARKET_SALES_SEEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSalesSeen(map: Record<string, number>): void {
  try {
    localStorage.setItem(MARKET_SALES_SEEN_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function notifyNewSales(sales: MarketSale[]): void {
  const seen = readSalesSeen();
  const fresh = sales.filter(s => !seen[s.id]);
  if (!fresh.length) return;
  for (const s of fresh) {
    seen[s.id] = s.soldAt;
    const furnHint = s.tokenId.includes('gear-')
      ? 'Item left your inventory.'
      : 'It left your home/inventory.';
    banner(`Your ${s.title} sold for ${fmtN(Number(s.price))} GD. ${furnHint}`, 'good');
  }
  writeSalesSeen(seen);
}

async function loadMarket(): Promise<void> {
  const gen = ++marketFetchGen;
  try {
    const res = await fetch('/market', { credentials: 'include' });
    const data = (await res.json()) as {
      listings?: MarketListing[];
      mySales?: MarketSale[];
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || 'Could not load market');
    if (gen !== marketFetchGen) return;
    marketListings = data.listings ?? [];
    marketMySales = data.mySales ?? [];
    marketErr = '';
    notifyNewSales(marketMySales);
  } catch (err) {
    if (gen !== marketFetchGen) return;
    marketErr = err instanceof Error ? err.message : 'Could not load market';
  } finally {
    if (gen === marketFetchGen && phoneOpen && phoneApp === 'shop') phoneRefresh();
  }
}

function enterMarket(): void {
  void loadMarket();
  void refreshMe().catch(() => {});
}

export { LOCS, locAt };
export const GAS = GAS_GD;
export const here = () => {
  const id = placeId(currentInterior, player.position.x, player.position.z);
  return LOCS.find(l => l.id === id) ?? locAt(player.position.x, player.position.z);
};
/** Other players currently at a place (from presence heartbeat). */
export const peopleAt = (id: string) =>
  peopleAtPlace(id).map(o => ({ userData: { npc: { name: o.name } } }));
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
type PoseLimbId = 'armL' | 'armR' | 'legL' | 'legR';
type CustomPoseDraft = Record<PoseLimbId, PoseLimbDraft>;

const emptyLimbDraft = (): PoseLimbDraft => ({ raise: 0, spread: 0, bend: 0 });
const emptyPoseDraft = (): CustomPoseDraft => ({
  armL: emptyLimbDraft(),
  armR: emptyLimbDraft(),
  legL: emptyLimbDraft(),
  legR: emptyLimbDraft(),
});

let phoneApp: string | null = null,
  socialTab = 'all',
  chatTab = 'here',
  dmWith: string | null = null,
  profOf: string | null = null,
  poseEdit = false,
  poseLimb: PoseLimbId = 'armL',
  poseDraft: CustomPoseDraft = emptyPoseDraft(),
  posesTab: 'feed' | 'mine' = 'mine',
  editingPoseId: string | null = null,
  editingPoseName = 'My pose',
  poseLiking = new Set<string>();

/** Bottom-docked pose editor: see the live avatar while dragging sliders. */
let poseDockActive = false;
let poseCamSaved: { dist: number; pitch: number; ty: number } | null = null;

function leavePoseDock() {
  if (poseCamSaved) {
    cam.dist = poseCamSaved.dist;
    cam.pitch = poseCamSaved.pitch;
    cam.ty = poseCamSaved.ty;
    poseCamSaved = null;
  }
  poseDockActive = false;
  modalEl.classList.remove('low');
  sheet.classList.remove('pose-dock');
}

function enterPoseDock() {
  if (!poseDockActive) {
    poseCamSaved = { dist: cam.dist, pitch: cam.pitch, ty: cam.ty };
    cam.dist = 7.6;
    cam.pitch = 0.1;
    cam.ty = -0.7;
    poseDockActive = true;
  }
  modalEl.classList.add('low');
  sheet.classList.add('pose-dock');
}

function syncPoseDock() {
  if (phoneOpen && poseEdit) enterPoseDock();
  else leavePoseDock();
}

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
export async function travel(id: string) {
  const l = LOCS.find(x => x.id === id);
  if (!l) return;
  try {
    const res = await fetch('/travel', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: id }),
    });
    const data = (await res.json()) as { available?: string; settling?: string; error?: string };
    if (!res.ok) return banner(data.error || 'Not enough GD to travel', 'bad');
    if (currentInterior) clearInterior();
    const available = Number(data.available);
    setHudAvailable(available);
    if (data.settling != null) setHudSettling(Number(data.settling) || 0);
    S.bal = available;
    logTx('out', GAS, 'Fast travel');
    player.position.set(l.sp[0], 0, l.sp[1]);
    vel.x = vel.z = 0;
    cam.tx = l.sp[0];
    cam.tz = l.sp[1];
    closeModal();
    banner(`Arrived at ${l.name}. ${GAS} GD`, 'info');
    updateHud();
    save();
  } catch {
    banner('Travel failed', 'bad');
  }
}

function refreshMyHomeQuotes() {
  if (phoneApp !== 'myhome') return;
  void loadMerchantQuotes()
    .then(() => {
      if (phoneOpen && phoneApp === 'myhome') phoneRefresh();
    })
    .catch(() => {});
}

let stopHomePoll: (() => void) | null = null;

function syncHomeMerchantPoll() {
  const want = phoneOpen && phoneApp === 'myhome';
  if (want && !stopHomePoll) {
    stopHomePoll = startMerchantPoll(() => {
      if (phoneOpen && phoneApp === 'myhome') phoneRefresh();
    });
  } else if (!want && stopHomePoll) {
    stopHomePoll();
    stopHomePoll = null;
  }
}

export function openPhone(app?: string) {
  if (introOpen() || (modalOpen() && !phoneOpen)) return;
  if (phoneOpen) {
    phoneApp = app || null;
    renderPhone();
    if (phoneApp === 'myhome') refreshMyHomeQuotes();
    if (phoneApp === 'poses') void enterPoses();
    if (phoneApp === 'shop') enterMarket();
    syncHomeMerchantPoll();
    return;
  }
  phoneOpen = true;
  phoneApp = app || null;
  profOf = null;
  dmWith = null;
  openModal('', () => {
    phoneOpen = false;
    poseEdit = false;
    leavePoseDock();
    sheet.classList.remove('phonesheet', 'assist-sheet', 'pose-dock');
    sheet.onclick = null;
    sheet.onkeydown = null;
    sheet.oninput = null;
    syncHomeMerchantPoll();
    updateAssistHint();
  });
  sheet.classList.add('phonesheet', 'assist-sheet');
  renderPhone();
  if (phoneApp === 'myhome') refreshMyHomeQuotes();
  if (phoneApp === 'poses') void enterPoses();
  if (phoneApp === 'shop') enterMarket();
  syncHomeMerchantPoll();
}

async function enterPoses() {
  await markNotesRead();
  await Promise.all([loadPoses(), loadPoseFeed()]);
  if (phoneOpen && phoneApp === 'poses') phoneRefresh();
  placeAssistBadge();
}
export function phoneRefresh() {
  if (!phoneOpen) return;
  const scr = sheet.querySelector('.ph-scr') as HTMLElement | null;
  const top = scr?.scrollTop ?? 0;
  const pin = $('#pin') as HTMLInputElement | null;
  const pinVal = pin?.value;
  const pinFocus = !!pin && document.activeElement === pin;
  const mktTok = $('#mktToken') as HTMLSelectElement | null;
  const mktTokVal = mktTok?.value;
  const mktTokFocus = !!mktTok && document.activeElement === mktTok;
  const mktPrice = $('#mktPrice') as HTMLInputElement | null;
  const mktPriceVal = mktPrice?.value;
  const mktPriceFocus = !!mktPrice && document.activeElement === mktPrice;
  const mktPriceSel =
    mktPriceFocus && mktPrice
      ? ([mktPrice.selectionStart ?? 0, mktPrice.selectionEnd ?? 0] as const)
      : null;
  renderPhone();
  const scr2 = sheet.querySelector('.ph-scr') as HTMLElement | null;
  if (scr2 && top) scr2.scrollTop = top;
  if (pinVal != null) {
    const n = $('#pin') as HTMLInputElement | null;
    if (n) {
      n.value = pinVal;
      if (pinFocus) {
        n.focus();
        n.setSelectionRange(pinVal.length, pinVal.length);
      }
    }
  }
  if (mktTokVal != null) {
    const n = $('#mktToken') as HTMLSelectElement | null;
    if (n) {
      if ([...n.options].some(o => o.value === mktTokVal)) n.value = mktTokVal;
      if (mktTokFocus) n.focus();
    }
  }
  if (mktPriceVal != null) {
    const n = $('#mktPrice') as HTMLInputElement | null;
    if (n) {
      n.value = mktPriceVal;
      if (mktPriceFocus) {
        n.focus();
        const a = mktPriceSel?.[0] ?? mktPriceVal.length;
        const b = mktPriceSel?.[1] ?? mktPriceVal.length;
        n.setSelectionRange(a, b);
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
  'My Home — buy a home, then sleep to restore energy.',
  'Step to a lit door, press Use to enter. E also works.',
  'Hold-drag to look. Click me anytime for modules.',
];
const MID_HINTS = [
  'Wins show on your balance as soon as the round ends.',
  'Market module lists furniture or gear for GD (2% sale fee).',
  'Forge mint prices follow the smith quote — check GD before minting.',
  'Home maintenance is due each period or the bed locks.',
  'Trade / Security / Community XP shapes your role.',
];
const HIGH_HINTS = [
  'Tired or hungry cuts skill pay by 40% — eat and rest first.',
  'Listing fee is 2% — price above the floor for a clean sale.',
  'Merchant shops trade GD with each other. The plaza market shows the latest hop.',
  'Wanted status overrides your role until it expires.',
];

function skillTier(): 'beginner' | 'mid' | 'high' {
  const mx = Math.max(L('trade'), L('sec'), L('comm'));
  if (mx < 2) return 'beginner';
  if (mx <= 3) return 'mid';
  return 'high';
}

function nearSpot(x: number, z: number, r: number): boolean {
  return Math.hypot(player.position.x - x, player.position.z - z) < r;
}

function locationHint(): string | null {
  if (nearSpot(34, 24, 14)) return 'Diner: Use the counter to buy food and refill hunger.';
  if (nearSpot(20, -4, 14)) return 'Vault Lab: Use a terminal — locks pay GD and shards.';
  if (nearSpot(0, -10, 12)) return 'Forge: mint gear NFTs when you have shards + GD.';
  if (nearSpot(0, 6, 12)) return 'Plaza: check the Exchange screens, then open Map for places.';
  if (S.home.owned && nearSpot(22, 32, 14)) return 'Home: Use the bed to sleep. Pay maintenance if overdue.';
  return null;
}

function needsHint(): string | null {
  if (!weak()) return null;
  if (S.needs.hunger < 10 && nearSpot(34, 24, 14)) return 'Hungry: buy food at this counter — skill pay is cut 40%.';
  if (S.needs.energy < 15 && S.home.owned && nearSpot(22, 32, 14))
    return 'Tired: Use the bed to sleep — skill pay is cut 40%.';
  if (S.needs.hunger < 10) return 'Hungry: skill pay is cut 40%. Head to Neon Diner (east).';
  if (S.needs.energy < 15) return 'Tired: skill pay is cut 40%. Rest on a bench or sleep at home.';
  return 'Tired or hungry: skill pay is cut 40% until you eat or rest.';
}

function situationHint(): string | null {
  if (S.home.owned && overdue()) return 'Home maintenance is overdue — bed is locked until you pay in My Home.';
  const funds = hudAvailable ?? S.bal;
  if (funds < 5_000) return 'Low on GD — Vault, Trade, or Post to earn. Starter was 60,000.';
  if (chefShop.closed || smithShop.closed || dealerShop.closed)
    return 'A merchant is closed (out of GD). City trades refill wallets — check Feed.';
  if (S.shards > 0 && S.nfts.length === 0 && nearSpot(0, -10, 12))
    return 'You have shards — Use the forge to mint gear.';
  if (S.shards > 0 && S.nfts.length === 0) return 'You have shards — visit Gear Forge to mint an NFT.';
  if (S.stats.trades === 0 && nearSpot(12, 8, 14)) return 'Try Trade Terminal: 10-second up/down bets for GD.';
  if (S.xp.sec === 0 && nearSpot(20, -4, 14)) return 'First vault: tap STOP in the green zone for GD + shards.';
  if (S.stats.posts === 0 && nearSpot(-8, 10, 14)) return 'Attention Booth: spend a little GD to post and maybe earn.';
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
  // Priority: needs → location (all tiers) → situation → rotating fallback.
  const needs = needsHint();
  if (needs) return needs;
  const loc = locationHint();
  if (loc) return loc;
  const sit = situationHint();
  if (sit) return sit;
  const pool = skillTier() === 'beginner' ? BEGINNER_HINTS : skillTier() === 'mid' ? MID_HINTS : HIGH_HINTS;
  const hints = heldPoseId
    ? pool
    : [`Make a pose, then hit Shot to share. ${DRIP_LINE}`, ...pool];
  const i = Math.floor(Date.now() / 12000) % hints.length;
  return hints[i]!;
}

export function placeAssistBadge() {
  const el = $('#assistBadge') as HTMLElement | null;
  if (!el) return;
  const pos = noteCount > 0 ? assistantScreenPos() : null;
  if (!pos) {
    el.hidden = true;
    return;
  }
  const app = $('#app') as HTMLElement;
  const ar = app.getBoundingClientRect();
  el.hidden = false;
  el.textContent = noteCount > 9 ? '9+' : String(noteCount);
  el.style.left = `${pos.x - ar.left + 18}px`;
  el.style.top = `${pos.y - ar.top - 8}px`;
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
  const npcN = d.phase === 'done' ? d.npcTrades.length : d.shownNpcTrades;
  const npc =
    npcN === 0
      ? `No NPC city trades${soFar}`
      : `${fmtN(npcN)} NPC supply trade${npcN === 1 ? '' : 's'}${soFar}`;
  const head =
    d.pumps + d.rugs === 0
      ? `No pumps or rugs${soFar}`
      : `${fmtN(d.pumps + d.rugs)} headlines${soFar} (${d.pumps} pump${d.pumps === 1 ? '' : 's'}, ${d.rugs} rug${d.rugs === 1 ? '' : 's'})`;
  if (!best || bestAbs < 0.01) return `${npc}. ${head}. Nothing moved more than 1%.`;
  return `${npc}. ${head}. Biggest spike: ${best.title} ${dayMove(best.open, best.high).text}.`;
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
    <div class="day-stats"><span><b>${fmtN(d.sales)}</b><small>Sales</small></span><span><b>${fmtN(d.phase === 'done' ? d.npcTrades.length : d.shownNpcTrades)}</b><small>NPC trades</small></span><span><b class="pos">${d.pumps}</b><small>Pumps</small></span><span><b class="neg">${d.rugs}</b><small>Rugs</small></span></div>
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
    const ads = NEAR_AD_APPS.map(
      a =>
        `<a class="ap ad" href="${esc(a.href)}" target="_blank" rel="noopener noreferrer"><i class="ad-logo"><img src="${esc(a.logo)}" alt="" width="28" height="28" loading="lazy"><em>NEAR</em></i><span>${esc(a.name)}</span></a>`,
    ).join('');
    body =
      `<div class="ph-h"><b>Modules</b></div>` +
      (assistHintsEnabled()
        ? `<p class="assist-tip">${esc(currentAssistHint())}</p>`
        : `<p class="assist-tip muted">Hints hidden. <button type="button" class="lnk" data-a="hintsOn">Show hints</button></p>`) +
      `<div class="ph-quick">` +
      `<button type="button" class="ph-quick-btn map" data-a="app" data-v="map"><span class="ph-quick-ico">M</span><span><b>Map</b><small>Places &amp; travel</small></span></button>` +
      `<button type="button" class="ph-quick-btn poses" data-a="app" data-v="poses"><span class="ph-quick-ico">◇${noteCount ? `<u>${noteCount > 9 ? '9+' : noteCount}</u>` : ''}</span><span><b>Poses</b><small>Drip is forever</small></span></button>` +
      `</div>` +
      `<div class="apps">${ap('social', 'Social', '#2ee6ff', 'S')}${ap('chat', 'Chat', '#b8ff3d', 'C')}${ap('wallet', 'Balance', '#ff3d9a', 'W')}${ap('bank', 'Bank', '#ffb12e', 'B')}${ap('me', 'Profile', '#7a8cff', 'P')}${ap('set', 'Settings', '#8b97b8', '⚙')}${ap('myhome', 'My Home', '#3dffb0', 'H')}${ap('shop', 'Market', '#26324f', '$')}${ads}</div>`;
  } else if (phoneApp === 'poses' || phoneApp === 'pose') {
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
        `<p class="hint">Your character updates live — drag the city to orbit. ${isArm ? 'Raise 0 = ribs; spread aims the lift out.' : 'Raise / spread the leg.'} ${bendLabel} bends.</p>` +
        `<div class="pose-stage pose-stage-dock" id="poseLive">${poseSvgMarkup(draftPose, { size: 80, className: 'pose-fig', look: S.look })}</div>` +
        `<div class="pose-chips">${chip('armL', 'Arm L')}${chip('armR', 'Arm R')}${chip('legL', 'Leg L')}${chip('legR', 'Leg R')}</div>` +
        row('raise', isArm ? 'Raise (0 = ribs)' : 'Raise', isArm ? -0.8 : -2.4, 2.4) +
        row('spread', 'Spread out', 0, 1.7) +
        row('bend', bendLabel, isArm ? -2.3 : 0, 2.3) +
        `<label class="pose-row"><span>Name</span><input id="poseName" type="text" maxlength="40" value="${esc(editingPoseName)}"></label>` +
        `<div class="acts"><button class="pri" data-a="poseSave">Save pose</button><button data-a="poseList">Cancel</button></div>`;
    } else if (posesTab === 'feed') {
      const opts =
        myPoses.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') ||
        '<option value="">Save a pose first</option>';
      const cards = posePosts
        .map(
          p =>
            `<article class="post"><b>${esc(p.name)}</b><div class="pose-stage sm">${poseSvgMarkup(p.pose, { size: 112, className: 'pose-fig' })}</div><div>${esc(p.caption || '…')}</div><button data-a="poseLike" data-v="${esc(p.id)}" ${p.liked ? 'disabled' : ''}>${p.liked ? 'Liked' : 'Like'} ${p.likes}</button></article>`,
        )
        .join('');
      body =
        hdr('Poses', 'home') +
        `<div class="chips"><button data-a="posesTab" data-v="feed" class="on">Feed</button><button data-a="posesTab" data-v="mine">Mine</button></div>` +
        `<div class="cmp"><select id="posePick">${opts}</select><input id="pin" type="text" maxlength="140" placeholder="The economy can be on fire, but drip is forever." autocomplete="off"><button class="pri" data-a="posePost" ${myPoses.length ? '' : 'disabled'}>Post</button></div>` +
        (cards || '<p class="hint">No poses posted yet.</p>');
    } else {
      const saved = myPoses.find(p => p.id === heldPoseId);
      const activePreset = POSE_PRESETS.find(p => p.id === heldPoseId);
      const activePose: Pose = saved?.pose ?? activePreset?.pose ?? NEUTRAL_POSE;
      const activeName = saved?.name ?? activePreset?.name ?? 'Standing';
      const card = (id: string, name: string, p: Pose) => {
        const on = heldPoseId === id ? ' on' : '';
        return `<button type="button" class="pose-card${on}" data-a="posePick" data-v="${esc(id)}">
          <span class="pose-thumb">${poseSvgMarkup(p, { size: 88, className: 'pose-fig', look: S.look })}</span>
          <span class="pose-card-name">${esc(name)}</span>
        </button>`;
      };
      const mine = myPoses
        .map(
          p =>
            `<div class="row">${card(p.id, p.name, p.pose)}<span><button data-a="poseRename" data-v="${esc(p.id)}">Edit</button><button data-a="poseDel" data-v="${esc(p.id)}">Delete</button></span></div>`,
        )
        .join('');
      const cards = POSE_PRESETS.map(p => card(p.id, p.name, p.pose)).join('');
      body =
        hdr('Poses', 'home') +
        `<div class="chips"><button data-a="posesTab" data-v="feed">Feed</button><button data-a="posesTab" data-v="mine" class="on">Mine</button></div>` +
        `<p class="hint">It's all about fashion and poses. Tap a pose, then hit Shot to share. It holds until you walk.</p>` +
        `<div class="pose-now${heldPoseId ? ' live' : ''}">
          <div class="pose-stage sm">${poseSvgMarkup(activePose, { size: 112, className: 'pose-fig pose-fig-lg', look: S.look })}</div>
          <div class="pose-now-meta"><small>Now</small><b>${esc(activeName)}</b></div>
        </div>` +
        `<h3>Yours</h3>${mine || '<p class="hint">No saved poses yet.</p>'}` +
        `<div class="pose-grid">${cards}</div>` +
        `<div class="acts"><button class="pri" data-a="poseEdit">New pose</button>${heldPoseId ? '<button data-a="poseClear">Clear</button>' : ''}</div>`;
    }
  } else if (phoneApp === 'shop') {
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
    const busy = !!marketBusyKey;
    body =
      hdr('Market', 'home') +
      `<p class="hint">Sell furniture or gear for ${MARKET_LIST_MIN_GD}–${fmtN(MARKET_LIST_MAX_GD)} GD (2% fee). Listed items stay in your home until sold, then transfer to the buyer.</p>` +
      (marketErr ? `<p class="hint" style="color:var(--pink)">${esc(marketErr)}</p>` : '') +
      `<div class="mkt-list-form">` +
      `<small class="mkt-label">Item</small>` +
      `<div class="cmp"><select id="mktToken" ${busy || !owned.length ? 'disabled' : ''}>${opt}</select></div>` +
      `<small class="mkt-label">Price (GD)</small>` +
      `<div class="cmp"><input id="mktPrice" type="number" min="${MARKET_LIST_MIN_GD}" max="${MARKET_LIST_MAX_GD}" value="500" step="1" inputmode="numeric" placeholder="Price GD" ${busy ? 'disabled' : ''}><button class="pri${marketBusyKey === 'list' ? ' is-busy' : ''}" data-a="mktlist" ${busy || !owned.length ? 'disabled' : ''}>List</button></div>` +
      `</div>` +
      `<h3>Open listings</h3>` +
      (others.length
        ? others
            .map(l => {
              const spinning = marketBusyKey === `buy:${l.id}`;
              return `<div class="row mkt-row"><span><b>${esc(l.title)}</b><small>${esc(l.sellerName)}</small></span><span class="mkt-price">${esc(fmtN(Number(l.price)))} GD</span><button class="pri${spinning ? ' is-busy' : ''}" data-a="mktbuy" data-v="${esc(l.id)}" ${busy ? 'disabled' : ''}>Buy</button></div>`;
            })
            .join('')
        : '<p class="hint">No open listings yet.</p>') +
      (mine.length
        ? `<h3>Your listings</h3>` +
          mine
            .map(l => {
              const spinning = marketBusyKey === `cancel:${l.id}`;
              return `<div class="row mkt-row"><span><b>${esc(l.title)}</b><small>Your listing</small></span><span class="mkt-price">${esc(fmtN(Number(l.price)))} GD</span><button class="${spinning ? 'is-busy' : ''}" data-a="mktcancel" data-v="${esc(l.id)}" ${busy ? 'disabled' : ''}>Cancel</button></div>`;
            })
            .join('')
        : '') +
      (marketMySales.length
        ? `<h3>Recent sales</h3>` +
          marketMySales
            .slice(0, 8)
            .map(
              l =>
                `<div class="row mkt-row"><span><b>${esc(l.title)}</b><small>Sold</small></span><span class="mkt-price">${esc(fmtN(Number(l.price)))} GD</span></div>`,
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
      <div class="msgs">${placeMessages.map(m => `<div class="m ${m.name === S.name ? 'me' : ''}"><small>${esc(m.name)}</small>${esc(m.text)}</div>`).join('') || '<p class="hint">Quiet here. Say something.</p>'}</div><div class="cmp"><input id="pin" type="text" maxlength="160" placeholder="Message everyone here" autocomplete="off"><button class="pri" data-a="sendLoc">Send</button></div>`;
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
      (cityTradeGlance
        ? `<p class="hint">Last city trade: ${esc(cityTradeGlance)}</p>`
        : '<p class="hint">City merchants trade GD with each other. The plaza market shows the latest hop.</p>') +
      mapLocs
        .map(l => {
          const n = peopleAt(l.id).length + (l.id === L0.id ? 1 : 0);
          return `<div class="loc"><div><b>${l.name}</b> ${l.id === L0.id ? '<span class="tag">You are here</span>' : ''}<div class="hint">${l.note} · ${n} people</div></div>${l.id === L0.id ? '' : `<button data-a="go" data-v="${l.id}">Go</button>`}</div>`;
        })
        .join('');
  } else if (phoneApp === 'wallet') {
    body =
      hdr('Balance', 'home') +
      `<div class="res win" style="padding:6px 0"><small>Balance</small><b>${fmtN(hudAvailable ?? S.bal)} GD</b></div><div class="pstats"><span><b>${S.shards}</b><small>Shards</small></span><span><b>${S.nfts.length}</b><small>NFTs</small></span></div><div class="hint">${weak() ? '<b class="neg">Tired or hungry: skill pay is cut by 40%.</b> Eat or sleep, then play.' : 'Skill games pay full GD when you win. Eat and rest so pay is not cut.'}</div>
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
  } else if (phoneApp === 'bank') {
    const gd = fmtN(hudAvailable ?? S.bal);
    body =
      hdr('Bank', 'home') +
      `<section class="bank">` +
      `<div class="bank-bal"><small>Available to send</small><b>${gd}</b><span>GD</span></div>` +
      `<p class="hint">Sending moves GD to an account you control. Play is unchanged until you send.</p>` +
      `<label class="mkt-label" for="bankTo">Account</label>` +
      `<input id="bankTo" type="text" maxlength="64" placeholder="name.testnet" autocomplete="off" spellcheck="false" ${bankBusy ? 'disabled' : ''}>` +
      `<label class="mkt-label" for="bankAmt">Amount</label>` +
      `<div class="cmp"><input id="bankAmt" type="text" inputmode="numeric" maxlength="15" placeholder="1000" autocomplete="off" ${bankBusy ? 'disabled' : ''}><button class="pri${bankBusy ? ' is-busy' : ''}" data-a="bankSend" ${bankBusy ? 'disabled' : ''}>Send</button></div>` +
      `</section>`;
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
  syncPoseDock();
  sheet.onclick = e => {
    if ((e.target as HTMLElement).closest('a[href]')) return;
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
        void loadPlaceChat().then(() => {
          if (phoneOpen && phoneApp === 'chat') phoneRefresh();
        });
      }
      if (v === 'poses') void enterPoses();
      if (v === 'shop') enterMarket();
    } else if (a === 'hintsOn') {
      setAssistHintsEnabled(true);
    } else if (a === 'hintsOff') {
      setAssistHintsEnabled(false);
    } else if (a === 'posesTab' && (v === 'feed' || v === 'mine')) {
      posesTab = v;
      phoneApp = 'poses';
      if (v === 'feed') void loadPoseFeed();
      else void loadPoses();
    } else if (a === 'poseList') {
      poseEdit = false;
      posesTab = 'mine';
      phoneApp = 'poses';
    } else if (a === 'poseLimb' && v && ['armL', 'armR', 'legL', 'legR'].includes(v)) {
      poseLimb = v as PoseLimbId;
      phoneApp = 'poses';
      poseEdit = true;
    } else if (a === 'poseEdit') {
      editingPoseId = null;
      editingPoseName = 'My pose';
      poseDraft = emptyPoseDraft();
      poseLimb = 'armL';
      setHeldPose(poseFromDraft(poseDraft), null);
      poseEdit = true;
      phoneApp = 'poses';
    } else if (a === 'poseRename' && v) {
      const saved = myPoses.find(p => p.id === v);
      if (!saved) return;
      editingPoseId = saved.id;
      editingPoseName = saved.name;
      poseDraft = draftFromPose(saved.pose);
      poseLimb = 'armL';
      setHeldPose(saved.pose, saved.id);
      poseEdit = true;
      phoneApp = 'poses';
    } else if (a === 'poseDel' && v) {
      void deleteServerPose(v).then(ok => {
        if (heldPoseId === v) setHeldPose(null, null);
        banner(ok ? 'Pose deleted' : 'Could not delete', ok ? 'good' : 'bad');
        if (phoneOpen) renderPhone();
      });
      return;
    } else if (a === 'posePick') {
      const saved = myPoses.find(p => p.id === v);
      if (saved) setHeldPose(saved.pose, saved.id);
      else {
        const preset = POSE_PRESETS.find(p => p.id === v);
        if (preset) setHeldPose(preset.pose, preset.id);
        else return;
      }
      closeModal();
      return;
    } else if (a === 'poseClear') {
      setHeldPose(null, null);
    } else if (a === 'poseSave') {
      const name = (($('#poseName') as HTMLInputElement | null)?.value || editingPoseName).trim();
      const pose = poseFromDraft(poseDraft);
      void saveServerPose(editingPoseId, name || 'My pose', pose).then(saved => {
        if (!saved) {
          banner('Could not save pose', 'bad');
          return;
        }
        editingPoseId = saved.id;
        setHeldPose(saved.pose, saved.id);
        poseEdit = false;
        posesTab = 'mine';
        banner('Pose saved', 'good');
        if (phoneOpen) renderPhone();
      });
      return;
    } else if (a === 'posePost') {
      const poseId = ($('#posePick') as HTMLSelectElement | null)?.value;
      const caption = inp?.value.trim() ?? '';
      if (!poseId) return;
      void publishPose(poseId, caption).then(ok => {
        banner(ok ? 'Posted' : 'Could not post', ok ? 'good' : 'bad');
        if (phoneOpen) renderPhone();
      });
      return;
    } else if (a === 'poseLike' && v) {
      const post = posePosts.find(p => p.id === v);
      if (!post || post.liked || poseLiking.has(v)) return;
      poseLiking.add(v);
      post.liked = true;
      post.likes += 1;
      renderPhone();
      void likePose(v).then(ok => {
        poseLiking.delete(v);
        if (!ok && post) {
          post.liked = false;
          post.likes = Math.max(0, post.likes - 1);
        }
        if (phoneOpen) renderPhone();
      });
      return;
    } else if (a === 'social') phoneApp = 'social';
    else if (a === 'inbox') {
      dmWith = null;
      chatTab = 'inbox';
      phoneApp = 'chat';
    } else if (a === 'stab') socialTab = v!;
    else if (a === 'ctab') {
      chatTab = v!;
      if (v === 'here')
        void loadPlaceChat().then(() => {
          if (phoneOpen && phoneApp === 'chat') phoneRefresh();
        });
    }
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
      void sendPlaceChat(x).then(ok => {
        if (!ok) banner('Could not send', 'bad');
        if (phoneOpen && phoneApp === 'chat') renderPhone();
      });
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
      if (marketBusyKey) return;
      const tokenEl = $('#mktToken') as HTMLSelectElement | null;
      const priceEl = $('#mktPrice') as HTMLInputElement | null;
      const tokenId = tokenEl?.value?.trim() ?? '';
      const price = Number(priceEl?.value ?? 0);
      if (!tokenId) {
        banner('Pick an item to list', 'bad');
        return;
      }
      marketBusyKey = 'list';
      phoneRefresh();
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
          marketBusyKey = '';
          phoneRefresh();
        });
      return;
    } else if (a === 'mktbuy') {
      if (marketBusyKey || !v) return;
      const listing = marketListings.find(l => l.id === v);
      marketBusyKey = `buy:${v}`;
      phoneRefresh();
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
          if (listing) {
            post(
              'sys',
              'MARKET',
              `${S.name} bought ${listing.title} from ${listing.sellerName} for ${fmtN(Number(listing.price))} GD.`,
            );
          }
          await loadMarket();
          await refreshMe();
          updateHud();
        })
        .catch(err => banner(err instanceof Error ? err.message : 'Buy failed', 'bad'))
        .finally(() => {
          marketBusyKey = '';
          phoneRefresh();
        });
      return;
    } else if (a === 'mktcancel') {
      if (marketBusyKey || !v) return;
      marketBusyKey = `cancel:${v}`;
      phoneRefresh();
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
          marketBusyKey = '';
          phoneRefresh();
        });
      return;
    } else if (a === 'bankSend') {
      if (bankBusy) return;
      const to = (($('#bankTo') as HTMLInputElement | null)?.value ?? '').trim();
      const amount = (($('#bankAmt') as HTMLInputElement | null)?.value ?? '').trim();
      if (!to || !amount) {
        banner('Enter an account and an amount', 'bad');
        return;
      }
      bankBusy = true;
      phoneRefresh();
      void fetch('/withdraw', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, amount }),
      })
        .then(async res => {
          const data = (await res.json()) as { error?: string; available?: string; settling?: string; pending?: boolean };
          if (!res.ok) throw new Error(data.error || 'Could not send GD');
          if (data.available != null) setHudAvailable(Number(data.available));
          if (data.settling != null) setHudSettling(Number(data.settling) || 0);
          S.bal = Number(data.available ?? S.bal);
          updateHud();
          await refreshMe().catch(() => {});
          banner(data.pending ? 'Sent. It may take a moment to show.' : 'GD sent', 'good');
        })
        .catch(err => banner(err instanceof Error ? err.message : 'Could not send GD', 'bad'))
        .finally(() => {
          bankBusy = false;
          if (phoneOpen && phoneApp === 'bank') phoneRefresh();
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
    syncHomeMerchantPoll();
    if ((a === 'app' && v === 'myhome') || a === 'buyhome' || a === 'furn') {
      refreshMyHomeQuotes();
    }
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
    if (stage) {
      stage.innerHTML = poseSvgMarkup(live, { size: 80, className: 'pose-fig', look: S.look });
    }
  };
}

setAssistantClickHandler(() => {
  if (phoneOpen) closeModal();
  else openPhone('poses');
});

function heldPoseName(): string {
  if (!heldPoseId) return 'Standing';
  return myPoses.find(p => p.id === heldPoseId)?.name ?? POSE_PRESETS.find(p => p.id === heldPoseId)?.name ?? 'Pose';
}

/** Picture of the live character in the city, with a caption, for saving or copying. */
function takePoseShot() {
  if (!heldPoseId) return;
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const snap = document.createElement('canvas');
  snap.width = src.width;
  snap.height = src.height;
  const sx = snap.getContext('2d');
  if (!sx) return;
  sx.drawImage(src, 0, 0);
  const poseName = heldPoseName();
  const who = S.name || 'You';
  openModal('');
  resultCard(true, poseName, who, `${DRIP_LINE} ${poseName}`, (x, w, h) => {
    const bar = 72;
    x.drawImage(snap, 0, 0, w, h - bar);
    x.fillStyle = '#070910';
    x.fillRect(0, h - bar, w, bar);
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
    x.fillStyle = '#e9eefc';
    x.font = '600 16px "Chakra Petch", sans-serif';
    x.fillText(`${who} · ${poseName}`, 16, h - 48);
    x.fillStyle = '#8b97b8';
    x.font = '500 13px "Chakra Petch", sans-serif';
    x.fillText("It's all about fashion and poses.", 16, h - 30);
    x.fillStyle = '#2ee6ff';
    x.fillText('The economy can be on fire, but drip is forever.', 16, h - 12);
  });
}

($('#shotBtn') as HTMLButtonElement | null)?.addEventListener('click', () => takePoseShot());
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
let chatPoll = 0;
const phoneUpdateState = { last: '' as string };
export function phoneUpdate(dt: number) {
  phT += dt;
  chatPoll += dt;
  if (chatPoll > 3 && phoneOpen && phoneApp === 'chat' && chatTab === 'here') {
    chatPoll = 0;
    const typing = (document.activeElement as HTMLElement | null)?.matches?.('#pin');
    void loadPlaceChat().then(() => {
      if (!typing && phoneOpen && phoneApp === 'chat') phoneRefresh();
    });
  }
  if (phT > 20 && phoneOpen && !(document.activeElement as HTMLElement | null)?.matches?.('#pin')) {
    phT = 0;
    if (phoneApp === 'set' && advancedOpen && Date.now() - chainAt > 5000) loadChainProof();
    phoneRefresh();
  }
  updateAssistHint();
  placeAssistBadge();
  const l = here();
  if (l.id !== phoneUpdateState.last) phoneUpdateState.last = l.id;
  const hereCount = peopleAt(l.id).length + 1;
  ($('#loc') as HTMLElement).textContent = `${l.name} · ${hereCount} here`;
}
