import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '@/lib/db';
import {
  cancelOrder, claimUtr, createOrder, getOrder, listOrders, merchantOrderView, notifyFailedOrders, recordBankCredit, recordFailedPayment,
} from '@/lib/orders';
import { hasDatabase } from './setup';
import { randomId } from '@/lib/crypto';
import { createMerchant, credit, resetDatabase } from './helpers';

const statusOf = async (id: string) => (await getOrder(id))?.status;

describe.skipIf(!hasDatabase)('order matching', () => {
  beforeEach(resetDatabase);

  test('two people paying ₹10 at the same time get different amounts and are matched correctly', async () => {
    const merchant = await createMerchant();
    const mine = await createOrder(merchant, { amount: '10' });
    const friends = await createOrder(merchant, { amount: '10' });
    expect([mine.amountPaise, friends.amountPaise]).toEqual([1001, 1002]);

    expect((await recordBankCredit(merchant.id, credit(1002, '425100000002')))?.id).toBe(friends.id);
    expect(await statusOf(mine.id)).toBe('pending');
    expect(await statusOf(friends.id)).toBe('paid');

    expect((await recordBankCredit(merchant.id, credit(1001, '425100000001')))?.id).toBe(mine.id);
    expect((await getOrder(mine.id))?.txn?.utr).toBe('425100000001');
  });

  test('orders created at the same instant never get the same amount', async () => {
    const merchant = await createMerchant();
    const created = await Promise.all(Array.from({ length: 20 }, () => createOrder(merchant, { amount: '10' })));
    expect(new Set(created.map((o) => o.amountPaise)).size).toBe(20);
  });

  test('the same UTR can never pay twice', async () => {
    const merchant = await createMerchant();
    const a = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(1001, '425100000010'));
    const b = await createOrder(merchant, { amount: '10' });
    expect(b.amountPaise).toBe(1001); // re-uses ₹10.01 now that it's free
    expect(await recordBankCredit(merchant.id, credit(1001, '425100000010'))).toBeNull();
    expect(await statusOf(a.id)).toBe('paid');
    expect(await statusOf(b.id)).toBe('pending');
  });

  test("one merchant's bank emails never pay another merchant's orders", async () => {
    const me = await createMerchant();
    const other = await createMerchant();
    const mine = await createOrder(me, { amount: '10' });
    const theirs = await createOrder(other, { amount: '10' });
    expect(theirs.amountPaise).toBe(1001);

    expect((await recordBankCredit(other.id, credit(1001, '425100000060')))?.id).toBe(theirs.id);
    expect(await statusOf(mine.id)).toBe('pending');
    expect((await recordBankCredit(me.id, credit(1001, '425100000060')))?.id).toBe(mine.id);
  });

  test('payments that arrived before the order was created do not count', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    expect(await recordBankCredit(merchant.id, credit(1001, '425100000020', new Date(order.createdAt.getTime() - 3600_000)))).toBeNull();
    expect(await statusOf(order.id)).toBe('pending');
  });

  test('a rounded payment is matched once the payer submits their UTR (either order)', async () => {
    const merchant = await createMerchant();
    const early = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(1000, '425100000030'));
    expect(await statusOf(early.id)).toBe('pending');
    expect((await claimUtr(early.id, '425100000030')).status).toBe('paid');

    const late = await createOrder(merchant, { amount: '10' });
    await claimUtr(late.id, '425100000031');
    expect(await statusOf(late.id)).toBe('pending');
    expect((await recordBankCredit(merchant.id, credit(1000, '425100000031')))?.id).toBe(late.id);
  });

  test("knowing a friend's UTR doesn't steal their exact-amount payment", async () => {
    const merchant = await createMerchant();
    const friends = await createOrder(merchant, { amount: '10' });
    const mine = await createOrder(merchant, { amount: '10' });
    await claimUtr(mine.id, '425100000040');
    expect((await recordBankCredit(merchant.id, credit(friends.amountPaise, '425100000040')))?.id).toBe(friends.id);
    expect(await statusOf(mine.id)).toBe('pending');
  });

  test('UTR claims must match the order amount', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(500, '425100000050'));
    expect((await claimUtr(order.id, '425100000050')).status).toBe('pending');
  });

  test('cancelled orders free their amount and are never paid', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await cancelOrder(merchant.id, order.id);
    expect(await recordBankCredit(merchant.id, credit(1001, '425100000070'))).toBeNull();
    expect((await createOrder(merchant, { amount: '10' })).amountPaise).toBe(1001);
    await expect(cancelOrder(merchant.id, (await createOrder(merchant, { amount: '20' })).id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  test('Idempotency-Key returns the same order, and conflicts on a different amount', async () => {
    const merchant = await createMerchant();
    const [a, b] = await Promise.all([
      createOrder(merchant, { amount: '10', idempotencyKey: 'checkout-1' }),
      createOrder(merchant, { amount: '10', idempotencyKey: 'checkout-1' }),
    ]);
    expect(a.id).toBe(b.id);
    await expect(createOrder(merchant, { amount: '11', idempotencyKey: 'checkout-1' })).rejects.toMatchObject({ status: 409 });
  });

  test('listing filters by computed status and paginates', async () => {
    const merchant = await createMerchant();
    const paid = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(1001, '425100000080'));
    for (let i = 0; i < 3; i++) await createOrder(merchant, { amount: '20' });
    await prisma.order.create({
      data: { id: 'ord_old', merchantId: merchant.id, basePaise: 3000, amountPaise: 3001, createdAt: new Date(Date.now() - 86400_000), expiresAt: new Date(Date.now() - 86000_000) },
    });

    expect((await listOrders(merchant.id, { limit: 10, state: 'paid' })).data.map((o) => o.id)).toEqual([paid.id]);
    expect((await listOrders(merchant.id, { limit: 10, state: 'failed' })).data.map((o) => o.id)).toEqual(['ord_old']);
    const page1 = await listOrders(merchant.id, { limit: 2, state: 'pending' });
    const page2 = await listOrders(merchant.id, { limit: 2, state: 'pending', cursor: page1.nextCursor! });
    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  test('refuses orders when the merchant cannot verify payments', async () => {
    await expect(createOrder(await createMerchant({ vpa: null }), { amount: '10' })).rejects.toMatchObject({ code: 'merchant_not_configured' });
    await expect(createOrder(await createMerchant({ gmailRefreshToken: null }), { amount: '10' })).rejects.toMatchObject({ code: 'gmail_not_connected' });
    await expect(createOrder(await createMerchant(), { amount: '0.5' })).rejects.toMatchObject({ status: 400 });
  });
});

describe.skipIf(!hasDatabase)('failed orders', () => {
  beforeEach(resetDatabase);

  const expire = (id: string, minutesAgo: number) =>
    prisma.order.update({ where: { id }, data: { expiresAt: new Date(Date.now() - minutesAgo * 60_000) } });

  test('an order fails after the payment window plus the checking minute, not before', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    expect(order.expiresAt.getTime() - order.createdAt.getTime()).toBe(2 * 60_000);

    await expire(order.id, 0.5);
    expect(merchantOrderView((await getOrder(order.id))!).status).toBe('pending');
    await expire(order.id, 2);
    expect(merchantOrderView((await getOrder(order.id))!)).toMatchObject({ status: 'failed', failure_reason: 'payment_not_received' });
  });

  test('a bank email that arrives late still pays a failed order', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await expire(order.id, 5);
    expect(merchantOrderView((await getOrder(order.id))!).status).toBe('failed');
    expect((await recordBankCredit(merchant.id, credit(order.amountPaise, '425100000100')))?.status).toBe('paid');
  });

  test('order.failed is queued exactly once, and never for paid orders', async () => {
    const merchant = await createMerchant({ webhookUrl: 'http://127.0.0.1:9/unreachable' });
    const failed = await createOrder(merchant, { amount: '10' });
    const paid = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(paid.amountPaise, '425100000101'));
    await expire(failed.id, 2);
    await expire(paid.id, 2);

    await Promise.all([notifyFailedOrders(), notifyFailedOrders(merchant.id)]);
    await notifyFailedOrders();
    const events = await prisma.webhookDelivery.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.event, e.orderId])).toEqual([['order.paid', paid.id], ['order.failed', failed.id]]);
    expect(events[1]!.payload).toMatchObject({ type: 'order.failed', data: { order: { id: failed.id, status: 'failed' } } });
  });

  test('a UTR from a failed payment is rejected, and failed orders can still be claimed', async () => {
    const merchant = await createMerchant();
    const order = await createOrder(merchant, { amount: '10' });
    await recordFailedPayment(merchant.id, { utr: '662600000001', amountPaise: 1001, messageId: 'failmsg', receivedAt: new Date() });
    await expect(claimUtr(order.id, '662600000001')).rejects.toMatchObject({ status: 422, code: 'payment_failed' });

    await expire(order.id, 5);
    expect(merchantOrderView(await claimUtr(order.id, '425100000102')).status).toBe('pending');
  });
});

