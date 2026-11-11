/**
 * Advertiser-only page. Connects a NEAR wallet and calls market.book_ad.
 * Players never see this flow.
 */
import {
  internalActionToNaj,
  setupWalletSelector,
  type WalletSelector,
} from '@near-wallet-selector/core';
import { setupModal, type WalletSelectorModal } from '@near-wallet-selector/modal-ui-js';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import '@near-wallet-selector/modal-ui-js/styles.css';
import { JsonRpcProvider } from 'near-api-js';

const NETWORK = 'testnet';
const CONTRACT =
  (import.meta.env.VITE_MARKET_CONTRACT as string | undefined) ||
  'market.glitch-edoye.testnet';
const RPC = 'https://test.rpc.fastnear.com';

type ConfigView = {
  slot_count: number;
  max_units: number;
  unit_ms: string | number;
  base_price: string;
};

type Booking = {
  advertiser: string;
  project_name: string;
  creative_url: string;
  start_ns: string;
  end_ns: string;
  paid: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let selector: WalletSelector;
let modal: WalletSelectorModal;
let accountId: string | null = null;
let config: ConfigView | null = null;

const provider = new JsonRpcProvider({ url: RPC });

function showErr(msg: string) {
  const el = $('err');
  el.hidden = !msg;
  el.textContent = msg;
  $('ok').hidden = true;
}

function showOk(msg: string) {
  const el = $('ok');
  el.hidden = !msg;
  el.textContent = msg;
  $('err').hidden = true;
}

function yoctoToNear(yocto: string | bigint): string {
  const n = typeof yocto === 'bigint' ? yocto : BigInt(yocto || '0');
  const whole = n / 10n ** 24n;
  const frac = n % 10n ** 24n;
  const fracStr = frac.toString().padStart(24, '0').replace(/0+$/, '').slice(0, 5);
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

function nsToLocal(ns: string): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  if (!Number.isFinite(ms)) return ns;
  return new Date(ms).toLocaleString();
}

async function viewFunction<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const value = await provider.callFunction({
    contractId: CONTRACT,
    method,
    args,
  });
  return value as T;
}

async function refreshAccount() {
  const state = selector.store.getState();
  accountId = state.accounts[0]?.accountId ?? null;
  $('account').textContent = accountId ?? '';
  $('disconnect').hidden = !accountId;
  $('connect').textContent = accountId ? 'Switch wallet' : 'Connect wallet';
  ($('submit') as HTMLButtonElement).disabled = !accountId || !config;
}

