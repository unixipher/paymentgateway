import { NextResponse, type NextRequest } from 'next/server';
import { randomToken, sign } from '@/lib/crypto';
import { config } from '@/lib/env';
import { googleAuthUrl } from '@/lib/google';
import { clientIp, handler } from '@/lib/http';
import { OAUTH_STATE_COOKIE, safeRedirectPath } from '@/lib/oauth-state';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Starts Google sign-in. The frontend links (full-page navigation) to
 * `/api/auth/google?redirect=/dashboard`.
 */
export const GET = handler(async (req: NextRequest) => {
  await rateLimit(`auth-start:${clientIp(req)}`, 20, 60_000);

  const nonce = randomToken('st');
  const redirect = safeRedirectPath(req.nextUrl.searchParams.get('redirect'));
  const state = sign(JSON.stringify({ nonce, redirect, exp: Date.now() + 10 * 60_000 }));

  const response = NextResponse.redirect(googleAuthUrl(nonce));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: config().apiBaseUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/auth/google/callback',
    maxAge: 10 * 60,
  });
  return response;
});
