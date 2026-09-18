import type { NextRequest } from 'next/server';
import { authenticateDevice, messagesSchema, processMessages } from '@/lib/devices';
import { handler, json, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';

export const maxDuration = 60;

/** Bank SMS and notifications forwarded by the phone as they arrive. A credit pays its order immediately. */
export const POST = handler(async (req: NextRequest) => {
  const device = await authenticateDevice(req);
  await rateLimit(`device:${device.id}`, 60, 60_000);
  const { messages } = await readJson(req, messagesSchema);
  return json({ data: await processMessages(device, messages) });
});
