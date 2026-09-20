import { prisma } from './db';
import { logger } from './logger';
import { pollAllDue } from './poller';
import { flagUnverifiedCredits } from './reconcile';
import { deliverDueWebhooks } from './webhooks';

/** Runs one complete, idempotent background-work cycle. Safe for the HTTP fallback or worker. */
export async function runBackgroundTick(now = new Date()) {
  const started = Date.now();

  // Reconciliation runs after polling, so an email found in this cycle counts.
  const polling = await pollAllDue();
  const [reconciliation, webhooks, cleanup] = await Promise.all([
    flagUnverifiedCredits(now),
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
    reconciliation,
    webhooks,
    cleanup: {
      sessions: cleanup[0].count,
      login_codes: cleanup[1].count,
      pairing_codes: cleanup[2].count,
      rate_limits: cleanup[3].count,
    },
    duration_ms: Date.now() - started,
  };
  logger.info('background tick', result);
  return result;
}
