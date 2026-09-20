import type { Merchant } from '@/generated/prisma/client';
import { decrypt } from './crypto';
import { prisma } from './db';
import { config } from './env';
import {
  GoogleAuthRevokedError, forgetAccessToken, getMessage, gmailAccessToken, listMessageIds, type GmailMessage,
} from './google';
import { logger } from './logger';
import { formatRupees } from './money';
import { notifyFailedOrders, recordBankCredit, recordFailedPayment } from './orders';
import { header, parseCreditEmail, parseFailedPaymentEmail, verifySender } from './parser';

async function processMessage(merchant: Merchant, msg: GmailMessage) {
  const headers = msg.payload?.headers ?? [];
  const receivedAt = new Date(Number(msg.internalDate));
  const log = (verdict: string) =>
    prisma.gmailMessage.createMany({
      data: [{
        merchantId: merchant.id,
        gmailMessageId: msg.id,
        receivedAt,
        fromAddr: header(headers, 'From').slice(0, 300),
        subject: header(headers, 'Subject').slice(0, 300),
        verdict,
      }],
      skipDuplicates: true,
    });

  const sender = verifySender(headers, config().trustedBankDomains, merchant.bankKey);
  if (!sender.ok) {
    await log(`ignored: ${sender.reason}`);
    return null;
  }

  const alert = parseCreditEmail(msg.payload);
  if (!alert.ok) {
    const failed = parseFailedPaymentEmail(msg.payload);
    if (failed.ok) {
      await recordFailedPayment(merchant.id, { utr: failed.utr, amountPaise: failed.amountPaise, messageId: msg.id, receivedAt });
      await log(`failed payment${failed.amountPaise ? ` ₹${formatRupees(failed.amountPaise)}` : ''}, UTR ${failed.utr}`);
      return null;
    }
    await log(`ignored: ${alert.reason}`);
    return null;
  }

  await log(`credit ₹${formatRupees(alert.amountPaise)}${alert.utr ? `, UTR ${alert.utr}` : ''}`);
  return recordBankCredit(merchant.id, {
    messageId: msg.id,
    amountPaise: alert.amountPaise,
    utr: alert.utr,
    payerVpa: alert.payerVpa,
    payerName: alert.payerName,
    bankDomain: sender.domain,
    receivedAt,
  });
}

/** Reads bank emails received since `since` and matches them to orders. Returns how many orders got paid. */
export async function pollMerchant(merchant: Merchant, since: Date): Promise<number> {
  // Turned off in Settings: the bank's emails don't confirm payments, so don't read them.
  if (!merchant.gmailRefreshToken || !merchant.confirmByEmail) return 0;
  try {
    const token = await gmailAccessToken(merchant.id, decrypt(merchant.gmailRefreshToken));
    // Narrow the search to bank senders; verifySender still does the real check on each message.
    const fromFilter = config().trustedBankDomains.map((d) => `from:${d}`).join(' ');
    const ids = (await listMessageIds(token, `after:${Math.floor(since.getTime() / 1000)} {${fromFilter}}`)).reverse();

    const seen = new Set(
      (await prisma.gmailMessage.findMany({
        where: { merchantId: merchant.id, gmailMessageId: { in: ids } },
        select: { gmailMessageId: true },
      })).map((m) => m.gmailMessageId),
    );

    let paid = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      if (await processMessage(merchant, await getMessage(token, id))) paid++;
    }
    return paid;
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) {
      await prisma.merchant.update({ where: { id: merchant.id }, data: { gmailRefreshToken: null } });
      forgetAccessToken(merchant.id);
      logger.warn('gmail access revoked, merchant must sign in again', { merchantId: merchant.id });
      return 0;
    }
    logger.error('gmail poll failed', { merchantId: merchant.id, err });
    return 0;
  }
}

/** Merchants with open orders, and how far back their Gmail needs to be searched. */
async function merchantsWithOpenOrders(now: number, merchantId?: string) {
  const { graceMs, claimWindowMs, clockSkewMs } = config();
  const open = await prisma.order.groupBy({
    by: ['merchantId'],
    where: {
      ...(merchantId && { merchantId }),
      status: 'pending',
      OR: [
        // A link nobody has opened can't have been paid (the payer hasn't seen the amount), so it needs no checks.
        { openedAt: { not: null }, expiresAt: { gte: new Date(now - graceMs) } },
        { claimedUtr: { not: null }, createdAt: { gte: new Date(now - claimWindowMs) } },
      ],
    },
    _min: { createdAt: true },
  });
  return new Map(open.map((o) => [o.merchantId, new Date((o._min.createdAt?.getTime() ?? now) - clockSkewMs)]));
}

/**
 * Checks one merchant's Gmail if it hasn't been checked within the poll interval. The conditional
 * update lets only one caller per interval through, across all serverless instances.
 */
export async function pollIfDue(merchantId: string): Promise<number> {
  const now = Date.now();
  const since = (await merchantsWithOpenOrders(now, merchantId)).get(merchantId);
  if (!since) return 0;
  const claimed = await prisma.merchant.updateMany({
    where: {
      id: merchantId,
      gmailRefreshToken: { not: null },
      confirmByEmail: true,
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(now - config().pollIntervalMs) } }],
    },
    data: { lastPolledAt: new Date(now) },
  });
  if (!claimed.count) return 0;
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
  return pollMerchant(merchant, since);
}

/** For the cron: every merchant with open orders that is due, then order.failed webhooks for orders that ran out of time. */
export async function pollAllDue() {
  const merchants = [...(await merchantsWithOpenOrders(Date.now())).keys()];
  const paid = await Promise.all(merchants.map((id) => pollIfDue(id)));
  return { merchants: merchants.length, paid: paid.reduce((a, b) => a + b, 0), failed: await notifyFailedOrders() };
}

/** Manual re-scan from the dashboard, e.g. to check that a bank's emails are recognised. */
export async function scanRecent(merchant: Merchant, days: number) {
  return pollMerchant(merchant, new Date(Date.now() - days * 24 * 3600_000));
}
