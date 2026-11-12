import * as THREE from 'three';
import {
  catalogById,
  merchantRulesFor,
  HOMEP_GD,
  MAINTENANCE_GD,
  MAINTENANCE_MS as MAINTENANCE_PERIOD_MS,
  POST_COST,
  TRADE_MAX_STAKE,
  TRADE_MIN_STAKE,
  vaultLockStart,
  vaultNeedle,
  type VaultLock,
} from '@glitch/shared';
import { $, clamp, esc, fmt, fmtN, pick } from './util';
import { applyChainItems, forgeItemIdForGear } from './itemsSync';
import { L, save, S, weak } from './state';
import { banner, cityTradeGlance, post, px, setCityTradeGlance, TOK } from './market';
import {
  applyHomePaint,
  BOTC,
  buildFurn,
  buildLook,
  cam,
  comfort,
  crowdTo,
  CAPDIRS,
  FURN,
  GEARS,
  GLASSC,
  HAIRC,
  HAIRS,
  hasF,
  HOME_PAINT_PRESETS,
  nearStation,
  overdue,
  player,
  rain,
  maintenanceLeft,
  setCustomizing,
  SKINS,
  TOPC,
  isInside,
  toggleBuilding,
  exitBuilding,
  warpIntoBuilding,
} from './world';
import {
  closeModal,
  hudAvailable,
  modalEl,
  modalOpen,
  modalTimer,
  openModal,
  resultCard,
  setHudAvailable,
  setHudSettling,
  setModalTimer,
  sheet,
  updateHud,
} from './hud';
export function useStation() {
  if (!nearStation || nearStation.locked || modalOpen()) return;
  const id = nearStation.id;
  if (id.startsWith('bdoor-')) {
    toggleBuilding(id.slice('bdoor-'.length));
    return;
  }
  const handlers: Record<string, () => void> = {
    trade: tradeGame,
    sec: secGame,
    comm: commGame,
    forge: forgeGame,
    eat: dinerGame,
    rest: benchRest,
    bed: sleepGame,
    door: exitHome,
  };
  handlers[id]?.();
}

($('#prompt') as HTMLButtonElement).addEventListener('click', useStation);

function plotLine(
  x: CanvasRenderingContext2D,
  d: number[],
  X: number,
  Y: number,
  w: number,
  h: number,
  entry: number | null | undefined,
  col: string,
) {
  const mn = Math.min(...d, entry ?? Infinity),
    mx = Math.max(...d, entry ?? -Infinity),
    rg = mx - mn || 1,
    pad = 18;
  const py = (v: number) => h - pad - ((v - mn) / rg) * (h - pad * 2),
    px_ = (i: number) => X + (i / Math.max(1, d.length - 1)) * w;
  if (entry != null) {
    x.strokeStyle = '#8b97b8';
    x.lineWidth = 2;
    x.setLineDash([8, 8]);
    x.beginPath();
    x.moveTo(X, Y + py(entry));
    x.lineTo(X + w, Y + py(entry));
    x.stroke();
    x.setLineDash([]);
  }
  x.strokeStyle = col;
  x.lineWidth = 4;
  x.lineJoin = 'round';
  x.beginPath();
  d.forEach((v, i) => (i ? x.lineTo(px_(i), Y + py(v)) : x.moveTo(px_(i), Y + py(v))));
  x.stroke();
  x.fillStyle = col;
  x.beginPath();
  x.arc(px_(d.length - 1), Y + py(d[d.length - 1]!), 6, 0, 7);
  x.fill();
}
function drawChart(cv: HTMLCanvasElement, d: number[], entry: number | null) {
  const w = (cv.width = (cv.clientWidth || 300) * 2),
    h = (cv.height = 220),
    x = cv.getContext('2d')!;
  x.clearRect(0, 0, w, h);
  plotLine(x, d, 0, 0, w, h, entry, d[d.length - 1]! >= d[0]! ? '#b8ff3d' : '#ff3d9a');
}
const TOKINFO: Record<string, string> = {
  BTX: 'The original coin. Slow and steady.',
  ETHR: 'Powers apps and contracts. Medium swings.',
  PIZZ: 'Named after the famous pizza purchase. Jumpy.',
  MOON: 'A meme coin. Wild swings and risky.',
  FARM: 'Pays rewards for locking coins. Medium risk.',
};
const STAKES = [1000, 5000, 10000, 50000, 100000];
const ARROW = (d: number) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${d ? 'M12 3 4 13h5v8h6v-8h5z' : 'M12 21 4 11h5V3h6v8h5z'}" fill="currentColor"/></svg>`;

type ServerBet = {
  id: string;
  sym: string;
  dir: 1 | -1;
  stake: string;
  p0: string;
  resolvesAt: number;
  status: 'open' | 'settled';
  price: string;
  markPnl: string;
  pnl: string | null;
  credited: string | null;
  capped: boolean;
};

type TradeState = {
  bet: ServerBet | null;
  available: string;
  settling?: string;
  xp: { trade: number; sec: number; comm: number };
  payUsed: number;
  error?: string;
};

async function tradeRequest(path: string, init?: RequestInit): Promise<TradeState> {
  const res = await fetch(path, { credentials: 'include', ...init });
  const data = (await res.json()) as TradeState;
  if (!res.ok) throw new Error(data.error || 'Bet failed');
  return data;
}

