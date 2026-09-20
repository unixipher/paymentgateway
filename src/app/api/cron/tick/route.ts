import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto';
import { config } from '@/lib/env';
import { ApiError, unauthorized } from '@/lib/errors';
import { handler, json } from '@/lib/http';
import { runBackgroundTick } from '@/lib/tick';

export const maxDuration = 60;

/**
 * Background work: check Gmail for merchants with open orders, retry webhooks, delete expired data.
 * Call every minute with `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this automatically).
 */
export const GET = handler(async (req: NextRequest) => {
  const secret = config().cronSecret;
  if (!secret) throw new ApiError(503, 'internal_error', 'CRON_SECRET is not configured');
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!safeEqual(token, secret)) throw unauthorized();

  return json(await runBackgroundTick());
});
