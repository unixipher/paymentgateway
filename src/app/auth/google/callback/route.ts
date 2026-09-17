import { NextResponse, type NextRequest } from 'next/server';
import { createLoginCode } from '@/lib/auth';
import { config } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { exchangeGoogleCode } from '@/lib/google';
import { logger } from '@/lib/logger';
import { upsertMerchantFromGoogle } from '@/lib/merchants';
import { OAUTH_STATE_COOKIE, verifyOAuthState } from '@/lib/oauth-state';

/**
 * Google redirects the browser here (this exact URL is registered in Google Cloud Console).
 * On success the browser is sent to `<FRONTEND_URL>/auth/callback?code=...`, where the frontend
 * exchanges the one-time code for a session token via `POST /api/auth/session`.
 */
export async function GET(req: NextRequest) {
  const frontend = (params: Record<string, string>) => {
    const response = NextResponse.redirect(`${config().frontendUrl}/auth/callback?${new URLSearchParams(params)}`);
    response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: '/auth/google/callback' });
    return response;
  };

  const query = req.nextUrl.searchParams;
  if (query.get('error')) return frontend({ error: query.get('error') === 'access_denied' ? 'access_denied' : 'google_error' });

  const state = verifyOAuthState(req.cookies.get(OAUTH_STATE_COOKIE)?.value, query.get('state'));
  const code = query.get('code');
  if (!state || !code) return frontend({ error: 'invalid_state' });

  try {
    const identity = await exchangeGoogleCode(code);
    const merchant = await upsertMerchantFromGoogle(identity);
    if (!merchant.gmailRefreshToken) return frontend({ error: 'gmail_not_connected' });
    const loginCode = await createLoginCode(merchant.id, state.redirect);
    return frontend({ code: loginCode });
  } catch (err) {
    if (err instanceof ApiError) return frontend({ error: 'gmail_permission_missing' });
    logger.error('google sign-in failed', { err });
    return frontend({ error: 'login_failed' });
  }
}
