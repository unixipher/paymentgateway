import { z } from 'zod';
import { DEFAULT_TRUSTED_BANK_DOMAINS, DEFAULT_TRUSTED_NOTIFICATION_APPS } from './parser';

const csv = z
  .string()
  .optional()
  .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64 encoded'),
  /** Public URL of this backend. Defaults to the Vercel production URL, then localhost. */
  API_BASE_URL: z.url().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
  /** The dashboard frontend. Google sign-in redirects back here. */
  FRONTEND_URL: z.url(),
  /** Extra origins allowed to call the authenticated API from a browser (the frontend is always allowed). */
  CORS_ORIGINS: csv,
  /** Required to call /api/cron/tick. Vercel Cron sends it automatically as a Bearer token. */
  CRON_SECRET: z.string().min(16).optional(),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(15),
  /** How long the payer has to pay, counted from when they open the checkout link. */
  ORDER_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(2),
  /** How long a link nobody has opened stays valid. It holds its unique amount until then. */
  LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(24 * 60),
  /** How long a phone-reported payment may wait for the bank's email before it is flagged. */
  RECONCILE_AFTER_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(45),
  TRUSTED_BANK_DOMAINS: csv,
  /** Bank SMS headers beyond the ones TRAI's register lists, without the operator prefix (e.g. HDFCBK). */
  TRUSTED_SMS_SENDERS: csv,
  /** Extra Android app packages whose notifications count as bank alerts. */
  TRUSTED_NOTIFICATION_APPS: csv,
});

const MINUTE = 60_000;

function load() {
  // Hosts often set unset variables to "", which should mean "not set".
  const raw = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  const env = parsed.data;

  const frontendUrl = env.FRONTEND_URL.replace(/\/$/, '');
  const apiBaseUrl = (
    env.API_BASE_URL
    ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')
  ).replace(/\/$/, '');

  return {
    isProduction: env.NODE_ENV === 'production',
    databaseUrl: env.DATABASE_URL,
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    apiBaseUrl,
    frontendUrl,
    corsOrigins: new Set([new URL(frontendUrl).origin, ...env.CORS_ORIGINS.map((o) => new URL(o).origin)]),
    cronSecret: env.CRON_SECRET,
    pollIntervalMs: env.POLL_INTERVAL_SECONDS * 1000,
    orderTtlMs: env.ORDER_TTL_MINUTES * MINUTE,
    linkTtlMs: env.LINK_TTL_MINUTES * MINUTE,
    /** After the payment window closes, how long checkout keeps saying "checking with your bank" before the order is failed. */
    verifyingMs: MINUTE,
    /** Bank alert emails can arrive minutes after the money does, so a failed order can still be paid this long after expiry. */
    graceMs: 10 * MINUTE,
    /** How long a payer can still submit a UTR for an order they paid the wrong amount for. */
    claimWindowMs: 24 * 60 * MINUTE,
    reconcileAfterMs: env.RECONCILE_AFTER_MINUTES * MINUTE,
    clockSkewMs: 2 * MINUTE,
    sessionTtlMs: 30 * 24 * 60 * MINUTE,
    loginCodeTtlMs: 2 * MINUTE,
    pairingCodeTtlMs: 10 * MINUTE,
    trustedBankDomains: [...DEFAULT_TRUSTED_BANK_DOMAINS, ...env.TRUSTED_BANK_DOMAINS.map((d) => d.toLowerCase())],
    trustedSmsSenders: env.TRUSTED_SMS_SENDERS.map((s) => s.toUpperCase()),
    trustedNotificationApps: [...DEFAULT_TRUSTED_NOTIFICATION_APPS, ...env.TRUSTED_NOTIFICATION_APPS],
  };
}

export type Config = ReturnType<typeof load>;

let cached: Config | undefined;

/** Validated configuration. Loaded on first use so `next build` doesn't need runtime secrets. */
export function config(): Config {
  cached ??= load();
  return cached;
}

/** For tests that change process.env. */
export function resetConfig() {
  cached = undefined;
}
