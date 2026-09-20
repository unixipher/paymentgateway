import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { handler, json, readJson } from '@/lib/http';
import { merchantView, updateMerchantSchema } from '@/lib/merchants';

export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  return json(merchantView(merchant));
});

export const PATCH = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const body = await readJson(req, updateMerchantSchema);
  if (!(body.confirm_by_email ?? merchant.confirmByEmail) && !(body.confirm_by_sms ?? merchant.confirmBySms)) {
    throw badRequest('Keep at least one of bank emails or phone SMS on, or no payment can be confirmed');
  }
  const updated = await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      ...(body.vpa !== undefined && { vpa: body.vpa }),
      ...(body.bank !== undefined && { bankKey: body.bank }),
      ...(body.display_name !== undefined && { displayName: body.display_name }),
      ...(body.webhook_url !== undefined && { webhookUrl: body.webhook_url }),
      ...(body.confirm_by_email !== undefined && { confirmByEmail: body.confirm_by_email }),
      ...(body.confirm_by_sms !== undefined && { confirmBySms: body.confirm_by_sms }),
    },
  });
  return json(merchantView(updated));
});
