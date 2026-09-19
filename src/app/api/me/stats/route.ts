import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth';
import { Prisma, dbSchema, prisma } from '@/lib/db';
import { handler, json } from '@/lib/http';
import { formatRupees } from '@/lib/money';

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 3600_000;

/** Start of the day in India containing `now`, for "today" totals. */
const istDayStart = (now: number) => new Date(Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);

/** Dashboard summary: today's collections, what's open, and the last 7 days by day (Indian time). */
export const GET = handler(async (req: NextRequest) => {
  const { merchant } = await authenticate(req, ['session']);
  const now = Date.now();
  const today = istDayStart(now);
  const weekStart = new Date(today.getTime() - 6 * DAY_MS);

  const [paidToday, openNow, paidWeek, unpaidWeek, days] = await Promise.all([
    prisma.order.aggregate({
      where: { merchantId: merchant.id, status: 'paid', paidAt: { gte: today } },
      _sum: { amountPaise: true },
      _count: true,
    }),
    prisma.order.count({ where: { merchantId: merchant.id, status: 'pending', expiresAt: { gt: new Date(now) } } }),
    prisma.order.count({ where: { merchantId: merchant.id, status: 'paid', createdAt: { gte: weekStart } } }),
    prisma.order.count({ where: { merchantId: merchant.id, status: 'pending', createdAt: { gte: weekStart }, expiresAt: { lte: new Date(now) } } }),
    prisma.$queryRaw<{ day: string; paise: bigint; count: bigint }[]>`
      SELECT to_char(paid_at + interval '330 minutes', 'YYYY-MM-DD') AS day, SUM(amount_paise) AS paise, COUNT(*) AS count
      FROM ${Prisma.raw(`"${dbSchema()}".orders`)}
      WHERE merchant_id = ${merchant.id} AND status = 'paid' AND paid_at >= ${weekStart}
      GROUP BY 1`,
  ]);

  // Success rate: paid ÷ (paid + ran out of time). Open and cancelled orders don't count.
  const byDay = new Map(days.map((row) => [row.day, row]));

  return json({
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
      return { date, collected: formatRupees(Number(row?.paise ?? 0)), collected_paise: Number(row?.paise ?? 0), payments: Number(row?.count ?? 0) };
    }),
  });
});
