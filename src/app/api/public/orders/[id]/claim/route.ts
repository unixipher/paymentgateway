import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { clientIp, handler, json, readJson } from '@/lib/http';
import { claimUtr, publicOrderView } from '@/lib/orders';
import { pollIfDue } from '@/lib/poller';
import { rateLimit } from '@/lib/rate-limit';

export const maxDuration = 60;

/** The payer submits the 12-digit UPI reference (UTR) from their app, e.g. when they paid a rounded amount. */
export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await rateLimit(`checkout-claim:${clientIp(req)}`, 10, 10 * 60_000);
  await rateLimit(`checkout-claim-order:${id}`, 5, 10 * 60_000);

  const { utr } = await readJson(req, z.object({ utr: z.string().trim().regex(/^\d{12}$/, 'must be the 12 digit UPI reference number') }));
  const order = await claimUtr(id, utr);
  if (order.status === 'pending') await pollIfDue(order.merchantId);

  const fresh = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: { txn: { select: { utr: true, payerVpa: true } }, merchant: { select: { vpa: true, displayName: true, email: true } } },
  });
  return json(publicOrderView(fresh, fresh.merchant));
});
