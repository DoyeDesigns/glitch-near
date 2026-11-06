import * as THREE from 'three';
import {
  HOMEP_GD,
  RENT_GD,
  RENT_MS as RENT_PERIOD_MS,
  POST_COST,
  TRADE_MAX_STAKE,
  TRADE_MIN_STAKE,
  vaultLockStart,
  vaultNeedle,
  type VaultLock,
} from '@glitch/shared';
import { $, clamp, esc, fmt, fmtN, pick, rnd } from './util';
import { burn, L, logTx, save, S, weak } from './state';
import { banner, post, px, TOK } from './market';
import {
  BOTC,
  buildFurn,
  buildLook,
  cam,
  comfort,
  crowdTo,
  FURN,
  GEARS,
  GLASSC,
  HAIRC,
  HAIRS,
  hasF,
  nearStation,
  overdue,
  player,
  rain,
  rentLeft,
  setCustomizing,
  SKINS,
  TOPC,
  vel,
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
import { here, LOCS } from './phone';

export function useStation() {
  if (!nearStation || nearStation.locked || modalOpen()) return;
  (
    {
      trade: tradeGame,
      sec: secGame,
      comm: commGame,
      forge: forgeGame,
      eat: dinerGame,
      rest: benchRest,
      bed: sleepGame,
      door: exitHome,
    } as Record<string, () => void>
  )[nearStation.id]!();
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
      `${pct >= 0 ? 'You won' : 'You lost'} ${Math.abs(pct).toFixed(0)}% of your bet${bet.capped ? ' (daily skill pay cap hit)' : ''}`,
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
      `${hits} of 3 locks opened${hits === 3 ? '. PERFECT!' : ''}${shd ? ` · +${shd} shards` : ''}${state.capped ? ' (daily skill pay cap hit)' : ''}`,
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
export const GEARINFO: Record<number, { shd: number; usdg: number; rar: string }> = {
  1: { shd: 3, usdg: 2, rar: 'Common' },
  3: { shd: 8, usdg: 10, rar: 'Rare' },
  4: { shd: 5, usdg: 5, rar: 'Common' },
  5: { shd: 15, usdg: 20, rar: 'Epic' },
  6: { shd: 30, usdg: 40, rar: 'Legendary' },
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
  const ch = (a: string[], k: 'hair' | 'gear') =>
    a
      .map((n, i) => {
        const lk = k === 'gear' && !gearOwned(i);
        return `<button class="${S.look[k] === i ? 'on' : ''}" data-k="${k}" data-v="${i}" ${lk ? 'disabled title="Mint it at the Gear Forge"' : ''}>${n}${lk ? ' (locked)' : ''}</button>`;
      })
      .join('');
  function render() {
    sheet.innerHTML = `<h2>Your look</h2><div class="cz"><small>Skin</small><div class="chips">${sw(SKINS, 'skin')}</div><small>Hair</small><div class="chips">${ch(HAIRS, 'hair')}</div><small>Hair colour</small><div class="chips">${sw(HAIRC, 'hairC')}</div>
    <small>Top</small><div class="chips">${sw(TOPC, 'top')}</div><small>Trousers</small><div class="chips">${sw(BOTC, 'bot')}</div>
    <small>Glasses</small><div class="chips"><button class="${S.look.glasses ? 'on' : ''}" data-k="glasses" data-v="1">On</button><button class="${S.look.glasses ? '' : 'on'}" data-k="glasses" data-v="0">Off</button>${S.look.glasses ? sw(GLASSC, 'glassC') : ''}</div>
    <small>Gear</small><div class="chips">${ch(GEARS, 'gear')}</div></div><div class="acts"><button class="pri" id="cdone">Done</button></div>`;
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
        `${state.viral ? 'VIRAL. ' : ''}+${state.followers} followers${state.capped ? ' (daily skill pay cap hit)' : ''}`,
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

/** @deprecated MVP has no USDG; kept for swap UI until removed. */
export const RATE = 500,
  RENT = RENT_GD,
  RENT_MS = RENT_PERIOD_MS,
  HOMEP = HOMEP_GD;
const clampN = () => {
  S.needs.energy = clamp(S.needs.energy, 0, 100);
  S.needs.hunger = clamp(S.needs.hunger, 0, 100);
};
let warnT = 0;
export function lifeUpdate(dt: number) {
  const n = S.needs,
    home = player.position.x > 100;
  n.hunger -= dt * 0.2;
  n.energy -= dt * (n.hunger <= 0 ? 0.5 : 0.25) * (home ? .5 : 1);
  clampN();
  warnT -= dt;
  if (warnT <= 0) {
    if (n.hunger < 10) {
      banner('You are starving. Eat at the Neon Diner (it takes USDG).', 'bad');
      warnT = 60;
    } else if (n.energy < 15) {
      banner('You are exhausted. Rest on a bench or sleep at home.', 'bad');
      warnT = 60;
    }
  }
  const r = player.userData.rig as THREE.Object3D;
  r.rotation.x += ((weak() ? .14 : 0) - r.rotation.x) * Math.min(1, dt * 4);
  rain.visible = !home;
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

export function swap(dir: string, amt: number) {
  if (here().id !== 'wall') return { ok: 0, msg: 'Go to Wall Street to swap.' };
  const gd = amt * RATE,
    fee = gd * 0.01;
  if (dir === 'buy') {
    if (S.bal < gd + fee) return { ok: 0, msg: 'Not enough GD.' };
    S.bal -= gd + fee;
    S.burned += fee;
    S.usdg += amt;
    logTx('out', gd + fee, `Swap for ${amt} USDG`);
  } else {
    if (S.usdg < amt) return { ok: 0, msg: 'Not enough USDG.' };
    S.usdg -= amt;
    S.bal += gd - fee;
    S.burned += fee;
    logTx('in', gd - fee, `Sold ${amt} USDG`);
  }
  save();
  updateHud();
  return { ok: 1, msg: dir === 'buy' ? `Bought ${amt} USDG` : `Sold ${amt} USDG` };
}
export function swapHtml() {
  if (here().id !== 'wall')
    return `<div class="hint">USDG is a stablecoin: it is always worth about ${RATE} GD. Restaurants and rent only take USDG. Swap it at <b>Wall Street</b> (open the Map).</div>`;
  return `<div class="hint"><b>Swap desk.</b> 1 USDG = ${RATE} GD, 1% fee.</div><div class="chips">${[5, 10, 25].map(n => `<button data-a="swap" data-d="buy" data-n="${n}">Buy ${n} USDG<br><small style="text-transform:none">${fmtN(n * RATE * 1.01)} GD</small></button>`).join('')}</div><div class="chips">${[5, 25].map(n => `<button data-a="swap" data-d="sell" data-n="${n}">Sell ${n} USDG</button>`).join('')}</div>`;
}

const MENU = [
  { n: 'Jollof and chicken', h: 45, e: 0, p: 8, d: 'A full meal' },
  { n: 'Suya skewer', h: 25, e: 0, p: 4, d: 'Quick bite' },
  { n: 'Zobo drink', h: 8, e: 12, p: 2, d: 'Cold and refreshing' },
];
export function dinerGame() {
  openModal('');
  const r = () => {
    sheet.innerHTML = `<h2>Neon Diner</h2><p>We only take <b>USDG</b>. You have <b>${S.usdg} USDG</b>.${S.usdg < 4 ? ' Swap some at Wall Street (Balance app) first.' : ''}</p>${meters()}${MENU.map((m, i) => `<div class="loc"><div><b>${m.n}</b><div class="hint">${m.d}: +${m.h} hunger${m.e ? `, +${m.e} energy` : ''}</div></div><button class="pri" data-m="${i}" ${S.usdg < m.p ? 'disabled' : ''}>${m.p} USDG</button></div>`).join('')}<div class="acts"><button id="dx">Leave</button></div>`;
    sheet.querySelectorAll('[data-m]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        const m = MENU[+(b as HTMLElement).dataset.m!]!;
        if (S.usdg < m.p) return;
        S.usdg -= m.p;
        S.needs.hunger += m.h;
        S.needs.energy += m.e;
        clampN();
        banner(`Ate ${m.n}. Hunger +${m.h}`, 'good');
        crowdTo('eat', 8);
        save();
        updateHud();
        r();
      };
    });
    ($('#dx') as HTMLButtonElement).onclick = closeModal;
  };
  r();
}
export function benchRest() {
  openModal('');
  progressModal('Resting on the bench', 'Slow, but free. Sleeping at home is much better.', 8, () => {
    S.needs.energy += 25;
    S.needs.hunger -= 3;
    clampN();
    resultCard(true, 'Energy +25', 'You feel a bit better', 'Took a nap on a park bench in Glitch.');
    updateHud();
    save();
  });
}
const SLEEPLINES = ['Zzz...', 'Dreaming of green candles...', 'Zzz... MOON... Zzz...'];

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
export function homeHtml(hdr: (title: string, back: string) => string) {
  const H = S.home;
  if (!H.owned)
    return (
      hdr('My Home', 'home') +
      `<div class="loc"><div><b>Studio apartment</b><div class="hint">Your own space. Sleep here to recover energy fast, and decorate it. Costs ${fmtN(HOMEP)} GD to buy, plus ${fmtN(RENT)} GD rent every hour.</div></div></div><div class="acts"><button class="pri" data-a="buyhome">Buy: ${fmtN(HOMEP)} GD + ${fmtN(RENT)} GD rent</button></div><div class="loc"><div><b>Penthouse</b><div class="hint">Bigger rooms. Coming later.</div></div><button disabled>Soon</button></div><p class="hint">You have ${fmtN(S.bal)} GD.</p>`
    );
  return (
    hdr('My Home', 'home') +
    `<div class="loc"><div><b>Studio apartment</b><div class="hint">${overdue() ? '<span class="neg">RENT OVERDUE. Your bed is locked until you pay.</span>' : 'Rent paid for ' + mmss(rentLeft())} · Comfort ${comfort()}</div></div></div>
  <div class="acts"><button class="pri" data-a="gohome">Go home (free)</button><button data-a="payrent" ${S.bal < RENT || rentLeft() > RENT_MS * 2 ? 'disabled' : ''}>Pay rent ${fmtN(RENT)} GD</button></div>
  <small style="display:block;margin-top:10px">Furniture (paid in GD)</small>` +
    FURN.map(
      f =>
        `<div class="loc"><div><b>${f.name}</b><div class="hint">${f.d} · +${f.pts} comfort</div></div>${hasF(f.id) ? '<span class="tag">Owned</span>' : `<button data-a="furn" data-v="${f.id}" ${S.bal < f.price ? 'disabled' : ''}>${fmtN(f.price)}</button>`}</div>`,
    ).join('')
  );
}

export function homeAct(a: string, v?: string) {
  const H = S.home;
  if (a === 'buyhome') {
    if (S.bal < HOMEP + RENT) return banner(`You need ${fmtN(HOMEP + RENT)} GD`, 'bad');
    burn(HOMEP);
    logTx('out', HOMEP, 'Bought Studio');
    burn(RENT);
    logTx('out', RENT, 'First rent');
    H.owned = true;
    H.paidUntil = Date.now() + RENT_MS;
    buildFurn();
    banner('You bought a Studio! Tap Go home.', 'good');
    post('sys', 'NEWS', `${S.name} bought a Studio apartment.`);
  } else if (a === 'payrent') {
    if (S.bal < RENT) return;
    burn(RENT);
    logTx('out', RENT, 'Rent');
    H.paidUntil = Math.max(H.paidUntil, Date.now()) + RENT_MS;
    banner('Rent paid', 'good');
  } else if (a === 'furn') {
    const f = FURN.find(x => x.id === v);
    if (!f || S.bal < f.price || hasF(v!)) return;
    burn(f.price);
    logTx('out', f.price, 'Furniture: ' + f.name);
    H.items.push(v!);
    buildFurn();
    banner(`${f.name} placed in your home`, 'good');
  } else if (a === 'gohome') {
    if (!H.owned) return;
    closeModal();
    player.position.set(140, 0, 4);
    vel.x = vel.z = 0;
    cam.tx = 140;
    cam.tz = 4;
    cam.yaw = 0;
    if (overdue()) banner('Rent is overdue. Pay it in the My Home app.', 'bad');
    return true;
  }
  save();
  updateHud();
}
export function exitHome() {
  const l = LOCS[0]!;
  player.position.set(l.sp[0], 0, l.sp[1]);
  vel.x = vel.z = 0;
  cam.tx = l.sp[0];
  cam.tz = l.sp[1];
  banner('Back in the city', 'info');
}
export function sleepGame() {
  if (!S.home.owned) return;
  if (overdue()) return banner('Your bed is locked: pay rent in the My Home app', 'bad');
  openModal('');
  const secs = Math.max(3, Math.round(8 - comfort() * .5));
  progressModal('Sleeping', pick(SLEEPLINES), secs, () => {
    S.needs.energy = 100;
    S.needs.hunger -= 10;
    clampN();
    resultCard(true, 'Fully rested', `Comfort ${comfort()}: slept in ${secs}s`, 'Slept in my Glitch apartment.');
    updateHud();
    save();
  });
}

export function forgeGame() {
  openModal('');
  const r = () => {
    sheet.innerHTML =
      `<h2>Gear Forge</h2><p>Gear is an <b>NFT</b>: a one-of-a-kind item with its own number that only you own. Collect <b>Shards</b> from the Vault Cracker, get <b>USDG</b> at Wall Street, then mint.</p><div class="hint">You have <b>${S.shards}</b> shards and <b>${S.usdg}</b> USDG.</div>` +
      Object.keys(GEARINFO)
        .map(k => {
          const g = +k,
            i = GEARINFO[g]!,
            own = S.nfts.find(n => n.g === g),
            ok = S.shards >= i.shd && S.usdg >= i.usdg;
          return `<div class="loc"><div><b>${GEARS[g]}</b> <span class="tag">${i.rar}</span><div class="hint">${own ? 'Owned: NFT #' + own.id : `${i.shd} shards + ${i.usdg} USDG`}</div></div>${own ? `<button data-e="${g}">${S.look.gear === g ? 'Wearing' : 'Wear'}</button>` : `<button class="pri" data-g="${g}" ${ok ? '' : 'disabled'}>Mint</button>`}</div>`;
        })
        .join('') +
      '<div class="acts"><button id="fx2">Leave</button></div>';
    sheet.querySelectorAll('[data-g]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => mint(+(b as HTMLElement).dataset.g!);
    });
    sheet.querySelectorAll('[data-e]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        S.look.gear = +(b as HTMLElement).dataset.e!;
        buildLook(player, S.look);
        save();
        r();
      };
    });
    ($('#fx2') as HTMLButtonElement).onclick = closeModal;
  };
  function mint(g: number) {
    const i = GEARINFO[g]!;
    if (S.shards < i.shd || S.usdg < i.usdg) return;
    S.shards -= i.shd;
    S.usdg -= i.usdg;
    const id = 1000 + Math.floor(rnd(0, 9000));
    S.nfts.push({ g, id, rar: i.rar });
    S.look.gear = g;
    buildLook(player, S.look);
    save();
    updateHud();
    post('sys', 'NEWS', `${S.name} minted ${GEARS[g]} (${i.rar}) NFT #${id}.`);
    const col = ({ Common: '#8b97b8', Rare: '#2ee6ff', Epic: '#ff3d9a', Legendary: '#ffb12e' } as Record<string, string>)[i.rar]!;
    resultCard(true, `NFT #${id}`, `${GEARS[g]} minted. Only you own it.`, `I minted a ${i.rar} ${GEARS[g]} NFT #${id} in Glitch.`, (x, w, h) => {
      x.fillStyle = '#070910';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = col;
      x.lineWidth = 6;
      x.strokeRect(8, 8, w - 16, h - 16);
      x.textAlign = 'center';
      x.fillStyle = col;
      x.font = '700 28px "Chakra Petch",sans-serif';
      x.fillText(i.rar.toUpperCase(), w / 2, 70);
      x.fillStyle = '#e9eefc';
      x.font = '700 72px "Chakra Petch",sans-serif';
      x.fillText(GEARS[g]!, w / 2, 190);
      x.fillStyle = '#8b97b8';
      x.font = '500 26px "JetBrains Mono",monospace';
      x.fillText('NFT #' + id + ' · owner ' + S.name, w / 2, 250);
      x.fillText('GLITCH', w / 2, 320);
    });
  }
  r();
}
