# Payment Gateway API

Base URL: the backend deployment, e.g. `https://api.example.com`. All request and response bodies are JSON.

- [Authentication](#authentication)
- [Errors, rate limits, pagination](#conventions)
- [Dashboard sign-in flow](#dashboard-sign-in-flow)
- [Merchant account](#merchant-account)
- [Orders](#orders)
- [Checkout (public)](#checkout-public)
- [Webhooks](#webhooks)
- [Operations](#operations)

## Authentication

Every authenticated request sends `Authorization: Bearer <token>`. There are two kinds of token:

| Token | Looks like | Who uses it | Can call |
|---|---|---|---|
| Session token | `pgs_…` | The dashboard frontend, after Google sign-in | `/api/me/*`, `/api/auth/session`, `/api/v1/*` |
| API key | `pgk_live_…` | The merchant's own server | `/api/v1/*` |

Never put an API key in browser code. `/api/public/*` needs no token.

## Conventions

**Errors** always have this shape, with an HTTP status to match:

```json
{ "error": { "code": "validation_failed", "message": "Request validation failed", "details": [{ "path": "vpa", "message": "must be a UPI ID like name@okhdfcbank" }] } }
```

| Status | `code` |
|---|---|
| 400 | `bad_request`, `validation_failed` |
| 401 | `unauthorized` (missing, invalid or expired token) |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict`, `gmail_not_connected`, `merchant_not_configured` |
| 410 | `gone` (order expired or cancelled) |
| 429 | `rate_limited` (see the `Retry-After` header, in seconds) |
| 500 | `internal_error` |

**Pagination.** List endpoints take `?limit=` (1–100, default 25) and `?cursor=`. They return `{ "data": [...], "next_cursor": "..." | null }`. To get the next page, pass `next_cursor` back as `cursor`.

**Money.** Amounts are strings in rupees with 2 decimals (`"99.01"`), plus the same value as integer paise (`9901`).

**Timestamps** are ISO 8601 in UTC.

## Dashboard sign-in flow

```
Frontend                                  Backend                          Google
   │  1. window.location =                   │                                │
   │     /api/auth/google?redirect=/orders ─▶│  2. redirect ─────────────────▶│ user signs in and
   │                                          │                                │ grants Gmail read access
   │                                          │◀── 3. /auth/google/callback ───│
   │◀── 4. redirect FRONTEND_URL/auth/callback?code=pgc_… ──                   │
   │  5. POST /api/auth/session {code} ──────▶│                                │
   │◀── { token: "pgs_…", redirect: "/orders", merchant } ──                   │
   │  6. store token; send Authorization: Bearer pgs_… on every call           │
```

1. Send the browser (a full-page navigation, not `fetch`) to `GET /api/auth/google?redirect=/some/path`. `redirect` is optional and must be a path on the frontend.
2. Google sends the user back to the backend, which then redirects to **`<FRONTEND_URL>/auth/callback`** with either:
   - `?code=pgc_…`: a one-time code, valid for 2 minutes, or
   - `?error=…`: one of `access_denied` (user cancelled), `gmail_permission_missing` (user unticked Gmail access), `gmail_not_connected`, `invalid_state` (link expired or tampered), `google_error`, `login_failed`.
3. Exchange the code:

```http
POST /api/auth/session
{ "code": "pgc_…" }
```
```json
201
{ "token": "pgs_…", "token_type": "Bearer", "expires_at": "2026-10-17T10:00:00.000Z", "redirect": "/orders",
  "merchant": { "id": "mer_…", "email": "…", "vpa": null, "gmail_connected": true, "api_key": null, … } }
```

Sessions last 30 days. On any `401`, send the user through sign-in again.

**Sign out:** `DELETE /api/auth/session` (with the session token) → `204`.

## Merchant account

All of these need a **session token**.

### `GET /api/me`

```json
{
  "id": "mer_…", "object": "merchant", "email": "shop@gmail.com",
  "vpa": "shop@okhdfcbank", "display_name": "Ice Cream Co", "webhook_url": "https://shop.example/hooks/upi",
  "gmail_connected": true, "gmail_connected_at": "…",
  "api_key": { "prefix": "pgk_live_Ab3dE", "created_at": "…" },
  "created_at": "…"
}
```

`gmail_connected: false` means Google access expired or was revoked. Payments can't be verified and new orders are refused, so prompt the user to sign in again.

### `PATCH /api/me`

Update any of these fields (unknown fields are rejected):

```json
{ "vpa": "shop@okhdfcbank", "display_name": "Ice Cream Co", "webhook_url": "https://shop.example/hooks/upi" }
```

`display_name` and `webhook_url` accept `null` to clear them. In production, `webhook_url` must be a public `https://` URL.

### API key

- `POST /api/me/api-key` → `201 { "api_key": "pgk_live_…", "prefix": "…", "created_at": "…" }`. **This is the only time the full key is shown.** Creating a new key revokes the old one immediately.
- `DELETE /api/me/api-key` → `204`.

### Webhook signing secret

- `GET /api/me/webhook-secret` → `{ "webhook_secret": "whsec_…" }`
- `POST /api/me/webhook-secret` → rotates it and returns the new secret.

### Webhook delivery log

- `GET /api/me/webhook-deliveries` (paginated). Each item has `id`, `event`, `order_id`, `status` (`pending` | `succeeded` | `failed`), `attempts`, `last_status_code`, `last_error`, `next_attempt_at`, `delivered_at`, `created_at` and `payload`.
- `POST /api/me/webhook-deliveries/:id/retry` re-sends a pending or failed delivery now → `{ "id": "…", "result": "succeeded" | "retrying" | "failed" | "skipped" }`.

### Bank emails (troubleshooting)

- `GET /api/me/bank-emails` (paginated): bank emails the poller examined, and what it decided. Each item has `id`, `received_at`, `from`, `subject`, `verdict` and `recognised`. Example verdicts: `credit ₹99.01, UTR 425112345678`, `ignored: failed or reversed transaction`.
- `POST /api/me/gmail/scan` `{ "days": 3 }` (1–7) re-reads recent bank emails now → `{ "orders_paid": 0 }`. Limited to 2 per minute.

## Orders

Use an **API key** from the merchant's server, or a **session token** from the dashboard.

### Order object

```json
{
  "id": "ord_…", "object": "order",
  "status": "pending",
  "amount": "99.01", "amount_paise": 9901,
  "base_amount": "99.00", "base_amount_paise": 9900,
  "currency": "INR",
  "note": "Ice Cream", "metadata": { "cart_id": "42" },
  "redirect_url": "https://shop.example/thanks",
  "checkout_url": "https://dashboard.example.com/pay/ord_…",
  "utr": null, "payer_vpa": null, "claimed_utr": null,
  "created_at": "…", "expires_at": "…", "paid_at": null, "cancelled_at": null
}
```

| `status` | Meaning |
|---|---|
| `pending` | Waiting for payment. |
| `paid` | A verified bank credit matched this order. `utr` is set. |
| `expired` | No payment arrived in time (15 min by default, plus a 10 min grace period for late bank emails). If the payer submitted a UTR, the order stays `pending` for up to 24 hours. |
| `cancelled` | Cancelled by the merchant. It will never be marked paid. |

**Why `amount` differs from `base_amount`:** every open order gets a unique paise amount (₹99.01, ₹99.02, …), which is how a bank alert email is matched to exactly one order. The payer must pay `amount` exactly.

### `POST /api/v1/orders`

```http
POST /api/v1/orders
Authorization: Bearer pgk_live_…
Idempotency-Key: cart-42-attempt-1

{ "amount": "99", "note": "Ice Cream", "redirect_url": "https://shop.example/thanks", "metadata": { "cart_id": "42" } }
```

| Field | Rules |
|---|---|
| `amount` | Required. Rupees, 1–99999, at most 2 decimals. String or number. |
| `note` | Optional, ≤ 50 characters. Shown in the payer's UPI app. |
| `redirect_url` | Optional http(s) URL for the checkout page to send the payer to after payment. |
| `metadata` | Optional string→string map, ≤ 20 keys. Returned as-is and never shown to the payer. |

Responds `201` with the order. Send the payer to `checkout_url`.

- **`Idempotency-Key`** (optional, ≤ 100 characters of `A-Z a-z 0-9 _ . : -`): retrying with the same key returns the original order instead of creating a new one. Reusing a key with a different amount returns `409 conflict`.
- `409 merchant_not_configured`: no UPI ID is set. `409 gmail_not_connected`: Gmail access was lost.
- `429 rate_limited`: over 120 orders per minute, or all 99 paise slots for this amount are taken. Retry after `Retry-After` seconds.

### `GET /api/v1/orders`

Paginated, newest first. Optional filter: `?status=pending|paid|expired|cancelled`.

### `GET /api/v1/orders/:id`

Returns the order, or `404` if it belongs to another merchant.

### `POST /api/v1/orders/:id/cancel`

Cancels a pending order and returns it. Cancelling a paid order returns `409`.

## Checkout (public)

These endpoints are for the payer's checkout page, which is typically `/pay/:id` on the frontend. They need no auth and can be called from any origin. They are rate limited per IP.

### `GET /api/public/orders/:id`

```json
{
  "id": "ord_…", "object": "checkout", "status": "pending",
  "amount": "99.01", "amount_paise": 9901, "currency": "INR", "note": "Ice Cream",
  "payee": { "name": "Ice Cream Co", "vpa": "shop@okhdfcbank" },
  "upi_link": "upi://pay?pa=shop@okhdfcbank&pn=Ice%20Cream%20Co&am=99.01&cu=INR&tn=Ice%20Cream",
  "qr_url": "https://api.example.com/api/public/orders/ord_…/qr",
  "redirect_url": "https://shop.example/thanks",
  "utr": null, "utr_submitted": false,
  "expires_at": "…", "paid_at": null
}
```

**Poll this every 3–5 seconds while `status` is `pending`.** Each call also triggers a Gmail check (at most once per 15 s per merchant). That's how payments are detected when no cron job is running. Stop polling once the status is `paid`, `expired` or `cancelled`.

### `GET /api/public/orders/:id/qr?size=512`

A PNG QR code of `upi_link` (`size` 128–1024), for use as `<img src={qr_url}>`.

### `POST /api/public/orders/:id/claim`

```json
{ "utr": "425112345678" }
```

The payer enters the 12-digit UPI reference number from their UPI app. Offer this when a payment isn't detected, for example because the payer paid a rounded amount. The response is the checkout object. The order becomes `paid` once the bank email with that UTR arrives and its amount equals the order's `amount` or `base_amount`. A payment that matches an order by exact amount always goes to that order, so a UTR copied from someone else can't take their payment. Limited to 10 per 10 minutes per IP and 5 per order.

### Suggested checkout page

1. `GET /api/public/orders/:id`. If it's not `pending`, show the final state.
2. Show `amount` prominently with the message "pay exactly this amount". Show `<img src={qr_url}>`, plus a button linking to `upi_link` for phones.
3. Poll every 3 seconds. When the status becomes `paid`, show success and, if `redirect_url` is set, redirect to `redirect_url?order_id=<id>&status=paid`.
4. After about a minute, show "Paid but still waiting?" with a UTR form that posts to `/claim`.
5. Show a countdown to `expires_at`.

## Webhooks

When an order is paid, the backend sends a `POST` to the merchant's `webhook_url`:

```http
POST /hooks/upi
Content-Type: application/json
X-Webhook-Id: evt_…
X-Webhook-Event: order.paid
X-Webhook-Signature: t=1789640000,v1=5f2c…

{ "id": "evt_…", "type": "order.paid", "created_at": "…", "data": { "order": { …order object… } } }
```

- Any `2xx` response counts as delivered, and redirects are not followed. Respond within 10 seconds.
- Failed deliveries are retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h (8 attempts in total). After that the delivery is marked `failed`, and you can retry it from the delivery log.
- A delivery can arrive more than once. **Deduplicate on `X-Webhook-Id`** (or the order `id`).
- Events are recorded in the same database transaction that marks the order paid, so they are never lost.

**Verify every webhook** before trusting it. Compute an HMAC-SHA256 with your webhook secret over `<t>.<raw request body>`, compare it to `v1`, and reject timestamps more than 5 minutes old:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(rawBody: string, signatureHeader: string, secret: string): boolean {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Use the **raw** body exactly as received, not re-serialised JSON.

## Operations

- `GET /api/health` → `200 {"status":"ok","database":"up"}`, or `503` if the database is down.
- `GET /api/cron/tick` with `Authorization: Bearer <CRON_SECRET>` checks Gmail for merchants with open orders, retries due webhooks, and deletes expired sessions, login codes and rate-limit rows. Run it every minute.
