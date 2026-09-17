import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { handler, json } from '@/lib/http';
import { cancelOrder, merchantOrderView } from '@/lib/orders';

export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { merchant } = await authenticate(req, ['api_key', 'session']);
  const { id } = await params;
  return json(merchantOrderView(await cancelOrder(merchant.id, id)));
});
