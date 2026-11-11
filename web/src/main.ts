import './styles.css';
import { $ } from './util';
import { S, save } from './state';
import { addTickT, cases, EVENTS, feed, market, post, runEvent, serverTick, TOK, economyUpdate } from './market';
import { startStream } from './stream';
import {
  buildFurn,
  buildLook,
  cam,
  camera,
  clearInterior,
  enterBuilding,
  exitBuilding,
  isInside,
  player,
  renderer,
  scene,
  stations,
  warpIntoBuilding,
  worldUpdate,
} from './world';
import {
  closeModal,
  drawScreens,
  introOpen,
  modalOpen,
  setHudAvailable,
  setHudSettling,
  startAdsPoll,
  startMePoll,
  updateHud,
} from './hud';
import { applyChainItems } from './itemsSync';
import {
  fetchGoogleClientId,
  googleLoginRequest,
  GoogleNeedsNameError,
  loginRequest,
  type Me,
} from './session';
import {
  commGame,
  dinerGame,
  forgeGame,
  lifeUpdate,
  openCustomizer,
  secGame,
  tradeGame,
  useStation,
} from './games';
import { here, LOCS, openPhone, phoneUpdate, travel } from './phone';

startStream();
startAdsPoll();
buildFurn();

($('#styleBtn') as HTMLButtonElement).onclick = () => {
  if (!modalOpen() && !introOpen()) openCustomizer();
};
function showIntroError(message: string) {
  const el = $('#introErr') as HTMLElement;
  el.hidden = false;
  el.textContent = message;
}

function readPin(): string | null {
  const pin = ($('#pinIn') as HTMLInputElement).value.trim();
  if (!/^\d{4,6}$/.test(pin)) {
    showIntroError('PIN is 4–6 digits.');
    return null;
  }
  return pin;
}

type IntroTab = 'signin' | 'create' | 'guest';
let introTab: IntroTab = 'signin';
let googleReady = false;

function setIntroTab(tab: IntroTab) {
  introTab = tab;
  document.querySelectorAll('[data-intro-tab]').forEach(el => {
    const on = (el as HTMLElement).dataset.introTab === tab;
    el.classList.toggle('on', on);
    if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const named = $('#introNamed') as HTMLElement;
  const guest = $('#introGuest') as HTMLElement;
  const start = $('#startBtn') as HTMLButtonElement;
  const create = $('#createBtn') as HTMLButtonElement;
  named.hidden = tab === 'guest';
  guest.hidden = tab !== 'guest';
  start.hidden = tab !== 'signin';
  create.hidden = tab !== 'create';
  const inviteLab = $('#inviteLabel') as HTMLElement;
  const inviteIn = $('#inviteIn') as HTMLInputElement;
  // Invite only for create / guest (new accounts); Google name-step may also reveal it.
  const showInvite = tab === 'create' || tab === 'guest' || !($('#googleFinishBtn') as HTMLButtonElement).hidden;
  inviteLab.hidden = !showInvite;
  inviteIn.hidden = !showInvite;
  const gw = $('#googleWrap') as HTMLElement;
  // Google lives inside Sign in / Create only — not a separate entry mode.
  gw.hidden = !(googleReady && (tab === 'signin' || tab === 'create'));
  ($('#introErr') as HTMLElement).hidden = true;
}

function setIntroBusy(busy: boolean) {
  ($('#startBtn') as HTMLButtonElement).disabled = busy;
  ($('#createBtn') as HTMLButtonElement).disabled = busy;
  ($('#guestBtn') as HTMLButtonElement).disabled = busy;
  const finish = $('#googleFinishBtn') as HTMLButtonElement;
  if (!finish.hidden) finish.disabled = busy;
}

function applyProfile(profile: Me) {
  S.name = profile.name;
  S.bal = Number(profile.available);
  S.xp = profile.xp;
  S.needs = profile.needs;
  S.home.paidUntil = profile.homePaidUntil ?? 0;
  applyChainItems(profile.items);
  buildFurn();
  buildLook(player, S.look);
  setHudAvailable(Number(profile.available));
  setHudSettling(Number(profile.settling) || 0);
  const intro = $('#intro') as HTMLElement;
  intro.hidden = true;
  intro.style.display = 'none';
  save();
  updateHud();
  startMePoll();
  post('npc', S.name, 'just landed in the city. gm.');
  if (!S.styled) {
    S.styled = 1;
    openCustomizer();
  }
}

function inviteCode(): string | undefined {
  const v = ($('#inviteIn') as HTMLInputElement).value.trim();
  return v || undefined;
}

async function enterCity(body: {
  name?: string;
  pin?: string;
  guest?: boolean;
  signup?: boolean;
  inviteCode?: string;
}) {
  setIntroBusy(true);
  ($('#introErr') as HTMLElement).hidden = true;
  try {
    applyProfile(await loginRequest(body));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not sign in';
    showIntroError(msg);
    if (/paused|NEAR|invite/i.test(msg) && introTab !== 'signin') setIntroTab('signin');
  } finally {
    setIntroBusy(false);
  }
}

function namedBody(signup: boolean): {
  name: string;
  pin: string;
  signup?: boolean;
  inviteCode?: string;
} | null {
  const name = ($('#nameIn') as HTMLInputElement).value.trim().toLowerCase();
  if (!name) {
    showIntroError(signup ? 'Choose a player name.' : 'Enter your name to sign in.');
    return null;
  }
  const pin = readPin();
  if (!pin) return null;
  const invite = inviteCode();
  return signup ? { name, pin, signup: true, inviteCode: invite } : { name, pin };
}

document.querySelectorAll('[data-intro-tab]').forEach(el => {
  (el as HTMLButtonElement).onclick = () => {
    const tab = (el as HTMLElement).dataset.introTab as IntroTab | undefined;
    if (tab === 'signin' || tab === 'create' || tab === 'guest') setIntroTab(tab);
  };
});

($('#startBtn') as HTMLButtonElement).onclick = () => {
  const body = namedBody(false);
  if (body) void enterCity(body);
};
($('#createBtn') as HTMLButtonElement).onclick = () => {
  const body = namedBody(true);
  if (body) void enterCity(body);
};
($('#guestBtn') as HTMLButtonElement).onclick = () => {
  void enterCity({ guest: true, inviteCode: inviteCode() });
};
($('#nameIn') as HTMLInputElement).addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (introTab === 'create') ($('#createBtn') as HTMLButtonElement).click();
    else ($('#startBtn') as HTMLButtonElement).click();
  }
});
($('#pinIn') as HTMLInputElement).addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (introTab === 'create') ($('#createBtn') as HTMLButtonElement).click();
    else ($('#startBtn') as HTMLButtonElement).click();
  }
});

