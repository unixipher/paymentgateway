import type { NextRequest } from 'next/server';
import { authenticateDevice } from '@/lib/devices';
import { handler, json } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { merchantStats, receivedToday, recentCredits } from '@/lib/stats';

/**
 * The app's home screen and soundbox: the merchant's stats plus the latest bank credits. Polled every
 * few seconds while the app is open, and by the always-on service to announce new payments.
 */
export const GET = handler(async (req: NextRequest) => {
  const device = await authenticateDevice(req);
  await rateLimit(`device-dashboard:${device.id}`, 60, 60_000);
  const [stats, received, credits] = await Promise.all([
    merchantStats(device.merchantId),
    receivedToday(device.merchantId),
    recentCredits(device.merchantId, 30),
  ]);
  return json({
    merchant: { email: device.merchant.email, display_name: device.merchant.displayName },
    ...stats,
    today: { ...stats.today, ...received },
    credits,
  });
});
