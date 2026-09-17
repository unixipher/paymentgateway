import { safeEqual, unsign } from './crypto';

export const OAUTH_STATE_COOKIE = 'pg_oauth_state';

/** Only same-site relative paths, so the frontend redirect can't be turned into an open redirect. */
export function safeRedirectPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 200) return null;
  return value;
}

/** Returns the redirect path stored at sign-in start if the cookie is authentic, fresh and matches `state`. */
export function verifyOAuthState(cookie: string | undefined, state: string | null): { redirect: string | null } | null {
  if (!cookie || !state) return null;
  const value = unsign(cookie);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { nonce?: string; redirect?: string | null; exp?: number };
    if (!parsed.nonce || !parsed.exp || parsed.exp < Date.now() || !safeEqual(parsed.nonce, state)) return null;
    return { redirect: safeRedirectPath(parsed.redirect) };
  } catch {
    return null;
  }
}
