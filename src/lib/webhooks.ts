import type { Merchant } from '@/generated/prisma/client';
import { runAfterResponse } from './background';
import { decrypt, hmacSha256Hex, randomId, safeEqual } from './crypto';
import { prisma, type Prisma } from './db';
import { logger } from './logger';

/** Delay before each attempt. After the last one the delivery is marked failed (~45 hours in total). */
const BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];
const LOCK_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** Signatures older than this should be rejected by receivers (replay protection). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type WebhookEvent = 'order.paid' | 'order.failed' | 'payment.unverified';

/** `X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

/** Reference verification, mirrored in the API docs for merchants. */
export function verifyWebhookSignature(secret: string, body: string, header: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return safeEqual(parts.v1, hmacSha256Hex(secret, `${timestamp}.${body}`));
}

/**
 * Records a webhook in the outbox. Pass the transaction client so the event is committed atomically
 * with the change it describes. Returns null if the merchant has no webhook URL.
 */
export async function enqueueWebhook(
  tx: Prisma.TransactionClient,
  merchant: Pick<Merchant, 'id' | 'webhookUrl'>,
  event: WebhookEvent,
  data: Record<string, unknown>,
  orderId?: string,
): Promise<string | null> {
  if (!merchant.webhookUrl) return null;
  const id = randomId('evt');
  await tx.webhookDelivery.create({
    data: {
      id,
      merchantId: merchant.id,
      orderId,
      event,
      payload: { id, type: event, created_at: new Date().toISOString(), data } as Prisma.InputJsonValue,
    },
  });
  return id;
}

/** Tries delivery right after the response is sent; the cron picks up anything that fails. */
export function scheduleDelivery(ids: (string | null)[]) {
  for (const id of ids) {
    if (id) runAfterResponse(`webhook delivery ${id}`, () => deliverWebhook(id));
  }
}

export async function deliverWebhook(id: string): Promise<'succeeded' | 'retrying' | 'failed' | 'skipped'> {
  const now = new Date();
  // Claim the delivery so concurrent workers don't send it twice.
  const claimed = await prisma.webhookDelivery.updateMany({
    where: {
      id,
      status: 'pending',
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS), attempts: { increment: 1 } },
  });
  if (!claimed.count) return 'skipped';

  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { merchant: true } });
  const { merchant } = delivery;
  if (!merchant.webhookUrl) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: 'failed', lockedUntil: null, lastError: 'Webhook URL was removed' },
    });
    return 'failed';
  }

  const body = JSON.stringify(delivery.payload);
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(merchant.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'paymentgateway-webhooks/1.0',
        'x-webhook-id': delivery.id,
        'x-webhook-event': delivery.event,
        'x-webhook-signature': signWebhook(decrypt(merchant.webhookSecret), body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    statusCode = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (!error) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: 'succeeded', deliveredAt: new Date(), lockedUntil: null, lastStatusCode: statusCode, lastError: null },
    });
    return 'succeeded';
  }

  const nextDelay = BACKOFF_MS[delivery.attempts];
  const exhausted = nextDelay === undefined;
  await prisma.webhookDelivery.update({
    where: { id },
    data: {
      status: exhausted ? 'failed' : 'pending',
      nextAttemptAt: exhausted ? delivery.nextAttemptAt : new Date(Date.now() + nextDelay),
      lockedUntil: null,
      lastStatusCode: statusCode,
      lastError: error.slice(0, 500),
    },
  });
  logger.warn('webhook delivery failed', { id, merchantId: merchant.id, attempt: delivery.attempts, error, exhausted });
  return exhausted ? 'failed' : 'retrying';
}

export async function deliverDueWebhooks(limit = 50) {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  const results = await Promise.all(due.map((d) => deliverWebhook(d.id)));
  return { attempted: due.length, succeeded: results.filter((r) => r === 'succeeded').length };
}
