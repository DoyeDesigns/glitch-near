import { $, esc, fmt, fmtN } from './util';
import { applyChainItems } from './itemsSync';
import { lvl, payCap, roleName, S, SAVE, START, SK } from './state';
import { cases, chg, feed, market, metrics, px, serverTick, TOK } from './market';
import { buildFurn, adTex, exTex, keys, labTex, releaseLookLock, towTex } from './world';
import { refreshMe } from './session';

/** Last `available` from GET /me. HUD balance uses this when set. */
export let hudAvailable: number | null = null;
export const setHudAvailable = (n: number | null) => {
  hudAvailable = n;
};

/** Unminted credits included in `available`. Hidden when zero. */
export let hudSettling = 0;
export const setHudSettling = (n: number) => {
  hudSettling = Number.isFinite(n) ? Math.max(0, n) : 0;
};

let mePoll: ReturnType<typeof setInterval> | 0 = 0;
export function startMePoll() {
  if (mePoll) return;
  const tick = () => {
    refreshMe()
      .then(m => {
        hudAvailable = Number(m.available);
        hudSettling = Number(m.settling) || 0;
        S.bal = hudAvailable;
        S.needs = m.needs;
        S.home.paidUntil = m.homePaidUntil ?? S.home.paidUntil;
        applyChainItems(m.items);
        buildFurn();
        updateHud();
      })
      .catch(() => {});
  };
  tick();
  mePoll = setInterval(tick, 5000);
}

export let sideTab: string | null = null;
export const setSideTab = (t: string | null) => {
  sideTab = t;
};

type LbRow = { rank: number; name: string; balance: string };
let lbRows: LbRow[] = [];
let lbFetchAt = 0;
let lbFetching = false;
const LB_POLL_MS = 10_000;

function ensureLeaderboardPoll() {
  const now = Date.now();
  if (lbFetching || (lbFetchAt > 0 && now - lbFetchAt < LB_POLL_MS)) return;
  lbFetching = true;
  fetch('/leaderboard', { credentials: 'include' })
    .then(async res => {
      if (!res.ok) return;
      const data = (await res.json()) as { players?: LbRow[] };
      if (Array.isArray(data.players)) {
        lbRows = data.players;
        lbFetchAt = Date.now();
        if (sideTab === 'rank') renderSide();
      }
    })
    .catch(() => {})
    .finally(() => {
      lbFetching = false;
    });
}

export const modalEl = $('#modal') as HTMLElement;
export const sheet = $('#sheet') as HTMLElement;
export let modalTimer: ReturnType<typeof setInterval> | 0 = 0;
export const setModalTimer = (t: ReturnType<typeof setInterval> | 0) => {
  modalTimer = t;
};
let modalClose: (() => void) | null = null;

export const modalOpen = () => !modalEl.hidden;
export const introOpen = () => !($('#intro') as HTMLElement).hidden;

export function openModal(html: string, onClose?: (() => void) | null) {
  closeModal();
  releaseLookLock();
  delete sheet.dataset.lock;
  sheet.className = 'sheet';
  sheet.onclick = null;
  sheet.onkeydown = null;
  sheet.innerHTML = html;
  modalEl.hidden = false;
  modalClose = onClose || null;
  keys.clear();
}

export function closeModal() {
  modalEl.classList.remove('low');
  clearInterval(modalTimer as number);
  modalTimer = 0;
  modalEl.hidden = true;
  if (modalClose) {
    const f = modalClose;
    modalClose = null;
    f();
  }
}

modalEl.addEventListener('pointerdown', e => {
  if (e.target === modalEl && !sheet.dataset.lock) closeModal();
});
addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalOpen() && !sheet.dataset.lock) closeModal();
});

