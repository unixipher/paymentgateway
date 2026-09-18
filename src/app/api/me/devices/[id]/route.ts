import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { handler, noContent } from '@/lib/http';

/** Removes a phone. Its token stops working immediately. */
export const DELETE = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { merchant } = await authenticate(req, ['session']);
  const { id } = await params;
  const deleted = await prisma.device.deleteMany({ where: { id, merchantId: merchant.id } });
  if (!deleted.count) throw notFound('Device not found');
  return noContent();
});
