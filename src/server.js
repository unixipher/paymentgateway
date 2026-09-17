import express from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import { encrypt, randomId, sign, unsign } from './crypto.js';
import { prisma } from './db.js';
import { exchangeCode, googleAuthUrl, safePoll, startPoller } from './gmail.js';
import { HttpError, claimUtr, createOrder, getOrder, listOrders, publicOrder, upiLink } from './orders.js';
import * as views from './views.js';

const SESSION_MS = 7 * 24 * 60 * 60_000;
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https://') };

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

async function sessionMerchant(req) {
  const value = unsign(cookies(req).session ?? '');
  const [id, expiresAt] = value?.split(':') ?? [];
  if (!id || Number(expiresAt) < Date.now()) return null;
  return prisma.merchant.findUnique({ where: { id } });
}

async function requireLogin(req, res, next) {
  req.merchant = await sessionMerchant(req);
  if (!req.merchant) return res.redirect('/');
  next();
}

async function requireApiAuth(req, res, next) {
  const apiKey = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  req.merchant = apiKey
    ? await prisma.merchant.findUnique({ where: { apiKey } })
    : await sessionMerchant(req);
  if (!req.merchant) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---- Merchant login & dashboard ----

app.get('/', async (req, res) => {
  const merchant = await sessionMerchant(req);
  if (!merchant) return res.send(views.landing());
  const [orders, emails] = await Promise.all([
    listOrders(merchant.id, 30),
    prisma.gmailMessage.findMany({ where: { merchantId: merchant.id }, orderBy: { receivedAt: 'desc' }, take: 30 }),
  ]);
  res.send(views.dashboard({ merchant, orders, emails, baseUrl: config.baseUrl }));
});

app.get('/auth/google', (req, res) => {
  const state = randomId('state');
  res.cookie('oauth_state', state, { ...cookieOptions, maxAge: 10 * 60_000 });
  res.redirect(googleAuthUrl(state));
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) throw new HttpError(400, `Google sign-in failed: ${error}`);
  if (!state || state !== cookies(req).oauth_state) throw new HttpError(400, 'Sign-in session expired, please try again');
  res.clearCookie('oauth_state');

  const { email, refreshToken } = await exchangeCode(String(code));
  const encrypted = refreshToken ? encrypt(refreshToken) : undefined;
  const merchant = await prisma.merchant.upsert({
    where: { email },
    update: { refreshToken: encrypted },
    create: {
      id: randomId('mer'),
      email,
      refreshToken: encrypted,
      webhookSecret: randomId('whsec', 24),
      apiKey: randomId('key', 24),
    },
  });

  res.cookie('session', sign(`${merchant.id}:${Date.now() + SESSION_MS}`), { ...cookieOptions, maxAge: SESSION_MS });
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/');
});

app.post('/settings', requireLogin, async (req, res) => {
  const vpa = String(req.body.vpa ?? '').trim();
  const displayName = String(req.body.display_name ?? '').trim().slice(0, 50);
  const webhookUrl = String(req.body.webhook_url ?? '').trim();
  if (!/^[a-z0-9._-]{2,}@[a-z][a-z0-9]{1,}$/i.test(vpa)) throw new HttpError(400, 'That does not look like a UPI ID');
  if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) throw new HttpError(400, 'Webhook URL must start with http:// or https://');
  await prisma.merchant.update({
    where: { id: req.merchant.id },
    data: { vpa, displayName: displayName || null, webhookUrl: webhookUrl || null },
  });
  res.redirect('/');
});

app.post('/orders/test', requireLogin, async (req, res) => {
  const order = await createOrder(req.merchant, { amount: req.body.amount, note: req.body.note || 'Test order' });
  res.redirect(`/pay/${order.id}`);
});

app.post('/scan', requireLogin, async (req, res) => {
  if (!req.merchant.refreshToken) throw new HttpError(400, 'Gmail access has expired, sign in again');
  await safePoll(req.merchant, Date.now() - 3 * 24 * 60 * 60_000);
  res.redirect('/#emails');
});

// ---- Payment page ----

app.get('/pay/:id', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { merchant: true, txn: true } });
  if (!order) throw new HttpError(404, 'Order not found');
  const link = upiLink(order.merchant, order);
  res.send(views.payPage({
    order: publicOrder(order),
    payeeName: order.merchant.displayName || order.merchant.vpa,
    link,
    qr: await QRCode.toDataURL(link, { margin: 1, width: 520 }),
  }));
});

// ---- JSON API ----

app.post('/api/orders', requireApiAuth, async (req, res) => {
  res.status(201).json(publicOrder(await createOrder(req.merchant, req.body)));
});

app.get('/api/orders', requireApiAuth, async (req, res) => {
  res.json((await listOrders(req.merchant.id)).map(publicOrder));
});

app.get('/api/orders/:id', async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  res.json(publicOrder(order));
});

app.post('/api/orders/:id/claim', async (req, res) => {
  res.json(publicOrder(await claimUtr(req.params.id, String(req.body?.utr ?? '').trim())));
});

app.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'Something went wrong' : err.message;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(views.errorPage(message));
});

app.listen(config.port, () => {
  console.log(`UPI gateway running at ${config.baseUrl}`);
  startPoller();
});
