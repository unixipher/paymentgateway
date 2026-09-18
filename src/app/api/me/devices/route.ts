import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { deviceView } from '@/lib/devices';
import { handler, json } from '@/lib/http';

/** Phones paired with this account. */
export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const devices = await prisma.device.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: 'desc' } });
  return json({ data: devices.map(deviceView) });
});
