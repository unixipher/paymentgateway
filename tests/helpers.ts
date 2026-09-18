import { NextRequest } from 'next/server';
import { encrypt, randomId } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { newWebhookSecret } from '@/lib/merchants';

export async function resetDatabase() {
  await prisma.$transaction([
    prisma.webhookDelivery.deleteMany(),
    prisma.bankTxn.deleteMany(),
    prisma.order.deleteMany(),
    prisma.gmailMessage.deleteMany(),
    prisma.deviceMessage.deleteMany(),
    prisma.devicePairingCode.deleteMany(),
    prisma.device.deleteMany(),
    prisma.failedPayment.deleteMany(),
    prisma.session.deleteMany(),
    prisma.loginCode.deleteMany(),
    prisma.rateLimit.deleteMany(),
    prisma.merchant.deleteMany(),
  ]);
}

export function createMerchant(overrides: Partial<Parameters<typeof prisma.merchant.create>[0]['data']> = {}) {
  const id = randomId('mer');
  return prisma.merchant.create({
    data: {
      id,
      email: `${id}@example.com`,
      vpa: 'shop@okhdfcbank',
      gmailRefreshToken: encrypt('fake-refresh-token'),
      webhookSecret: encrypt(newWebhookSecret()),
      ...overrides,
    },
  });
}

let gmailId = 0;
export const credit = (amountPaise: number, utr: string | null, receivedAt = new Date()) => ({
  messageId: `msg${++gmailId}-${Date.now()}`,
  amountPaise,
  utr,
  payerVpa: null,
  bankDomain: 'hdfcbank.net',
  receivedAt,
});

export function request(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(url, 'https://api.example.com'), {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