export function tradeGame() {
  let tk = TOK[0]!,
    snap = tk.hist.slice(-120),
    stake = 5000,
    funds = hudAvailable ?? S.bal,
    busy = false,
    settled = false,
    pos: { bet: ServerBet; trail: number[] } | null = null;
  const R = (l: string, d: string, v: number, col: string) =>
    `<span>${l}<em>${d}</em></span><div class="bar"><i style="width:${Math.round(clamp(v, 0, 1) * 100)}%;background:${col}"></i></div>`;
  const sigs = (t: (typeof TOK)[0]) => {
    const n = L('trade');
    return (
      R('Buzz', 'how much people are talking', t.hype, '#ff3d9a') +
      (n >= 2 ? R('Real use', 'how many people use it', t.usage, '#2ee6ff') : '') +
      (n >= 3 ? R('Safety', 'does it look trustworthy', t.trust, '#b8ff3d') : '') +
      (n >= 4 ? R('Big buyers', 'whales buying or selling', t.flow / 2 + .5, '#ffb12e') : '') +
      (n < 4 ? '<small style="grid-column:1/3;text-transform:none">Level up Trade to unlock more clues.</small>' : '')
    );
  };
  function applyAccount(state: TradeState) {
    const before = L('trade');
    const today = new Date().toISOString().slice(0, 10);
    funds = Number(state.available);
    setHudAvailable(funds);
    setHudSettling(Number(state.settling) || 0);
    S.xp.trade = state.xp.trade;
    if (S.payDay !== today) {
      S.payDay = today;
      S.payUsed = 0;
    }
    S.payUsed = Math.max(S.payUsed, state.payUsed);
    if (L('trade') > before) banner(`Trade skill up: level ${L('trade')}`, 'good');
    save();
    updateHud();
  }
  function render() {
    sheet.dataset.lock = pos ? '1' : '';
    const fr = snap[snap.length - 1]!,
      c0 = fr / snap[0]! - 1,
      entry = pos ? Number(pos.bet.p0) : null;
    sheet.innerHTML = `<h2>Trade Terminal</h2><p>Pick a coin and guess if its price will go up or down in 10 seconds. Guess right and you win GD. Guess wrong and you lose some.</p>
    <div class="chips">${TOK.map(t => `<button data-t="${t.sym}" class="${t === tk ? 'on' : ''}" ${pos ? 'disabled' : ''}>${t.sym}</button>`).join('')}</div>
    <div class="tk"><span><b>${tk.name}</b> <small style="text-transform:none">${TOKINFO[tk.sym]}</small></span></div>
    <div class="tk"><b>${px(pos ? tk.price : fr)} <small>per coin</small></b><span id="tch" class="${c0 >= 0 ? 'pos' : 'neg'}">${(c0 >= 0 ? '+' : '') + (c0 * 100).toFixed(2)}% recently</span></div>
    <canvas class="chart" id="tcv"></canvas>
    ${pos ? '' : '<div class="hint">The chart is paused. It starts moving when you place your bet.</div>'}
    <div class="sig" id="tsig">${sigs(tk)}</div>
    ${
      pos
        ? `<div class="live"><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" class="bg"/><circle cx="50" cy="50" r="42" class="fg" id="rfg"/></svg><b id="rnum">10</b><div><small>Your bet is running</small><div id="tpnl" class="big">0</div><div class="hint" id="tdesc"></div></div></div>`
        : `
    <small>How much do you want to bet?</small>
    <div class="chips" id="stk">${STAKES.map(v => `<button data-s="${v}" class="${v === stake ? 'on' : ''}" ${v > funds ? 'disabled' : ''}>${fmtN(v)}</button>`).join('')}</div>
    <input id="cust" type="text" inputmode="numeric" placeholder="Or type your own amount" autocomplete="off">
    <div class="hint" id="mult"></div>
    <div class="acts"><button class="bet up" id="tlong"><span class="ico"><i class="ar">${ARROW(1)}</i></span><span class="bt"><b>Bet UP</b><small>Win if the price is higher in 10 seconds</small></span></button>
    <button class="bet dn" id="tshort"><span class="ico"><i class="ar d">${ARROW(0)}</i></span><span class="bt"><b>Bet DOWN</b><small>Win if the price is lower in 10 seconds</small></span></button></div>
    <div class="acts"><button id="tx">Cancel</button></div>`
    }`;
    sheet.querySelectorAll('[data-t]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        tk = TOK.find(t => t.sym === (b as HTMLElement).dataset.t)!;
        snap = tk.hist.slice(-120);
        render();
      };
    });
    sheet.querySelectorAll('[data-s]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        stake = +(b as HTMLElement).dataset.s!;
        render();
      };
    });
    if (!pos) {
      const ci = $('#cust') as HTMLInputElement;
      ci.oninput = () => {
        const v = parseInt(ci.value.replace(/\D/g, ''), 10);
        if (v) {
          stake = clamp(v, TRADE_MIN_STAKE, TRADE_MAX_STAKE);
          sheet.querySelectorAll('[data-s]').forEach(b => b.classList.remove('on'));
        }
        note();
      };
      note();
      ($('#tlong') as HTMLButtonElement).onclick = () => void start(1);
      ($('#tshort') as HTMLButtonElement).onclick = () => void start(-1);
      ($('#tx') as HTMLButtonElement).onclick = closeModal;
    }
    drawChart($('#tcv') as HTMLCanvasElement, pos ? tk.hist.slice(-60) : snap, entry);
  }
  function note() {
    const m = $('#mult');
    if (m)
      m.innerHTML = `Betting <b>${fmtN(stake)} GD</b> (1% fee). Moves are multiplied by 20: if the price changes 1%, you win or lose about <b>${fmtN(stake * .2)} GD</b>. You can never lose more than your bet.`;
  }
  function paint(mark: number, left: number) {
    const el = $('#tpnl');
    if (!el || !pos) return;
    el.textContent = (mark >= 0 ? '+' : '') + fmtN(mark) + ' GD';
    el.className = 'big ' + (mark >= 0 ? 'pos' : 'neg');
    ($('#rnum') as HTMLElement).textContent = String(Math.max(0, Math.ceil(left)));
    const C = 2 * Math.PI * 42;
    const ring = $('#rfg') as HTMLElement;
    ring.style.strokeDasharray = String(C);
    ring.style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, left / 10))));
    const c = $('#tcv') as HTMLCanvasElement | null;
    if (c) drawChart(c, tk.hist.slice(-60), Number(pos.bet.p0));
  }
  function watch() {
    const C = 2 * Math.PI * 42;
    ($('#rfg') as HTMLElement).style.strokeDasharray = String(C);
    ($('#tdesc') as HTMLElement).textContent = `You bet ${pos!.bet.dir > 0 ? 'UP' : 'DOWN'} on ${pos!.bet.sym}. The dashed line is where you started.`;
    setModalTimer(
      setInterval(() => {
        if (!pos || pos.bet.status === 'settled') return;
        pos.trail.push(tk.price);
        const left = Math.max(0, (pos.bet.resolvesAt - Date.now()) / 1000);
        paint(Number(pos.bet.markPnl), left);
        void tradeRequest('/trade')
          .then(state => {
            if (!pos || !state.bet || state.bet.id !== pos.bet.id) return;
            pos.bet = state.bet;
            if (state.bet.status === 'settled') {
              if (settled) return;
              settled = true;
              clearInterval(modalTimer as number);
              setModalTimer(0);
              applyAccount(state);
              finish(state.bet);
            }
          })
          .catch(() => {});
      }, 500),
    );
  }
  function showOpen(bet: ServerBet) {
    const found = TOK.find(t => t.sym === bet.sym);
    if (found) tk = found;
    pos = { bet, trail: [Number(bet.p0), tk.price] };
    render();
    watch();
  }
  async function start(d: 1 | -1) {
    if (busy || pos) return;
    if (stake < TRADE_MIN_STAKE || stake > TRADE_MAX_STAKE || stake + Math.round(stake * 0.01) > funds) {
      banner('Not enough GD', 'bad');
      return;
    }
    busy = true;
    try {
      const state = await tradeRequest('/trade/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sym: tk.sym, dir: d, stake }),
      });
      applyAccount(state);
      if (state.bet?.status === 'open') showOpen(state.bet);
    } catch (err) {
      banner(err instanceof Error ? err.message : 'Bet failed', 'bad');
    } finally {
      busy = false;
    }
  }
  function finish(bet: ServerBet) {
    const pnl = Number(bet.pnl ?? bet.markPnl);
    const credited = Number(bet.credited ?? '0');
    const stakeN = Number(bet.stake);
    S.stats.trades++;
    if (pnl > 0) S.stats.wins++;
    crowdTo('trade', 12);
    const side = bet.dir > 0 ? 'UP' : 'DOWN',
      pct = stakeN ? (pnl / stakeN) * 100 : 0,
      end = Number(bet.price),
      p0 = Number(bet.p0),
      mv = p0 ? (end / p0 - 1) * 100 : 0,
      trail = pos?.trail.slice() ?? [p0, end],
      sym = bet.sym,
      nm = tk.name,
      win = pnl >= 0,
      col = win ? '#b8ff3d' : '#ff3d9a';
    const draw = (x: CanvasRenderingContext2D, w: number, h: number) => {
      x.fillStyle = '#070910';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = col;
      x.lineWidth = 3;
      x.strokeRect(6, 6, w - 12, h - 12);
      x.fillStyle = '#e9eefc';
      x.font = '700 40px "Chakra Petch",sans-serif';
      x.fillText(sym + '  ' + (bet.dir > 0 ? '▲ UP' : '▼ DOWN'), 28, 62);
      x.fillStyle = '#8b97b8';
      x.font = '500 20px "Chakra Petch",sans-serif';
      x.fillText(nm + ' · price moved ' + (mv >= 0 ? '+' : '') + mv.toFixed(2) + '%', 28, 92);
      x.textAlign = 'right';
      x.fillStyle = col;
      x.font = '700 62px "JetBrains Mono",monospace';
      x.fillText((pct >= 0 ? '+' : '') + pct.toFixed(1) + '%', w - 28, 70);
      x.textAlign = 'left';
      plotLine(x, trail, 28, 110, w - 56, 190, p0, col);
      x.fillStyle = '#8b97b8';
      x.font = '500 18px "Chakra Petch",sans-serif';
      x.fillText('GLITCH · 10 second trade', 28, h - 20);
    };
    const shown = win ? credited : pnl;
    resultCard(
      win,
      (shown > 0 ? '+' : '') + fmtN(shown) + ' GD',
      `${pct >= 0 ? 'You won' : 'You lost'} ${Math.abs(pct).toFixed(0)}% of your bet`,
      `I bet ${side} on ${sym} in Glitch: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% in 10 seconds.`,
      draw,
    );
    if (pnl < 0) post('bad', S.name, `lost a bet going ${side} on ${sym}. pain.`);
    else if (pnl > 50000) post('npc', S.name, `just won ${fmt(pnl)} GD on ${sym}`);
    save();
    updateHud();
  }
  openModal('');
  render();
  void tradeRequest('/trade')
    .then(state => {
      applyAccount(state);
      if (state.bet?.status === 'open') showOpen(state.bet);
      else if (!pos) render();
    })
    .catch(() => {});
}

type VaultStart = {
  id: string;
  seed: number;
  startedAt: number;
  locks: VaultLock[];
  pauseMs: number;
};

type VaultFinish = {
  status: 'open' | 'settled';
  hit: boolean;
  hits: number;
  stops: number[];
  credited: string | null;
  capped: boolean;
  shardsMinted: number;
  shardBalance: string | null;
  available: string;
  settling?: string;
  xp: { trade: number; sec: number; comm: number };
  payUsed: number;
  error?: string;
};

async function vaultRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Vault failed');
  return data;
}

export function secGame() {
  let attempt: VaultStart | null = null,
    stops: number[] = [],
    results: boolean[] = [],
    round = 0,
    done = false,
    busy = false,
    ticking = false;
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === ' ' || e.key === 'Enter') && !done) {
      e.preventDefault();
      void stop();
    }
  };
  addEventListener('keydown', onKey);
  openModal('', () => {
    removeEventListener('keydown', onKey);
    if (!done) void vaultRequest('/vault/cancel', { method: 'POST' }).catch(() => {});
  });
  sheet.dataset.lock = '1';
  sheet.innerHTML = `<h2>Vault Cracker</h2><p>Opening the vault…</p>`;

  function applyAccount(state: VaultFinish) {
    const before = L('sec');
    const today = new Date().toISOString().slice(0, 10);
    setHudAvailable(Number(state.available));
    setHudSettling(Number(state.settling) || 0);
    S.xp.sec = state.xp.sec;
    if (S.payDay !== today) {
      S.payDay = today;
      S.payUsed = 0;
    }
    S.payUsed = Math.max(S.payUsed, state.payUsed);
    if (state.shardBalance != null) S.shards = Number(state.shardBalance) || 0;
    if (L('sec') > before) banner(`Security skill up: level ${L('sec')}`, 'good');
    save();
    updateHud();
  }
  function paintNeedle() {
    if (busy || done || !attempt) return;
    const lock = attempt.locks[round];
    if (!lock) return;
    const elapsed = Date.now() - attempt.startedAt - vaultLockStart(stops, round);
    const p = vaultNeedle(elapsed, lock.speed);
    const n = $('#ndl') as HTMLElement | null;
    if (n) n.style.left = `calc(${p * 100}% - 3px)`;
  }
  function render() {
    if (!attempt) return;
    const lock = attempt.locks[round];
    if (!lock) return;
    sheet.dataset.lock = '1';
    sheet.innerHTML = `<h2>Vault Cracker</h2><p>A rich NPC left a vault open. Tap STOP (or press Space) when the glowing needle is inside the green zone.</p>
    <div class="locks">${[0, 1, 2]
      .map(i => {
        const past = i < round;
        const cls = i === round ? 'now' : past && results[i] ? 'ok' : '';
        const label = past ? (results[i] ? 'OPEN' : 'MISS') : 'LOCK ' + (i + 1);
        return `<span class="lk2 ${cls}">${label}</span>`;
      })
      .join('')}</div>
    <div class="vbar"><i class="zone" style="left:${lock.zoneStart * 100}%;width:${lock.zoneWidth * 100}%"></i><i class="needle" id="ndl"></i></div>
    <div class="hint">Each lock is faster and the green zone is smaller. Each open lock pays GD.</div>
    <div class="acts"><button class="pri" id="stopb" style="font-size:18px;padding:14px">STOP</button><button id="vx">Leave</button></div>`;
    ($('#stopb') as HTMLButtonElement).onclick = () => void stop();
    ($('#vx') as HTMLButtonElement).onclick = () => void leave();
    paintNeedle();
    if (!ticking) {
      ticking = true;
      setModalTimer(setInterval(paintNeedle, 16));
    }
  }
  function showResult(state: VaultFinish) {
    done = true;
    clearInterval(modalTimer as number);
    setModalTimer(0);
    applyAccount(state);
    const hits = state.hits;
    const credited = Number(state.credited ?? '0');
    const shd = state.shardsMinted;
    if (hits === 3) post('good', S.name, 'cracked a whole vault. smooth.');
    resultCard(
      hits >= 2,
      hits ? '+' + fmtN(credited) + ' GD' : 'Locked out',
      `${hits} of 3 locks opened${hits === 3 ? '. PERFECT!' : ''}${shd ? ` · +${shd} shards` : ''}`,
      `I opened ${hits}/3 locks in the Glitch vault game.`,
    );
  }
  async function leave() {
    if (done) {
      closeModal();
      return;
    }
    done = true;
    sheet.dataset.lock = '';
    try {
      await vaultRequest('/vault/cancel', { method: 'POST' });
    } catch {
      /* already closed */
    }
    closeModal();
  }
  async function stop() {
    if (done || busy || !attempt) return;
    const elapsed = Math.round(Date.now() - attempt.startedAt);
    if (elapsed < vaultLockStart(stops, round)) return;
    busy = true;
    try {
      const state = await vaultRequest<VaultFinish>('/vault/finish', {
        method: 'POST',
        body: JSON.stringify({ stops: [...stops, elapsed] }),
      });
      stops = state.stops;
      results[round] = state.hit;
      const n = $('#ndl') as HTMLElement | null;
      if (n) n.style.background = state.hit ? '#b8ff3d' : '#ff3d9a';
      if (state.status === 'settled') {
        window.setTimeout(() => {
          if (!done) showResult(state);
        }, attempt.pauseMs);
        return;
      }
      const nextIndex = stops.length;
      const startAt = vaultLockStart(stops, nextIndex);
      const wait = Math.max(0, startAt - (Date.now() - attempt.startedAt));
      window.setTimeout(() => {
        if (done) return;
        round = nextIndex;
        busy = false;
        render();
      }, wait);
    } catch (err) {
      busy = false;
      banner(err instanceof Error ? err.message : 'Vault failed', 'bad');
    }
  }
  async function openAttempt(): Promise<VaultStart> {
    try {
      return await vaultRequest<VaultStart>('/vault/start', { method: 'POST' });
    } catch (err) {
      if (!(err instanceof Error) || !/already open/i.test(err.message)) throw err;
      await vaultRequest('/vault/cancel', { method: 'POST' });
      return await vaultRequest<VaultStart>('/vault/start', { method: 'POST' });
    }
  }
  void (async () => {
    try {
      attempt = await openAttempt();
      if (done) {
        await vaultRequest('/vault/cancel', { method: 'POST' }).catch(() => {});
        return;
      }
      render();
    } catch (err) {
      if (done) return;
      sheet.dataset.lock = '';
      sheet.innerHTML = `<h2>Vault Cracker</h2><p>${esc(err instanceof Error ? err.message : 'Could not open the vault')}</p><div class="acts"><button id="vx">Leave</button></div>`;
      ($('#vx') as HTMLButtonElement).onclick = () => closeModal();
    }
  })();
}

export const FREEGEAR = [0, 2];
export const GEARINFO: Record<number, { shd: number; gd: number; rar: string }> = {
  1: { shd: 3, gd: 1000, rar: 'Common' },
  3: { shd: 8, gd: 5000, rar: 'Rare' },
  4: { shd: 5, gd: 2500, rar: 'Common' },
  5: { shd: 15, gd: 10000, rar: 'Epic' },
  6: { shd: 30, gd: 20000, rar: 'Legendary' },
};

export const gearOwned = (g: number) => FREEGEAR.includes(g) || S.nfts.some(n => n.g === g);

export function openCustomizer() {
  const pd = cam.dist,
    pp = cam.pitch,
    pty = cam.ty;
  setCustomizing(true);
  cam.dist = 7.6;
  cam.pitch = .1;
  cam.ty = -0.7;
  openModal('', () => {
    setCustomizing(false);
    cam.dist = pd;
    cam.pitch = pp;
    cam.ty = pty;
    modalEl.classList.remove('low');
    save();
  });
  modalEl.classList.add('low');
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  const sw = (a: number[], k: keyof typeof S.look) =>
    a
      .map(
        (c, i) =>
          `<button class="sw ${S.look[k] === i ? 'on' : ''}" data-k="${k}" data-v="${i}" style="background:${hex(c)}" aria-label="${k} ${i + 1}"></button>`,
      )
      .join('');
  const ch = (a: string[], k: 'hair' | 'gear' | 'capDir') =>
    a
      .map((n, i) => {
        const lk = k === 'gear' && !gearOwned(i);
        return `<button class="${S.look[k] === i ? 'on' : ''}" data-k="${k}" data-v="${i}" ${lk ? 'disabled title="Mint it at the Gear Forge"' : ''}>${n}${lk ? ' (locked)' : ''}</button>`;
      })
      .join('');
  function render() {
    const capRow =
      S.look.gear === 1
        ? `<small>Cap facing</small><div class="chips">${ch(CAPDIRS, 'capDir')}</div>`
        : '';
    sheet.innerHTML = `<h2>Your look</h2><div class="cz"><small>Skin</small><div class="chips">${sw(SKINS, 'skin')}</div><small>Hair</small><div class="chips">${ch(HAIRS, 'hair')}</div><small>Hair colour</small><div class="chips">${sw(HAIRC, 'hairC')}</div>
    <small>Top</small><div class="chips">${sw(TOPC, 'top')}</div><small>Trousers</small><div class="chips">${sw(BOTC, 'bot')}</div>
    <small>Glasses</small><div class="chips"><button class="${S.look.glasses ? 'on' : ''}" data-k="glasses" data-v="1">On</button><button class="${S.look.glasses ? '' : 'on'}" data-k="glasses" data-v="0">Off</button>${S.look.glasses ? sw(GLASSC, 'glassC') : ''}</div>
    <small>Gear</small><div class="chips">${ch(GEARS, 'gear')}</div>${capRow}</div><div class="acts"><button class="pri" id="cdone">Done</button></div>`;
    sheet.querySelectorAll('[data-k]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        const k = (b as HTMLElement).dataset.k as keyof typeof S.look;
        const v = (b as HTMLElement).dataset.v!;
        if (k === 'glasses') S.look.glasses = v === '1';
        else (S.look as unknown as Record<string, number | boolean>)[k] = +v;
        buildLook(player, S.look);
        render();
      };
    });
    ($('#cdone') as HTMLButtonElement).onclick = closeModal;
  }
  render();
}

type PostTake = 'hype' | 'warn' | 'meme';

type PostResult = {
  sym: string;
  take: PostTake;
  reach: number;
  viral: boolean;
  followers: number;
  followerTotal: number;
  pnl: string;
  credited: string;
  capped: boolean;
  available: string;
  settling?: string;
  xp: { trade: number; sec: number; comm: number };
  payUsed: number;
  error?: string;
};

export function commGame() {
  let tk = TOK[3]!,
    take: PostTake | null = null,
    funds = hudAvailable ?? S.bal,
    busy = false;
  function render() {
    sheet.dataset.lock = '';
    sheet.innerHTML = `<h2>Attention Booth</h2><p>Boost a post for ${fmt(POST_COST)} GD. Read the mood: hype works in greed, warnings work in fear, memes work any time (a bit less).</p>
    <div class="chips">${TOK.map(t => `<button data-t="${t.sym}" class="${t === tk ? 'on' : ''}">${t.sym}</button>`).join('')}</div>
    <div class="chips">${([['hype', `${tk.sym} to the moon`], ['warn', `careful: ${tk.sym} looks like a rug`], ['meme', `me explaining ${tk.sym} to my landlord`]] as const).map(([k, l]) => `<button data-k="${k}" class="${take === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    <small>Followers ${fmtN(S.followers)} · Community level ${L('comm')}</small>
    <div class="acts"><button class="pri" id="pst" ${take && funds >= POST_COST && !busy ? '' : 'disabled'}>Post</button><button id="px">Cancel</button></div>`;
    sheet.querySelectorAll('[data-t]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        tk = TOK.find(t => t.sym === (b as HTMLElement).dataset.t)!;
        render();
      };
    });
    sheet.querySelectorAll('[data-k]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        take = (b as HTMLElement).dataset.k as PostTake;
        render();
      };
    });
    ($('#px') as HTMLButtonElement).onclick = closeModal;
    ($('#pst') as HTMLButtonElement).onclick = () => void send();
  }
  function applyAccount(state: PostResult) {
    const before = L('comm');
    const today = new Date().toISOString().slice(0, 10);
    funds = Number(state.available);
    setHudAvailable(funds);
    setHudSettling(Number(state.settling) || 0);
    S.xp.comm = state.xp.comm;
    S.followers = state.followerTotal;
    if (S.payDay !== today) {
      S.payDay = today;
      S.payUsed = 0;
    }
    S.payUsed = Math.max(S.payUsed, state.payUsed);
    if (L('comm') > before) banner(`Community skill up: level ${L('comm')}`, 'good');
    save();
    updateHud();
  }
  async function send() {
    if (busy || !take || funds < POST_COST) return;
    busy = true;
    render();
    const chosen = take;
    const sym = tk.sym;
    try {
      const res = await fetch('/post', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sym, take: chosen }),
      });
      const state = (await res.json()) as PostResult;
      if (!res.ok) throw new Error(state.error || 'Could not post');
      applyAccount(state);
      S.stats.posts++;
      if (state.reach > 1.2) S.rep++;
      const txt =
        chosen === 'hype' ? `${sym} to the moon` : chosen === 'warn' ? `careful: ${sym} looks like a rug` : `me explaining ${sym} to my landlord`;
      post('npc', S.name, txt);
      crowdTo('comm', 12);
      if (state.viral) post('sys', 'TRENDING', `${S.name}'s ${sym} post is going viral.`);
      const pnl = Number(state.pnl);
      const credited = Number(state.credited);
      const shown = pnl >= 0 ? credited : pnl;
      resultCard(
        shown >= 0,
        (shown >= 0 ? '+' : '') + fmt(shown) + ' GD',
        `${state.viral ? 'VIRAL. ' : ''}+${state.followers} followers`,
        `My ${sym} take in Glitch ${state.viral ? 'went viral' : 'got ' + state.followers + ' new followers'}.`,
      );
      save();
    } catch (err) {
      busy = false;
      banner(err instanceof Error ? err.message : 'Could not post', 'bad');
      render();
    }
  }
  openModal('');
  render();
}