export function resultCard(
  win: boolean,
  big: string,
  line: string,
  brag: string,
  draw?: (x: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  sheet.dataset.lock = '';
  sheet.innerHTML = `<div class="res ${win ? 'win' : 'loss'}"><small>${esc(line)}</small><b>${big}</b></div>${draw ? '<canvas id="rcv" width="640" height="360" style="width:100%;border-radius:10px;display:block"></canvas>' : ''}
  <div class="acts"><button id="rcopy">Copy text</button>${draw ? '<button id="rsave">Save image</button>' : ''}<button id="rclose" class="pri">Back to the city</button></div>`;
  if (draw) {
    const c = $('#rcv') as HTMLCanvasElement;
    draw(c.getContext('2d')!, c.width, c.height);
    ($('#rsave') as HTMLButtonElement).onclick = () => {
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = 'glitch-result.png';
      a.click();
    };
  }
  ($('#rclose') as HTMLButtonElement).onclick = closeModal;
  ($('#rcopy') as HTMLButtonElement).onclick = async e => {
    try {
      await navigator.clipboard.writeText(brag + ' #Glitch');
      (e.target as HTMLElement).textContent = 'Copied';
    } catch {
      (e.target as HTMLElement).textContent = 'Copy blocked';
    }
  };
}

export type BillboardSlot = {
  slotId: number;
  ad: {
    projectName: string;
    creativeUrl: string;
  } | null;
  price1Unit: string;
};

let billboardSlots: BillboardSlot[] = [];
const creativeImages = new Map<string, HTMLImageElement>();
let adsPoll: ReturnType<typeof setInterval> | 0 = 0;

function yoctoToNearLabel(yocto: string): string {
  try {
    const n = BigInt(yocto || '0');
    const whole = n / 10n ** 24n;
    const frac = n % 10n ** 24n;
    const fracStr = frac.toString().padStart(24, '0').replace(/0+$/, '').slice(0, 4);
    return fracStr ? `${whole}.${fracStr} N` : `${whole} N`;
  } catch {
    return '— N';
  }
}

function loadCreative(url: string): HTMLImageElement | null {
  const proxy = `/ads/creative?url=${encodeURIComponent(url)}`;
  let img = creativeImages.get(proxy);
  if (img) return img.complete && img.naturalWidth > 0 ? img : null;
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = proxy;
  creativeImages.set(proxy, img);
  return null;
}

export function startAdsPoll() {
  if (adsPoll) return;
  const tick = () => {
    fetch('/ads')
      .then(r => r.json())
      .then((data: { slots?: BillboardSlot[] }) => {
        if (Array.isArray(data.slots)) billboardSlots = data.slots;
      })
      .catch(() => {});
  };
  tick();
  adsPoll = setInterval(tick, 15_000);
}
const ago = (t: number) => {
  // Logical sim time from server is in seconds; wall posts use Date.now() ms.
  const age = t > 1e12 ? Math.floor((Date.now() - t) / 1000) : Math.max(0, Math.floor(serverTick / 2 - t));
  return age < 60 ? age + 's' : Math.floor(age / 60) + 'm';
};

export function drawScreens() {
  exTex.redraw((x, w, h) => {
    x.fillStyle = '#04070f';
    x.fillRect(0, 0, w, h);
    x.font = '700 22px "JetBrains Mono",monospace';
    x.fillStyle = '#2ee6ff';
    x.fillText('EXCHANGE', 14, 30);
    TOK.forEach((t, i) => {
      const c = chg(t);
      x.fillStyle = '#e9eefc';
      x.fillText(t.sym, 14, 70 + i * 40);
      x.fillText(px(t.price), 150, 70 + i * 40);
      x.fillStyle = c >= 0 ? '#b8ff3d' : '#ff3d9a';
      x.fillText((c >= 0 ? '+' : '') + (c * 100).toFixed(1) + '%', 370, 70 + i * 40);
    });
  });
  labTex.redraw((x, w, h) => {
    x.fillStyle = '#05100a';
    x.fillRect(0, 0, w, h);
    x.font = '700 22px "JetBrains Mono",monospace';
    x.fillStyle = '#b8ff3d';
    x.fillText('BOUNTY BOARD', 14, 30);
    x.font = '600 20px "JetBrains Mono",monospace';
    if (!cases.length) {
      x.fillStyle = '#8b97b8';
      x.fillText('No open CIA cases', 14, 80);
    }
    cases.slice(0, 4).forEach((c, i) => {
      x.fillStyle = '#ffb12e';
      x.fillText('#' + c.no, 14, 80 + i * 40);
      x.fillStyle = '#e9eefc';
      x.fillText(c.title.slice(0, 26), 90, 80 + i * 40);
    });
    x.fillStyle = '#8b97b8';
    x.fillText('Reports: ' + S.stats.reports + '  Exploits: ' + S.stats.exploits, 14, h - 16);
  });
  towTex.redraw((x, w) => {
    x.fillStyle = '#0c0818';
    x.fillRect(0, 0, w, w);
    x.font = '700 24px "Chakra Petch",sans-serif';
    x.fillStyle = '#ff3d9a';
    x.fillText('LIVE FEED', 14, 34);
    x.font = '500 19px "Chakra Petch",sans-serif';
    feed.slice(0, 8).forEach((p, i) => {
      x.fillStyle = p.kind === 'bad' ? '#ff3d9a' : p.kind === 'sys' ? '#ffb12e' : '#2ee6ff';
      x.fillText(p.who.slice(0, 12), 14, 76 + i * 54);
      x.fillStyle = '#e9eefc';
      x.fillText(p.text.slice(0, 40), 14, 100 + i * 54);
    });
  });
  adTex.forEach((a, i) => {
    const slot =
      billboardSlots.length > 0
        ? billboardSlots[i % billboardSlots.length]!
        : { slotId: i, ad: null, price1Unit: '0' };
    a.redraw((x, w, h) => {
      x.fillStyle = '#080a16';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#ff3d9a';
      x.lineWidth = 6;
      x.strokeRect(6, 6, w - 12, h - 12);
      x.textAlign = 'center';
      if (slot.ad?.creativeUrl) {
        const img = loadCreative(slot.ad.creativeUrl);
        if (img) {
          try {
            x.drawImage(img, 12, 12, w - 24, h - 48);
          } catch {
            /* tainted or not ready */
          }
        }
        x.fillStyle = '#2ee6ff';
        x.font = '700 20px "Chakra Petch",sans-serif';
        x.fillText('Sponsored', w / 2, h - 18);
        x.fillStyle = '#e9eefc';
        x.font = '600 18px "Chakra Petch",sans-serif';
        x.fillText((slot.ad.projectName || '').slice(0, 28), w / 2, 36);
      } else {
        x.fillStyle = '#ff3d9a';
        x.font = '700 40px "Chakra Petch",sans-serif';
        x.fillText('YOUR AD HERE', w / 2, 110);
        x.fillStyle = '#e9eefc';
        x.font = '500 22px "Chakra Petch",sans-serif';
        x.fillText(yoctoToNearLabel(slot.price1Unit), w / 2, 160);
      }
    });
  });
}

export function updateHud() {
  ($('#pname') as HTMLElement).textContent = S.name;
  ($('#bal') as HTMLElement).textContent = fmtN(hudAvailable ?? S.bal);
  const settling = $('#settling') as HTMLElement;
  if (hudSettling > 0) {
    settling.hidden = false;
    settling.textContent = `settling ${fmtN(hudSettling)}`;
  } else {
    settling.hidden = true;
    settling.textContent = '';
  }
  const r = $('#role') as HTMLElement,
    rn = roleName();
  r.textContent = rn;
  r.style.color = rn === 'Wanted' || rn === 'Hacker' ? 'var(--pink)' : '';
  r.style.borderColor = r.style.color;
  const ret = (S.bal - START) / START,
    re = $('#ret') as HTMLElement;
  re.textContent = (ret >= 0 ? '+' : '') + (ret * 100).toFixed(1) + '%';
  re.className = ret >= 0 ? 'up' : 'dn';
  ($('#rep') as HTMLElement).textContent = 'Rep ' + S.rep;
  const en = S.needs.energy,
    hu = S.needs.hunger;
  ($('#enB') as HTMLElement).style.width = en + '%';
  ($('#huB') as HTMLElement).style.width = hu + '%';
  ($('#enB') as HTMLElement).style.background = en < 20 ? 'var(--pink)' : 'var(--amber)';
  ($('#huB') as HTMLElement).style.background = hu < 20 ? 'var(--pink)' : 'var(--lime)';
  ($('#enT') as HTMLElement).textContent = String(Math.round(en));
  ($('#huT') as HTMLElement).textContent = String(Math.round(hu));
  const used = Math.min(1, S.payUsed / payCap());
  ($('#payBar') as HTMLElement).style.width = used * 100 + '%';
  ($('#payTxt') as HTMLElement).textContent = fmt(S.payUsed) + ' / ' + fmt(payCap());
  ($('#mOn') as HTMLElement).textContent = fmtN(metrics.on);
  ($('#mDist') as HTMLElement).textContent = fmtN(1 + metrics.on / 40);
  ($('#mVis') as HTMLElement).textContent = fmtN(metrics.vis);
  const m = market.mood;
  ($('#mk') as HTMLElement).innerHTML =
    `<div class="tk"><small>Market</small><b class="${m >= 0 ? 'pos' : 'neg'}">${m > .25 ? 'GREED' : m < -.25 ? 'FEAR' : 'CALM'}</b></div><div class="bar"><i style="width:${50 + m * 50}%;background:${m >= 0 ? 'var(--lime)' : 'var(--pink)'}"></i></div>` +
    TOK.map(t => {
      const c = chg(t);
      return `<div class="tk"><b>${t.sym}</b><span>${px(t.price)}</span><span class="${c >= 0 ? 'pos' : 'neg'}">${(c * 100).toFixed(1)}%</span></div>`;
    }).join('') +
    `<div class="tk"><small>Regulator heat</small><span>${Math.round(market.heat * 100)}%</span></div>`;
}

const hideCoach = () => {
  ($('#coach') as HTMLElement).hidden = true;
};

function sideTitle(): string {
  if (sideTab === 'feed') return 'Feed';
  if (sideTab === 'skills') return 'Skills';
  if (sideTab === 'rank') return 'Rank';
  if (sideTab === 'about') return 'About';
  return '';
}

function bindSideClose(el: HTMLElement) {
  const x = el.querySelector('.side-x') as HTMLButtonElement | null;
  if (x)
    x.onclick = () => {
      setSideTab(null);
      renderSide();
    };
}

export function renderSide() {
  const el = $('#side') as HTMLElement;
  if (!sideTab) {
    el.hidden = true;
    document.querySelectorAll('.tabs [data-tab], #aboutBtn').forEach(b => b.classList.remove('on'));
    return;
  }
  el.hidden = false;
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.tab === sideTab));
  ($('#aboutBtn') as HTMLElement).classList.toggle('on', sideTab === 'about');
  const head = `<div class="side-h"><b>${esc(sideTitle())}</b><button type="button" class="side-x" aria-label="Close">×</button></div>`;
  if (sideTab === 'feed')
    el.innerHTML =
      head +
      (feed
        .slice(0, 25)
        .map(
          p =>
            `<div class="post ${p.kind}"><time>${ago(p.t)}</time><span class="who">${esc(p.who)}</span><div>${esc(p.text)}</div><div class="lk">♥ ${p.likes}</div></div>`,
        )
        .join('') || '<small>Quiet for now</small>');
  else if (sideTab === 'skills') {
    const row = (k: keyof typeof S.xp, d: string) => {
      const xp = S.xp[k],
        l = lvl(xp),
        a = 40 * (l - 1) ** 2,
        b = 40 * l * l;
      return `<div class="sk"><div class="top"><b>${SK[k]} L${l}</b><small>${d}</small></div><div class="meter"><i style="width:${Math.round(((xp - a) / (b - a)) * 100)}%"></i></div></div>`;
    };
    el.innerHTML =
      head +
      `<b>Role: ${roleName()}</b><p style="color:var(--mute);margin:2px 0 6px">Everyone starts as a Newcomer. Your role emerges from what you do.</p>` +
      row('trade', 'read signals') +
      row('sec', 'find bugs') +
      row('comm', 'move attention') +
      ['Build', 'Capital', 'Creative'].map(n => `<div class="sk lock"><div class="top"><b>${n}</b><small>next update</small></div></div>`).join('') +
      `<small>Trades ${S.stats.trades} · Bugs ${S.stats.found} · Posts ${S.stats.posts} · Followers ${fmtN(S.followers)}</small>`;
  } else if (sideTab === 'rank') {
    ensureLeaderboardPoll();
    const rows = lbRows;
    el.innerHTML =
      head +
      `<b>Top balances</b>` +
      (rows.length
        ? rows
            .map(p => {
              const me = p.name === S.name;
              const label = me ? `${p.name} (you)` : p.name;
              return `<div class="rk ${me ? 'me' : ''}"><span>${p.rank}. ${esc(label)}</span><span>${fmtN(Number(p.balance))}</span></div>`;
            })
            .join('')
        : '<small>No ranked players yet</small>');
  } else {
    el.innerHTML =
      head +
      `<p style="color:var(--mute)">Glitch is a free multiplayer city where web3 history becomes a game. This is a one-player slice: the market, other players and visitor counts are simulated. Your GD is custodial — the server settles earn/spend on NEAR testnet or a local mock ledger. Players never see a wallet. GD cannot be cashed out to mainnet.</p>
    <b>Economy health</b><div class="rk"><span>Created by skill pay</span><span class="pos">${fmt(S.created)}</span></div><div class="rk"><span>Burned (fees, losses, fines, holding tax)</span><span class="neg">${fmt(S.burned)}</span></div>
    <p style="color:var(--mute)">Profits are capped daily and every loss is destroyed, so skill cannot print unlimited money.</p><button id="resetBtn">Reset progress</button>`;
    ($('#resetBtn') as HTMLButtonElement).onclick = () => {
      try {
        localStorage.removeItem(SAVE);
      } catch {
        /* ignore */
      }
      location.reload();
    };
  }
  bindSideClose(el);
}

document.querySelectorAll('.tabs [data-tab]').forEach(b => {
  (b as HTMLButtonElement).onclick = () => {
    const tab = (b as HTMLElement).dataset.tab!;
    setSideTab(sideTab === tab ? null : tab);
    hideCoach();
    renderSide();
  };
});
($('#aboutBtn') as HTMLButtonElement).onclick = () => {
  setSideTab(sideTab === 'about' ? null : 'about');
  hideCoach();
  renderSide();
};
setInterval(() => {
  if (sideTab === 'feed' || sideTab === 'rank' || sideTab === 'skills') renderSide();
}, 2000);
