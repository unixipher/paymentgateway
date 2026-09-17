import type { NextRequest } from 'next/server';
import { authenticate, generateApiKey } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { handler, json, noContent } from '@/lib/http';

/** Creates a new API key, replacing (and immediately invalidating) any existing one. The key is only returned here. */
export const POST = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const { key, hash, prefix } = generateApiKey();
  const updated = await prisma.merchant.update({
    where: { id: merchant.id },
    data: { apiKeyHash: hash, apiKeyPrefix: prefix, apiKeyCreatedAt: new Date() },
  });
  return json({ api_key: key, prefix, created_at: updated.apiKeyCreatedAt?.toISOString() }, { status: 201 });
});

export const DELETE = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { apiKeyHash: null, apiKeyPrefix: null, apiKeyCreatedAt: null },
  });
  return noContent();
});