export const MAINTENANCE = MAINTENANCE_GD,
  MAINTENANCE_MS = MAINTENANCE_PERIOD_MS,
  HOMEP = HOMEP_GD;

function fundsNow(): number {
  return hudAvailable ?? S.bal;
}

function applyFunds(available: string, settling?: string): void {
  const n = Number(available);
  setHudAvailable(n);
  if (settling != null) setHudSettling(Number(settling) || 0);
  S.bal = n;
}

function applyNeeds(needs: { energy: number; hunger: number }): void {
  S.needs.energy = needs.energy;
  S.needs.hunger = needs.hunger;
}

async function lifeRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export type CityDayPhase = 'idle' | 'loading' | 'playing' | 'done' | 'error';

export type CityDayRow = {
  itemId: string;
  title: string;
  /** Morning price, before any sales. */
  open: number;
  /** Highest sale price seen so far. */
  high: number;
  /** Price after the day finishes restocking. Stays at the open until playback ends. */
  close: number;
  sales: number;
};

export type CityDayShop = {
  id: 'chef' | 'smith' | 'dealer';
  name: string;
  rows: CityDayRow[];
};

export type CityDayHeadline = {
  t: number;
  kind: 'pump' | 'rugPull';
  title: string;
};

/** Playback board for one simulated city day. Live menus and GD are never written. */
export type CityDayNpcTrade = {
  t: number;
  from: string;
  to: string;
  amount: number;
  label: string;
};

