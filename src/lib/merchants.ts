import { isIP } from 'node:net';
import { z } from 'zod';
import type { Merchant } from '@/generated/prisma/client';
import { encrypt, randomId, randomToken } from './crypto';
import { prisma } from './db';
import { config } from './env';
import type { GoogleIdentity } from './google';

export const newWebhookSecret = () => randomToken('whsec');

/** Creates or updates the merchant for a Google sign-in and stores the (encrypted) Gmail refresh token. */
export async function upsertMerchantFromGoogle(identity: GoogleIdentity): Promise<Merchant> {
  const gmail = identity.refreshToken
    ? { gmailRefreshToken: encrypt(identity.refreshToken), gmailConnectedAt: new Date() }
    : {};
  const existing = await prisma.merchant.findFirst({
    where: { OR: [{ googleSub: identity.sub }, { email: identity.email }] },
  });
  if (existing) {
    return prisma.merchant.update({
      where: { id: existing.id },
      data: { googleSub: identity.sub, email: identity.email, ...gmail },
    });
  }
  return prisma.merchant.create({
    data: {
      id: randomId('mer'),
      email: identity.email,
      googleSub: identity.sub,
      webhookSecret: encrypt(newWebhookSecret()),
      ...gmail,
    },
  });
}

export function merchantView(merchant: Merchant) {
  return {
    id: merchant.id,
    object: 'merchant',
    email: merchant.email,
    vpa: merchant.vpa,
    display_name: merchant.displayName,
    webhook_url: merchant.webhookUrl,
    gmail_connected: Boolean(merchant.gmailRefreshToken),
    gmail_connected_at: merchant.gmailConnectedAt?.toISOString() ?? null,
    api_key: merchant.apiKeyHash
      ? { prefix: merchant.apiKeyPrefix, created_at: merchant.apiKeyCreatedAt?.toISOString() ?? null }
      : null,
    created_at: merchant.createdAt.toISOString(),
  };
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

function isPrivateAddress(host: string): boolean {
  const ip = host.replace(/^\[|\]$/g, '');
  const version = isIP(ip);
  if (version === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) return ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || /^::ffff:/i.test(ip);
  return false;
}

/** Webhook targets must be public HTTPS endpoints in production (no SSRF into private networks). */
export const webhookUrlSchema = z
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    if (!config().isProduction) return ['http:', 'https:'].includes(url.protocol);
    return url.protocol === 'https:' && !PRIVATE_HOST.test(url.hostname) && !isPrivateAddress(url.hostname);
  }, 'must be a public https:// URL');

// NPCI's UPI address for a bank account without its own UPI ID: <account number>@<IFSC>.ifsc.npci.
const BANK_ACCOUNT_VPA = /^(\d{9,18})@([a-z]{4}0[a-z0-9]{6})\.ifsc\.npci$/i;

export const vpaSchema = z
  .string()
  .trim()
  .transform((value) => {
    const bank = value.match(BANK_ACCOUNT_VPA);
    // IFSC codes are written in capitals everywhere, including NPCI's own examples of this format.
    return bank ? `${bank[1]}@${bank[2]!.toUpperCase()}.ifsc.npci` : value.toLowerCase();
  })
  .refine(
    (value) => BANK_ACCOUNT_VPA.test(value) || /^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,64}$/.test(value),
    'must be a UPI ID like name@okhdfcbank, or a bank account as 123456789012@SBIN0001234.ifsc.npci',
  );

export const updateMerchantSchema = z
  .object({
    vpa: vpaSchema.optional(),
    display_name: z.string().trim().min(1).max(50).nullable().optional(),
    webhook_url: webhookUrlSchema.nullable().optional(),
  })
  .strict();
