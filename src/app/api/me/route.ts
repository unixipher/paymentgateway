import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { handler, json, readJson } from '@/lib/http';
import { merchantView, updateMerchantSchema } from '@/lib/merchants';

export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  return json(merchantView(merchant));
});

export const PATCH = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const body = await readJson(req, updateMerchantSchema);
  const updated = await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      ...(body.vpa !== undefined && { vpa: body.vpa }),
      ...(body.display_name !== undefined && { displayName: body.display_name }),
      ...(body.webhook_url !== undefined && { webhookUrl: body.webhook_url }),
    },
  });
  return json(merchantView(updated));
});
