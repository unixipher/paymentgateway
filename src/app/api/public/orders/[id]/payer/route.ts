import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { clientIp, handler, json, readJson } from '@/lib/http';
import { payerNameSchema } from '@/lib/names';
import { publicOrderView, setPayerName } from '@/lib/orders';
import { rateLimit } from '@/lib/rate-limit';

/** The payer's name, asked on the checkout page before they pay: the name on the bank account they'll pay from. */
export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await rateLimit(`checkout-payer:${clientIp(req)}`, 20, 10 * 60_000);

  const { name } = await readJson(req, z.object({ name: payerNameSchema }));
  await setPayerName(id, name);

  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: { txn: { select: { utr: true, payerVpa: true, payerName: true, channel: true, receivedAt: true, emailConfirmedAt: true } }, merchant: { select: { vpa: true, displayName: true, email: true } } },
  });
  return json(publicOrderView(order, order.merchant));
});
