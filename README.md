# Payment Gateway (backend)

UPI payments to a merchant's own UPI ID, verified automatically by reading their bank's credit alert emails from Gmail, and instantly from bank SMS through the Android app ([paymentgateway-android](../paymentgateway-android)). This repo is the backend only: a Next.js (App Router, TypeScript) API. The dashboard and checkout UI live in a separate frontend repo.

**API reference for the frontend and merchants: [docs/API.md](docs/API.md)**

## How a payment is verified

1. A merchant creates an order for ₹99 and gets **₹99.01**. Every open order has a unique paise amount (₹99.01, ₹99.02, …), which is how an email is matched to exactly one order.
2. The payer pays that exact amount by scanning the QR code or opening the UPI link.
3. The bank emails the merchant's Gmail: *"₹99.01 credited … UPI Ref 425112345678"*.
4. The backend reads new bank emails from the merchant's Gmail (read-only access) and:
   - **rejects spoofed emails.** The sender must be a trusted bank domain, and Gmail's own `Authentication-Results` header must show DKIM/DMARC passed for it.
   - **rejects anything that isn't a completed credit:** debits, card spends, failed, declined or reversed transactions, and marketing mail.
   - **matches the credit** to the open order with that exact amount. Each UTR counts once, and each credit pays at most one order.
5. The order becomes `paid`, and a signed webhook is recorded in the outbox and delivered with retries.

If a payer's app rounds the amount, they can submit their 12-digit UTR on the checkout page. An exact-amount match always wins over a UTR claim.

**Bank SMS** reach the backend within seconds when the merchant pairs an Android phone (dashboard → Phones). Each SMS goes through the same parser and matching as an email. It must arrive from a header TRAI's register says a bank holds, and one payment reported by both email and SMS is counted once. See [docs/API.md](docs/API.md#android-app-bank-sms) and [data/trai/README.md](data/trai/README.md).

Gmail is checked **on demand**, when the checkout page polls the order status (at most once per 15 s per merchant), and continuously by the dedicated PM2 worker in production.

## Project layout

```
src/
  app/
    api/auth/…            Google sign-in start, session exchange / sign out
    auth/google/callback  Google OAuth redirect URI
    api/me/…              merchant settings, API key, webhook secret, delivery log, bank emails, scan
    api/v1/orders/…       orders API (API key or session)
    api/public/orders/…   checkout: status, QR PNG, UTR claim (CORS: any origin)
    api/device/…          Phone app: pairing, heartbeat, forwarded bank SMS/notifications, dashboard
    api/me/devices/…      pairing codes, paired phones, forwarded-message log
    api/cron/tick         Gmail polling, webhook retries, cleanup
    api/health
  proxy.ts                CORS and security headers
  lib/
    parser.ts             bank email → verified credit (pure, heavily tested)
    reconcile.ts          flags phone-reported payments the bank's email never confirmed
    dlt.ts                bank SMS sender headers, checked against TRAI's register
    banks.ts              the banks we can recognise by name, in the register and in an alert
    sms-headers.generated.ts  every header TRAI assigned to a bank (built from data/trai/)
    orders.ts             unique amounts, matching, idempotency, API views
    poller.ts             Gmail polling with a cross-instance throttle
    tick.ts               one idempotent background-work cycle
    devices.ts            phone pairing, device tokens, bank SMS/notification ingest
    webhooks.ts           outbox, signing, delivery with backoff
    auth.ts               sessions, login codes, API keys (all stored hashed)
    crypto.ts             AES-256-GCM secrets at rest, HMAC signing
    env.ts                validated configuration
data/trai/                TRAI's register of SMS headers, and what it is used for
prisma/                   schema and migrations
tests/                    Vitest: parser, security, order matching, HTTP API, CORS
ecosystem.config.cjs      PM2 processes for the API, worker and frontend
deploy/                   Nginx reverse-proxy example
```

## Security

- **Tokens:** session tokens, login codes, API keys, device tokens and pairing codes are random values, stored only as SHA-256 hashes.
- **Encrypted at rest:** Gmail refresh tokens and webhook secrets use AES-256-GCM, with keys derived from `ENCRYPTION_KEY`.
- **OAuth:** state is in a signed, short-lived, HttpOnly cookie. Only relative redirect paths are allowed, and a verified Google email is required.
- **Frontend handoff:** a single-use 2-minute code, exchanged for a Bearer token. There are no cross-site cookies.
- **Isolation:** every row belongs to one merchant, and every query filters by it.
- **Rate limits:** stored in Postgres, so they hold across serverless instances. Sign-in, checkout status, QR codes, UTR claims, order creation and scans are all limited.
- **Webhooks:** HMAC-SHA256 signatures that include a timestamp, and in production only public HTTPS targets are allowed.
- **The merchant's bank:** a merchant can name the bank their UPI ID pays into, and an alert from any other bank is then refused, by email and SMS alike.
- **Checked twice:** a payment a phone reported is looked at again about 45 minutes later. A phone can forge an SMS, but not the bank's DKIM-signed email, so a payment no email ever confirmed raises `payment.unverified` and is marked in the dashboard. It is flagged, not undone.
- **Bank SMS:** an alert counts only if its sender header passes every check TRAI's own framework allows — a real operator and service-area prefix, a non-promotional message type, a header the register says a **bank** holds, and, when both are recognisable, agreement between that bank and the bank the alert names. See [data/trai/README.md](data/trai/README.md).
- **Validation:** Zod on every input, and unknown fields are rejected. Errors return a consistent JSON shape and never include internals.

## Setup