export type CityDayBoard = {
  phase: CityDayPhase;
  hours: number;
  /** 0..1 through the simulated day. */
  progress: number;
  /** Simulated clock, HH:MM from midnight. */
  clock: string;
  /** Most recent sale, for the live line. */
  latest: string;
  error: string;
  shops: CityDayShop[];
  headlines: CityDayHeadline[];
  shownHeadlines: number;
  sales: number;
  pumps: number;
  rugs: number;
  /** Off-chain NPC city-trade events for the day recap. */
  npcTrades: CityDayNpcTrade[];
  shownNpcTrades: number;
};

type SimPoint = { t: number; itemId: string; price: number };
type TrackedRow = CityDayRow & { end: number; pts: SimPoint[]; idx: number };

const SHOP_META = [
  { id: 'chef', name: 'Diner' },
  { id: 'smith', name: 'Forge' },
  { id: 'dealer', name: 'Dealer' },
] as const;

function emptyCityDay(): CityDayBoard {
  return {
    phase: 'idle',
    hours: 24,
    progress: 0,
    clock: '00:00',
    latest: '',
    error: '',
    shops: [],
    headlines: [],
    shownHeadlines: 0,
    sales: 0,
    pumps: 0,
    rugs: 0,
    npcTrades: [],
    shownNpcTrades: 0,
  };
}

