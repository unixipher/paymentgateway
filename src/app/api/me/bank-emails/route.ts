import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { handler, json, paginationQuery, searchParams } from '@/lib/http';

/** Bank emails the poller has examined and what it decided, for troubleshooting unmatched payments. */
export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const { limit, cursor } = paginationQuery.parse(searchParams(req));
  const rows = await prisma.gmailMessage.findMany({
    where: { merchantId: merchant.id },
    orderBy: [{ receivedAt: 'desc' }, { gmailMessageId: 'desc' }],
    take: limit + 1,
    ...(cursor && { cursor: { merchantId_gmailMessageId: { merchantId: merchant.id, gmailMessageId: cursor } }, skip: 1 }),
  });
  const page = rows.slice(0, limit);
  return json({
    data: page.map((m) => ({
      id: m.gmailMessageId,
      object: 'bank_email',
      received_at: m.receivedAt.toISOString(),
      from: m.fromAddr,
      subject: m.subject,
      verdict: m.verdict,
      recognised: m.verdict.startsWith('credit'),
    })),
    next_cursor: rows.length > limit ? page.at(-1)?.gmailMessageId ?? null : null,
  });
});
