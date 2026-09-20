/**
 * Second opinion on payments a phone reported.
 *
 * A paired phone is trusted to forward bank SMS, so a phone that has been tampered with can post a
 * message that looks like a credit alert: the right sender header, the right amount, an invented
 * UTR. Nothing in the message itself gives that away. The bank's email can't be forged the same
 * way — it carries Gmail's own DKIM/DMARC verdict — so the same payment, seen again by email, is
 * what confirms the phone was telling the truth.
 *
 * This sweeps for credits a phone reported that no email ever corroborated, and flags them. It does
 * not undo the payment: by then the merchant may have handed over the goods, and the right response
 * is theirs to choose. A flagged payment raises `payment.unverified` and is marked in the dashboard.
 */
import { prisma } from './db';
import { config } from './env';
import { logger } from './logger';
import { enqueueWebhook } from './webhooks';

/** A credit the phone reported, still waiting on the bank's email. */
const UNCORROBORATED = {
  channel: { not: 'email' },
  emailConfirmedAt: null,
  unverifiedNotifiedAt: null,
} as const;

/**
 * Flags phone-reported payments that no bank email has confirmed. Only for merchants whose email
 * channel is known to work, so a merchant whose bank sends no email — or who has Gmail off — is
 * never told their genuine payments are suspect.
 */
export async function flagUnverifiedCredits(now = new Date()) {
  const cutoff = new Date(now.getTime() - config().reconcileAfterMs);
  const due = await prisma.bankTxn.findMany({
    where: {
      ...UNCORROBORATED,
      receivedAt: { lt: cutoff },
      // Only payments that actually settled an order are worth anyone's attention.
      orderId: { not: null },
      merchant: { confirmByEmail: true, gmailRefreshToken: { not: null } },
    },
    include: { merchant: { select: { id: true, webhookUrl: true } } },
    orderBy: { receivedAt: 'asc' },
    take: 200,
  });
  if (due.length === 0) return { checked: 0, flagged: 0, skipped: 0 };

  let flagged = 0;
  let skipped = 0;
  for (const txn of due) {
    // Has this merchant's email channel ever corroborated anything? If not, the silence says
    // nothing about this payment, so leave it alone rather than cry wolf.
    const emailWorks = await prisma.bankTxn.findFirst({
      where: { merchantId: txn.merchantId, emailConfirmedAt: { not: null } },
      select: { id: true },
    });
    if (!emailWorks) { skipped++; continue; }

    await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: the email may have landed since the sweep began.
      const current = await tx.bankTxn.findFirst({ where: { id: txn.id, ...UNCORROBORATED } });
      if (!current) { skipped++; return; }
      await tx.bankTxn.update({ where: { id: txn.id }, data: { unverifiedNotifiedAt: now } });
      await enqueueWebhook(tx, txn.merchant, 'payment.unverified', {
        order_id: txn.orderId,
        amount: txn.amountPaise,
        utr: txn.utr,
        channel: txn.channel,
        sender: txn.bankDomain,
        received_at: txn.receivedAt.toISOString(),
        reason: 'no bank email confirmed this payment',
      }, txn.orderId ?? undefined);
      flagged++;
    });
  }

  if (flagged > 0) logger.warn('payments no bank email confirmed', { flagged, checked: due.length });
  return { checked: due.length, flagged, skipped };
}
