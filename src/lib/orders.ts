import type { BankTxn, Channel, Merchant, Order } from '@/generated/prisma/client';
import { randomId } from './crypto';
import { isUniqueViolation, prisma, type Prisma } from './db';
import { config } from './env';
import { ApiError, badRequest, conflict, notFound } from './errors';
import { logger } from './logger';
import { vpaSchema } from './merchants';
import { formatRupees, rupeesToPaise } from './money';
import { nameMatchesAlert, namesConflict } from './names';
import { enqueueWebhook, scheduleDelivery } from './webhooks';

const MAX_BASE_PAISE = 99_999_00; // UPI P2P limit is ₹1,00,000 and we add up to 99 paise
// Prisma's defaults (2s to get a connection, 5s to finish) are too tight for a remote database under bursts.
const TXN_OPTIONS = { maxWait: 15_000, timeout: 15_000 };
const ago = (ms: number, from = Date.now()) => new Date(from - ms);

export type OrderWithTxn = Order & { txn: Pick<BankTxn, 'utr' | 'payerVpa' | 'payerName'> | null };
export type OrderState = 'pending' | 'paid' | 'failed' | 'cancelled';
const withTxn = { txn: { select: { utr: true, payerVpa: true, payerName: true } } } as const;

/**
 * `failed` means no payment arrived in time: the payment window plus a short "checking with your bank"
 * period. It isn't stored, and it isn't quite final: a bank email that arrives within the grace period
 * still marks the order paid (and sends order.paid). An order whose payer submitted a UTR stays
 * pending while that UTR can still be matched.
 */
export function orderState(order: Order, now = Date.now()): OrderState {
  if (order.status !== 'pending') return order.status;
  if (now <= order.expiresAt.getTime() + config().verifyingMs) return 'pending';
  if (order.claimedUtr && now <= order.createdAt.getTime() + config().claimWindowMs) return 'pending';
  return 'failed';
}

/** Where-clause for a computed state, so list filters agree with orderState(). */
function stateFilter(state: OrderState, now = Date.now()): Prisma.OrderWhereInput {
  const open: Prisma.OrderWhereInput = {
    status: 'pending',
    OR: [
      { expiresAt: { gte: ago(config().verifyingMs, now) } },
      { claimedUtr: { not: null }, createdAt: { gte: ago(config().claimWindowMs, now) } },
    ],
  };
  if (state === 'pending') return open;
  if (state === 'failed') return { status: 'pending', NOT: open };
  return { status: state };
}

// ---- Creating orders ----

export interface CreateOrderInput {
  amount: string;
  note?: string | null;
  redirectUrl?: string | null;
  metadata?: Record<string, string> | null;
  idempotencyKey?: string | null;
  /** Name on the bank account the payer will pay from. Optional; see allocateAmount. */
  payerName?: string | null;
}

// Two people paying ₹99 at the same time are told to pay ₹99.01 and ₹99.02, so the amount in the
// bank's alert email says exactly whose payment it was. The exact base amount is never handed out,
// which means someone who rounds to ₹99.00 can't accidentally settle another person's order.
//
// Once all 99 are taken, payers who gave their name can share an amount with payers whose names are
// clearly different ("Amal" and "Dilip" can both pay ₹99.07, two "Amal"s never), because the bank
// alert says who sent the money. Payers without a name never share.
async function allocateAmount(
  tx: Prisma.TransactionClient,
  merchantId: string,
  basePaise: number,
  now: number,
  payerName: string | null,
) {
  const open = await tx.order.findMany({
    where: {
      merchantId,
      status: 'pending',
      amountPaise: { gte: basePaise + 1, lte: basePaise + 99 },
      expiresAt: { gte: ago(config().graceMs, now) },
    },
    select: { amountPaise: true, payerName: true },
  });
  const byAmount = new Map<number, (string | null)[]>();
  for (const o of open) byAmount.set(o.amountPaise, [...(byAmount.get(o.amountPaise) ?? []), o.payerName]);

  for (let offset = 1; offset <= 99; offset++) {
    if (!byAmount.has(basePaise + offset)) return basePaise + offset;
  }
  if (!payerName) return null;
  for (let offset = 1; offset <= 99; offset++) {
    const names = byAmount.get(basePaise + offset)!;
    if (names.every((name) => name && !namesConflict(name, payerName))) return basePaise + offset;
  }
  return null;
}