async function loadSlots() {
  config = await viewFunction<ConfigView>('get_config');
  const slotCount = Number(config.slot_count);
  const maxUnits = Number(config.max_units) || 1;
  const unitsInput = $('units') as HTMLInputElement;
  unitsInput.max = String(maxUnits);
  unitsInput.min = '1';

  const slotSelect = $('slot') as HTMLSelectElement;
  slotSelect.innerHTML = '';
  const host = $('slots');
  host.innerHTML = '';

  for (let i = 0; i < slotCount; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Slot ${i}`;
    slotSelect.appendChild(opt);

    const [current, queue, price] = await Promise.all([
      viewFunction<Booking | null>('get_current_ad', { slot_id: i }),
      viewFunction<Booking[]>('get_queue', { slot_id: i }),
      viewFunction<string>('get_price', { slot_id: i, units: 1 }),
    ]);

    const card = document.createElement('article');
    card.className = 'slot';
    const cur =
      current && current.creative_url?.startsWith('https://')
        ? `<p><span class="tag">Live</span> ${escapeHtml(current.project_name)} — ends ${escapeHtml(nsToLocal(String(current.end_ns)))}</p>`
        : `<p><span class="tag">Empty</span> YOUR AD HERE</p>`;
    const qLines =
      (queue ?? [])
        .map(
          b =>
            `<p>Queued: ${escapeHtml(b.project_name)} · ${escapeHtml(nsToLocal(String(b.start_ns)))} → ${escapeHtml(nsToLocal(String(b.end_ns)))}</p>`,
        )
        .join('') || '<p>No queue</p>';
    card.innerHTML = `<h3>Slot ${i}</h3>${cur}<p>1-unit price: <strong>${yoctoToNear(String(price))}</strong> NEAR</p>${qLines}`;
    host.appendChild(card);
  }

  await updatePrice();
  ($('submit') as HTMLButtonElement).disabled = !accountId;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function updatePrice() {
  if (!config) return;
  const slot = Number(($('slot') as HTMLSelectElement).value);
  const units = Number(($('units') as HTMLInputElement).value) || 1;
  try {
    const price = await viewFunction<string>('get_price', { slot_id: slot, units });
    $('price').textContent = yoctoToNear(String(price));
    ($('price') as HTMLElement).dataset.yocto = String(price);
  } catch {
    $('price').textContent = '—';
  }
}

function parseBookingFromOutcome(outcome: unknown): Booking | null {
  try {
    const status = (outcome as { status?: { SuccessValue?: string } })?.status;
    if (!status?.SuccessValue) return null;
    const json = atob(status.SuccessValue);
    return JSON.parse(json) as Booking;
  } catch {
    return null;
  }
}

async function book(ev: Event) {
  ev.preventDefault();
  showErr('');
  showOk('');
  if (!accountId) {
    showErr('Connect a wallet first');
    return;
  }
  const slot_id = Number(($('slot') as HTMLSelectElement).value);
  const units = Number(($('units') as HTMLInputElement).value);
  const creative_url = ($('creative') as HTMLInputElement).value.trim();
  const project_name = ($('project') as HTMLInputElement).value.trim();
  if (!creative_url.startsWith('https://')) {
    showErr('Creative URL must be https');
    return;
  }
  if (!project_name || project_name.length > 40) {
    showErr('Project name must be 1–40 characters');
    return;
  }
  const deposit =
    ($('price') as HTMLElement).dataset.yocto ||
    String(await viewFunction<string>('get_price', { slot_id, units }));

  const wallet = await selector.wallet();
  ($('submit') as HTMLButtonElement).disabled = true;
  try {
    const outcome = await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: CONTRACT,
      actions: [
        internalActionToNaj({
          type: 'FunctionCall',
          params: {
            methodName: 'book_ad',
            args: { slot_id, units, creative_url, project_name },
            gas: '30000000000000',
            deposit: String(deposit),
          },
        }),
      ],
    });

    const booking = parseBookingFromOutcome(outcome);
    if (booking) {
      showOk(
        `Booked ${booking.project_name}: ${nsToLocal(String(booking.start_ns))} → ${nsToLocal(String(booking.end_ns))}`,
      );
    } else {
      showOk('Booking submitted. Refresh slots to confirm queue times.');
    }
    await loadSlots();
  } catch (err) {
    showErr(err instanceof Error ? err.message : 'Booking failed');
  } finally {
    ($('submit') as HTMLButtonElement).disabled = !accountId;
  }
}

async function main() {
  selector = await setupWalletSelector({
    network: NETWORK,
    modules: [setupMyNearWallet()],
  });
  modal = setupModal(selector, {
    contractId: CONTRACT,
    description: 'Glitch billboard ads (testnet)',
  });

  selector.store.observable.subscribe(() => {
    void refreshAccount();
  });
  await refreshAccount();

  $('connect').onclick = () => modal.show();
  $('disconnect').onclick = async () => {
    const wallet = await selector.wallet();
    await wallet.signOut();
    await refreshAccount();
  };
  $('slot').onchange = () => void updatePrice();
  $('units').oninput = () => void updatePrice();
  $('book').onsubmit = ev => void book(ev);

  try {
    await loadSlots();
  } catch (err) {
    showErr(err instanceof Error ? err.message : 'Could not load market config');
  }
}

void main();
