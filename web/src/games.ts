import * as THREE from 'three';
import { HOMEP_GD, RENT_GD, RENT_MS as RENT_PERIOD_MS } from '@glitch/shared';
import { $, clamp, esc, fmt, fmtN, pick, randn, rnd } from './util';
import { addXp, burn, earn, escrow, L, logTx, save, settle, S, weak } from './state';
import { banner, market, post, px, TOK } from './market';
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
  modalEl,
  modalOpen,
  modalTimer,
  openModal,
  resultCard,
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

export function tradeGame() {
  let tk = TOK[0]!,
    snap = tk.hist.slice(-120),
    stake = 5000,
    pos: { d: number; amt: number; p0: number; t: number; trail: number[] } | null = null;
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
  function render() {
    sheet.dataset.lock = pos ? '1' : '';
    const fr = snap[snap.length - 1]!,
      c0 = fr / snap[0]! - 1;
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
    <div class="chips" id="stk">${STAKES.map(v => `<button data-s="${v}" class="${v === stake ? 'on' : ''}" ${v > S.bal ? 'disabled' : ''}>${fmtN(v)}</button>`).join('')}</div>
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
          stake = clamp(v, 100, Math.max(100, Math.floor(S.bal)));
          sheet.querySelectorAll('[data-s]').forEach(b => b.classList.remove('on'));
        }
        note();
      };
      note();
      ($('#tlong') as HTMLButtonElement).onclick = () => start(1);
      ($('#tshort') as HTMLButtonElement).onclick = () => start(-1);
      ($('#tx') as HTMLButtonElement).onclick = closeModal;
    }
    drawChart($('#tcv') as HTMLCanvasElement, pos ? tk.hist.slice(-60) : snap, pos ? pos.p0 : null);
  }
  function note() {
    const m = $('#mult');
    if (m)
      m.innerHTML = `Betting <b>${fmtN(stake)} GD</b> (1% fee). Moves are multiplied by 20: if the price changes 1%, you win or lose about <b>${fmtN(stake * .2)} GD</b>. You can never lose more than your bet.`;
  }
  function start(d: number) {
    const amt = Math.min(stake, Math.floor(S.bal));
    if (amt < 100) return banner('Not enough GD', 'bad');
    escrow(amt);
    burn(amt * 0.01);
    tk.flow += d * Math.min(.5, amt / 2e6);
    pos = { d, amt: amt * 0.99, p0: tk.price, t: 10, trail: [tk.price] };
    render();
    const C = 2 * Math.PI * 42;
    ($('#rfg') as HTMLElement).style.strokeDasharray = String(C);
    ($('#rfg') as HTMLElement).style.strokeDashoffset = '0';
    ($('#tdesc') as HTMLElement).textContent = `You bet ${d > 0 ? 'UP' : 'DOWN'} on ${tk.sym}. The dashed line is where you started.`;
    setModalTimer(
      setInterval(() => {
        pos!.t -= 0.25;
        pos!.trail.push(tk.price);
        const pnl = Math.max(-pos!.amt, pos!.amt * 20 * pos!.d * (tk.price / pos!.p0 - 1));
        const el = $('#tpnl');
        if (el) {
          el.textContent = (pnl >= 0 ? '+' : '') + fmtN(pnl) + ' GD';
          el.className = 'big ' + (pnl >= 0 ? 'pos' : 'neg');
          ($('#rnum') as HTMLElement).textContent = String(Math.max(0, Math.ceil(pos!.t)));
          ($('#rfg') as HTMLElement).style.strokeDashoffset = String(C * (1 - pos!.t / 10));
        }
        const c = $('#tcv') as HTMLCanvasElement | null;
        if (c) drawChart(c, tk.hist.slice(-60), pos!.p0);
        if (pos!.t <= 0) {
          clearInterval(modalTimer as number);
          setModalTimer(0);
          finish(pnl);
        }
      }, 250),
    );
  }
  function finish(pnl: number) {
    const r = settle(pos!.amt, pnl);
    S.stats.trades++;
    if (pnl > 0) S.stats.wins++;
    addXp('trade', 12 + (pnl > 0 ? 8 : 0));
    crowdTo('trade', 12);
    const side = pos!.d > 0 ? 'UP' : 'DOWN',
      pct = (pnl / pos!.amt) * 100,
      mv = (tk.price / pos!.p0 - 1) * 100,
      trail = pos!.trail.slice(),
      p0 = pos!.p0,
      sym = tk.sym,
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
      x.fillText(sym + '  ' + (pos!.d > 0 ? '▲ UP' : '▼ DOWN'), 28, 62);
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
    resultCard(
      win,
      (pnl >= 0 ? '+' : '') + fmtN(r.credited) + ' GD',
      `${pct >= 0 ? 'You won' : 'You lost'} ${Math.abs(pct).toFixed(0)}% of your bet${r.capped ? ' (daily skill pay cap hit)' : ''}`,
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
}

export function secGame() {
  let round = 0,
    hits = 0,
    p = 0,
    dir = 1,
    done = false,
    zone = [0, 0],
    last = performance.now(),
    busy = false;
  const ZW = [.24, .18, .13],
    SP = [.75, 1.0, 1.3];
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === ' ' || e.key === 'Enter') && !done) {
      e.preventDefault();
      stop();
    }
  };
  addEventListener('keydown', onKey);
  openModal('', () => {
    removeEventListener('keydown', onKey);
  });
  function setup() {
    zone = [rnd(.08, .92 - ZW[round]!), ZW[round]!];
    busy = false;
    p = 0;
    dir = 1;
    render();
  }
  function render() {
    sheet.dataset.lock = '1';
    sheet.innerHTML = `<h2>Vault Cracker</h2><p>A rich NPC left a vault open. Tap STOP (or press Space) when the glowing needle is inside the green zone.</p>
    <div class="locks">${[0, 1, 2].map(i => `<span class="lk2 ${i < round ? 'ok' : i === round ? 'now' : ''}">${i < round ? 'OPEN' : 'LOCK ' + (i + 1)}</span>`).join('')}</div>
    <div class="vbar"><i class="zone" style="left:${zone[0]! * 100}%;width:${zone[1]! * 100}%"></i><i class="needle" id="ndl"></i></div>
    <div class="hint">Each lock is faster and the green zone is smaller. Each open lock pays GD.</div>
    <div class="acts"><button class="pri" id="stopb" style="font-size:18px;padding:14px">STOP</button><button id="vx">Leave</button></div>`;
    ($('#stopb') as HTMLButtonElement).onclick = stop;
    ($('#vx') as HTMLButtonElement).onclick = () => {
      done = true;
      sheet.dataset.lock = '';
      closeModal();
    };
  }
  function stop() {
    if (done || busy) return;
    busy = true;
    const ok = p >= zone[0]! && p <= zone[0]! + zone[1]!;
    if (ok) hits++;
    const n = $('#ndl') as HTMLElement | null;
    if (n) n.style.background = ok ? '#b8ff3d' : '#ff3d9a';
    round++;
    setTimeout(() => {
      if (done) return;
      if (round >= 3) end();
      else setup();
    }, 600);
  }
  function end() {
    done = true;
    clearInterval(modalTimer as number);
    const pay = hits * 15000 + (hits === 3 ? 30000 : 0),
      shd = hits + (hits === 3 ? 1 : 0);
    S.shards += shd;
    addXp('sec', 8 + hits * 6);
    const r = pay ? earn(pay) : { credited: 0, capped: false };
    if (hits === 3) post('good', S.name, 'cracked a whole vault. smooth.');
    save();
    updateHud();
    resultCard(
      hits >= 2,
      hits ? '+' + fmtN(r.credited) + ' GD' : 'Locked out',
      `${hits} of 3 locks opened${hits === 3 ? '. PERFECT!' : ''}${shd ? ` · +${shd} shards` : ''}`,
      `I opened ${hits}/3 locks in the Glitch vault game.`,
    );
  }
  setModalTimer(
    setInterval(() => {
      const now = performance.now(),
        dt = (now - last) / 1000;
      last = now;
      if (busy || done) return;
      p += dir * SP[Math.min(round, 2)]! * dt;
      if (p > 1) {
        p = 1;
        dir = -1;
      }
      if (p < 0) {
        p = 0;
        dir = 1;
      }
      const n = $('#ndl') as HTMLElement | null;
      if (n) n.style.left = `calc(${p * 100}% - 3px)`;
    }, 16),
  );
  setup();
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