export let cityDay: CityDayBoard = emptyCityDay();

/** Overlay-only city day playback (never mutates live menus / GD). */
export let citySimPlaying = false;
let citySimRaf = 0;

const dayClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

function tallyCityDay(): void {
  let sales = 0;
  for (const shop of cityDay.shops) {
    for (const row of shop.rows) sales += row.sales;
  }
  const shown = cityDay.headlines.slice(0, cityDay.shownHeadlines);
  cityDay.sales = sales;
  cityDay.pumps = shown.filter(h => h.kind === 'pump').length;
  cityDay.rugs = shown.filter(h => h.kind === 'rugPull').length;
}

export function stopCitySimPlayback(): void {
  if (citySimRaf) cancelAnimationFrame(citySimRaf);
  citySimRaf = 0;
  citySimPlaying = false;
}

/**
 * POST /sim/fast-forward and play ~60s as a day recap.
 * Live stock and GD are untouched.
 */
export async function playCityDaySim(onTick?: () => void): Promise<void> {
  if (citySimPlaying) return;
  citySimPlaying = true;
  cityDay = { ...emptyCityDay(), phase: 'loading', latest: 'Fetching the day…' };
  onTick?.();
  try {
    const res = await lifeRequest<{
      hours: number;
      seed: number;
      merchants: Record<
        'chef' | 'smith' | 'dealer',
        { timeline: SimPoint[]; ending: Record<string, { price: number }> }
      >;
      events: Array<{ t: number; kind: 'pump' | 'rugPull'; title: string }>;
      npcTrades?: {
        trades: Array<{ t: number; from: string; to: string; amount: number; label: string }>;
      };
    }>('/sim/fast-forward', { hours: 24, seed: 42 });

    const shops: CityDayShop[] = SHOP_META.map(meta => {
      const merchant = res.merchants[meta.id];
      const byItem = new Map<string, SimPoint[]>();
      for (const p of merchant.timeline) {
        const list = byItem.get(p.itemId) ?? [];
        list.push(p);
        byItem.set(p.itemId, list);
      }
      const rows: TrackedRow[] = merchantRulesFor(meta.id).map(rule => {
        const pts = (byItem.get(rule.id) ?? []).slice().sort((a, b) => a.t - b.t);
        return {
          itemId: rule.id,
          title: catalogById(rule.id)?.title ?? rule.id,
          open: rule.basePrice,
          high: rule.basePrice,
          close: rule.basePrice,
          end: merchant.ending[rule.id]?.price ?? rule.basePrice,
          sales: 0,
          pts,
          idx: 0,
        };
      });
      return { id: meta.id, name: meta.name, rows };
    });

    const headlines = res.events.slice().sort((a, b) => a.t - b.t);
    const npcTrades: CityDayNpcTrade[] = (res.npcTrades?.trades ?? [])
      .slice()
      .sort((a, b) => a.t - b.t)
      .map(t => ({
        t: t.t,
        from: t.from,
        to: t.to,
        amount: t.amount,
        label: t.label,
      }));
    cityDay = {
      phase: 'playing',
      hours: res.hours,
      progress: 0,
      clock: '00:00',
      latest: 'The day is starting.',
      error: '',
      shops,
      headlines,
      shownHeadlines: 0,
      sales: 0,
      pumps: 0,
      rugs: 0,
      npcTrades,
      shownNpcTrades: 0,
    };
    onTick?.();

    const horizon = Math.max(1, res.hours * 3600);
    const playMs = 60_000;
    const started = performance.now();
    let headIdx = 0;
    let npcIdx = 0;
    let lastUi = 0;

    const advance = (simT: number, final: boolean) => {
      let latest = cityDay.latest;
      for (const shop of cityDay.shops) {
        for (const row of shop.rows as TrackedRow[]) {
          while (row.idx < row.pts.length && row.pts[row.idx]!.t <= simT) {
            const p = row.pts[row.idx]!;
            if (p.price > row.high) row.high = p.price;
            row.sales += 1;
            row.idx += 1;
            latest = `${shop.name} sold ${row.title} at ${fmtN(p.price)} GD`;
          }
          if (final) row.close = row.end;
        }
      }
      while (headIdx < headlines.length && headlines[headIdx]!.t <= simT) headIdx += 1;
      while (npcIdx < npcTrades.length && npcTrades[npcIdx]!.t <= simT) {
        const hop = npcTrades[npcIdx]!;
        latest = `${roleLabel(hop.from)} → ${roleLabel(hop.to)} ${fmtN(hop.amount)} GD (${hop.label})`;
        npcIdx += 1;
      }
      cityDay.shownHeadlines = headIdx;
      cityDay.shownNpcTrades = npcIdx;
      cityDay.latest = final
        ? `${fmtN(npcTrades.length)} NPC supply trades today. Live prices were not changed.`
        : latest;
      cityDay.progress = final ? 1 : Math.min(1, simT / horizon);
      cityDay.clock = dayClock(final ? horizon : simT);
      tallyCityDay();
    };

    await new Promise<void>(resolve => {
      const tick = (now: number) => {
        const elapsed = now - started;
        const done = elapsed >= playMs;
        advance(done ? horizon : (elapsed / playMs) * horizon, done);
        if (done) {
          citySimPlaying = false;
          citySimRaf = 0;
          cityDay.phase = 'done';
          banner('Day recap is ready. Live prices were not changed.', 'info');
          onTick?.();
          resolve();
          return;
        }
        if (now - lastUi > 250) {
          lastUi = now;
          onTick?.();
        }
        citySimRaf = requestAnimationFrame(tick);
      };
      citySimRaf = requestAnimationFrame(tick);
    });
  } catch (err) {
    stopCitySimPlayback();
    cityDay = {
      ...emptyCityDay(),
      phase: 'error',
      error: err instanceof Error ? err.message : 'Could not simulate',
    };
    onTick?.();
    throw err;
  }
}

let warnT = 0;
/** Warnings and pose only. Hunger and energy come from the server. */
export function lifeUpdate(dt: number) {
  const n = S.needs;
  warnT -= dt;
  if (warnT <= 0) {
    if (n.hunger < 10) {
      banner('You are starving. Eat at the Neon Diner.', 'bad');
      warnT = 60;
    } else if (n.energy < 15) {
      banner('You are exhausted. Rest on a bench or sleep at home.', 'bad');
      warnT = 60;
    }
  }
  const r = player.userData.rig as THREE.Object3D;
  r.rotation.x += ((weak() ? .14 : 0) - r.rotation.x) * Math.min(1, dt * 4);
  rain.visible = !isInside();
}

export function progressModal(title: string, line: string, secs: number, done: () => void) {
  sheet.dataset.lock = '1';
  const C = 2 * Math.PI * 42;
  sheet.innerHTML = `<h2>${title}</h2><p>${line}</p><div class="live" style="justify-content:center"><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" class="bg"/><circle cx="50" cy="50" r="42" class="fg" id="rfg" style="stroke-dasharray:${C};stroke-dashoffset:0"/></svg><b id="rnum">${secs}</b></div>`;
  let t = secs;
  clearInterval(modalTimer as number);
  setModalTimer(
    setInterval(() => {
      t -= .25;
      ($('#rnum') as HTMLElement).textContent = String(Math.max(0, Math.ceil(t)));
      ($('#rfg') as HTMLElement).style.strokeDashoffset = String(C * (1 - t / secs));
      if (t <= 0) {
        clearInterval(modalTimer as number);
        setModalTimer(0);
        sheet.dataset.lock = '';
        done();
      }
    }, 250),
  );
}
export const meters = () =>
  `<div class="needs" style="margin:6px 0"><div><span>Energy ${Math.round(S.needs.energy)}</span><i><b style="width:${S.needs.energy}%;background:var(--amber)"></b></i></div><div><span>Hunger ${Math.round(S.needs.hunger)}</span><i><b style="width:${S.needs.hunger}%;background:var(--lime)"></b></i></div></div>`;

