import type { BankTxn, Merchant, Order } from '@/generated/prisma/client';
import { randomId } from './crypto';
import { isUniqueViolation, prisma, type Prisma } from './db';
import { config } from './env';
import { ApiError, badRequest, conflict, notFound } from './errors';
import { formatRupees, rupeesToPaise } from './money';
import { enqueueWebhook, scheduleDelivery } from './webhooks';

const MAX_BASE_PAISE = 99_999_00; // UPI P2P limit is ₹1,00,000 and we add up to 99 paise
// Prisma's defaults (2s to get a connection, 5s to finish) are too tight for a remote database under bursts.
const TXN_OPTIONS = { maxWait: 15_000, timeout: 15_000 };
const ago = (ms: number, from = Date.now()) => new Date(from - ms);

export type OrderWithTxn = Order & { txn: Pick<BankTxn, 'utr' | 'payerVpa'> | null };
export type OrderState = 'pending' | 'paid' | 'cancelled' | 'expired';
const withTxn = { txn: { select: { utr: true, payerVpa: true } } } as const;

export function orderState(order: Order, now = Date.now()): OrderState {
  if (order.status !== 'pending') return order.status;
  if (now <= order.expiresAt.getTime() + config().graceMs) return 'pending';
  if (order.claimedUtr && now <= order.createdAt.getTime() + config().claimWindowMs) return 'pending';
  return 'expired';
}

/** Where-clause for a computed state, so list filters agree with orderState(). */
function stateFilter(state: OrderState, now = Date.now()): Prisma.OrderWhereInput {
  const open: Prisma.OrderWhereInput = {
    status: 'pending',
    OR: [
      { expiresAt: { gte: ago(config().graceMs, now) } },
      { claimedUtr: { not: null }, createdAt: { gte: ago(config().claimWindowMs, now) } },
    ],
  };
  if (state === 'pending') return open;
  if (state === 'expired') return { status: 'pending', NOT: open };
  return { status: state };
}

// ---- Creating orders ----

export interface CreateOrderInput {
  amount: string;
  note?: string | null;
  redirectUrl?: string | null;
  metadata?: Record<string, string> | null;
  idempotencyKey?: string | null;
}

// Two people paying ₹99 at the same time are told to pay ₹99.01 and ₹99.02, so the amount in the
// bank's alert email says exactly whose payment it was. The exact base amount is never handed out,
// which means someone who rounds to ₹99.00 can't accidentally settle another person's order.
async function allocateAmount(tx: Prisma.TransactionClient, merchantId: string, basePaise: number, now: number) {
  const open = await tx.order.findMany({
    where: {
      merchantId,
      status: 'pending',
      amountPaise: { gte: basePaise + 1, lte: basePaise + 99 },
      expiresAt: { gte: ago(config().graceMs, now) },
    },
    select: { amountPaise: true },
  });
  const used = new Set(open.map((o) => o.amountPaise));
  for (let offset = 1; offset <= 99; offset++) {
    if (!used.has(basePaise + offset)) return basePaise + offset;
  }
  return null;
}

export async function createOrder(merchant: Merchant, input: CreateOrderInput): Promise<OrderWithTxn> {
  if (!merchant.vpa) throw new ApiError(409, 'merchant_not_configured', 'Set your UPI ID before creating orders');
  if (!merchant.gmailRefreshToken) {
    throw new ApiError(409, 'gmail_not_connected', 'Gmail is not connected, so payments could not be verified. Sign in again.');
  }

  const basePaise = rupeesToPaise(input.amount);
  if (!basePaise || basePaise < 100 || basePaise > MAX_BASE_PAISE) {
    throw badRequest('amount must be between 1 and 99999 rupees with at most 2 decimals');
  }

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(merchant.id, input.idempotencyKey);
    if (existing) return assertSameRequest(existing, basePaise);
  }

  const now = Date.now();
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialise allocation per merchant so two simultaneous requests can't be handed the same amount.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${merchant.id}))::text`;
      const amountPaise = await allocateAmount(tx, merchant.id, basePaise, now);
      if (!amountPaise) {
        throw new ApiError(429, 'rate_limited', 'Too many open orders for this amount, try again in a few minutes', undefined, {
          'Retry-After': '60',
        });
      }
      return tx.order.create({
        data: {
          id: randomId('ord'),
          merchantId: merchant.id,
          basePaise,
          amountPaise,
          note: input.note ?? null,
          redirectUrl: input.redirectUrl ?? null,
          metadata: input.metadata ?? undefined,
          idempotencyKey: input.idempotencyKey ?? null,
          createdAt: new Date(now),
          expiresAt: new Date(now + config().orderTtlMs),
        },
        include: withTxn,
      });
    }, TXN_OPTIONS);
  } catch (err) {
    // A concurrent request with the same Idempotency-Key won the race.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await findByIdempotencyKey(merchant.id, input.idempotencyKey);
      if (existing) return assertSameRequest(existing, basePaise);
    }
    throw err;
  }
}

