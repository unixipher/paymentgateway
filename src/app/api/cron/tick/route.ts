import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { config } from '@/lib/env';
import { ApiError, unauthorized } from '@/lib/errors';
import { handler, json } from '@/lib/http';
import { logger } from '@/lib/logger';
import { pollAllDue } from '@/lib/poller';
import { deliverDueWebhooks } from '@/lib/webhooks';

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

  const started = Date.now();
  const now = new Date();
  const [polling, webhooks, cleanup] = await Promise.all([
    pollAllDue(),
    deliverDueWebhooks(),
    Promise.all([
      prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.loginCode.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.devicePairingCode.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 3600_000) } } }),
    ]),
  ]);

  const result = {
    polling,
    webhooks,
    cleanup: { sessions: cleanup[0].count, login_codes: cleanup[1].count, pairing_codes: cleanup[2].count, rate_limits: cleanup[3].count },
    duration_ms: Date.now() - started,
  };
  logger.info('cron tick', result);
  return json(result);
});
