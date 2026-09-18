// Phones running the Android app: pairing, their tokens, and the bank SMS/notifications they forward.
import { randomInt } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import type { Device, DeviceMessage, Merchant } from '@/generated/prisma/client';
import { DEVICE_TOKEN_PREFIX, bearerToken } from './auth';
import { randomId, randomToken, sha256Hex } from './crypto';
import { prisma } from './db';
import { config } from './env';
import { unauthorized } from './errors';
import { formatRupees } from './money';
import { recordBankCredit, recordFailedPayment } from './orders';
import { parseCreditAlert, parseFailedPayment, verifyNotificationApp, verifySmsSender } from './parser';

// ---- Pairing ----

// No 0/O, 1/I/L: the code is read off a screen and typed on a phone.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A single-use code, e.g. `K7QM-2WXR`, that the app exchanges for a device token. Replaces any earlier code. */
export async function createPairingCode(merchantId: string) {
  const raw = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('');
  const expiresAt = new Date(Date.now() + config().pairingCodeTtlMs);
  await prisma.$transaction([
    prisma.devicePairingCode.deleteMany({ where: { merchantId } }),
    prisma.devicePairingCode.create({ data: { codeHash: sha256Hex(raw), merchantId, expiresAt } }),
  ]);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

export const pairSchema = z
  .object({
    code: z.string().trim().min(8).max(20),
    name: z.string().trim().min(1).max(60),
    platform: z.enum(['android']).default('android'),
    app_version: z.string().trim().max(30).nullable().optional(),
  })
  .strict();

/** Redeems a pairing code. The device token is returned only here; just its hash is stored. */
export async function pairDevice(input: z.infer<typeof pairSchema>) {
  const redeemed = await prisma.devicePairingCode
    .delete({ where: { codeHash: sha256Hex(normalizeCode(input.code)) } })
    .catch(() => null);
  if (!redeemed || redeemed.expiresAt.getTime() < Date.now()) {
    throw unauthorized('Pairing code is invalid or expired. Create a new one in the dashboard.');
  }
  const token = randomToken(DEVICE_TOKEN_PREFIX);
  const device = await prisma.device.create({
    data: {
      id: randomId('dev'),
      merchantId: redeemed.merchantId,
      name: input.name,
      platform: input.platform,
      appVersion: input.app_version ?? null,
      tokenHash: sha256Hex(token),
      lastSeenAt: new Date(),
    },
    include: { merchant: true },
  });
  return { token, device };
}

/** Resolves the phone behind `Authorization: Bearer pgd_…`, or throws 401 (e.g. after it was removed). */
export async function authenticateDevice(req: NextRequest): Promise<Device & { merchant: Merchant }> {
  const token = bearerToken(req);
  if (!token?.startsWith(`${DEVICE_TOKEN_PREFIX}_`)) throw unauthorized('This endpoint requires a device token');
  const device = await prisma.device.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { merchant: true } });
  if (!device?.merchant) throw unauthorized('This phone was removed from the account. Pair it again.');

  const appVersion = req.headers.get('x-app-version')?.slice(0, 30) ?? device.appVersion;
  // Only write occasionally, not on every request.
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000 || appVersion !== device.appVersion) {
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), appVersion } });
  }
  return device;
}

// ---- Messages ----

export const messagesSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            /** The app's own id for the message, stable across retries. */
            id: z.string().trim().min(1).max(100),
            channel: z.enum(['sms', 'notification']),
            /** SMS sender (e.g. VM-HDFCBK-S) or the app package that posted the notification. */
            sender: z.string().trim().min(1).max(100),
            title: z.string().max(500).nullable().optional(),
            body: z.string().min(1).max(4000),
            /** When the bank sent it (SMS centre timestamp) or the notification was posted. */
            received_at: z.iso.datetime({ offset: true }),
            /** When the phone got it, to tell the carrier's delay from the phone's. */
            delivered_at: z.iso.datetime({ offset: true }).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

type IncomingMessage = z.infer<typeof messagesSchema>['messages'][number];

