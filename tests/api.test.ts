import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, test } from 'vitest';
import { POST as createSession, DELETE as deleteSession } from '@/app/api/auth/session/route';
import { GET as cronTick } from '@/app/api/cron/tick/route';
import { GET as getMe, PATCH as patchMe } from '@/app/api/me/route';
import { POST as rotateApiKey } from '@/app/api/me/api-key/route';
import { GET as publicOrder } from '@/app/api/public/orders/[id]/route';
import { POST as claim } from '@/app/api/public/orders/[id]/claim/route';
import { GET as qr } from '@/app/api/public/orders/[id]/qr/route';
import { GET as getOrderRoute } from '@/app/api/v1/orders/[id]/route';
import { GET as listOrdersRoute, POST as createOrderRoute } from '@/app/api/v1/orders/route';
import { createLoginCode } from '@/lib/auth';
import { decrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { createOrder, recordBankCredit } from '@/lib/orders';
import { rateLimit } from '@/lib/rate-limit';
import { verifyWebhookSignature } from '@/lib/webhooks';
import { proxy } from '@/proxy';
import { hasDatabase } from './setup';
import { createMerchant, credit, params, request, resetDatabase } from './helpers';

async function signIn(merchantId: string) {
  const code = await createLoginCode(merchantId, '/orders');
  const res = await createSession(request('/api/auth/session', { method: 'POST', body: { code } }), undefined);
  expect(res.status).toBe(201);
  return { code, body: (await res.json()) as { token: string; redirect: string } };
}

async function apiKeyFor(merchantId: string) {
  const { body } = await signIn(merchantId);
  const res = await rotateApiKey(request('/api/me/api-key', { method: 'POST', headers: { authorization: `Bearer ${body.token}` } }), undefined);
  return ((await res.json()) as { api_key: string }).api_key;
}

describe.skipIf(!hasDatabase)('HTTP API', () => {
  beforeEach(resetDatabase);

  test('dashboard sign-in: login code is single-use and sessions can be revoked', async () => {
    const merchant = await createMerchant();
    const { code, body } = await signIn(merchant.id);
    expect(body.token).toMatch(/^pgs_/);
    expect(body.redirect).toBe('/orders');

    const auth = { authorization: `Bearer ${body.token}` };
    const me = await getMe(request('/api/me', { headers: auth }), undefined);
    expect(await me.json()).toMatchObject({ id: merchant.id, gmail_connected: true, api_key: null });

    const replay = await createSession(request('/api/auth/session', { method: 'POST', body: { code } }), undefined);
    expect(replay.status).toBe(401);

    expect((await deleteSession(request('/api/auth/session', { method: 'DELETE', headers: auth }), undefined)).status).toBe(204);
    expect((await getMe(request('/api/me', { headers: auth }), undefined)).status).toBe(401);
  });

  test('settings are validated', async () => {
    const merchant = await createMerchant();
    const { body } = await signIn(merchant.id);
    const auth = { authorization: `Bearer ${body.token}` };

    const bad = await patchMe(request('/api/me', { method: 'PATCH', headers: auth, body: { vpa: 'not a vpa', extra: 1 } }), undefined);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'validation_failed' } });

    const ok = await patchMe(request('/api/me', { method: 'PATCH', headers: auth, body: { vpa: 'Me@OKAXIS', display_name: 'Ice Cream Co' } }), undefined);
    expect(await ok.json()).toMatchObject({ vpa: 'me@okaxis', display_name: 'Ice Cream Co' });
  });

  test('orders API: API key auth, idempotency, merchant isolation and consistent errors', async () => {
    const merchant = await createMerchant();
    const key = await apiKeyFor(merchant.id);
    expect(key).toMatch(/^pgk_live_/);
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).apiKeyHash).not.toContain(key);

    const unauthenticated = await createOrderRoute(request('/api/v1/orders', { method: 'POST', body: { amount: '99' } }), undefined);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });

    const headers = { authorization: `Bearer ${key}`, 'idempotency-key': 'cart-42' };
    const body = { amount: '99', note: 'Ice Cream', metadata: { cart: '42' } };
    const first = await createOrderRoute(request('/api/v1/orders', { method: 'POST', headers, body }), undefined);
    const second = await createOrderRoute(request('/api/v1/orders', { method: 'POST', headers, body }), undefined);
    const order = (await first.json()) as { id: string; amount: string; checkout_url: string };
    expect(first.status).toBe(201);
    expect(order).toMatchObject({ amount: '99.01', status: 'pending', metadata: { cart: '42' } });
    expect(order.checkout_url).toBe(`https://dashboard.example.com/pay/${order.id}`);
    expect(((await second.json()) as { id: string }).id).toBe(order.id);

    const invalid = await createOrderRoute(request('/api/v1/orders', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: { amount: '99', surprise: true } }), undefined);
    expect(invalid.status).toBe(400);

    const list = await listOrdersRoute(request('/api/v1/orders?status=pending', { headers: { authorization: `Bearer ${key}` } }), undefined);
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);

    const otherKey = await apiKeyFor((await createMerchant()).id);
    const foreign = await getOrderRoute(request(`/api/v1/orders/${order.id}`, { headers: { authorization: `Bearer ${otherKey}` } }), params({ id: order.id }));
    expect(foreign.status).toBe(404);
  });

  test('public checkout exposes only what the payer needs', async () => {
    const merchant = await createMerchant({ displayName: 'Ice Cream Co' });
    const key = await apiKeyFor(merchant.id);
    const created = await createOrderRoute(request('/api/v1/orders', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: { amount: '50', metadata: { internal: 'x' } } }), undefined);
    const { id } = (await created.json()) as { id: string };

    const res = await publicOrder(request(`/api/public/orders/${id}`), params({ id }));
    const view = (await res.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ status: 'pending', amount: '50.01', payee: { name: 'Ice Cream Co', vpa: 'shop@okhdfcbank' } });
    expect(view.upi_link).toBe('upi://pay?pa=shop@okhdfcbank&pn=Ice%20Cream%20Co&am=50.01&cu=INR&tn=Order%20' + id.slice(-6));
    expect(view).not.toHaveProperty('metadata');
    expect(view).not.toHaveProperty('base_amount');

    const png = await qr(request(`/api/public/orders/${id}/qr`), params({ id }));
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');

    const badClaim = await claim(request(`/api/public/orders/${id}/claim`, { method: 'POST', body: { utr: '123' } }), params({ id }));
    expect(badClaim.status).toBe(400);
  });

  test('paid orders trigger a signed webhook', async () => {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const merchant = await createMerchant({ webhookUrl: `http://127.0.0.1:${port}/hook` });
      const key = await apiKeyFor(merchant.id);
      const created = await createOrderRoute(request('/api/v1/orders', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: { amount: '10' } }), undefined);
      const { id } = (await created.json()) as { id: string };

      await recordBankCredit(merchant.id, credit(1001, '425100000090'));
      await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1);

      const [hook] = received;
      const secret = decrypt((await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).webhookSecret);
      expect(verifyWebhookSignature(secret, hook!.body, String(hook!.headers['x-webhook-signature']))).toBe(true);
      expect(JSON.parse(hook!.body)).toMatchObject({ type: 'order.paid', data: { order: { id, status: 'paid', utr: '425100000090' } } });
      await expect.poll(async () => (await prisma.webhookDelivery.findFirstOrThrow({ where: { orderId: id } })).status).toBe('succeeded');
    } finally {
      server.close();
    }
  });

  test('failed webhooks are retried later', async () => {
    const merchant = await createMerchant({ webhookUrl: 'http://127.0.0.1:9/unreachable' });
    const order = await createOrder(merchant, { amount: '10' });
    await recordBankCredit(merchant.id, credit(1001, '425100000091'));
    // `attempts` is incremented when a delivery is claimed; wait for the failed attempt to be recorded.
    await expect.poll(async () => (await prisma.webhookDelivery.findFirst({ where: { orderId: order.id } }))?.lastError, { timeout: 15_000 }).toBeTruthy();
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { orderId: order.id } });
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1 });
    expect(delivery.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(delivery.lastError).toBeTruthy();
  });

  test('rate limits return 429 with Retry-After', async () => {
    await rateLimit('test-key', 2, 60_000);
    await rateLimit('test-key', 2, 60_000);
    await expect(rateLimit('test-key', 2, 60_000)).rejects.toMatchObject({ status: 429, headers: { 'Retry-After': expect.any(String) } });
  });

  test('cron requires the secret', async () => {
    expect((await cronTick(request('/api/cron/tick'), undefined)).status).toBe(401);
    const ok = await cronTick(request('/api/cron/tick', { headers: { authorization: 'Bearer test-cron-secret-0123456789' } }), undefined);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ polling: { merchants: 0 }, webhooks: { attempted: 0 } });
  });
});

describe('CORS proxy', () => {
  const preflight = (path: string, origin: string) => proxy(request(path, { method: 'OPTIONS', headers: { origin } }));

  test('the frontend origin may call the authenticated API', () => {
    const res = preflight('/api/me', 'https://dashboard.example.com');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dashboard.example.com');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  test('other origins may not', () => {
    const res = preflight('/api/me', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('checkout endpoints are open to any site', () => {
    expect(preflight('/api/public/orders/ord_1', 'https://merchant-shop.example').headers.get('access-control-allow-origin')).toBe('*');
  });
});
