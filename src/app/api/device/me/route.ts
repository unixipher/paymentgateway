import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { authenticateDevice, deviceView, forwardingRules } from '@/lib/devices';
import { handler, json, noContent } from '@/lib/http';

/** The app's heartbeat: confirms it is still paired and fetches which senders to forward. */
export const GET = handler(async (req: NextRequest) => {
  const device = await authenticateDevice(req);
  return json({
    device: deviceView(device),
    merchant: { email: device.merchant.email, display_name: device.merchant.displayName },
    rules: forwardingRules(),
  });
});

/** Unpairs this phone (the app's "Sign out"). */
export const DELETE = handler(async (req: NextRequest) => {
  const device = await authenticateDevice(req);
  await prisma.device.deleteMany({ where: { id: device.id } });
  return noContent();
});