Requirements: Node 24, a Postgres database (e.g. [Prisma Postgres](https://www.prisma.io/postgres)), and a Google Cloud project.

1. **Google Cloud Console**
   - Enable the **Gmail API**.
   - **Google Auth Platform → Audience:** External. While in Testing, add every Gmail account that will sign in as a test user (Testing-mode refresh tokens expire after 7 days).
   - **Clients → Web application.** Authorized redirect URIs: `http://localhost:3000/auth/google/callback` and `https://<your-backend-domain>/auth/google/callback`.
2. **Environment:** copy `.env.example` to `.env` and fill it in. Each variable is documented in that file.
3. Install, migrate and run:
   ```bash
   npm install          # also generates the Prisma client
   npm run db:migrate
   npm run dev          # http://localhost:3000
   ```
4. Merchants enable **email alerts for UPI credits** in their bank's netbanking, sent to the Gmail account they sign in with. Forwarded emails fail DKIM and are ignored.

```bash
npm test            # Vitest. Database tests use DATABASE_URL but run in a separate `gateway_test` schema.
npm run typecheck
npm run build
```

## Deploying to a VM with PM2

PM2 runs three fork-mode processes: the API, the Gmail/background worker, and the frontend. The worker
checks Gmail, reconciles phone payments, retries webhooks and cleans expired data every 15 seconds.

Keep the backend and frontend repositories as sibling directories named `paymentgateway` and
`paymentgateway-frontend`.

1. Install Node 24, Nginx, and PM2 on the VM (`npm install -g pm2`). Point the frontend and API DNS
   records at the VM and allow inbound ports 80 and 443.
2. In the backend, create `.env.production` from `.env.production.example`. Keep the current
   `DATABASE_URL` and `ENCRYPTION_KEY` during migration; changing the encryption key disconnects Gmail
   and makes existing webhook secrets unreadable.
3. In the frontend, copy `.env.example` to `.env.production` and set `NEXT_PUBLIC_API_URL` to the public
   API URL. This value is baked in during the build.
4. Install, migrate and build:
   ```bash
   npm ci
   npm run db:migrate
   npm run build
   npm --prefix ../paymentgateway-frontend ci
   npm --prefix ../paymentgateway-frontend run build
   ```
5. Start all three processes and persist them across reboots:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   pm2 status
   pm2 logs gateway-worker
   ```
   Run the root command printed by `pm2 startup` once.
6. Configure Nginx from `deploy/nginx.conf.example`, then enable HTTPS with Certbot or your existing
   certificate setup. The API listens on `127.0.0.1:3000`; the frontend listens on `127.0.0.1:5173`.
7. Add `https://<api-domain>/auth/google/callback` to the Google OAuth client. If the API hostname
   changes, update the production server URL in the Android and iOS apps.

Deploy later updates with:

```bash
git pull
git -C ../paymentgateway-frontend pull
npm ci && npm run db:migrate && npm run build
npm --prefix ../paymentgateway-frontend ci
npm --prefix ../paymentgateway-frontend run build
pm2 reload ecosystem.config.cjs --update-env
```

The PM2 configuration runs one instance of each process and restarts them at 512 MB (API), 256 MB
(worker), and 384 MB (frontend). Do not scale the worker above one instance; the job operations are
idempotent, but a single worker avoids unnecessary Gmail API traffic.

## Legacy Vercel deployment

1. **Framework preset: Next.js.** If the project was created for the old Express version, change it under Settings → Build and Deployment.
2. Set the environment variables from `.env.example`. `FRONTEND_URL` must be the deployed frontend URL. `API_BASE_URL` can be omitted when using the Vercel production domain.
3. **Migrations run automatically on production deploys.** `vercel.json` sets the build command to `npm run vercel-build`, which runs `prisma migrate deploy` (retrying once if another build holds the migration lock) before `next build`, but only when `VERCEL_ENV` is `production`. Preview deploys of other branches never change the database. This overrides any Build Command set in the Vercel dashboard. You can also migrate by hand with `npm run db:migrate`.
4. **Cron (recommended).** Call `GET /api/cron/tick` every minute with `Authorization: Bearer $CRON_SECRET`. The PM2 worker replaces this schedule.
   - **Vercel Pro:** add `"crons": [{ "path": "/api/cron/tick", "schedule": "* * * * *" }]` to `vercel.json`. Vercel sends `CRON_SECRET` automatically.
   - **Vercel Hobby** only allows daily crons. Use an external scheduler instead (cron-job.org, GitHub Actions, Upstash QStash) with that header.
   - Without a cron, payments are still detected while a checkout page is open, but webhook retries and cleanup only happen when the cron runs.

### Upgrading an existing Express deployment

The migration `20260918000000_production_backend` keeps existing merchants, orders and transactions. It converts plaintext API keys to hashes, so existing keys keep working. After deploying it, run once:

```bash
node --env-file=.env scripts/migrate-legacy-secrets.ts   # needs the old SESSION_SECRET and the new ENCRYPTION_KEY
```

This re-encrypts Gmail tokens and webhook secrets with `ENCRYPTION_KEY`. You can then remove `SESSION_SECRET` and delete the script.

## Limitations

- Detection speed depends on the bank's alert email: usually seconds, sometimes minutes.
- Bank email formats vary. The parser is tested against HDFC-, ICICI- and Kotak/Kotak811-style alerts. Add samples to `tests/parser.test.ts` when adding a bank.
- At most 99 open orders per base amount per merchant at a time. Beyond that, order creation returns `429`.
- Gmail read access is a Google "restricted" scope. Opening sign-in to the public requires Google's verification and security assessment.
- Banks may restrict personal accounts that receive high volumes of business payments.
