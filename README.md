# UPI Gateway (email-verified)

Accept UPI payments to your own UPI ID and confirm them automatically by reading your bank's credit alert emails from Gmail.

## How a payment is verified

1. **Unique amount per order.** Asking for ₹99 creates an order for ₹99.01. A second ₹99 order open at the same time gets ₹99.02, and so on. The exact base amount is never handed out.
2. The payer scans the QR code or taps "Open UPI app" and pays that exact amount.
3. Your bank sends a "₹99.02 credited … UPI Ref 425112345678" email to your Gmail.
4. Every 15 seconds the poller reads new emails from known bank domains and:
   - **Rejects spoofed emails.** The sender must be a trusted bank domain, and Gmail's own `Authentication-Results` header must show DKIM/DMARC passed for that domain. Anyone can type `From: alerts@hdfcbank.net`, but they can't pass DKIM for it.
   - Parses the amount, the 12-digit UTR and the payer's VPA.
   - Matches it to the open order with that exact amount. The UTR is stored as unique, so one bank credit can never pay two orders.
5. The order is marked paid, the payment page updates, and your webhook is called.

**Fallback:** if the payer's app paid a rounded amount (₹99.00), they can enter the UTR on the payment page. Once the bank email with that UTR and amount arrives, the order is paid. An exact-amount match always wins over a UTR claim, so someone who learns another person's UTR can't steal their payment.

## Setup

1. **Turn on email alerts** for UPI/account credits in your bank's netbanking, going to the Gmail account you'll sign in with. Forwarded emails fail DKIM and will be ignored.
2. **Google Cloud Console** (https://console.cloud.google.com):
   - Create a project and enable the **Gmail API**.
   - OAuth consent screen: User type **External**, publishing status **Testing**. Add your Gmail address under **Test users**.
   - Credentials → Create OAuth client ID → **Web application**. Authorised redirect URI: `http://localhost:3000/auth/google/callback`.
3. **Postgres.** Any Postgres works; [Prisma Postgres](https://www.prisma.io/postgres) has a free tier. Copy its connection string.
4. Configure and run (Node 22.18 or newer):
   ```bash
   cp .env.example .env   # fill in DATABASE_URL, Google client id/secret and SESSION_SECRET
   npm install            # also generates the Prisma client
   npm run db:migrate     # creates the tables
   npm start              # http://localhost:3000
   ```
5. Sign in, set your UPI ID on the dashboard, then click **Scan last 3 days** to check that your bank's emails are recognised. Create a ₹1 test order and pay it from another UPI account.

If your bank's alerts show up as ignored, look at the reason in the "Bank emails seen" table. Add a missing sender domain with `TRUSTED_BANK_DOMAINS`, or adjust the regexes in [src/parser.js](src/parser.js) and add a sample to [test/parser.test.js](test/parser.test.js).

## API

```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Authorization: Bearer <api key from dashboard>" \
  -H "Content-Type: application/json" \
  -d '{"amount": "99", "note": "Ice Cream", "redirect_url": "https://example.com/thanks"}'
```

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/orders` | API key | Create an order; send the customer to `pay_url` |
| `GET /api/orders` | API key | Your recent orders |
| `GET /api/orders/:id` | none | Order status (`pending` / `paid` / `expired`) |
| `POST /api/orders/:id/claim` | none | Payer submits `{ "utr": "425112345678" }` |

Webhook on payment: `POST <webhook_url>` with body `{"event":"order.paid","data":{...order}}` and header `x-signature: sha256=<hex HMAC-SHA256 of the raw body using your webhook secret>`. Verify the signature before trusting it.

## Limitations (it's a project, not a bank)

- **Speed depends on your bank's emails.** Most arrive within seconds; some take minutes. Orders stay matchable for 10 minutes after they expire.
- **Email formats vary by bank** and change over time. The parser is regex-based and tested against HDFC-, ICICI- and Kotak-style texts.
- **Gmail read access is a Google "restricted" scope.** In Testing mode only listed test users can sign in, and refresh tokens expire after 7 days (you'll be asked to sign in again). Publishing to real users requires Google's security review.
- **At most 99 open orders per base amount** at a time, per merchant.
- Webhooks aren't retried, and there's no rate limiting on UTR claims.
- Banks may restrict personal UPI IDs that receive lots of business payments.

## Data

The schema is in [prisma/schema.prisma](prisma/schema.prisma). Every signed-in Google account is a `Merchant`, and all of its orders, bank transactions and scanned emails reference it (deleted with it). Every query filters by that merchant, so one user's bank emails can never pay another user's orders. Unique amounts and "a UTR is counted once" are also per user.

After changing the schema, create a migration with `npx prisma migrate dev --name <change>`, then commit the new folder in `prisma/migrations`.

## Tests

```bash
npm test
```

The parser tests need nothing. The order-matching tests use `DATABASE_URL` from `.env`, but run in a separate `gateway_test` schema that is dropped and rebuilt from the migrations on every run, so your real tables are untouched. Without `DATABASE_URL` they are skipped.
