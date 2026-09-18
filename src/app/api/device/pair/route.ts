import type { NextRequest } from 'next/server';
import { deviceView, forwardingRules, pairDevice, pairSchema } from '@/lib/devices';
import { clientIp, handler, json, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

/** The Android app exchanges a pairing code from the dashboard for its device token. */
export const POST = handler(async (req: NextRequest) => {
  // Codes are 40 bits and live 10 minutes; this keeps guessing hopeless.
  await rateLimit(`pair:${clientIp(req)}`, 10, 10 * 60_000);
  const body = await readJson(req, pairSchema);
  const { token, device } = await pairDevice(body);
  return json(
    {
      device_token: token,
      device: deviceView(device),
      merchant: { email: device.merchant.email, display_name: device.merchant.displayName },
      rules: forwardingRules(),
    },
    { status: 201 },
  );
});
