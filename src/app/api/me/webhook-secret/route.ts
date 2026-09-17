import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { decrypt, encrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { handler, json } from '@/lib/http';
import { newWebhookSecret } from '@/lib/merchants';

/** Reveals the signing secret used for `X-Webhook-Signature`. */
export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  return json({ webhook_secret: decrypt(merchant.webhookSecret) });
});

/** Rotates the signing secret. Deliveries sent after this are signed with the new one. */
export const POST = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const secret = newWebhookSecret();
  await prisma.merchant.update({ where: { id: merchant.id }, data: { webhookSecret: encrypt(secret) } });
  return json({ webhook_secret: secret }, { status: 201 });
});