export async function createOrder(merchant: Merchant, input: CreateOrderInput): Promise<OrderWithTxn> {
  if (!merchant.vpa) throw new ApiError(409, 'merchant_not_configured', 'Set your UPI ID before creating orders');
  // e.g. a bank account saved as account@IFSC.ifsc.npci while that was allowed; UPI apps decline it.
  if (!vpaSchema.safeParse(merchant.vpa).success) {
    throw new ApiError(409, 'merchant_not_configured', 'Your payee address is not a UPI ID. Set a UPI ID like name@okhdfcbank in Settings.');
  }
  if (!merchant.gmailRefreshToken && !(await prisma.device.count({ where: { merchantId: merchant.id } }))) {
    throw new ApiError(409, 'gmail_not_connected', 'Connect Gmail or pair a phone, so payments can be verified.');
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
      const amountPaise = await allocateAmount(tx, merchant.id, basePaise, now, input.payerName ?? null);
      if (!amountPaise) {
        const hint = input.payerName ? '' : ' Passing payer_name lets more payers share an amount.';
        throw new ApiError(429, 'rate_limited', `Too many open orders for this amount, try again in a few minutes.${hint}`, undefined, {
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
          payerName: input.payerName ?? null,
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
  channel?: Channel;
  messageId: string;
  amountPaise: number;
  utr: string | null;
  payerVpa: string | null;
  /** The sender's name as the bank printed it, if the alert says. */
  payerName?: string | null;
  bankDomain: string;
  receivedAt: Date;
}

/** How far apart an email and an SMS for the same payment can arrive. */
const SAME_PAYMENT_WINDOW_MS = 15 * 60_000;

/** Called once per verified bank credit alert. Returns the order it paid, if any. */
export async function recordBankCredit(merchantId: string, credit: BankCredit) {
  const channel = credit.channel ?? 'email';
  let txn: BankTxn | null;
  try {
    txn = await prisma.$transaction(async (tx) => {
      // One payment is often reported twice: by the bank's email and by its SMS. With the same UTR the
      // unique index catches it. When one of them has no UTR, the same amount from the other channel
      // within a few minutes is the same payment. The lock stops both being recorded at the same moment.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:${merchantId}`}))::text`;
      const t = credit.receivedAt.getTime();
      const nearby = await tx.bankTxn.findMany({
        where: {
          merchantId,
          channel: { not: channel },
          amountPaise: credit.amountPaise,
          receivedAt: { gte: new Date(t - SAME_PAYMENT_WINDOW_MS), lte: new Date(t + SAME_PAYMENT_WINDOW_MS) },
          ...(credit.utr && { utr: null }),
        },
        orderBy: { receivedAt: 'asc' },
      });
      // Payers with different names can share an amount, so two alerts naming clearly different
      // senders are two payments.
      const twin = nearby.find((other) => !(credit.payerName && other.payerName && !namesConflict(credit.payerName, other.payerName)));
      if (twin) {
        if (!credit.utr) {
          // Nothing new to record, unless this alert names the sender and the first didn't.
          return !twin.payerName && credit.payerName
            ? tx.bankTxn.update({ where: { id: twin.id }, data: { payerName: credit.payerName } })
            : null;
        }
        // The twin had no UTR; now it has one, which a payer's UTR claim can match.
        return tx.bankTxn.update({
          where: { id: twin.id },
          data: { utr: credit.utr, payerVpa: twin.payerVpa ?? credit.payerVpa, payerName: twin.payerName ?? credit.payerName ?? null },
        });
      }
      return tx.bankTxn.create({ data: { merchantId, ...credit, channel } });
    }, TXN_OPTIONS);
  } catch (err) {
    // Already processed, or a duplicate alert for the same UTR.
    if (isUniqueViolation(err)) return credit.utr ? fillInDuplicate(merchantId, credit) : null;
    throw err;
  }
  return txn ? matchTxn(txn) : null;
}

/**
 * The same payment reported again (e.g. Kotak's SMS, then its email). The later alert may say who sent
 * the money where the first didn't, which is what decides an amount several payers share. So fill that
 * in and try matching again.
 */
async function fillInDuplicate(merchantId: string, credit: BankCredit) {
  const existing = await prisma.bankTxn.findFirst({ where: { merchantId, utr: credit.utr } });
  if (!existing || existing.orderId) return null;
  const payerName = existing.payerName ?? credit.payerName ?? null;
  const payerVpa = existing.payerVpa ?? credit.payerVpa;
  if (payerName === existing.payerName && payerVpa === existing.payerVpa) return null;
  return matchTxn(await prisma.bankTxn.update({ where: { id: existing.id }, data: { payerName, payerVpa } }));
}

async function matchTxn(txn: BankTxn) {
  if (txn.orderId) return null;
  const t = txn.receivedAt.getTime();
  const { clockSkewMs, graceMs, claimWindowMs } = config();

  // 1. The unique amount, received while that order was open. This always wins, so knowing
  //    someone else's UTR doesn't let you steal a payment that already identifies its order.
  const sameAmount = await prisma.order.findMany({
    where: {
      merchantId: txn.merchantId,
      status: 'pending',
      amountPaise: txn.amountPaise,
      createdAt: { lte: new Date(t + clockSkewMs) },
      expiresAt: { gte: ago(graceMs, t) },
    },
    orderBy: { createdAt: 'asc' },
  });
  let order = pickBySender(sameAmount, txn);

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

/**
 * Normally at most one open order has a given amount. When payers shared it (see allocateAmount), the
 * sender's name in the alert decides, and only if it matches exactly one of them. Otherwise nothing is
 * guessed: the payer can still submit their UTR.
 */
function pickBySender(candidates: Order[], txn: BankTxn): Order | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  if (!candidates.some((o) => o.payerName)) return candidates[0]!;
  const matches = txn.payerName
    ? candidates.filter((o) => o.payerName && nameMatchesAlert(o.payerName, txn.payerName!))
    : [];
  if (matches.length === 1) return matches[0]!;
  logger.warn('shared amount not matched by sender name', {
    txnId: txn.id,
    amountPaise: txn.amountPaise,
    candidates: candidates.length,
    nameMatches: matches.length,
  });
  return null;
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
  const paid = await getOrder(orderId);
  if (paid?.paidAt) {
    logger.info('order paid', { orderId, durationMs: paid.paidAt.getTime() - paid.createdAt.getTime() });
  }
  return paid;
}

export async function claimUtr(orderId: string, utr: string) {
  const order = await getOrder(orderId);
  if (!order) throw notFound('Order not found');
  const state = orderState(order);
  if (state === 'paid') return order;
  // A failed order can still be claimed: the payer may have paid in time with the bank email running late.
  if (state === 'cancelled' || Date.now() > order.createdAt.getTime() + config().claimWindowMs) {
    throw new ApiError(410, 'gone', `This order is ${state}`);
  }
  const failed = await prisma.failedPayment.findUnique({ where: { merchantId_utr: { merchantId: order.merchantId, utr } } });
  if (failed) {
    throw new ApiError(422, 'payment_failed', 'This UPI payment failed, and your bank refunds any money that was debited. Please pay again.');
  }

  await prisma.order.updateMany({ where: { id: orderId, status: 'pending' }, data: { claimedUtr: utr } });
  // The bank alert may already be here (it just didn't match by amount), or it will arrive later.
  const txn = await prisma.bankTxn.findFirst({ where: { merchantId: order.merchantId, utr, orderId: null } });
  if (txn) await matchTxn(txn);
  return (await getOrder(orderId))!;
}

// ---- Failed payments ----

export interface FailedPaymentReport {
  utr: string;
  amountPaise: number | null;
  messageId: string;
  receivedAt: Date;
}

/** Remembers the reference number of a failed or reversed payment so it can't be claimed. */
export async function recordFailedPayment(merchantId: string, failure: FailedPaymentReport) {
  await prisma.failedPayment.createMany({ data: [{ merchantId, ...failure }], skipDuplicates: true });
}

/**
 * Queues one order.failed webhook for each order that ran out of time. Runs from the cron and when a
 * checkout page sees its order fail, so merchants without a cron still hear about it.
 */
export async function notifyFailedOrders(merchantId?: string, limit = 100) {
  const now = Date.now();
  const due = await prisma.order.findMany({
    where: { ...(merchantId && { merchantId }), failureNotifiedAt: null, ...stateFilter('failed', now) },
    orderBy: { expiresAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  const webhookIds: (string | null)[] = [];
  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      // Guarded on the state again so a payment that lands meanwhile, or another worker, wins cleanly.
      const claimed = await tx.order.updateMany({
        where: { id, failureNotifiedAt: null, ...stateFilter('failed', now) },
        data: { failureNotifiedAt: new Date(now) },
      });
      if (!claimed.count) return;
      const order = await tx.order.findUniqueOrThrow({ where: { id }, include: { ...withTxn, merchant: true } });
      webhookIds.push(await enqueueWebhook(tx, order.merchant, 'order.failed', { order: merchantOrderView(order, now) }, id));
    }, TXN_OPTIONS);
  }
  scheduleDelivery(webhookIds);
  return due.length;
}

// ---- API representations ----

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Full order, for the merchant (API key or dashboard session). */
export function merchantOrderView(order: OrderWithTxn, now = Date.now()) {
  const status = orderState(order, now);
  return {
    id: order.id,
    object: 'order',
    status,
    failure_reason: status === 'failed' ? 'payment_not_received' : null,
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
    payer_name: order.payerName,
    /** Who the bank says sent the money. */
    paid_by: order.txn?.payerName ?? null,
    claimed_utr: order.claimedUtr,
    created_at: iso(order.createdAt),
    expires_at: iso(order.expiresAt),
    paid_at: iso(order.paidAt),
    cancelled_at: iso(order.cancelledAt),
  };
}

/** What the payer's checkout page needs. No merchant-private fields. */
export function publicOrderView(order: OrderWithTxn, merchant: Pick<Merchant, 'vpa' | 'displayName' | 'email'>) {
  const status = orderState(order);
  return {
    id: order.id,
    object: 'checkout',
    status,
    failure_reason: status === 'failed' ? 'payment_not_received' : null,
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
    /** The name the payer gave; they should pay from a bank account in this name. */
    payer_name: order.payerName,
    created_at: iso(order.createdAt),
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