type MerchantMenuDish = {
  itemId: string;
  title: string;
  stock: number;
  price: number;
  demandEma?: number;
  reasoning: { stockFactor: number; demandFactor: number; clamp: string; finalPrice: number };
  shardsCost?: number;
};

/** @deprecated Alias. */
type ChefMenuDish = MerchantMenuDish;

type MerchantLastTrade = {
  from: string;
  to: string;
  amount: number;
  label: string;
  at: number;
};

type MerchantShopMeta = {
  closed: boolean;
  balanceKnown: boolean;
  gdBalance: string;
  minBalance: number;
  lastTrade?: MerchantLastTrade;
};

/** Cached menus / quotes from GET /merchants. */
export let chefMenu: MerchantMenuDish[] = [];
export let dealerQuotes: Record<string, MerchantMenuDish> = {};
export let smithQuotes: Record<string, MerchantMenuDish> = {};
export let chefShop: MerchantShopMeta = { closed: false, balanceKnown: false, gdBalance: '0', minBalance: 1000 };
export let smithShop: MerchantShopMeta = { closed: false, balanceKnown: false, gdBalance: '0', minBalance: 1000 };
export let dealerShop: MerchantShopMeta = { closed: false, balanceKnown: false, gdBalance: '0', minBalance: 1000 };

function shopMeta(
  raw:
    | {
        closed?: boolean;
        balanceKnown?: boolean;
        gdBalance?: string;
        minBalance?: number;
        lastTrade?: MerchantLastTrade;
      }
    | undefined,
): MerchantShopMeta {
  return {
    closed: !!raw?.closed,
    balanceKnown: raw?.balanceKnown === true,
    gdBalance: String(raw?.gdBalance ?? '0'),
    minBalance: Number(raw?.minBalance ?? 1000) || 1000,
    lastTrade: raw?.lastTrade,
  };
}

const CLOSED_MSG = 'Closed — merchant is out of GD';

function roleLabel(id: string): string {
  if (id === 'chef') return 'Chef';
  if (id === 'smith') return 'Smith';
  if (id === 'dealer') return 'Dealer';
  return id;
}

function merchantWalletBlock(name: string, shop: MerchantShopMeta): string {
  const status = shop.closed
    ? CLOSED_MSG
    : shop.balanceKnown
      ? 'Open'
      : 'Open · balance syncing…';
  const bal =
    shop.balanceKnown || Number(shop.gdBalance) > 0
      ? `${fmtN(Number(shop.gdBalance))} GD`
      : '—';
  const last = shop.lastTrade
    ? `<p class="hint">Last: ${esc(roleLabel(shop.lastTrade.from))} → ${esc(roleLabel(shop.lastTrade.to))} ${fmtN(shop.lastTrade.amount)} GD (${esc(shop.lastTrade.label)})</p>`
    : '';
  const closedHint = shop.closed
    ? `<p class="hint">NPC city trades and player sales refill this wallet (${fmtN(Number(shop.gdBalance))} / ${fmtN(shop.minBalance)}).</p>`
    : '';
  return `<div class="day" style="margin:8px 0"><b>${esc(name)} wallet</b><p class="hint">${esc(status)} · ${bal}</p>${last}${closedHint}</div>`;
}

/** Poll GET /merchants while a merchant UI is open. */
export function startMerchantPoll(onUpdate: () => void): () => void {
  const id = window.setInterval(() => {
    void loadMerchantQuotes()
      .then(() => onUpdate())
      .catch(() => {});
  }, 5_000);
  return () => window.clearInterval(id);
}

function newestLastTrade(): MerchantLastTrade | undefined {
  let best: MerchantLastTrade | undefined;
  for (const shop of [chefShop, smithShop, dealerShop]) {
    const t = shop.lastTrade;
    if (!t) continue;
    if (!best || t.at > best.at) best = t;
  }
  return best;
}

export function formatCityTrade(t: MerchantLastTrade): string {
  return `${roleLabel(t.from)} → ${roleLabel(t.to)} ${fmtN(t.amount)} GD · ${t.label}`;
}

let cityTradePulse = 0;

/** Light world poll so on-chain merchant hops show in the market strip (no toast). */
export function startCityTradePulse(): void {
  if (cityTradePulse) return;
  const tick = () => {
    void loadMerchantQuotes().catch(() => {});
  };
  tick();
  cityTradePulse = window.setInterval(tick, 10_000);
}

export async function loadMerchantQuotes(): Promise<void> {
  const res = await fetch('/merchants', { credentials: 'include' });
  const data = (await res.json()) as {
    error?: string;
    chef?: {
      menu: MerchantMenuDish[];
      closed?: boolean;
      gdBalance?: string;
      minBalance?: number;
      lastTrade?: MerchantLastTrade;
    };
    dealer?: {
      menu: MerchantMenuDish[];
      closed?: boolean;
      gdBalance?: string;
      minBalance?: number;
      lastTrade?: MerchantLastTrade;
    };
    smith?: {
      menu: MerchantMenuDish[];
      closed?: boolean;
      gdBalance?: string;
      minBalance?: number;
      lastTrade?: MerchantLastTrade;
    };
  };
  if (!res.ok) throw new Error(data.error || 'Could not load merchants');
  chefShop = shopMeta(data.chef);
  dealerShop = shopMeta(data.dealer);
  smithShop = shopMeta(data.smith);
  chefMenu = data.chef?.menu ?? [];
  dealerQuotes = Object.fromEntries((data.dealer?.menu ?? []).map(d => [d.itemId, d]));
  smithQuotes = Object.fromEntries((data.smith?.menu ?? []).map(d => [d.itemId, d]));
  const latest = newestLastTrade();
  const line = latest ? formatCityTrade(latest) : null;
  if (line !== cityTradeGlance) {
    setCityTradeGlance(line);
    updateHud();
  }
}

const reasonHint = (d: Pick<MerchantMenuDish, 'reasoning' | 'stock'>) => {
  const r = d.reasoning;
  const bits = [
    `stock ×${r.stockFactor.toFixed(2)}`,
    `demand ×${r.demandFactor.toFixed(2)}`,
    r.clamp !== 'none' ? `clamp ${r.clamp}` : null,
    `left ${d.stock.toFixed(1)}`,
  ].filter(Boolean);
  return bits.join(' · ');
};

