import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { config } from '@/lib/env';
import { createPairingCode } from '@/lib/devices';
import { handler, json } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

/** A single-use code to type into the Android app. Creating one invalidates the previous one. */
export const POST = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  await rateLimit(`pairing-code:${merchant.id}`, 10, 10 * 60_000);
  const { code, expiresAt } = await createPairingCode(merchant.id);
  return json({ code, expires_at: expiresAt.toISOString(), server_url: config().apiBaseUrl }, { status: 201 });
});
