import type { NextRequest } from 'next/server';
import { runAfterResponse } from '@/lib/background';
import { prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { clientIp, handler, json } from '@/lib/http';
import { notifyFailedOrders, orderState, publicOrderView } from '@/lib/orders';
import { pollIfDue } from '@/lib/poller';
import { rateLimit } from '@/lib/rate-limit';

export const maxDuration = 60;

/**
 * Checkout status for the payer's page, which polls this every few seconds. While the order is open,
 * each call also triggers a (throttled) Gmail check after the response is sent, so payments are
 * detected (and order.failed webhooks sent) even without a cron job.
 */
export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await rateLimit(`checkout-status:${clientIp(req)}`, 120, 60_000);
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: { txn: { select: { utr: true, payerVpa: true } }, merchant: { select: { vpa: true, displayName: true, email: true } } },
  });
  if (!order) throw notFound('Order not found');

  const state = orderState(order);
  // A failed order can still be paid by a bank email that arrives late, so keep checking for a while.
  if (state === 'pending' || state === 'failed') {
    runAfterResponse('on-demand gmail poll', () => pollIfDue(order.merchantId));
  }
  if (state === 'failed' && !order.failureNotifiedAt) {
    runAfterResponse('order.failed webhooks', () => notifyFailedOrders(order.merchantId));
  }
  return json(publicOrderView(order, order.merchant));
});
