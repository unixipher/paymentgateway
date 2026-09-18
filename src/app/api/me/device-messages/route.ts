import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { deviceMessageView } from '@/lib/devices';
import { handler, json, paginationQuery, searchParams } from '@/lib/http';

/** Bank SMS and notifications forwarded by paired phones and what was decided, for troubleshooting. */
export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const { limit, cursor } = paginationQuery.parse(searchParams(req));
  const rows = await prisma.deviceMessage.findMany({
    where: { merchantId: merchant.id },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    include: { device: { select: { name: true } } },
  });
  const page = rows.slice(0, limit);
  return json({ data: page.map(deviceMessageView), next_cursor: rows.length > limit ? page.at(-1)?.id ?? null : null });
});
