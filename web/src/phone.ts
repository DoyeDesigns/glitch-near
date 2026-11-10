import { GAS_GD } from '@glitch/shared';
import { $, esc, fmt, fmtN, pick, rnd } from './util';
import { burn, logTx, payCap, roleName, SAVE, save, S, txlog, weak } from './state';
import { banner, feed, post, serverTick } from './market';
import { NPC_NAMES } from './constants';
import { cam, npcs, player, say, vel } from './world';
import { closeModal, introOpen, modalOpen, openModal, sheet, updateHud } from './hud';
import { homeAct, homeHtml, openCustomizer } from './games';
import { hudAvailable } from './hud';
import { fetchChainProof, type ChainProof } from './session';

export const LOCS = [
  { id: 'plaza', name: 'Central Plaza', x: 0, z: 6, r: 14, sp: [0, 10] as [number, number], note: 'The main square. Everyone passes through.' },
  { id: 'wall', name: 'Wall Street', x: -17, z: -4, r: 12, sp: [-13, -3] as [number, number], note: 'Trade coins at the Exchange.' },
  { id: 'lab', name: 'Vault Lab', x: 17, z: -4, r: 12, sp: [13, -3] as [number, number], note: 'Crack vaults and watch the bounty board.' },
  { id: 'tower', name: 'Attention Tower', x: 0, z: -24, r: 10, sp: [0, -19] as [number, number], note: 'Post, trend and gain followers.' },
  { id: 'diner', name: 'Neon Diner', x: 30, z: 20, r: 10, sp: [27, 17] as [number, number], note: 'Eat here. Paid in GD.' },
  { id: 'home', name: 'My Home', x: 140, z: 0, r: 14, sp: [140, 4] as [number, number], note: 'Your place.' },
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
export const here = () => locAt(player.position.x, player.position.z);
export const peopleAt = (id: string) => npcs.filter(a => locAt(a.position.x, a.position.z).id === id);
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
  const items = Object.entries(p.items);
  const itemRows =
    items.map(([id, n]) => `<li><code>${esc(id)}</code> ${esc(fmtUnits(n))}</li>`).join('') ||
    '<li>None</li>';
  return `<div class="proof">
    <div class="proof-id"><code>${esc(p.accountId)}</code><button type="button" data-a="copyacct">Copy</button></div>
    <div><span>GD on chain</span><b>${esc(fmtUnits(p.gdOnChain))}</b></div>
    <div><span>Available</span><b>${esc(fmtUnits(p.available))}</b></div>
    <div><span>Pending</span><b>${esc(fmtUnits(p.pending))}</b></div>
    <div class="proof-items"><span>Items</span><ul>${itemRows}</ul></div>
    <div><span>Network fees, covered by the game</span><b>${esc(p.nearBalance)} NEAR</b></div>
    <p class="hint">
      <a href="${explorerHref(p.accountId)}" target="_blank" rel="noopener">Account</a>
      ${p.gdContract ? ` · <a href="${explorerHref(p.gdContract)}" target="_blank" rel="noopener">GD contract</a>` : ''}
      ${p.itemsContract ? ` · <a href="${explorerHref(p.itemsContract)}" target="_blank" rel="noopener">Items contract</a>` : ''}
    </p>
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
let phoneApp: string | null = null,
  socialTab = 'all',
  chatTab = 'here',
  dmWith: string | null = null,
  profOf: string | null = null;
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
  const b = $('#phoneBtn') as HTMLElement;
  b.dataset.n = unread ? String(unread) : '';
}
export function travel(id: string) {
  const l = LOCS.find(x => x.id === id);
  if (!l) return;
  if (S.bal < GAS) return banner('Not enough GD to travel', 'bad');
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

export function openPhone(app?: string) {
  if (introOpen() || (modalOpen() && !phoneOpen)) return;
  if (phoneOpen) {
    phoneApp = app || null;
    return renderPhone();
  }
  phoneOpen = true;
  phoneApp = app || null;
  profOf = null;
  dmWith = null;
  openModal('', () => {
    phoneOpen = false;
    sheet.classList.remove('phonesheet');
    sheet.onclick = null;
    sheet.onkeydown = null;
  });
  sheet.classList.add('phonesheet');
  renderPhone();
}
export function phoneRefresh() {
  if (!phoneOpen) return;
  const i = $('#pin') as HTMLInputElement | null,
    v = i && i.value,
    f = i && document.activeElement === i;
  renderPhone();
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
const hdr = (title: string, back?: string) =>
  `<div class="ph-h">${back ? `<button data-a="${back}">‹</button>` : ''}<b>${title}</b></div>`;

function renderPhone() {
  const t = new Date().toTimeString().slice(0, 5),
    L0 = here();
  let body = '';
  if (!phoneApp) {
    const ap = (id: string, nm: string, col: string, ch: string, soon?: number) =>
      `<button class="ap ${soon ? 'soon' : ''}" ${soon ? 'disabled' : `data-a="app" data-v="${id}"`}><i style="background:${col}">${ch}${id === 'chat' && unread ? `<u>${unread}</u>` : ''}</i><span>${nm}</span></button>`;
    body = `<div class="ph-h"><b>Apps</b></div><div class="apps">${ap('social', 'Social', '#2ee6ff', 'S')}${ap('chat', 'Chat', '#b8ff3d', 'C')}${ap('map', 'Map', '#ffb12e', 'M')}${ap('wallet', 'Balance', '#ff3d9a', 'W')}${ap('me', 'Profile', '#7a8cff', 'P')}${ap('set', 'Settings', '#8b97b8', '⚙')}${ap('myhome', 'My Home', '#3dffb0', 'H')}${ap('shop', 'Market', '#26324f', '$', 1)}</div><p class="hint" style="text-align:center">Market (buy and sell with other players) arrives in the next update.</p>`;
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
    const X = (x: number) => 150 + x * 3,
      Z = (z: number) => 110 + z * 2.3;
    body =
      hdr('Map', 'home') +
      `<svg viewBox="0 0 300 220" class="map"><rect width="300" height="220" fill="#04060c"/>${LOCS.filter(l => l.id !== 'home')
        .map(
          l =>
            `<g data-a="go" data-v="${l.id}" style="cursor:pointer"><circle cx="${X(l.x)}" cy="${Z(l.z)}" r="${l.r * 1.4}" fill="${l.id === L0.id ? 'rgba(46,230,255,.18)' : 'rgba(255,255,255,.05)'}" stroke="${l.id === L0.id ? '#2ee6ff' : '#26324f'}"/><text x="${X(l.x)}" y="${Z(l.z) + 3}" text-anchor="middle" fill="#e9eefc" font-size="9" font-family="sans-serif">${l.name}</text></g>`,
        )
        .join('')}<circle cx="${X(player.position.x)}" cy="${Z(player.position.z)}" r="4" fill="#b8ff3d"/></svg>
    <p class="hint">Walking is free. Fast travel costs ${GAS} GD.</p>` +
      LOCS.filter(l => l.id !== 'home')
        .map(
          l =>
            `<div class="loc"><div><b>${l.name}</b> ${l.id === L0.id ? '<span class="tag">You are here</span>' : ''}<div class="hint">${l.note} · ${peopleAt(l.id).length + (l.id === L0.id ? 1 : 0)} people</div></div>${l.id === L0.id ? '' : `<button data-a="go" data-v="${l.id}">Go</button>`}</div>`,
        )
        .join('');
  } else if (phoneApp === 'wallet') {
    body =
      hdr('Balance', 'home') +
      `<div class="res win" style="padding:6px 0"><small>Balance</small><b>${fmtN(hudAvailable ?? S.bal)} GD</b></div><div class="pstats"><span><b>${S.shards}</b><small>Shards</small></span><span><b>${S.nfts.length}</b><small>NFTs</small></span></div><div class="hint">Daily skill pay: ${fmt(S.payUsed)} of ${fmt(payCap())} used. After that it pays only 20%.${weak() ? ' <b class="neg">Tired or hungry: skill pay is cut by 40%.</b>' : ''}</div><div class="meter"><i style="width:${Math.min(100, (S.payUsed / payCap()) * 100)}%"></i></div>
    <small style="display:block;margin-top:10px">Activity (every move is recorded, like a block explorer)</small>` +
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
    body =
      hdr('Settings', 'home') +
      `<small>Display name</small><div class="cmp"><input id="pin" type="text" maxlength="14" value="${esc(S.name)}"><button class="pri" data-a="name">Save</button></div><div class="acts"><button data-a="style">Change my look</button></div><details class="adv"${advancedOpen ? ' open' : ''}><summary>Advanced</summary><h3>Onchain proof</h3>${proofHtml()}</details><div class="acts"><button class="dn" data-a="reset">Reset progress</button></div>`;
  }
  sheet.innerHTML = `<div class="ph-bar"><span>${t}</span><span>${esc(L0.name)}</span><span>5G ▮▮▮</span></div><div class="ph-scr">${body}</div><div class="ph-nav"><button data-a="home" aria-label="Home"></button></div>`;
  sheet.onclick = e => {
    const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const a = b.dataset.a!,
      v = b.dataset.v,
      inp = $('#pin') as HTMLInputElement | null;
    if (a === 'home') {
      phoneApp = null;
      dmWith = null;
    } else if (a === 'app') {
      phoneApp = v!;
      if (v === 'chat') {
        chatTab = 'here';
        dmWith = null;
      }
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
      const pp = peopleAt(here().id);
      if (pp.length && Math.random() < .6) {
        const n = pick(pp),
          nm = (n.userData.npc as { name: string }).name;
        setTimeout(() => {
          const r = pick(REPLY.find(z => z[0].test(x))![1]);
          chatIn(locAt(n.position.x, n.position.z).id, nm, r);
          say(n, r.slice(0, 24));
        }, rnd(1500, 3500));
      }
    } else if (a === 'sendDM') {
      const x = inp!.value.trim();
      if (!x) return;
      dmIn(dmWith!, x, true);
      npcReply(dmWith!, x);
    } else if (a === 'go') return travel(v!);
    else if (['buyhome', 'paymaintenance', 'furn', 'gohome'].includes(a)) {
      if (homeAct(a, v)) return;
    } else if (a === 'copyacct') {
      const id = chainProof?.accountId;
      if (!id) return;
      void navigator.clipboard.writeText(id).then(
        () => banner('Copied', 'good'),
        () => banner('Could not copy', 'bad'),
      );
      return;
    } else if (a === 'name') {
      const x = inp!.value.trim().slice(0, 14);
      if (x) {
        S.name = x;
        save();
        updateHud();
      }
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
}

($('#phoneBtn') as HTMLButtonElement).onclick = () => (phoneOpen ? closeModal() : openPhone());
addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'p' && !((e.target as HTMLElement)?.tagName === 'INPUT')) {
    if (phoneOpen) closeModal();
    else if (!modalOpen()) openPhone();
  }
});

let folT = rnd(20, 35),
  dmT = rnd(60, 90),
  phT = 0;
const phoneUpdateState = { last: '' as string };
export function phoneUpdate(dt: number) {
  folT -= dt;
  if (folT <= 0) {
    folT = rnd(25, 45);
    const n = pick(NPC_NAMES);
    S.followers++;
    post('sys', 'NEWS', `${n} followed ${S.name}.`);
  }
  dmT -= dt;
  if (dmT <= 0) {
    dmT = rnd(70, 110);
    const n = pick(NPC_NAMES);
    dmIn(n, pick(['gm! saw your post', 'you trading today?', 'follow back?', 'wagwan, nice look btw']));
  }
  phT += dt;
  if (phT > 20 && phoneOpen && !(document.activeElement as HTMLElement | null)?.matches?.('#pin')) {
    phT = 0;
    if (phoneApp === 'set' && advancedOpen && Date.now() - chainAt > 5000) loadChainProof();
    phoneRefresh();
  }
  const l = here();
  if (l.id !== phoneUpdateState.last) {
    phoneUpdateState.last = l.id;
    ($('#loc') as HTMLElement).textContent = l.name;
  }
  ($('#loc') as HTMLElement).textContent = `${l.name} · ${peopleAt(l.id).length + 1} here`;
}
