import { config } from './env';
import { badRequest } from './errors';
import type { GmailPart } from './parser';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Registered in Google Cloud Console as the OAuth redirect URI. */
export const googleRedirectUri = () => `${config().apiBaseUrl}/auth/google/callback`;

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config().google.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: ['openid', 'email', GMAIL_SCOPE].join(' '),
    access_type: 'offline',
    prompt: 'consent', // always hand back a refresh token
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Google rejected the refresh token: the user revoked access, or (in Testing mode) it expired. */
export class GoogleAuthRevokedError extends Error {}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: config().google.clientId, client_secret: config().google.clientSecret, ...params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    if (body.error === 'invalid_grant' && params.grant_type === 'refresh_token') throw new GoogleAuthRevokedError(body.error);
    throw new Error(`Google token endpoint: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
  }
  return body;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  refreshToken: string | undefined;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: googleRedirectUri() });
  if (!tokens.scope?.split(' ').includes(GMAIL_SCOPE)) {
    throw badRequest('Gmail read access was not granted');
  }
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const user = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean };
  if (!res.ok || !user.sub || !user.email || !user.email_verified) throw badRequest('Could not read a verified Google account');
  return { sub: user.sub, email: user.email.toLowerCase(), refreshToken: tokens.refresh_token };
}

// Access tokens live ~1 hour; cache them per warm instance to avoid a token call on every poll.
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export async function gmailAccessToken(merchantId: string, refreshToken: string): Promise<string> {
  const cached = accessTokens.get(merchantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  accessTokens.set(merchantId, { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
  return tokens.access_token;
}

export const forgetAccessToken = (merchantId: string) => accessTokens.delete(merchantId);

export interface GmailMessage {
  id: string;
  internalDate: string;
  snippet?: string;
  payload?: GmailPart;
}

async function gmailGet<T>(token: string, path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) throw new GoogleAuthRevokedError('Gmail API returned 401');
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function listMessageIds(token: string, query: string, maxResults = 100): Promise<string[]> {
  const list = await gmailGet<{ messages?: { id: string }[] }>(token, 'messages', { q: query, maxResults });
  return (list.messages ?? []).map((m) => m.id);
}

export const getMessage = (token: string, id: string) =>
  gmailGet<GmailMessage>(token, `messages/${encodeURIComponent(id)}`, { format: 'full' });
