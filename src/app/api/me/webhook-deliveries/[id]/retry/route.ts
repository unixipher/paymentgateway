import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { handler, json } from '@/lib/http';
import { deliverWebhook } from '@/lib/webhooks';

/** Re-sends a delivery now (e.g. after fixing the endpoint), whether it failed or is still retrying. */
export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { merchant } = await authenticate(req, ['session']);
  const { id } = await params;
  const updated = await prisma.webhookDelivery.updateMany({
    where: { id, merchantId: merchant.id, status: { in: ['pending', 'failed'] } },
    data: { status: 'pending', nextAttemptAt: new Date(), lockedUntil: null, attempts: 0 },
  });
  if (!updated.count) throw notFound('Webhook delivery not found or already delivered');
  const result = await deliverWebhook(id);
  return json({ id, result });
});
