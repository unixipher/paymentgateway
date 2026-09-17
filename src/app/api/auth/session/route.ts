import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, redeemLoginCode, revokeSession } from '@/lib/auth';
import { clientIp, handler, json, noContent, readJson } from '@/lib/http';
import { merchantView } from '@/lib/merchants';
import { rateLimit } from '@/lib/rate-limit';

/** Exchanges the one-time `code` from the sign-in redirect for a session token. */
export const POST = handler(async (req: NextRequest) => {
  await rateLimit(`auth-session:${clientIp(req)}`, 20, 60_000);
  const { code } = await readJson(req, z.object({ code: z.string().min(10).max(200) }));
  const { token, session, redirectPath } = await redeemLoginCode(code, req.headers.get('user-agent'));
  return json(
    {
      token,
      token_type: 'Bearer',
      expires_at: session.expiresAt.toISOString(),
      redirect: redirectPath,
      merchant: merchantView(session.merchant),
    },
    { status: 201 },
  );
});

/** Signs out: revokes the session token used for this request. */
export const DELETE = handler(async (req: NextRequest) => {
  const { sessionId } = await authenticate(req, ['session']);
  if (sessionId) await revokeSession(sessionId);
  return noContent();
});
