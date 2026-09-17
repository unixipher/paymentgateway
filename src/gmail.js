import { config } from './config.js';
import { decrypt } from './crypto.js';
import { prisma } from './db.js';
import { HttpError, formatRupees, recordBankTxn } from './orders.js';
import { header, parseCreditEmail, verifySender } from './parser.js';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const redirectUri = () => `${config.baseUrl}/auth/google/callback`;

export function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: ['openid', 'email', GMAIL_SCOPE].join(' '),
    access_type: 'offline',
    prompt: 'consent', // always hand back a refresh token
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(`Google token error: ${json.error} ${json.error_description ?? ''}`);
    err.code = json.error;
    throw err;
  }
  return json;
}

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!tokens.scope?.split(' ').includes(GMAIL_SCOPE)) {
    throw new HttpError(400, 'Gmail read access was not granted. Sign in again and tick the Gmail permission.');
  }
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await res.json();
  if (!res.ok || !user.email_verified) throw new HttpError(400, 'Could not read a verified email from Google');
  return { email: user.email.toLowerCase(), refreshToken: tokens.refresh_token };
}

const accessTokens = new Map(); // merchant id -> { token, expiresAt }

async function accessToken(merchant) {
  const cached = accessTokens.get(merchant.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(merchant.refreshToken) });
  accessTokens.set(merchant.id, { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
  return tokens.access_token;
}

async function gmailGet(token, path, params) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function processMessage(merchant, msg) {
  const headers = msg.payload?.headers ?? [];
  const receivedAt = Number(msg.internalDate);
  const log = (verdict) => prisma.gmailMessage.createMany({
    data: [{
      merchantId: merchant.id,
      gmailMessageId: msg.id,
      receivedAt: new Date(receivedAt),
      fromAddr: header(headers, 'From'),
      subject: header(headers, 'Subject'),
      verdict,
    }],
    skipDuplicates: true,
  });

  const sender = verifySender(headers, config.trustedBankDomains);
  if (!sender.ok) {
    await log(`ignored: ${sender.reason}`);
    return null;
  }

  const alert = parseCreditEmail(msg.payload);
  if (!alert.ok) {
    await log(`ignored: ${alert.reason}`);
    return null;
  }

  await log(`credit ₹${formatRupees(alert.amountPaise)}${alert.utr ? `, UTR ${alert.utr}` : ''}`);
  return recordBankTxn(merchant.id, {
    gmailMessageId: msg.id,
    amountPaise: alert.amountPaise,
    utr: alert.utr,
    payerVpa: alert.payerVpa,
    bankDomain: sender.domain,
    receivedAt,
  });
}

export async function pollMerchant(merchant, sinceMs) {
  const token = await accessToken(merchant);
  // Narrow the search to bank senders; verifySender still does the real check on each message.
  const fromFilter = config.trustedBankDomains.map((d) => `from:${d}`).join(' ');
  const list = await gmailGet(token, 'messages', { q: `after:${Math.floor(sinceMs / 1000)} {${fromFilter}}`, maxResults: 100 });
  const ids = (list.messages ?? []).map((m) => m.id).reverse(); // oldest first

  const seen = new Set((await prisma.gmailMessage.findMany({
    where: { merchantId: merchant.id, gmailMessageId: { in: ids } },
    select: { gmailMessageId: true },
  })).map((m) => m.gmailMessageId));

  let paid = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    const msg = await gmailGet(token, `messages/${id}`, { format: 'full' });
    if (await processMessage(merchant, msg)) paid++;
  }
  return paid;
}

export async function safePoll(merchant, sinceMs) {
  try {
    return await pollMerchant(merchant, sinceMs);
  } catch (err) {
    if (err.code === 'invalid_grant') {
      await prisma.merchant.update({ where: { id: merchant.id }, data: { refreshToken: null } });
      accessTokens.delete(merchant.id);
      console.warn(`${merchant.email}: Google access expired or was revoked, they need to sign in again`);
    } else {
      console.error(`Polling Gmail for ${merchant.email} failed: ${err.message}`);
    }
    return 0;
  }
}

// Only merchants with open orders are polled, starting from their oldest open order.
async function merchantsToPoll(now) {
  const open = await prisma.order.groupBy({
    by: ['merchantId'],
    where: {
      status: 'pending',
      OR: [
        { expiresAt: { gte: new Date(now - config.graceMs) } },
        { claimedUtr: { not: null }, createdAt: { gte: new Date(now - config.claimWindowMs) } },
      ],
    },
    _min: { createdAt: true },
  });
  const merchants = await prisma.merchant.findMany({
    where: { id: { in: open.map((o) => o.merchantId) }, refreshToken: { not: null } },
  });
  const oldestOpen = new Map(open.map((o) => [o.merchantId, o._min.createdAt.getTime()]));
  return merchants.map((merchant) => ({ merchant, since: oldestOpen.get(merchant.id) - config.clockSkewMs }));
}

export function startPoller() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const { merchant, since } of await merchantsToPoll(Date.now())) await safePoll(merchant, since);
    } catch (err) {
      console.error(`Poller failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, config.pollIntervalMs);
  void tick();
}
