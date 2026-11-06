import { $, esc, fmt, fmtN } from './util';
import { lvl, payCap, roleName, S, SAVE, START, SK } from './state';
import { board, cases, chg, feed, market, metrics, px, serverTick, TOK } from './market';
import { adTex, exTex, keys, labTex, npcs, towTex } from './world';
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

const ADS: [string, string, string][] = [
  ['YOUR AD HERE', '2,000 - 50,000 NGN per slot', '#ff3d9a'],
  ['MOONBOY ARMY', 'Join the $MOON raid. Not financial advice.', '#b8ff3d'],
  ['AUDIT SZN', 'Vault Cracker: open locks, get paid', '#2ee6ff'],
];
let adI = 0,
  adT = 0;
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
  adT++;
  if (adT % 12 === 0) adI++;
  adTex.forEach((a, i) => {
    const ad = ADS[(adI + i) % ADS.length]!;
    a.redraw((x, w, h) => {
      x.fillStyle = '#080a16';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = ad[2];
      x.lineWidth = 6;
      x.strokeRect(6, 6, w - 12, h - 12);
      x.textAlign = 'center';
      x.fillStyle = ad[2];
      x.font = '700 44px "Chakra Petch",sans-serif';
      x.fillText(ad[0], w / 2, 110);
      x.fillStyle = '#e9eefc';
      x.font = '500 22px "Chakra Petch",sans-serif';
      x.fillText(ad[1], w / 2, 160);
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
  ($('#mDist') as HTMLElement).textContent = fmtN(npcs.length + 1 + metrics.on / 40);
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

export function renderSide() {
  const el = $('#side') as HTMLElement;
  if (!sideTab) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.tab === sideTab));
  if (sideTab === 'feed')
    el.innerHTML =
      feed
        .slice(0, 25)
        .map(
          p =>
            `<div class="post ${p.kind}"><time>${ago(p.t)}</time><span class="who">${esc(p.who)}</span><div>${esc(p.text)}</div><div class="lk">♥ ${p.likes}</div></div>`,
        )
        .join('') || '<small>Quiet for now</small>';
  else if (sideTab === 'skills') {
    const row = (k: keyof typeof S.xp, d: string) => {
      const xp = S.xp[k],
        l = lvl(xp),
        a = 40 * (l - 1) ** 2,
        b = 40 * l * l;
      return `<div class="sk"><div class="top"><b>${SK[k]} L${l}</b><small>${d}</small></div><div class="meter"><i style="width:${Math.round(((xp - a) / (b - a)) * 100)}%"></i></div></div>`;
    };
    el.innerHTML =
      `<b>Role: ${roleName()}</b><p style="color:var(--mute);margin:2px 0 6px">Everyone starts as a Newcomer. Your role emerges from what you do.</p>` +
      row('trade', 'read signals') +
      row('sec', 'find bugs') +
      row('comm', 'move attention') +
      ['Build', 'Capital', 'Creative'].map(n => `<div class="sk lock"><div class="top"><b>${n}</b><small>next update</small></div></div>`).join('') +
      `<small>Trades ${S.stats.trades} · Bugs ${S.stats.found} · Posts ${S.stats.posts} · Followers ${fmtN(S.followers)}</small>`;
  } else if (sideTab === 'rank') {
    const all = board.concat([{ name: S.name + ' (you)', ret: (S.bal - START) / START, me: 1 }]).sort((a, b) => b.ret - a.ret);
    el.innerHTML =
      `<b>Top returns</b> <span class="tag demo">NPC rivals</span>` +
      all
        .map(
          (b, i) =>
            `<div class="rk ${b.me ? 'me' : ''}"><span>${i + 1}. ${esc(b.name)}</span><span>${(b.ret >= 0 ? '+' : '') + (b.ret * 100).toFixed(0)}%</span></div>`,
        )
        .join('');
  } else {
    el.innerHTML = `<b>About this prototype</b><p style="color:var(--mute)">Glitch is a free multiplayer city where web3 history becomes a game. This is a one-player slice: the market, other players and visitor counts are simulated. Your GD is stored in this browser only and can never be cashed out.</p>
    <b>Economy health</b><div class="rk"><span>Created by skill pay</span><span class="pos">${fmt(S.created)}</span></div><div class="rk"><span>Burned (fees, losses, fines, upkeep)</span><span class="neg">${fmt(S.burned)}</span></div>
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
  renderSide();
};
setInterval(() => {
  if (sideTab === 'feed' || sideTab === 'rank' || sideTab === 'skills') renderSide();
}, 2000);
