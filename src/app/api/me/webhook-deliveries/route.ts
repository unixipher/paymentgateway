import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { handler, json, paginationQuery, searchParams } from '@/lib/http';

export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const { limit, cursor } = paginationQuery.parse(searchParams(req));
  const rows = await prisma.webhookDelivery.findMany({
    where: { merchantId: merchant.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const page = rows.slice(0, limit);
  return json({
    data: page.map((d) => ({
      id: d.id,
      object: 'webhook_delivery',
      event: d.event,
      order_id: d.orderId,
      status: d.status,
      attempts: d.attempts,
      last_status_code: d.lastStatusCode,
      last_error: d.lastError,
      next_attempt_at: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
      delivered_at: d.deliveredAt?.toISOString() ?? null,
      created_at: d.createdAt.toISOString(),
      payload: d.payload,
    })),
    next_cursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
  });
});
