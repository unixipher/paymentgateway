import { NextResponse, type NextRequest } from 'next/server';

// Proxy runs separately from route code, so it reads the environment directly instead of importing lib/env.
function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of [process.env.FRONTEND_URL, ...(process.env.CORS_ORIGINS ?? '').split(',')]) {
    try {
      if (value?.trim()) origins.add(new URL(value.trim()).origin);
    } catch {
      // ignore malformed entries; lib/env reports them on first request
    }
  }
  return origins;
}

const ALLOW_HEADERS = 'Authorization, Content-Type, Idempotency-Key';
const ALLOW_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/**
 * CORS and baseline security headers for the API.
 * - `/api/public/*` (checkout) can be called from any site; it never uses credentials.
 * - Everything else is only exposed to the configured frontend origins. Auth is a Bearer token, not
 *   cookies, so CORS here limits which browser apps can read responses rather than being the auth boundary.
 */
export function proxy(req: NextRequest) {
  const origin = req.headers.get('origin');
  const isPublic = req.nextUrl.pathname.startsWith('/api/public/');
  const allowOrigin = isPublic ? '*' : origin && allowedOrigins().has(origin) ? origin : null;

  const cors = new Headers();
  if (allowOrigin) {
    cors.set('Access-Control-Allow-Origin', allowOrigin);
    cors.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  if (!isPublic) cors.set('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    if (allowOrigin) {
      cors.set('Access-Control-Allow-Methods', ALLOW_METHODS);
      cors.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
      cors.set('Access-Control-Max-Age', '86400');
    }
    return new NextResponse(null, { status: allowOrigin ? 204 : 403, headers: cors });
  }

  const response = NextResponse.next();
  cors.forEach((value, key) => response.headers.set(key, value));
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  if (req.nextUrl.protocol === 'https:') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  return response;
}

export const config = {
  matcher: ['/api/:path*', '/auth/:path*'],
};
