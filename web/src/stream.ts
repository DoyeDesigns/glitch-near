import { $ } from './util';
import { applyActiveEvents, applyStreamState, type StreamPayload } from './market';

const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const url = `${base}/stream`;

const seenEvents = new Set<string>();
let es: EventSource | null = null;
let everConnected = false;

function setReconnect(show: boolean) {
  const el = $('#reconnect') as HTMLElement | null;
  if (el) el.hidden = !show;
}

function onPayload(raw: string) {
  let data: StreamPayload;
  try {
    data = JSON.parse(raw) as StreamPayload;
  } catch {
    return;
  }
  applyStreamState(data);

  const fresh = data.activeEvents.filter(e => !seenEvents.has(e.id));
  for (const e of fresh) seenEvents.add(e.id);
  // Cap seen set
  if (seenEvents.size > 200) {
    const keep = new Set(data.activeEvents.map(e => e.id));
    for (const id of [...seenEvents]) if (!keep.has(id)) seenEvents.delete(id);
  }
  if (fresh.length) applyActiveEvents(fresh);

  everConnected = true;
  setReconnect(false);
}

export function startStream(): void {
  if (es) return;
  setReconnect(true);
  es = new EventSource(url);

  es.addEventListener('state', (ev: MessageEvent<string>) => {
    onPayload(ev.data);
  });
  // Some servers send unnamed messages
  es.onmessage = (ev: MessageEvent<string>) => {
    onPayload(ev.data);
  };

  es.onerror = () => {
    if (everConnected || es?.readyState === EventSource.CONNECTING) setReconnect(true);
  };
}

export function stopStream(): void {
  es?.close();
  es = null;
}
