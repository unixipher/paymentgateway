import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate } from '@/lib/auth';
import { ApiError } from '@/lib/errors';
import { handler, json, readJson } from '@/lib/http';
import { scanRecent } from '@/lib/poller';
import { rateLimit } from '@/lib/rate-limit';

export const maxDuration = 60;

/** Re-reads recent bank emails right away (normally this happens automatically while orders are open). */
export const POST = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  if (!merchant.gmailRefreshToken) throw new ApiError(409, 'gmail_not_connected', 'Gmail is not connected. Sign in again.');
  const { days } = await readJson(req, z.object({ days: z.number().int().min(1).max(7).default(3) }));
  await rateLimit(`gmail-scan:${merchant.id}`, 2, 60_000);
  const ordersPaid = await scanRecent(merchant, days);
  return json({ orders_paid: ordersPaid });
});
