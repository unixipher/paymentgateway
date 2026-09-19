import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { handler, json } from '@/lib/http';
import { merchantStats } from '@/lib/stats';

/** Dashboard summary: today's collections, what's open, and the last 7 days by day (Indian time). */
export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  return json(await merchantStats(merchant.id));
});