type GisAccounts = {
  id: {
    initialize: (opts: {
      client_id: string;
      callback: (res: { credential: string }) => void;
    }) => void;
    renderButton: (parent: HTMLElement, opts: Record<string, unknown>) => void;
  };
};

declare global {
  interface Window {
    google?: { accounts: GisAccounts };
  }
}

let pendingGoogleCredential: string | null = null;

function showGoogleNameStep() {
  ($('#googleNameHint') as HTMLElement).hidden = false;
  ($('#googleFinishBtn') as HTMLButtonElement).hidden = false;
  ($('#inviteLabel') as HTMLElement).hidden = false;
  ($('#inviteIn') as HTMLInputElement).hidden = false;
  ($('#nameIn') as HTMLInputElement).focus();
}

async function completeGoogleLogin(credential: string, name?: string) {
  setIntroBusy(true);
  showIntroError('');
  ($('#introErr') as HTMLElement).hidden = true;
  try {
    const inviteCode = ($('#inviteIn') as HTMLInputElement).value.trim() || undefined;
    const profile = await googleLoginRequest({
      credential,
      name,
      inviteCode,
    });
    pendingGoogleCredential = null;
    applyProfile(profile);
  } catch (err) {
    if (err instanceof GoogleNeedsNameError) {
      pendingGoogleCredential = credential;
      showGoogleNameStep();
      showIntroError(err.message);
    } else {
      showIntroError(err instanceof Error ? err.message : 'Could not sign in with Google');
    }
  } finally {
    setIntroBusy(false);
  }
}

function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-gis]') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Google script failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.dataset.gis = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google script failed'));
    document.head.appendChild(s);
  });
}

async function setupGoogleSignIn() {
  const clientId = await fetchGoogleClientId();
  if (!clientId) return;
  try {
    await loadGisScript();
  } catch {
    return;
  }
  const gis = window.google?.accounts?.id;
  if (!gis) return;

  gis.initialize({
    client_id: clientId,
    callback: res => {
      if (!res?.credential) {
        showIntroError('Google sign-in was cancelled');
        return;
      }
      void completeGoogleLogin(res.credential);
    },
  });
  gis.renderButton($('#googleBtn') as HTMLElement, {
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
    width: 280,
  });
  googleReady = true;
  if (introTab === 'signin' || introTab === 'create') {
    ($('#googleWrap') as HTMLElement).hidden = false;
  }
}

($('#googleFinishBtn') as HTMLButtonElement).onclick = () => {
  if (!pendingGoogleCredential) {
    showIntroError('Tap Sign in with Google first.');
    return;
  }
  const name = ($('#nameIn') as HTMLInputElement).value.trim().toLowerCase();
  if (!name) {
    showIntroError('Enter a player name to finish Google sign-in.');
    return;
  }
  void completeGoogleLogin(pendingGoogleCredential, name);
};

setIntroTab('signin');
void setupGoogleSignIn();

let last = performance.now();
let fpsFrames = 0;
let fpsWindowStart = last;
let fpsAvg = 60;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsFrames += 1;
  if (now - fpsWindowStart >= 1000) {
    fpsAvg = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  try {
    worldUpdate(dt);
    if (!introOpen()) {
      economyUpdate(dt);
      phoneUpdate(dt);
      lifeUpdate(dt);
    } else {
      addTickT(dt);
    }
    renderer.render(scene, camera);
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(frame);
}
buildLook(player, S.look);
drawScreens();
updateHud();
requestAnimationFrame(frame);

window.__g = {
  forgeGame,
  dinerGame,
  openPhone,
  travel,
  here,
  LOCS,
  openCustomizer,
  S,
  TOK,
  market,
  feed,
  cases,
  serverTick,
  player,
  cam,
  stations,
  runEvent,
  tradeGame,
  secGame,
  commGame,
  closeModal,
  useStation,
  get fps() {
    return fpsAvg;
  },
  enterBuilding,
  exitBuilding,
  clearInterior,
  warpIntoBuilding,
  isInside,
  EVENTS,
};
