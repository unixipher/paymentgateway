import { beforeEach, describe, expect, test } from 'vitest';
import { POST as createSession } from '@/app/api/auth/session/route';
import { DELETE as unpairSelf, GET as deviceMe } from '@/app/api/device/me/route';
import { POST as sendMessages } from '@/app/api/device/messages/route';
import { POST as pair } from '@/app/api/device/pair/route';
import { GET as listDeviceMessages } from '@/app/api/me/device-messages/route';
import { DELETE as removeDevice } from '@/app/api/me/devices/[id]/route';
import { POST as newPairingCode } from '@/app/api/me/devices/pairing-code/route';
import { GET as listDevices } from '@/app/api/me/devices/route';
import { GET as getOrderRoute } from '@/app/api/v1/orders/[id]/route';
import { createLoginCode } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { claimUtr, createOrder, getOrder, recordBankCredit } from '@/lib/orders';
import { hasDatabase } from './setup';
import { createMerchant, credit, params, request, resetDatabase } from './helpers';

async function sessionFor(merchantId: string) {
  const code = await createLoginCode(merchantId, null);
  const res = await createSession(request('/api/auth/session', { method: 'POST', body: { code } }), undefined);
  return { authorization: `Bearer ${((await res.json()) as { token: string }).token}` };
}

async function pairPhone(merchantId: string) {
  const session = await sessionFor(merchantId);
  const res = await newPairingCode(request('/api/me/devices/pairing-code', { method: 'POST', headers: session }), undefined);
  const { code } = (await res.json()) as { code: string };
  const paired = await pair(request('/api/device/pair', { method: 'POST', body: { code, name: 'Shop phone', app_version: '1.0' } }), undefined);
  expect(paired.status).toBe(201);
  const body = (await paired.json()) as { device_token: string; device: { id: string } };
  return { session, code, token: body.device_token, deviceId: body.device.id, auth: { authorization: `Bearer ${body.device_token}` } };
}

let seq = 0;
const sms = (body: string, overrides: Record<string, unknown> = {}) => ({
  id: `sms-${++seq}`,
  channel: 'sms',
  sender: 'VM-HDFCBK-S',
  body,
  received_at: new Date().toISOString(),
  ...overrides,
});

async function send(auth: Record<string, string>, messages: unknown[]) {
  const res = await sendMessages(request('/api/device/messages', { method: 'POST', headers: auth, body: { messages } }), undefined);
  return { status: res.status, body: (await res.json()) as { data: { id: string; status: string; verdict: string; order_id: string | null }[] } };
}