export interface MessageResult {
  id: string;
  status: 'credit' | 'failed_payment' | 'ignored';
  verdict: string;
  order_id: string | null;
}

const statusOf = (verdict: string): MessageResult['status'] =>
  verdict.startsWith('credit') ? 'credit' : verdict.startsWith('failed payment') ? 'failed_payment' : 'ignored';

async function processMessage(device: Device, msg: IncomingMessage): Promise<MessageResult> {
  const id = `${device.id}:${msg.id}`;
  const previous = await prisma.deviceMessage.findUnique({ where: { id } });
  if (previous) return { id: msg.id, status: statusOf(previous.verdict), verdict: previous.verdict, order_id: null };

  // The phone's clock decides when the payment happened, but it can't claim a time in the future.
  const receivedAt = new Date(Math.min(new Date(msg.received_at).getTime(), Date.now()));
  const deliveredAt = msg.delivered_at ? new Date(Math.min(new Date(msg.delivered_at).getTime(), Date.now())) : null;
  let orderId: string | null = null;

  const verdict = await (async () => {
    const sender = msg.channel === 'sms'
      ? verifySmsSender(msg.sender, config().trustedSmsSenders)
      : verifyNotificationApp(msg.sender, config().trustedNotificationApps);
    if (!sender.ok) return `ignored: ${sender.reason}`;

    const text = [msg.title, msg.body].filter(Boolean).join(' ');
    const alert = parseCreditAlert(text);
    if (!alert.ok) {
      const failed = parseFailedPayment(text);
      if (failed.ok) {
        await recordFailedPayment(device.merchantId, { utr: failed.utr, amountPaise: failed.amountPaise, messageId: id, receivedAt });
        return `failed payment${failed.amountPaise ? ` ₹${formatRupees(failed.amountPaise)}` : ''}, UTR ${failed.utr}`;
      }
      return `ignored: ${alert.reason}`;
    }

    const paid = await recordBankCredit(device.merchantId, {
      channel: msg.channel,
      messageId: id,
      amountPaise: alert.amountPaise,
      utr: alert.utr,
      payerVpa: alert.payerVpa,
      payerName: alert.payerName,
      bankDomain: sender.domain,
      receivedAt,
    });
    orderId = paid?.id ?? null;
    return `credit ₹${formatRupees(alert.amountPaise)}${alert.utr ? `, UTR ${alert.utr}` : ''}`;
  })();

  await prisma.deviceMessage.createMany({
    data: [{
      id,
      merchantId: device.merchantId,
      deviceId: device.id,
      channel: msg.channel,
      sender: msg.sender.slice(0, 100),
      receivedAt,
      deliveredAt,
      verdict,
    }],
    skipDuplicates: true,
  });
  return { id: msg.id, status: statusOf(verdict), verdict, order_id: orderId };
}

/** Processes a batch from the phone in the order it was received. Safe to retry: each message is handled once. */
export async function processMessages(device: Device, messages: IncomingMessage[]) {
  const results: MessageResult[] = [];
  for (const msg of messages) results.push(await processMessage(device, msg));
  return results;
}

// ---- API representations ----

export function deviceView(device: Device) {
  return {
    id: device.id,
    object: 'device',
    name: device.name,
    platform: device.platform,
    app_version: device.appVersion,
    created_at: device.createdAt.toISOString(),
    last_seen_at: device.lastSeenAt?.toISOString() ?? null,
  };
}

export function deviceMessageView(message: DeviceMessage & { device: Pick<Device, 'name'> | null }) {
  return {
    id: message.id,
    object: 'device_message',
    device_id: message.deviceId,
    device_name: message.device?.name ?? null,
    channel: message.channel,
    sender: message.sender,
    received_at: message.receivedAt.toISOString(),
    delivered_at: message.deliveredAt?.toISOString() ?? null,
    server_received_at: message.createdAt.toISOString(),
    verdict: message.verdict,
    recognised: message.verdict.startsWith('credit'),
  };
}

/** What the app needs to decide which SMS and notifications to forward. */
export const forwardingRules = () => ({
  sms_senders: config().trustedSmsSenders,
  notification_apps: config().trustedNotificationApps,
});
