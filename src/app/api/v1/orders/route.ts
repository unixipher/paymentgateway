import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate } from '@/lib/auth';
import { badRequest } from '@/lib/errors';
import { handler, json, paginationQuery, readJson, searchParams } from '@/lib/http';
import { payerNameSchema } from '@/lib/names';
import { createOrder, listOrders, merchantOrderView } from '@/lib/orders';
import { rateLimit } from '@/lib/rate-limit';

const createOrderSchema = z
  .object({
    amount: z.union([z.string(), z.number()]).transform(String),
    note: z.string().trim().min(1).max(50).optional(),
    redirect_url: z.url({ protocol: /^https?$/ }).max(500).optional(),
    /** Name on the bank account the payer will pay from, if you ask them. */
    payer_name: payerNameSchema.optional(),
    metadata: z
      .record(z.string().max(40), z.string().max(500))
      .refine((m) => Object.keys(m).length <= 20, 'at most 20 keys')
      .optional(),
  })
  .strict();

export const POST = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['api_key', 'session']);
  await rateLimit(`create-order:${merchant.id}`, 120, 60_000);

  const idempotencyKey = req.headers.get('idempotency-key');
  if (idempotencyKey !== null && !/^[\w.:-]{1,100}$/.test(idempotencyKey)) {
    throw badRequest('Idempotency-Key must be 1-100 characters of letters, digits, _ . : -');
  }

  const body = await readJson(req, createOrderSchema);
  const order = await createOrder(merchant, {
    amount: body.amount,
    note: body.note,
    redirectUrl: body.redirect_url,
    metadata: body.metadata,
    idempotencyKey,
    payerName: body.payer_name,
  });
  return json(merchantOrderView(order), { status: 201 });
});

const listQuery = paginationQuery.extend({
  status: z.enum(['pending', 'paid', 'failed', 'cancelled']).optional(),
});

export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['api_key', 'session']);
  const { limit, cursor, status } = listQuery.parse(searchParams(req));
  const { data, nextCursor } = await listOrders(merchant.id, { limit, cursor, state: status });
  // One clock for the whole page, and never `map(merchantOrderView)`: map would pass the array
  // index as `now`, so every expired order would read back as still pending.
  const now = Date.now();
  return json({ data: data.map((order) => merchantOrderView(order, now)), next_cursor: nextCursor });
});
