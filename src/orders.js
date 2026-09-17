import { config } from './config.js';
import { hmacHex, randomId } from './crypto.js';
import { db } from './db.js';
import { rupeesToPaise } from './parser.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BASE_PAISE = 99_999_00; // UPI P2P limit is ₹1,00,000 and we add up to 99 paise

export const formatRupees = (paise) => (paise / 100).toFixed(2);

// Two people paying ₹99 at the same time are told to pay ₹99.01 and ₹99.02, so the amount in the
// bank's alert email says exactly whose payment it was. The exact base amount is never handed out,
// which means someone who rounds to ₹99.00 can't accidentally settle another person's order.
function allocateAmount(merchantId, basePaise, now) {
  const used = new Set(
    db.prepare(`
      SELECT amount_paise FROM orders
      WHERE merchant_id = ? AND status = 'pending' AND amount_paise BETWEEN ? AND ? AND expires_at + ? >= ?
    `).all(merchantId, basePaise + 1, basePaise + 99, config.graceMs, now).map((r) => r.amount_paise),
  );
  for (let offset = 1; offset <= 99; offset++) {
    if (!used.has(basePaise + offset)) return basePaise + offset;
  }
  return null;
}

export function createOrder(merchant, { amount, note, redirect_url: redirectUrl } = {}) {
  if (!merchant.vpa) throw new HttpError(400, 'Set your UPI ID on the dashboard before creating orders');

  const basePaise = rupeesToPaise(amount ?? '');
  if (!basePaise || basePaise < 100 || basePaise > MAX_BASE_PAISE) {
    throw new HttpError(400, 'amount must be between 1 and 99999 rupees with at most 2 decimals');
  }
  if (redirectUrl && !/^https?:\/\//i.test(redirectUrl)) throw new HttpError(400, 'redirect_url must be an http(s) URL');

  const now = Date.now();
  const amountPaise = allocateAmount(merchant.id, basePaise, now);
  if (!amountPaise) throw new HttpError(429, 'Too many pending orders for this amount, try again in a few minutes');

  const id = randomId('ord');
  db.prepare(`
    INSERT INTO orders (id, merchant_id, base_paise, amount_paise, note, redirect_url, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, merchant.id, basePaise, amountPaise, note ? String(note).slice(0, 50) : null,
    redirectUrl ?? null, now, now + config.orderTtlMs);
  return getOrder(id);
}

export const getOrder = (id) => db.prepare(`
  SELECT o.*, t.utr AS paid_utr, t.payer_vpa
  FROM orders o LEFT JOIN bank_txns t ON t.id = o.txn_id
  WHERE o.id = ?
`).get(id);

export const listOrders = (merchantId, limit = 50) => db.prepare(`
  SELECT o.*, t.utr AS paid_utr, t.payer_vpa
  FROM orders o LEFT JOIN bank_txns t ON t.id = o.txn_id
  WHERE o.merchant_id = ? ORDER BY o.created_at DESC LIMIT ?
`).all(merchantId, limit);

export function orderStatus(order, now = Date.now()) {
  if (order.status === 'paid') return 'paid';
  if (now <= order.expires_at + config.graceMs) return 'pending';
  if (order.claimed_utr && now <= order.created_at + config.claimWindowMs) return 'pending';
  return 'expired';
}

export const publicOrder = (order) => ({
  id: order.id,
  status: orderStatus(order),
  amount: formatRupees(order.amount_paise),
  base_amount: formatRupees(order.base_paise),
  note: order.note,
  utr: order.paid_utr ?? null,
  redirect_url: order.redirect_url,
  pay_url: `${config.baseUrl}/pay/${order.id}`,
  created_at: new Date(order.created_at).toISOString(),
  expires_at: new Date(order.expires_at).toISOString(),
  paid_at: order.paid_at ? new Date(order.paid_at).toISOString() : null,
});

export function upiLink(merchant, order) {
  const params = {
    pa: merchant.vpa,
    pn: merchant.display_name || merchant.email.split('@')[0],
    am: formatRupees(order.amount_paise),
    cu: 'INR',
    tn: order.note || `Order ${order.id.slice(-6)}`,
  };
  return 'upi://pay?' + Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%40/g, '@')}`).join('&');
}

// Called once per verified bank credit email. Returns the order it paid, if any.
export function recordBankTxn(merchantId, { gmailId, amountPaise, utr, payerVpa, bankDomain, receivedAt }) {
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO bank_txns (id, merchant_id, amount_paise, utr, payer_vpa, bank_domain, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gmailId, merchantId, amountPaise, utr, payerVpa, bankDomain, receivedAt);
  if (!inserted.changes) return null; // already processed, or a duplicate alert for the same UTR
  return matchTxn(db.prepare('SELECT * FROM bank_txns WHERE id = ?').get(gmailId));
}

function matchTxn(txn) {
  if (txn.order_id) return null;
  const t = txn.received_at;

  // 1. The unique amount, received while that order was open. This always wins, so knowing
  //    someone else's UTR doesn't let you steal a payment that already identifies its order.
  let order = db.prepare(`
    SELECT * FROM orders
    WHERE merchant_id = ? AND status = 'pending' AND amount_paise = ?
      AND created_at - ? <= ? AND expires_at + ? >= ?
    ORDER BY created_at LIMIT 1
  `).get(txn.merchant_id, txn.amount_paise, config.clockSkewMs, t, config.graceMs, t);

  // 2. The payer submitted this UTR, e.g. because their app rounded ₹99.07 to ₹99.
  if (!order && txn.utr) {
    order = db.prepare(`
      SELECT * FROM orders
      WHERE merchant_id = ? AND status = 'pending' AND claimed_utr = ? AND ? IN (amount_paise, base_paise)
        AND created_at - ? <= ? AND created_at + ? >= ?
      ORDER BY created_at LIMIT 1
    `).get(txn.merchant_id, txn.utr, txn.amount_paise, config.clockSkewMs, t, config.claimWindowMs, t);
  }

  return order ? markPaid(order.id, txn.id) : null;
}

function markPaid(orderId, txnId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const txn = db.prepare('UPDATE bank_txns SET order_id = ? WHERE id = ? AND order_id IS NULL').run(orderId, txnId);
    const order = db.prepare(`UPDATE orders SET status = 'paid', txn_id = ?, paid_at = ? WHERE id = ? AND status = 'pending'`)
      .run(txnId, Date.now(), orderId);
    if (!txn.changes || !order.changes) {
      db.exec('ROLLBACK');
      return null;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const order = getOrder(orderId);
  void notifyMerchant(order);
  return order;
}

export function claimUtr(orderId, utr) {
  if (!/^\d{12}$/.test(utr)) throw new HttpError(400, 'The UPI reference / UTR number must be 12 digits');
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === 'paid') return order;
  if (orderStatus(order) === 'expired') throw new HttpError(410, 'This order has expired');

  db.prepare(`UPDATE orders SET claimed_utr = ? WHERE id = ? AND status = 'pending'`).run(utr, orderId);
  // The bank email may already be here (it just didn't match by amount), or it will arrive on a later poll.
  const txn = db.prepare('SELECT * FROM bank_txns WHERE merchant_id = ? AND utr = ? AND order_id IS NULL')
    .get(order.merchant_id, utr);
  if (txn) matchTxn(txn);
  return getOrder(orderId);
}

async function notifyMerchant(order) {
  const merchant = db.prepare('SELECT webhook_url, webhook_secret FROM merchants WHERE id = ?').get(order.merchant_id);
  if (!merchant?.webhook_url) return;
  const body = JSON.stringify({ event: 'order.paid', data: publicOrder(order) });
  try {
    const res = await fetch(merchant.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': `sha256=${hmacHex(merchant.webhook_secret, body)}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`Webhook for ${order.id} got HTTP ${res.status}`);
  } catch (err) {
    console.warn(`Webhook for ${order.id} failed: ${err.message}`);
  }
}
