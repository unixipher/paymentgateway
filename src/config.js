import { DEFAULT_TRUSTED_BANK_DOMAINS } from './parser.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

const minutes = (n) => n * 60_000;
const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  baseUrl: (
    process.env.BASE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    || `http://localhost:${port}`
  ).replace(/\/$/, ''),
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
  },
  sessionSecret: required('SESSION_SECRET'),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_SECONDS ?? 15) * 1000,
  orderTtlMs: minutes(Number(process.env.ORDER_TTL_MINUTES ?? 15)),
  // Bank alert emails can arrive a few minutes after the money does.
  graceMs: minutes(10),
  // How long a payer can still submit a UTR for an order they paid the wrong amount for.
  claimWindowMs: minutes(24 * 60),
  clockSkewMs: minutes(2),
  trustedBankDomains: [
    ...DEFAULT_TRUSTED_BANK_DOMAINS,
    ...(process.env.TRUSTED_BANK_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  ],
};

if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