export function dinerGame() {
  let busy = false;
  let menu: ChefMenuDish[] = [];
  /** Simulated overlay prices by itemId (playback only; live menu stays underneath). */
  let simPrices: Record<string, number> = {};
  let simPlaying = false;
  let simRaf = 0;
  let simLastUi = 0;
  const stopPoll = startMerchantPoll(() => {
    if (!busy) r();
  });
  const stopSim = () => {
    if (simRaf) cancelAnimationFrame(simRaf);
    simRaf = 0;
    simPlaying = false;
    simPrices = {};
  };
  const loadMenu = async () => {
    await loadMerchantQuotes();
    menu = chefMenu;
  };
  const r = () => {
    const funds = fundsNow();
    const closed = chefShop.closed;
    menu = chefMenu.length ? chefMenu : menu;
    sheet.innerHTML = `<h2>Neon Diner</h2><p>Paid in <b>GD</b>. Prices move with stock and demand. You have <b>${fmtN(funds)} GD</b>.</p>${meters()}${merchantWalletBlock('Chef', chefShop)}${
      menu.length === 0
        ? '<p class="hint">Loading menu…</p>'
        : menu
            .map(d => {
              const item = catalogById(d.itemId);
              const h = item?.effect.hunger ?? 0;
              const e = item?.effect.energy ?? 0;
              const soldOut = d.stock < 1;
              const sim = simPrices[d.itemId];
              const simHint =
                sim != null ? `<div class="hint">sim ${fmtN(sim)} GD</div>` : '';
              const disable = closed || soldOut || funds < d.price || busy;
              const label = closed ? 'Closed' : soldOut ? 'Sold out' : `${fmtN(d.price)} GD`;
              return `<div class="loc"><div><b>${esc(d.title)}</b><div class="hint">${esc(item?.effect.description ?? '')}${h ? `: +${h} hunger` : ''}${e ? `, +${e} energy` : ''}</div><div class="hint">${esc(reasonHint(d))}</div>${simHint}</div><button class="pri" data-id="${d.itemId}" ${disable ? 'disabled' : ''}>${label}</button></div>`;
            })
            .join('')
    }<div class="acts"><button id="dsim" ${busy || simPlaying || closed ? 'disabled' : ''}>${simPlaying ? 'Simulating…' : 'Simulate 1 day'}</button><button id="dx">Leave</button></div>`;
    sheet.querySelectorAll('[data-id]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        void (async () => {
          if (busy) return;
          busy = true;
          r();
          try {
            const res = await lifeRequest<{
              status: 'delivered' | 'settling';
              available: string;
              settling: string;
              needs: { energy: number; hunger: number };
              price?: number;
              stock?: number;
              demandEma?: number;
              reasoning?: ChefMenuDish['reasoning'];
            }>('/shop/buy', { itemId: (b as HTMLElement).dataset.id });
            applyFunds(res.available, res.settling);
            applyNeeds(res.needs);
            const item = catalogById((b as HTMLElement).dataset.id!);
            if (res.status === 'settling') banner('Payment is still landing on chain…', 'info');
            else banner(`Ate ${item?.title ?? 'food'}${res.price != null ? ` for ${fmtN(res.price)} GD` : ''}.`, 'good');
            crowdTo('eat', 8);
            await loadMenu();
            save();
            updateHud();
          } catch (err) {
            banner(err instanceof Error ? err.message : 'Could not buy', 'bad');
            try {
              await loadMenu();
            } catch {
              /* keep last menu */
            }
          } finally {
            busy = false;
            r();
          }
        })();
      };
    });
    const simBtn = $('#dsim') as HTMLButtonElement | null;
    if (simBtn) {
      simBtn.onclick = () => {
        if (busy || simPlaying) return;
        void (async () => {
          simPlaying = true;
          r();
          try {
            const res = await lifeRequest<{
              hours: number;
              seed: number;
              merchants: {
                chef: {
                  timeline: Array<{ t: number; itemId: string; price: number }>;
                  ending: Record<string, { price: number }>;
                };
              };
              npcTrades?: { trades: unknown[] };
            }>('/sim/fast-forward', { hours: 24, seed: 42 });
            const chef = res.merchants.chef;
            const npcCount = res.npcTrades?.trades?.length ?? 0;
            const horizon = Math.max(1, res.hours * 3600);
            const playMs = 60_000;
            const started = performance.now();
            const points = chef.timeline.slice().sort((a, b) => a.t - b.t);
            let idx = 0;
            const tick = (now: number) => {
              const elapsed = now - started;
              const simT = (elapsed / playMs) * horizon;
              let changed = false;
              while (idx < points.length && points[idx]!.t <= simT) {
                const p = points[idx]!;
                simPrices[p.itemId] = p.price;
                idx += 1;
                changed = true;
              }
              if (changed || now - simLastUi > 250) {
                simLastUi = now;
                r();
              }
              if (elapsed < playMs) {
                simRaf = requestAnimationFrame(tick);
              } else {
                for (const [id, end] of Object.entries(chef.ending)) {
                  simPrices[id] = end.price;
                }
                simPlaying = false;
                simRaf = 0;
                r();
                banner(
                  `Day sim finished · ${fmtN(npcCount)} NPC supply trades. Live prices unchanged.`,
                  'info',
                );
              }
            };
            simRaf = requestAnimationFrame(tick);
          } catch (err) {
            stopSim();
            banner(err instanceof Error ? err.message : 'Could not simulate', 'bad');
            r();
          }
        })();
      };
    }
    ($('#dx') as HTMLButtonElement).onclick = () => {
      stopSim();
      stopPoll();
      closeModal();
    };
  };
  openModal('', () => {
    stopSim();
    stopPoll();
  });
  void loadMenu()
    .then(() => r())
    .catch(err => {
      banner(err instanceof Error ? err.message : 'Could not load menu', 'bad');
      r();
    });
  r();
}

export function benchRest() {
  openModal('');
  progressModal('Resting on the bench', 'Slow, but free. Sleeping at home is much better.', 8, () => {
    void lifeRequest<{ needs: { energy: number; hunger: number }; available: string; settling: string }>(
      '/rest',
      { kind: 'bench' },
    )
      .then(res => {
        applyFunds(res.available, res.settling);
        applyNeeds(res.needs);
        resultCard(true, 'Energy +25', 'You feel a bit better', 'Took a nap on a park bench in Glitch.');
        updateHud();
        save();
      })
      .catch(err => {
        banner(err instanceof Error ? err.message : 'Could not rest', 'bad');
        closeModal();
      });
  });
}

const SLEEPLINES = ['Zzz...', 'Dreaming of green candles...', 'Zzz... MOON... Zzz...'];

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

export function homeHtml(hdr: (title: string, back: string) => string) {
  const H = S.home;
  const funds = fundsNow();
  const closed = dealerShop.closed;
  const studioQ = dealerQuotes['studio-apartment'];
  const studioPrice = studioQ?.price ?? HOMEP;
  const dealerWallet = merchantWalletBlock('Dealer', dealerShop);
  if (!H.owned)
    return (
      hdr('My Home', 'home') +
      dealerWallet +
      `<div class="loc"><div><b>Studio apartment</b><div class="hint">Own a home: sleep to restore energy and decorate. Maintenance is ${fmtN(MAINTENANCE)} GD each period; if it can't be paid, the home is locked until it is.</div>${studioQ ? `<div class="hint">${esc(reasonHint(studioQ))}</div>` : ''}</div></div><div class="acts"><button class="pri" data-a="buyhome" ${closed || funds < studioPrice + MAINTENANCE ? 'disabled' : ''}>${closed ? 'Closed' : `Buy: ${fmtN(studioPrice)} GD + ${fmtN(MAINTENANCE)} GD maintenance`}</button></div><div class="loc"><div><b>Penthouse</b><div class="hint">Bigger rooms. Coming later.</div></div><button disabled>Soon</button></div><p class="hint">You have ${fmtN(funds)} GD.</p>`
    );
  const paintId = H.paint?.id ?? 'midnight';
  const paints = HOME_PAINT_PRESETS.map(
    p =>
      `<button type="button" class="paint-swatch${paintId === p.id ? ' on' : ''}" data-a="homepaint" data-v="${esc(p.id)}" title="${esc(p.name)}" style="--pf:#${p.floor.toString(16).padStart(6, '0')};--pw:#${p.wall.toString(16).padStart(6, '0')};--pa:#${p.accent.toString(16).padStart(6, '0')}"><span>${esc(p.name)}</span></button>`,
  ).join('');
  return (
    hdr('My Home', 'home') +
    dealerWallet +
    `<div class="loc"><div><b>Studio apartment</b><div class="hint">${overdue() ? '<span class="neg">MAINTENANCE OVERDUE. Your bed is locked until you pay.</span>' : 'Maintenance paid for ' + mmss(maintenanceLeft())} · Comfort ${comfort()}</div></div></div>
  <div class="acts"><button class="pri" data-a="gohome">Go home (free)</button><button data-a="paymaintenance" ${closed || funds < MAINTENANCE || maintenanceLeft() > MAINTENANCE_MS * 2 ? 'disabled' : ''}>${closed ? 'Closed' : `Pay maintenance ${fmtN(MAINTENANCE)} GD`}</button></div>
  <small style="display:block;margin-top:10px">Room colors</small><div class="paint-grid">${paints}</div>
  <small style="display:block;margin-top:10px">Furniture</small>` +
    FURN.map(f => {
      const q = dealerQuotes[f.id];
      const price = q?.price ?? catalogById(f.id)?.priceGD ?? f.price;
      const soldOut = q != null && q.stock < 1;
      const hint = q ? `${f.d} · +${f.pts} comfort · ${reasonHint(q)}` : `${f.d} · +${f.pts} comfort`;
      const disable = closed || soldOut || funds < price;
      const label = closed ? 'Closed' : soldOut ? 'Sold out' : fmtN(price);
      return `<div class="loc"><div><b>${f.name}</b><div class="hint">${esc(hint)}</div></div>${hasF(f.id) ? '<span class="tag">Owned</span>' : `<button data-a="furn" data-v="${f.id}" ${disable ? 'disabled' : ''}>${label}</button>`}</div>`;
    }).join('')
  );
}