const findByIdempotencyKey = (merchantId: string, idempotencyKey: string) =>
  prisma.order.findUnique({ where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } }, include: withTxn });

function assertSameRequest(existing: OrderWithTxn, basePaise: number) {
  if (existing.basePaise !== basePaise) throw conflict('Idempotency-Key was already used with a different amount');
  return existing;
}

// ---- Reading orders ----

export const getOrder = (id: string) => prisma.order.findUnique({ where: { id }, include: withTxn });

export async function getMerchantOrder(merchantId: string, id: string) {
  const order = await prisma.order.findFirst({ where: { id, merchantId }, include: withTxn });
  if (!order) throw notFound('Order not found');
  return order;
}

export async function listOrders(merchantId: string, opts: { limit: number; cursor?: string; state?: OrderState }) {
  const rows = await prisma.order.findMany({
    where: { merchantId, ...(opts.state && stateFilter(opts.state)) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: opts.limit + 1,
    ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
    include: withTxn,
  });
  const page = rows.slice(0, opts.limit);
  return { data: page, nextCursor: rows.length > opts.limit ? page.at(-1)?.id ?? null : null };
}

export async function cancelOrder(merchantId: string, id: string) {
  const order = await getMerchantOrder(merchantId, id);
  if (order.status === 'cancelled') return order;
  const updated = await prisma.order.updateMany({
    where: { id, merchantId, status: 'pending' },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
  if (!updated.count) throw conflict('Only pending orders can be cancelled');
  return getMerchantOrder(merchantId, id);
}

// ---- Matching bank credits to orders ----

export interface BankCredit {
  gmailMessageId: string;
  amountPaise: number;
  utr: string | null;
  payerVpa: string | null;
  bankDomain: string;
  receivedAt: Date;
}

/** Called once per verified bank credit email. Returns the order it paid, if any. */
export async function recordBankCredit(merchantId: string, credit: BankCredit) {
  let txn: BankTxn;
  try {
    txn = await prisma.bankTxn.create({ data: { merchantId, ...credit } });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already processed, or a duplicate alert for the same UTR
    throw err;
  }
  return matchTxn(txn);
}

async function matchTxn(txn: BankTxn) {
  if (txn.orderId) return null;
  const t = txn.receivedAt.getTime();
  const { clockSkewMs, graceMs, claimWindowMs } = config();

  // 1. The unique amount, received while that order was open. This always wins, so knowing
  //    someone else's UTR doesn't let you steal a payment that already identifies its order.
  let order = await prisma.order.findFirst({
    where: {
      merchantId: txn.merchantId,
      status: 'pending',
      amountPaise: txn.amountPaise,
      createdAt: { lte: new Date(t + clockSkewMs) },
      expiresAt: { gte: ago(graceMs, t) },
    },
    orderBy: { createdAt: 'asc' },
  });

  // 2. The payer submitted this UTR, e.g. because their app rounded ₹99.07 to ₹99.
  if (!order && txn.utr) {
    order = await prisma.order.findFirst({
      where: {
        merchantId: txn.merchantId,
        status: 'pending',
        claimedUtr: txn.utr,
        OR: [{ amountPaise: txn.amountPaise }, { basePaise: txn.amountPaise }],
        createdAt: { lte: new Date(t + clockSkewMs), gte: ago(claimWindowMs, t) },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  return order ? markPaid(order.id, txn.id) : null;
}

class AlreadySettled extends Error {}

async function markPaid(orderId: string, txnId: string) {
  let webhookId: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      // The order row is updated first so a concurrent match for the same order waits here and then sees it paid.
      const order = await tx.order.updateMany({
        where: { id: orderId, status: 'pending' },
        data: { status: 'paid', paidAt: new Date() },
      });
      if (!order.count) throw new AlreadySettled();
      const txn = await tx.bankTxn.updateMany({ where: { id: txnId, orderId: null }, data: { orderId } });
      if (!txn.count) throw new AlreadySettled();

      const paid = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { ...withTxn, merchant: true } });
      webhookId = await enqueueWebhook(tx, paid.merchant, 'order.paid', { order: merchantOrderView(paid) }, orderId);
    }, TXN_OPTIONS);
  } catch (err) {
    if (err instanceof AlreadySettled || isUniqueViolation(err)) return null;
    throw err;
  }
  scheduleDelivery([webhookId]);
  return getOrder(orderId);
}

export async function claimUtr(orderId: string, utr: string) {
  const order = await getOrder(orderId);
  if (!order) throw notFound('Order not found');
  const state = orderState(order);
  if (state === 'paid') return order;
  if (state !== 'pending') throw new ApiError(410, 'gone', `This order is ${state}`);

  await prisma.order.updateMany({ where: { id: orderId, status: 'pending' }, data: { claimedUtr: utr } });
  // The bank email may already be here (it just didn't match by amount), or it will arrive on a later poll.
  const txn = await prisma.bankTxn.findFirst({ where: { merchantId: order.merchantId, utr, orderId: null } });
  if (txn) await matchTxn(txn);
  return (await getOrder(orderId))!;
}

// ---- API representations ----

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Full order, for the merchant (API key or dashboard session). */
export function merchantOrderView(order: OrderWithTxn) {
  return {
    id: order.id,
    object: 'order',
    status: orderState(order),
    amount: formatRupees(order.amountPaise),
    amount_paise: order.amountPaise,
    base_amount: formatRupees(order.basePaise),
    base_amount_paise: order.basePaise,
    currency: 'INR',
    note: order.note,
    metadata: order.metadata ?? {},
    redirect_url: order.redirectUrl,
    checkout_url: `${config().frontendUrl}/pay/${order.id}`,
    utr: order.txn?.utr ?? null,
    payer_vpa: order.txn?.payerVpa ?? null,
    claimed_utr: order.claimedUtr,
    created_at: iso(order.createdAt),
    expires_at: iso(order.expiresAt),
    paid_at: iso(order.paidAt),
    cancelled_at: iso(order.cancelledAt),
  };
}

/** What the payer's checkout page needs. No merchant-private fields. */
export function publicOrderView(order: OrderWithTxn, merchant: Pick<Merchant, 'vpa' | 'displayName' | 'email'>) {
  return {
    id: order.id,
    object: 'checkout',
    status: orderState(order),
    amount: formatRupees(order.amountPaise),
    amount_paise: order.amountPaise,
    currency: 'INR',
    note: order.note,
    payee: { name: payeeName(merchant), vpa: merchant.vpa },
    upi_link: merchant.vpa ? upiLink(merchant, order) : null,
    qr_url: `${config().apiBaseUrl}/api/public/orders/${order.id}/qr`,
    redirect_url: order.redirectUrl,
    utr: order.txn?.utr ?? null,
    utr_submitted: Boolean(order.claimedUtr),
    expires_at: iso(order.expiresAt),
    paid_at: iso(order.paidAt),
  };
}

const payeeName = (merchant: Pick<Merchant, 'displayName' | 'email'>) =>
  merchant.displayName || merchant.email.split('@')[0] || 'Merchant';

export function upiLink(merchant: Pick<Merchant, 'vpa' | 'displayName' | 'email'>, order: Order): string {
  const params = {
    pa: merchant.vpa ?? '',
    pn: payeeName(merchant),
    am: formatRupees(order.amountPaise),
    cu: 'INR',
    tn: order.note || `Order ${order.id.slice(-6)}`,
  };
  return `upi://pay?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%40/g, '@')}`)
    .join('&')}`;
}
