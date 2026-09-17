import { config } from './config.js';
import { decrypt } from './crypto.js';
import { db } from './db.js';
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
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(merchant.refresh_token) });
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

function processMessage(merchant, msg) {
  const headers = msg.payload?.headers ?? [];
  const receivedAt = Number(msg.internalDate);
  const log = (verdict) => db.prepare(`
    INSERT OR IGNORE INTO gmail_messages (id, merchant_id, received_at, from_addr, subject, verdict)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msg.id, merchant.id, receivedAt, header(headers, 'From'), header(headers, 'Subject'), verdict);

  const sender = verifySender(headers, config.trustedBankDomains);
  if (!sender.ok) {
    log(`ignored: ${sender.reason}`);
    return null;
  }

  const alert = parseCreditEmail(msg.payload);
  if (!alert.ok) {
    log(`ignored: ${alert.reason}`);
    return null;
  }

  log(`credit ₹${formatRupees(alert.amountPaise)}${alert.utr ? `, UTR ${alert.utr}` : ''}`);
  return recordBankTxn(merchant.id, {
    gmailId: msg.id,
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

  const seen = db.prepare('SELECT 1 FROM gmail_messages WHERE id = ?');
  let paid = 0;
  for (const { id } of (list.messages ?? []).reverse()) { // oldest first
    if (seen.get(id)) continue;
    const msg = await gmailGet(token, `messages/${id}`, { format: 'full' });
    if (processMessage(merchant, msg)) paid++;
  }
  return paid;
}

export async function safePoll(merchant, sinceMs) {
  try {
    return await pollMerchant(merchant, sinceMs);
  } catch (err) {
    if (err.code === 'invalid_grant') {
      db.prepare('UPDATE merchants SET refresh_token = NULL WHERE id = ?').run(merchant.id);
      accessTokens.delete(merchant.id);
      console.warn(`${merchant.email}: Google access expired or was revoked, they need to sign in again`);
    } else {
      console.error(`Polling Gmail for ${merchant.email} failed: ${err.message}`);
    }
    return 0;
  }
}

// Only merchants with open orders are polled, starting from their oldest open order.
export function startPoller() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const merchants = db.prepare(`
        SELECT m.*, MIN(o.created_at) AS oldest_open
        FROM merchants m JOIN orders o ON o.merchant_id = m.id
        WHERE m.refresh_token IS NOT NULL AND o.status = 'pending'
          AND (o.expires_at + ? >= ? OR (o.claimed_utr IS NOT NULL AND o.created_at + ? >= ?))
        GROUP BY m.id
      `).all(config.graceMs, now, config.claimWindowMs, now);
      for (const merchant of merchants) await safePoll(merchant, merchant.oldest_open - config.clockSkewMs);
    } finally {
      running = false;
    }
  };
  setInterval(tick, config.pollIntervalMs);
  void tick();
}
