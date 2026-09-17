import { config } from './config.js';
import { hmacHex, randomId } from './crypto.js';
import { isUniqueViolation, prisma } from './db.js';
import { rupeesToPaise } from './parser.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BASE_PAISE = 99_999_00; // UPI P2P limit is ₹1,00,000 and we add up to 99 paise
const withTxn = { txn: { select: { utr: true, payerVpa: true } } };
const ago = (ms, from = Date.now()) => new Date(from - ms);
// Prisma's defaults (2s to get a connection, 5s to finish) are too tight for a remote database under bursts.
const TXN_OPTIONS = { maxWait: 15_000, timeout: 15_000 };

export const formatRupees = (paise) => (paise / 100).toFixed(2);

// Two people paying ₹99 at the same time are told to pay ₹99.01 and ₹99.02, so the amount in the
// bank's alert email says exactly whose payment it was. The exact base amount is never handed out,
// which means someone who rounds to ₹99.00 can't accidentally settle another person's order.
async function allocateAmount(tx, merchantId, basePaise, now) {
  const open = await tx.order.findMany({
    where: {
      merchantId,
      status: 'pending',
      amountPaise: { gte: basePaise + 1, lte: basePaise + 99 },
      expiresAt: { gte: ago(config.graceMs, now) },
    },
    select: { amountPaise: true },
  });
  const used = new Set(open.map((o) => o.amountPaise));
  for (let offset = 1; offset <= 99; offset++) {
    if (!used.has(basePaise + offset)) return basePaise + offset;
  }
  return null;
}

export async function createOrder(merchant, { amount, note, redirect_url: redirectUrl } = {}) {
  if (!merchant.vpa) throw new HttpError(400, 'Set your UPI ID on the dashboard before creating orders');

  const basePaise = rupeesToPaise(amount ?? '');
  if (!basePaise || basePaise < 100 || basePaise > MAX_BASE_PAISE) {
    throw new HttpError(400, 'amount must be between 1 and 99999 rupees with at most 2 decimals');
  }
  if (redirectUrl && !/^https?:\/\//i.test(redirectUrl)) throw new HttpError(400, 'redirect_url must be an http(s) URL');

  const now = Date.now();
  return prisma.$transaction(async (tx) => {
    // Serialise allocation per merchant so two simultaneous requests can't be handed the same amount.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${merchant.id}))::text`;
    const amountPaise = await allocateAmount(tx, merchant.id, basePaise, now);
    if (!amountPaise) throw new HttpError(429, 'Too many pending orders for this amount, try again in a few minutes');
    return tx.order.create({
      data: {
        id: randomId('ord'),
        merchantId: merchant.id,
        basePaise,
        amountPaise,
        note: note ? String(note).slice(0, 50) : null,
        redirectUrl: redirectUrl ?? null,
        createdAt: new Date(now),
        expiresAt: new Date(now + config.orderTtlMs),
      },
      include: withTxn,
    });
  }, TXN_OPTIONS);
}

export const getOrder = (id) => prisma.order.findUnique({ where: { id }, include: withTxn });

export const listOrders = (merchantId, take = 50) =>
  prisma.order.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take, include: withTxn });

export function orderStatus(order, now = Date.now()) {
  if (order.status === 'paid') return 'paid';
  if (now <= order.expiresAt.getTime() + config.graceMs) return 'pending';
  if (order.claimedUtr && now <= order.createdAt.getTime() + config.claimWindowMs) return 'pending';
  return 'expired';
}

export const publicOrder = (order) => ({
  id: order.id,
  status: orderStatus(order),
  amount: formatRupees(order.amountPaise),
  base_amount: formatRupees(order.basePaise),
  note: order.note,
  utr: order.txn?.utr ?? null,
  redirect_url: order.redirectUrl,
  pay_url: `${config.baseUrl}/pay/${order.id}`,
  created_at: order.createdAt.toISOString(),
  expires_at: order.expiresAt.toISOString(),
  paid_at: order.paidAt?.toISOString() ?? null,
});

export function upiLink(merchant, order) {
  const params = {
    pa: merchant.vpa,
    pn: merchant.displayName || merchant.email.split('@')[0],
    am: formatRupees(order.amountPaise),
    cu: 'INR',
    tn: order.note || `Order ${order.id.slice(-6)}`,
  };
  return 'upi://pay?' + Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%40/g, '@')}`).join('&');
}

// Called once per verified bank credit email. Returns the order it paid, if any.
export async function recordBankTxn(merchantId, { gmailMessageId, amountPaise, utr, payerVpa, bankDomain, receivedAt }) {
  let txn;
  try {
    txn = await prisma.bankTxn.create({
      data: { merchantId, gmailMessageId, amountPaise, utr, payerVpa, bankDomain, receivedAt: new Date(receivedAt) },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already processed, or a duplicate alert for the same UTR
    throw err;
  }
  return matchTxn(txn);
}

async function matchTxn(txn) {
  if (txn.orderId) return null;
  const t = txn.receivedAt.getTime();

  // 1. The unique amount, received while that order was open. This always wins, so knowing
  //    someone else's UTR doesn't let you steal a payment that already identifies its order.
  let order = await prisma.order.findFirst({
    where: {
      merchantId: txn.merchantId,
      status: 'pending',
      amountPaise: txn.amountPaise,
      createdAt: { lte: new Date(t + config.clockSkewMs) },
      expiresAt: { gte: ago(config.graceMs, t) },
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
        createdAt: { lte: new Date(t + config.clockSkewMs), gte: ago(config.claimWindowMs, t) },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  return order ? markPaid(order.id, txn.id) : null;
}

class AlreadySettled extends Error {}

async function markPaid(orderId, txnId) {
  try {
    await prisma.$transaction(async (tx) => {
      // The order row is updated first so a concurrent match for the same order waits here and then sees it paid.
      const order = await tx.order.updateMany({ where: { id: orderId, status: 'pending' }, data: { status: 'paid', paidAt: new Date() } });
      if (!order.count) throw new AlreadySettled();
      const txn = await tx.bankTxn.updateMany({ where: { id: txnId, orderId: null }, data: { orderId } });
      if (!txn.count) throw new AlreadySettled();
    }, TXN_OPTIONS);
  } catch (err) {
    if (err instanceof AlreadySettled || isUniqueViolation(err)) return null;
    throw err;
  }
  const order = await getOrder(orderId);
  void notifyMerchant(order);
  return order;
}

export async function claimUtr(orderId, utr) {
  if (!/^\d{12}$/.test(utr)) throw new HttpError(400, 'The UPI reference / UTR number must be 12 digits');
  const order = await getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === 'paid') return order;
  if (orderStatus(order) === 'expired') throw new HttpError(410, 'This order has expired');

  await prisma.order.updateMany({ where: { id: orderId, status: 'pending' }, data: { claimedUtr: utr } });
  // The bank email may already be here (it just didn't match by amount), or it will arrive on a later poll.
  const txn = await prisma.bankTxn.findFirst({ where: { merchantId: order.merchantId, utr, orderId: null } });
  if (txn) await matchTxn(txn);
  return getOrder(orderId);
}

async function notifyMerchant(order) {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: order.merchantId },
      select: { webhookUrl: true, webhookSecret: true },
    });
    if (!merchant?.webhookUrl) return;
    const body = JSON.stringify({ event: 'order.paid', data: publicOrder(order) });
    const res = await fetch(merchant.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': `sha256=${hmacHex(merchant.webhookSecret, body)}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`Webhook for ${order.id} got HTTP ${res.status}`);
  } catch (err) {
    console.warn(`Webhook for ${order.id} failed: ${err.message}`);
  }
}
