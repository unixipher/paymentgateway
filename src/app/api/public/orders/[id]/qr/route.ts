import type { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { ApiError, notFound } from '@/lib/errors';
import { clientIp, handler } from '@/lib/http';
import { upiLink } from '@/lib/orders';
import { rateLimit } from '@/lib/rate-limit';

/** PNG QR code of the order's UPI payment link, for `<img src>`. The link never changes, so it's cacheable. */
export const GET = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await rateLimit(`checkout-qr:${clientIp(req)}`, 60, 60_000);
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: { merchant: { select: { vpa: true, displayName: true, email: true } } },
  });
  if (!order) throw notFound('Order not found');
  if (!order.merchant.vpa) throw new ApiError(409, 'merchant_not_configured', 'Merchant has no UPI ID');

  const size = Math.min(Math.max(Number(req.nextUrl.searchParams.get('size')) || 512, 128), 1024);
  const png = await QRCode.toBuffer(upiLink(order.merchant, order), { type: 'png', width: size, margin: 1, errorCorrectionLevel: 'M' });
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, immutable' },
  });
});
