// Dashboard numbers, shared by the web dashboard (session) and the phone app (device token).
import type { BankTxn, Order } from '@/generated/prisma/client';
import { prisma } from './db';
import { formatRupees } from './money';

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 3600_000;

/** Start of the day in India containing `now`, for "today" totals. */
const istDayStart = (now: number) => new Date(Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);

/** Today's collections, what's open, and the last 7 days by day (Indian time). */
export async function merchantStats(merchantId: string, now = Date.now()) {
  const today = istDayStart(now);
  const weekStart = new Date(today.getTime() - 6 * DAY_MS);

  const [paidToday, openNow, paidWeek, unpaidWeek, weeklyOrders] = await Promise.all([
    prisma.order.aggregate({
      where: { merchantId, status: 'paid', paidAt: { gte: today } },
      _sum: { amountPaise: true },
      _count: true,
    }),
    prisma.order.count({ where: { merchantId, status: 'pending', expiresAt: { gt: new Date(now) } } }),
    prisma.order.count({ where: { merchantId, status: 'paid', createdAt: { gte: weekStart } } }),
    prisma.order.count({ where: { merchantId, status: 'pending', createdAt: { gte: weekStart }, expiresAt: { lte: new Date(now) } } }),
    prisma.order.findMany({
      where: { merchantId, status: 'paid', paidAt: { gte: weekStart } },
      select: { paidAt: true, amountPaise: true },
    }),
  ]);

  // Success rate: paid ÷ (paid + ran out of time). Open and cancelled orders don't count.
  const byDay = new Map<string, { paise: number; count: number }>();
  for (const order of weeklyOrders) {
    if (!order.paidAt) continue;
    const day = new Date(order.paidAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const current = byDay.get(day) ?? { paise: 0, count: 0 };
    current.paise += order.amountPaise;
    current.count += 1;
    byDay.set(day, current);
  }

  return {
    today: {
      collected: formatRupees(paidToday._sum.amountPaise ?? 0),
      collected_paise: paidToday._sum.amountPaise ?? 0,
      payments: paidToday._count,
    },
    open_orders: openNow,
    success_rate_7d: paidWeek + unpaidWeek ? paidWeek / (paidWeek + unpaidWeek) : null,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = new Date(weekStart.getTime() + IST_OFFSET_MS + i * DAY_MS).toISOString().slice(0, 10);
      const row = byDay.get(date);
      return { date, collected: formatRupees(row?.paise ?? 0), collected_paise: row?.paise ?? 0, payments: row?.count ?? 0 };
    }),
  };
}

/** Everything the merchant's bank has reported received today (India time), whether or not it paid an order. */
export async function receivedToday(merchantId: string, now = Date.now()) {
  const received = await prisma.bankTxn.aggregate({
    where: { merchantId, receivedAt: { gte: istDayStart(now) } },
    _sum: { amountPaise: true },
    _count: true,
  });
  const paise = received._sum.amountPaise ?? 0;
  return { received: formatRupees(paise), received_paise: paise, credits: received._count };
}

/** Latest bank credits, newest first: what a soundbox announces and the app's payment list shows. */
export async function recentCredits(merchantId: string, limit: number) {
  const txns = await prisma.bankTxn.findMany({
    where: { merchantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: { order: { select: { id: true, note: true, payerName: true } } },
  });
  return txns.map(creditView);
}

function creditView(txn: BankTxn & { order: Pick<Order, 'id' | 'note' | 'payerName'> | null }) {
  return {
    id: txn.id,
    object: 'credit',
    amount: formatRupees(txn.amountPaise),
    amount_paise: txn.amountPaise,
    /** Who the bank says sent it, else the name the payer gave at checkout. */
    payer_name: txn.payerName ?? txn.order?.payerName ?? null,
    payer_vpa: txn.payerVpa,
    utr: txn.utr,
    /** How the bank reported it: `email`, or an `sms`/`notification` forwarded by a phone. */
    channel: txn.channel,
    /** When the bank's alert arrived. */
    received_at: txn.receivedAt.toISOString(),
    /** When the server recorded it. Apps announce only recent credits they haven't announced yet. */
    created_at: txn.createdAt.toISOString(),
    order_id: txn.order?.id ?? null,
    order_note: txn.order?.note ?? null,
  };
}
