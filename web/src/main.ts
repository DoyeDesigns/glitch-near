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
  player,
  renderer,
  scene,
  stations,
  worldUpdate,
} from './world';
import { closeModal, drawScreens, introOpen, modalOpen, setHudAvailable, setHudSettling, startMePoll, updateHud } from './hud';
import { loginRequest } from './session';
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

async function enterCity(body: { name?: string; pin?: string; guest?: boolean; signup?: boolean }) {
  const start = $('#startBtn') as HTMLButtonElement;
  const create = $('#createBtn') as HTMLButtonElement;
  const guest = $('#guestBtn') as HTMLButtonElement;
  start.disabled = true;
  create.disabled = true;
  guest.disabled = true;
  showIntroError('');
  ($('#introErr') as HTMLElement).hidden = true;
  try {
    const profile = await loginRequest(body);
    S.name = profile.name;
    S.bal = Number(profile.available);
    S.xp = profile.xp;
    S.needs = profile.needs;
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
  } catch (err) {
    showIntroError(err instanceof Error ? err.message : 'Could not sign in');
  } finally {
    start.disabled = false;
    create.disabled = false;
    guest.disabled = false;
  }
}

function namedBody(signup: boolean): { name: string; pin: string; signup?: boolean } | null {
  const name = ($('#nameIn') as HTMLInputElement).value.trim().toLowerCase();
  if (!name) {
    showIntroError('Enter a name, or play as guest.');
    return null;
  }
  const pin = readPin();
  if (!pin) return null;
  return signup ? { name, pin, signup: true } : { name, pin };
}

($('#startBtn') as HTMLButtonElement).onclick = () => {
  const body = namedBody(false);
  if (body) void enterCity(body);
};
($('#createBtn') as HTMLButtonElement).onclick = () => {
  const body = namedBody(true);
  if (body) void enterCity(body);
};
($('#guestBtn') as HTMLButtonElement).onclick = () => {
  void enterCity({ guest: true });
};
($('#nameIn') as HTMLInputElement).addEventListener('keydown', e => {
  if (e.key === 'Enter') ($('#startBtn') as HTMLButtonElement).click();
});

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
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
  EVENTS,
};
