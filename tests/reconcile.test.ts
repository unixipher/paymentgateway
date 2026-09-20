import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '@/lib/db';
import { createOrder, getOrder, recordBankCredit } from '@/lib/orders';
import { flagUnverifiedCredits } from '@/lib/reconcile';
import { createMerchant, credit, resetDatabase } from './helpers';
import { hasDatabase } from './setup';

/**
 * Alerts arrive now, against orders open now; the sweep runs later. Moving the sweep's clock rather
 * than backdating the alerts keeps matching (which wants the order open when the money arrived) intact.
 */
const LATER = () => new Date(Date.now() + 6 * 60 * 60_000);

const smsCredit = (amountPaise: number, utr: string | null, receivedAt = new Date()) => ({
  ...credit(amountPaise, utr, receivedAt),
  channel: 'sms' as const,
  bankDomain: 'VM-HDFCBK-S',
});

/** One email credit, so this merchant's email channel counts as working. */
async function emailChannelWorks(merchantId: string) {
  await recordBankCredit(merchantId, credit(9999, '400000000000'));
}

describe.skipIf(!hasDatabase)('payments no bank email confirmed', () => {
  beforeEach(resetDatabase);

  test('an SMS payment the bank email also reported is verified', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '425100000001'));
    expect(await statusOf(order.id)).toBe('paid');

    // The bank's email arrives later with the same UTR.
    await recordBankCredit(merchant.id, credit(order.amountPaise, '425100000001'));
    const txn = await prisma.bankTxn.findFirst({ where: { orderId: order.id } });
    expect(txn?.emailConfirmedAt).not.toBeNull();

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ flagged: 0 });
  });

  test('an SMS payment no email ever reported is flagged', async () => {
    const merchant = await createMerchant({ webhookUrl: 'https://shop.example.com/hook' });
    await emailChannelWorks(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));
    expect(await statusOf(order.id)).toBe('paid');

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ flagged: 1 });

    const delivery = await prisma.webhookDelivery.findFirst({ where: { event: 'payment.unverified' } });
    expect(delivery?.orderId).toBe(order.id);
    expect((delivery?.payload as { data: { utr: string } }).data.utr).toBe('999999999999');
  });

  test('the payment stands; it is flagged, not undone', async () => {
    const merchant = await createMerchant();
    await emailChannelWorks(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));

    await flagUnverifiedCredits(LATER());
    expect(await statusOf(order.id)).toBe('paid');
    expect((await getOrder(order.id))?.txn?.emailConfirmedAt).toBeNull();
  });

  test('it is flagged once, not on every tick', async () => {
    const merchant = await createMerchant({ webhookUrl: 'https://shop.example.com/hook' });
    await emailChannelWorks(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ flagged: 1 });
    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ flagged: 0 });
    expect(await prisma.webhookDelivery.count({ where: { event: 'payment.unverified' } })).toBe(1);
  });

  test('a payment still inside the waiting window is left alone', async () => {
    const merchant = await createMerchant();
    await emailChannelWorks(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));

    // Swept straight away: the bank's email has not had time to arrive yet.
    expect(await flagUnverifiedCredits(new Date())).toMatchObject({ checked: 0, flagged: 0 });
  });

  test('a merchant whose email channel has never worked is not told their payments are suspect', async () => {
    // Their bank may simply not send emails. Silence from a channel that has never spoken proves nothing.
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ flagged: 0, skipped: 1 });
  });

  test('a merchant with bank emails turned off is not swept', async () => {
    const merchant = await createMerchant();
    await emailChannelWorks(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));
    await prisma.merchant.update({ where: { id: merchant.id }, data: { confirmByEmail: false } });

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ checked: 0, flagged: 0 });
  });

  test('a merchant with no Gmail connected is not swept', async () => {
    const merchant = await createMerchant();
    await emailChannelWorks(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, '999999999999'));
    await prisma.merchant.update({ where: { id: merchant.id }, data: { gmailRefreshToken: null } });

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ checked: 0, flagged: 0 });
  });

  test('an SMS credit that paid no order is not flagged', async () => {
    const merchant = await createMerchant();
    await emailChannelWorks(merchant.id);
    await recordBankCredit(merchant.id, smsCredit(5000, '999999999999'));

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ checked: 0, flagged: 0 });
  });

  test('a credit the bank emailed first needs no second opinion', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(order.amountPaise, '425100000001'));

    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ checked: 0, flagged: 0 });
  });

  test('an email with no UTR still corroborates the SMS it matches on amount', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    const at = new Date();
    await recordBankCredit(merchant.id, smsCredit(order.amountPaise, null, at));
    await recordBankCredit(merchant.id, credit(order.amountPaise, null, new Date(at.getTime() + 60_000)));

    const txn = await prisma.bankTxn.findFirst({ where: { orderId: order.id } });
    expect(txn?.emailConfirmedAt).not.toBeNull();
    expect(await flagUnverifiedCredits(LATER())).toMatchObject({ flagged: 0 });
  });
});

const statusOf = async (id: string) => (await getOrder(id))?.status;
