/** Session snapshot from GET /me. HUD shows `available`. */

export type Me = {
  name: string;
  accountId: string;
  available: string;
  settling: string;
  items: Record<string, string>;
  xp: { trade: number; sec: number; comm: number };
  needs: { energy: number; hunger: number };
  homePaidUntil: number;
};

export let me: Me | null = null;

export async function loginRequest(body: {
  name?: string;
  pin?: string;
  guest?: boolean;
  signup?: boolean;
  inviteCode?: string;
}): Promise<Me> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error || 'Could not sign in');
  return refreshMe();
}

export class GoogleNeedsNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleNeedsNameError';
  }
}

export async function googleLoginRequest(body: {
  credential: string;
  name?: string;
  inviteCode?: string;
}): Promise<Me> {
  const res = await fetch('/auth/google', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: string; needsName?: boolean };
  if (!res.ok) {
    if (data.needsName) throw new GoogleNeedsNameError(data.error || 'Choose a player name');
    throw new Error(data.error || 'Could not sign in with Google');
  }
  return refreshMe();
}

export async function fetchGoogleClientId(): Promise<string | null> {
  const res = await fetch('/auth/google/config');
  if (!res.ok) return null;
  const data = (await res.json()) as { clientId?: string | null };
  return data.clientId || null;
}

export type ChainProof = {
  accountId: string;
  gdOnChain: string;
  available: string;
  pending: string;
  items: Record<string, string>;
  nearBalance: string;
  gdContract: string;
  itemsContract: string;
  chainMode?: 'mock' | 'testnet';
};

export async function fetchChainProof(): Promise<ChainProof> {
  const res = await fetch('/me/chain', { credentials: 'include' });
  const data = (await res.json()) as ChainProof & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Could not load on-chain proof');
  return data;
}

export async function refreshMe(): Promise<Me> {
  const res = await fetch('/me', { credentials: 'include' });
  const data = (await res.json()) as Me & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Could not load your profile');
  me = data;
  return data;
}