export function homeAct(a: string, v?: string): boolean | void {
  const H = S.home;
  if (a === 'homepaint') {
    if (!H.owned || !v) return;
    const preset = HOME_PAINT_PRESETS.find(p => p.id === v);
    if (!preset) return;
    H.paint = { id: preset.id, floor: preset.floor, wall: preset.wall, accent: preset.accent };
    applyHomePaint(H.paint);
    save();
    return;
  }
  if (a === 'gohome') {
    if (!H.owned) return;
    closeModal();
    warpIntoBuilding('home', 140, 4);
    if (overdue()) banner('Maintenance is overdue. Pay it in the My Home app.', 'bad');
    return true;
  }
  if (a === 'buyhome') {
    void lifeRequest<{
      studioStatus?: 'delivered' | 'settling';
      maintenanceStatus?: 'delivered' | 'settling';
      homePaidUntil: number;
      available: string;
      settling: string;
      needs: { energy: number; hunger: number };
    }>('/home/buy')
      .then(res => {
        applyFunds(res.available, res.settling);
        applyNeeds(res.needs);
        H.owned = true;
        H.paidUntil = res.homePaidUntil;
        buildFurn();
        if (res.studioStatus === 'settling') banner('Studio payment is still landing…', 'info');
        else if (res.maintenanceStatus === 'settling') banner('Studio bought. Maintenance is still landing…', 'info');
        else if ((res.homePaidUntil ?? 0) <= Date.now()) banner('Studio bought. Pay maintenance to unlock your bed.', 'info');
        else {
          banner('You bought a Studio! Tap Go home.', 'good');
          post('sys', 'NEWS', `${S.name} bought a Studio apartment.`);
        }
        save();
        updateHud();
      })
      .catch(err => banner(err instanceof Error ? err.message : 'Could not buy home', 'bad'));
    return;
  }
  if (a === 'paymaintenance') {
    void lifeRequest<{
      homePaidUntil: number;
      available: string;
      settling: string;
      needs: { energy: number; hunger: number };
      maintenanceStatus?: 'delivered' | 'settling';
    }>('/home/pay-rent')
      .then(res => {
        applyFunds(res.available, res.settling);
        applyNeeds(res.needs);
        H.paidUntil = res.homePaidUntil;
        if (res.maintenanceStatus === 'settling') banner('Maintenance is still landing on chain…', 'info');
        else banner('Maintenance paid', 'good');
        save();
        updateHud();
      })
      .catch(err => banner(err instanceof Error ? err.message : 'Could not pay', 'bad'));
    return;
  }
  if (a === 'furn') {
    if (!v || hasF(v)) return;
    void lifeRequest<{
      status: 'delivered' | 'settling';
      available: string;
      settling: string;
      needs: { energy: number; hunger: number };
    }>('/shop/buy', { itemId: v })
      .then(res => {
        applyFunds(res.available, res.settling);
        applyNeeds(res.needs);
        if (res.status === 'settling') banner('Payment is still landing on chain…', 'info');
        else {
          if (!H.items.includes(v)) H.items.push(v);
          buildFurn();
          const f = FURN.find(x => x.id === v);
          banner(`${f?.name ?? v} placed in your home`, 'good');
        }
        save();
        updateHud();
      })
      .catch(err => banner(err instanceof Error ? err.message : 'Could not buy', 'bad'));
  }
}

export function exitHome() {
  exitBuilding();
  banner('Back in the city', 'info');
}

export function sleepGame() {
  if (!S.home.owned) return;
  if (overdue()) return banner('Your bed is locked: pay maintenance in the My Home app', 'bad');
  openModal('');
  const secs = Math.max(3, Math.round(8 - comfort() * 0.5));
  progressModal('Sleeping', pick(SLEEPLINES), secs, () => {
    void lifeRequest<{ needs: { energy: number; hunger: number }; available: string; settling: string }>(
      '/rest',
      { kind: 'sleep' },
    )
      .then(res => {
        applyFunds(res.available, res.settling);
        applyNeeds(res.needs);
        resultCard(true, 'Fully rested', `Comfort ${comfort()}: slept in ${secs}s`, 'Slept in my Glitch apartment.');
        updateHud();
        save();
      })
      .catch(err => {
        banner(err instanceof Error ? err.message : 'Could not sleep', 'bad');
        closeModal();
      });
  });
}

export function forgeGame() {
  let busy = false;
  let stopPoll = () => {};
  const r = () => {
    const funds = fundsNow();
    const closed = smithShop.closed;
    sheet.innerHTML =
      `<h2>Gear Forge</h2><p>Gear is an <b>NFT</b>: a one-of-a-kind item with its own number that only you own. Collect <b>Shards</b> from the Vault Cracker, then mint here. GD price is the smith quote.</p><div class="hint">You have <b>${S.shards}</b> shards and <b>${fmtN(funds)}</b> GD.</div>${merchantWalletBlock('Smith', smithShop)}` +
      Object.keys(GEARINFO)
        .map(k => {
          const g = +k,
            i = GEARINFO[g]!,
            itemId = forgeItemIdForGear(g),
            q = itemId ? smithQuotes[itemId] : undefined,
            own = S.nfts.find(n => n.g === g),
            gd = q?.price ?? i.gd,
            shd = q?.shardsCost ?? i.shd,
            soldOut = q != null && q.stock < 1,
            tip = own
              ? `Owned: ${own.id.slice(-8)}`
              : `${shd} shards + ${fmtN(gd)} GD${q ? ` · ${reasonHint(q)}` : ''}`;
          const disable = closed || soldOut || busy || S.shards < shd || funds < gd;
          const label = closed ? 'Closed' : soldOut ? 'Sold out' : 'Mint';
          return `<div class="loc"><div><b>${GEARS[g]}</b> <span class="tag">${i.rar}</span><div class="hint">${esc(tip)}</div></div>${own ? `<button data-e="${g}">${S.look.gear === g ? 'Wearing' : 'Wear'}</button>` : `<button class="pri" data-mint="${g}" ${disable ? 'disabled' : ''}>${label}</button>`}</div>`;
        })
        .join('') +
      '<div class="acts"><button id="fx2">Leave</button></div>';
    sheet.querySelectorAll('[data-e]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        S.look.gear = +(b as HTMLElement).dataset.e!;
        buildLook(player, S.look);
        save();
        r();
      };
    });
    sheet.querySelectorAll('[data-mint]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        const g = +(b as HTMLElement).dataset.mint!;
        const itemId = forgeItemIdForGear(g);
        if (!itemId) return;
        busy = true;
        (b as HTMLButtonElement).disabled = true;
        void lifeRequest<{
          status: 'delivered' | 'settling';
          tokenId: string;
          itemId: string;
          available: string;
          settling: string;
          items: Record<string, string>;
          price?: number;
          stock?: number;
          demandEma?: number;
          reasoning?: MerchantMenuDish['reasoning'];
        }>('/forge/mint', { itemId })
          .then(res => {
            applyFunds(res.available, res.settling);
            applyChainItems(res.items);
            if (res.price != null && res.reasoning && res.stock != null) {
              smithQuotes[itemId] = {
                itemId,
                title: GEARS[g] ?? itemId,
                stock: res.stock,
                price: res.reasoning.finalPrice,
                demandEma: res.demandEma,
                reasoning: res.reasoning,
                shardsCost: GEARINFO[g]?.shd,
              };
            }
            if (res.status === 'settling') banner('Mint is still landing on chain…', 'info');
            else banner(`${GEARS[g]} forged${res.price != null ? ` for ${fmtN(res.price)} GD` : ''}`, 'good');
            save();
            updateHud();
            busy = false;
            void loadMerchantQuotes()
              .catch(() => {})
              .finally(r);
          })
          .catch(err => {
            banner(err instanceof Error ? err.message : 'Could not mint', 'bad');
            busy = false;
            r();
          });
      };
    });
    ($('#fx2') as HTMLButtonElement).onclick = () => {
      stopPoll();
      closeModal();
    };
  };
  openModal('', () => stopPoll());
  stopPoll = startMerchantPoll(() => {
    if (!busy) r();
  });
  void loadMerchantQuotes()
    .catch(err => banner(err instanceof Error ? err.message : 'Could not load forge prices', 'bad'))
    .finally(r);
}