describe.skipIf(!hasDatabase)('Android devices', () => {
  beforeEach(resetDatabase);

  test('pairing: the code is single-use, and a removed phone is locked out', async () => {
    const merchant = await createMerchant();
    const phone = await pairPhone(merchant.id);
    expect(phone.token).toMatch(/^pgd_/);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: phone.deviceId } })).tokenHash).not.toContain(phone.token);

    const replay = await pair(request('/api/device/pair', { method: 'POST', body: { code: phone.code, name: 'Other' } }), undefined);
    expect(replay.status).toBe(401);

    const me = await deviceMe(request('/api/device/me', { headers: phone.auth }), undefined);
    expect(await me.json()).toMatchObject({ device: { name: 'Shop phone' }, merchant: { email: merchant.email }, rules: { sms_senders: expect.arrayContaining(['HDFCBK']) } });

    const list = await listDevices(request('/api/me/devices', { headers: phone.session }), undefined);
    expect((await list.json()).data).toHaveLength(1);

    // Device tokens don't work on the merchant API, and sessions don't work as device tokens.
    expect((await getOrderRoute(request('/api/v1/orders/x', { headers: phone.auth }), params({ id: 'x' }))).status).toBe(401);
    expect((await deviceMe(request('/api/device/me', { headers: phone.session }), undefined)).status).toBe(401);

    const removed = await removeDevice(request(`/api/me/devices/${phone.deviceId}`, { method: 'DELETE', headers: phone.session }), params({ id: phone.deviceId }));
    expect(removed.status).toBe(204);
    expect((await deviceMe(request('/api/device/me', { headers: phone.auth }), undefined)).status).toBe(401);
  });

  test("a phone can't remove another merchant's device, and can unpair itself", async () => {
    const me = await pairPhone((await createMerchant()).id);
    const other = await pairPhone((await createMerchant()).id);
    const res = await removeDevice(request(`/api/me/devices/${other.deviceId}`, { method: 'DELETE', headers: me.session }), params({ id: other.deviceId }));
    expect(res.status).toBe(404);
    expect((await unpairSelf(request('/api/device/me', { method: 'DELETE', headers: other.auth }), undefined)).status).toBe(204);
    expect(await prisma.device.count({ where: { id: other.deviceId } })).toBe(0);
  });

  test('a bank SMS pays the order instantly, and a retried upload is not processed twice', async () => {
    const merchant = await createMerchant({ gmailRefreshToken: null });
    const phone = await pairPhone(merchant.id);
    const order = await createOrder(merchant, { amount: '10' }); // allowed without Gmail once a phone is paired

    const message = sms('Credit Alert!\nRs.10.01 credited to HDFC Bank A/c XX1234 on 18-09-26 from VPA payer@okaxis (UPI 425100000101)');
    const first = await send(phone.auth, [message]);
    expect(first.status).toBe(200);
    expect(first.body.data[0]).toMatchObject({ id: message.id, status: 'credit', order_id: order.id });

    const paid = await getOrder(order.id);
    expect(paid).toMatchObject({ status: 'paid', txn: { utr: '425100000101', payerVpa: 'payer@okaxis' } });
    expect(await prisma.bankTxn.findFirst({ where: { merchantId: merchant.id } })).toMatchObject({ channel: 'sms', bankDomain: 'VM-HDFCBK-S' });

    const retry = await send(phone.auth, [message]);
    expect(retry.body.data[0]).toMatchObject({ status: 'credit', order_id: null });
    expect(await prisma.bankTxn.count()).toBe(1);

    const log = await listDeviceMessages(request('/api/me/device-messages', { headers: phone.session }), undefined);
    expect((await log.json()).data).toEqual([
      expect.objectContaining({ channel: 'sms', sender: 'VM-HDFCBK-S', device_name: 'Shop phone', recognised: true, verdict: 'credit ₹10.01, UTR 425100000101' }),
    ]);
  });

  test('SMS from untrusted senders and non-credit messages never pay', async () => {
    const merchant = await createMerchant();
    const phone = await pairPhone(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    const text = 'Rs.10.01 credited to A/c XX1234 (UPI 425100000102)';

    const { body } = await send(phone.auth, [
      sms(text, { sender: '+919812345678' }),
      sms(text, { sender: 'VM-FAKEBK' }),
      sms(text, { channel: 'notification', sender: 'com.example.fakebank' }),
      sms('Rs.10.01 debited from A/c XX1234 (UPI 425100000103)'),
    ]);
    expect(body.data.map((r) => r.status)).toEqual(['ignored', 'ignored', 'ignored', 'ignored']);
    expect(body.data[0]?.verdict).toContain('not a bank SMS header');
    expect((await getOrder(order.id))?.status).toBe('pending');
  });

  test('a phone clock in the future cannot pay orders created later', async () => {
    const merchant = await createMerchant();
    const phone = await pairPhone(merchant.id);
    const future = new Date(Date.now() + 3600_000).toISOString();
    await send(phone.auth, [sms('Rs.10.01 credited to A/c XX1234 (UPI 425100000104)', { received_at: future })]);
    expect((await prisma.bankTxn.findFirstOrThrow()).receivedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('a failed-payment SMS stops the payer claiming that UTR', async () => {
    const merchant = await createMerchant();
    const phone = await pairPhone(merchant.id);
    const order = await createOrder(merchant, { amount: '10' });
    const { body } = await send(phone.auth, [sms('UPI txn of Rs 10.01 failed. Amount will be credited back to A/c XX1234. Ref 425100000105')]);
    expect(body.data[0]?.status).toBe('failed_payment');
    await expect(claimUtr(order.id, '425100000105')).rejects.toMatchObject({ code: 'payment_failed' });
  });

  describe('the same payment reported by both the bank email and the phone', () => {
    test('with the same UTR it is counted once', async () => {
      const merchant = await createMerchant();
      const phone = await pairPhone(merchant.id);
      await createOrder(merchant, { amount: '10' });
      await send(phone.auth, [sms('Rs.10.01 credited to A/c XX1234 (UPI 425100000201)')]);
      expect(await recordBankCredit(merchant.id, credit(1001, '425100000201'))).toBeNull();
      expect(await prisma.bankTxn.count()).toBe(1);
    });

    test("an alert without a UTR doesn't pay a second order for the same money", async () => {
      const merchant = await createMerchant();
      const phone = await pairPhone(merchant.id);
      const first = await createOrder(merchant, { amount: '10' });
      // e.g. a UPI app notification, which has no reference number
      expect((await recordBankCredit(merchant.id, { ...credit(1001, null), channel: 'notification' }))?.id).toBe(first.id);

      const second = await createOrder(merchant, { amount: '10' });
      expect(second.amountPaise).toBe(1001);
      await send(phone.auth, [sms('Rs.10.01 credited to A/c XX1234 (UPI 425100000202)')]);
      await recordBankCredit(merchant.id, credit(1001, null));
      expect((await getOrder(second.id))?.status).toBe('pending');
      expect(await prisma.bankTxn.count()).toBe(1);
      // The UTR from the later alert is kept on the one payment.
      expect((await getOrder(first.id))?.txn?.utr).toBe('425100000202');
    });
  });
});