describe.skipIf(!hasDatabase)('payers sharing an amount by name', () => {
  beforeEach(resetDatabase);

  // Five-letter names that never match each other, e.g. "BAAAA", "BAAAB".
  const filler = (i: number) => `B${[3, 2, 1, 0].map((p) => String.fromCharCode(65 + (Math.floor(i / 26 ** p) % 26))).join('')}`;

  /** Takes all 99 paise amounts for ₹10, each by a named payer. */
  async function fillAllAmounts(merchantId: string) {
    const now = Date.now();
    await prisma.order.createMany({
      data: Array.from({ length: 99 }, (_, i) => ({
        id: randomId('ord'),
        merchantId,
        basePaise: 1000,
        amountPaise: 1001 + i,
        payerName: filler(i),
        createdAt: new Date(now - 1000),
        expiresAt: new Date(now + 120_000),
      })),
    });
  }

  test('without a name the 100th payer is refused; with one they share an amount', async () => {
    const merchant = await createMerchant();
    await fillAllAmounts(merchant.id);
    await expect(createOrder(merchant, { amount: '10' })).rejects.toMatchObject({ status: 429 });
    const amal = await createOrder(merchant, { amount: '10', payerName: 'Amal' });
    expect(amal.amountPaise).toBeGreaterThanOrEqual(1001);
    expect(amal.amountPaise).toBeLessThanOrEqual(1099);
  });

  test('two payers named Amal never share an amount, Amal and Dilip may', async () => {
    const merchant = await createMerchant();
    await fillAllAmounts(merchant.id);
    const amalDas = await createOrder(merchant, { amount: '10', payerName: 'Amal Das' });
    const amalRoy = await createOrder(merchant, { amount: '10', payerName: 'Amal Roy' });
    const dilip = await createOrder(merchant, { amount: '10', payerName: 'Dilip' });
    expect(amalRoy.amountPaise).not.toBe(amalDas.amountPaise);
    expect(dilip.amountPaise).toBe(amalDas.amountPaise); // first amount whose payers are all clearly different
  });

  test("the sender's name in the alert decides who paid a shared amount", async () => {
    const merchant = await createMerchant();
    await fillAllAmounts(merchant.id);
    const amal = await createOrder(merchant, { amount: '10', payerName: 'Amal' });
    const dilip = await createOrder(merchant, { amount: '10', payerName: 'Dilip' });
    expect(dilip.amountPaise).toBe(amal.amountPaise);

    const paidDilip = await recordBankCredit(merchant.id, { ...credit(dilip.amountPaise, '425100000301'), payerName: 'DILIP KUMAR ROY' });
    expect(paidDilip?.id).toBe(dilip.id);
    expect(paidDilip?.txn?.payerName).toBe('DILIP KUMAR ROY');
    expect(await statusOf(amal.id)).toBe('pending');

    const paidAmal = await recordBankCredit(merchant.id, { ...credit(amal.amountPaise, '425100000302'), payerName: 'MR AMAL SEN' });
    expect(paidAmal?.id).toBe(amal.id);
  });

  test('a shared amount from an unknown sender is never guessed; the UTR claim still works', async () => {
    const merchant = await createMerchant();
    await fillAllAmounts(merchant.id);
    const amal = await createOrder(merchant, { amount: '10', payerName: 'Amal' });
    const dilip = await createOrder(merchant, { amount: '10', payerName: 'Dilip' });

    // Dilip paid from his father's account.
    expect(await recordBankCredit(merchant.id, { ...credit(dilip.amountPaise, '425100000303'), payerName: 'RAMESH KUMAR' })).toBeNull();
    expect(await statusOf(amal.id)).toBe('pending');
    expect(await statusOf(dilip.id)).toBe('pending');

    expect((await claimUtr(dilip.id, '425100000303')).status).toBe('paid');
    expect(await statusOf(amal.id)).toBe('pending');
  });

  test('an email and an SMS naming different senders are two payments, not one', async () => {
    const merchant = await createMerchant();
    await fillAllAmounts(merchant.id);
    const amal = await createOrder(merchant, { amount: '10', payerName: 'Amal' });
    const dilip = await createOrder(merchant, { amount: '10', payerName: 'Dilip' });

    await recordBankCredit(merchant.id, { ...credit(amal.amountPaise, '425100000304'), payerName: 'AMAL SEN' });
    const sms = await recordBankCredit(merchant.id, { ...credit(dilip.amountPaise, null), channel: 'sms', payerName: 'DILIP ROY' });
    expect(sms?.id).toBe(dilip.id);
    expect(await statusOf(amal.id)).toBe('paid');
  });
});
