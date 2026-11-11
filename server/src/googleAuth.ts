/** google-auth-library: verifies Google Identity Services ID tokens (audience + issuer + expiry). */
import { OAuth2Client } from 'google-auth-library';
import { config } from './config';

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export type GoogleIdPayload = {
  sub: string;
  email?: string;
  email_verified?: boolean;
};

type VerifyFn = (credential: string) => Promise<GoogleIdPayload>;

let verifyOverride: VerifyFn | null = null;

/** Test seam for ID token verification. */
export function setGoogleVerifyForTests(fn: VerifyFn | null): void {
  verifyOverride = fn;
}

export class GoogleCredentialError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 503 = 401,
  ) {
    super(message);
    this.name = 'GoogleCredentialError';
  }
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleIdPayload> {
  if (verifyOverride) return verifyOverride(credential);

  const clientId = config.googleClientId;
  if (!clientId) throw new GoogleCredentialError('Google sign-in is not configured', 503);
  if (!credential || typeof credential !== 'string') {
    throw new GoogleCredentialError('Missing Google credential', 400);
  }

  const client = new OAuth2Client(clientId);
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
  } catch {
    throw new GoogleCredentialError('Invalid Google credential', 401);
  }
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new GoogleCredentialError('Invalid Google credential', 401);
  if (!payload.iss || !ISSUERS.has(payload.iss)) {
    throw new GoogleCredentialError('Invalid Google credential', 401);
  }
  const exp = payload.exp;
  if (typeof exp === 'number' && exp * 1000 <= Date.now()) {
    throw new GoogleCredentialError('Google credential expired', 401);
  }
  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified,
  };
}