export function commGame() {
  let tk = TOK[3]!,
    take: string | null = null;
  const cost = 10000;
  function render() {
    sheet.dataset.lock = '';
    sheet.innerHTML = `<h2>Attention Booth</h2><p>Boost a post for ${fmt(cost)} GD. Read the mood: hype works in greed, warnings work in fear, memes work any time (a bit less).</p>
    <div class="chips">${TOK.map(t => `<button data-t="${t.sym}" class="${t === tk ? 'on' : ''}">${t.sym}</button>`).join('')}</div>
    <div class="chips">${[['hype', `${tk.sym} to the moon`], ['warn', `careful: ${tk.sym} looks like a rug`], ['meme', `me explaining ${tk.sym} to my landlord`]].map(([k, l]) => `<button data-k="${k}" class="${take === k ? 'on' : ''}">${esc(l!)}</button>`).join('')}</div>
    <small>Followers ${fmtN(S.followers)} · Community level ${L('comm')}</small>
    <div class="acts"><button class="pri" id="pst" ${take && S.bal >= cost ? '' : 'disabled'}>Post</button><button id="px">Cancel</button></div>`;
    sheet.querySelectorAll('[data-t]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        tk = TOK.find(t => t.sym === (b as HTMLElement).dataset.t)!;
        render();
      };
    });
    sheet.querySelectorAll('[data-k]').forEach(b => {
      (b as HTMLButtonElement).onclick = () => {
        take = (b as HTMLElement).dataset.k!;
        render();
      };
    });
    ($('#px') as HTMLButtonElement).onclick = closeModal;
    ($('#pst') as HTMLButtonElement).onclick = send;
  }
  function send() {
    burn(cost * 0.5);
    escrow(cost * 0.5);
    const m = market.mood,
      h = market.heat;
    const fit = take === 'hype' ? clamp(0.5 + m * 0.5 - h, 0, 1) : take === 'warn' ? clamp(0.3 + h * 2 - m * 0.3, 0, 1) : 0.45;
    const luck = Math.exp(randn() * 0.6),
      reach = fit * luck * (1 + 0.1 * (L('comm') - 1)) + 0.25;
    const pay = cost * 0.5 * (0.5 + reach * 1.6);
    const r = settle(cost * 0.5, pay - cost * 0.5);
    const fol = Math.floor(reach * 40 * (1 + L('comm') * .1));
    S.followers += fol;
    S.stats.posts++;
    addXp('comm', 14);
    S.rep += reach > 1.2 ? 1 : 0;
    if (take === 'hype') {
      tk.hype = clamp(tk.hype + .06 * reach, 0, 1);
      tk.flow += .15 * reach;
    } else if (take === 'warn') {
      tk.trust = clamp(tk.trust - .05 * reach, 0, 1);
      tk.flow -= .1 * reach;
    }
    const txt =
      take === 'hype' ? `${tk.sym} to the moon` : take === 'warn' ? `careful: ${tk.sym} looks like a rug` : `me explaining ${tk.sym} to my landlord`;
    post('npc', S.name, txt);
    crowdTo('comm', 12);
    const viral = reach > 1.5;
    if (viral) post('sys', 'TRENDING', `${S.name}'s ${tk.sym} post is going viral.`);
    resultCard(
      r.credited >= 0,
      (r.credited >= 0 ? '+' : '') + fmt(r.credited) + ' GD',
      `${viral ? 'VIRAL. ' : ''}+${fol} followers`,
      `My ${tk.sym} take in Glitch ${viral ? 'went viral' : 'got ' + fol + ' new followers'}.`,
    );
    save();
    updateHud();
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
