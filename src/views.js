import { formatRupees, orderStatus } from './orders.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (ms) => new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const layout = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --fg:#1a1a1a; --muted:#666; --line:#e3e3e3; --bg:#f7f7f5; --card:#fff; --accent:#0b6bcb; --ok:#1a7f37; --warn:#b35900; --bad:#c62828; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); padding:24px 16px; }
  main { max-width:960px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px; }
  .muted { color:var(--muted); font-size:13px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:end; }
  label { display:block; font-size:13px; color:var(--muted); }
  input { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:6px; min-width:0; width:100%; }
  .row > label { flex:1 1 200px; }
  button, .btn { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; display:inline-block; }
  button.secondary { background:transparent; color:var(--accent); }
  .table-wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  code { background:#f0f0ee; padding:1px 5px; border-radius:4px; font-size:13px; word-break:break-all; }
  pre { background:#f0f0ee; padding:12px; border-radius:6px; overflow-x:auto; font-size:12px; }
  .status { font-weight:600; } .paid { color:var(--ok); } .pending { color:var(--warn); } .expired { color:var(--bad); }
  .alert { background:#fff4e5; border-color:#f0c48a; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export const landing = () => layout('UPI Gateway', `
  <div class="card">
    <h1>UPI Gateway</h1>
    <p>Accept UPI payments to your own UPI ID. Payments are confirmed by reading your bank's credit alert emails
      from Gmail. We only get read access, and only bank alert emails are processed.</p>
    <a class="btn" href="/auth/google">Sign in with Google</a>
  </div>`);

export const errorPage = (message) => layout('Error', `
  <div class="card"><h1>Something went wrong</h1><p>${esc(message)}</p><a href="/">Back</a></div>`);

export function dashboard({ merchant, orders, emails, baseUrl }) {
  const orderRows = orders.map((o) => {
    const status = orderStatus(o);
    return `<tr>
      <td><a href="/pay/${esc(o.id)}">${esc(o.id)}</a></td>
      <td>₹${formatRupees(o.amountPaise)}</td>
      <td class="status ${status}">${status}</td>
      <td>${esc(o.txn?.utr ?? (o.claimedUtr ? `${o.claimedUtr} (claimed)` : ''))}</td>
      <td>${esc(o.txn?.payerVpa ?? '')}</td>
      <td>${esc(o.note ?? '')}</td>
      <td>${time(o.createdAt)}</td>
    </tr>`;
  }).join('');

  const emailRows = emails.map((e) => `<tr>
    <td>${time(e.receivedAt)}</td><td>${esc(e.fromAddr)}</td><td>${esc(e.subject)}</td><td>${esc(e.verdict)}</td>
  </tr>`).join('');

  return layout('Dashboard · UPI Gateway', `
    <div class="card row" style="justify-content:space-between;align-items:center">
      <div><h1>Dashboard</h1><div class="muted">${esc(merchant.email)}</div></div>
      <form method="post" action="/logout"><button class="secondary">Log out</button></form>
    </div>

    ${merchant.refreshToken ? '' : `<div class="card alert">Gmail access has expired or was revoked, so payments
      can't be verified. <a href="/auth/google">Sign in again</a>.</div>`}

    <div class="card">
      <h2>Settings</h2>
      <form method="post" action="/settings">
        <div class="row">
          <label>Your UPI ID (the account whose alerts reach this Gmail)
            <input name="vpa" value="${esc(merchant.vpa)}" placeholder="yourname@okhdfcbank" required></label>
          <label>Name shown to payers
            <input name="display_name" value="${esc(merchant.displayName)}" maxlength="50"></label>
        </div>
        <div class="row" style="margin-top:12px">
          <label>Webhook URL (optional)
            <input name="webhook_url" value="${esc(merchant.webhookUrl)}" placeholder="https://example.com/upi-webhook"></label>
          <button>Save</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Test payment</h2>
      <form method="post" action="/orders/test" class="row">
        <label>Amount (₹)<input name="amount" inputmode="decimal" value="1" required></label>
        <label>Note<input name="note" maxlength="50" placeholder="Test order"></label>
        <button>Create order</button>
      </form>
    </div>

    <div class="card">
      <h2>Orders</h2>
      <div class="table-wrap"><table>
        <tr><th>Order</th><th>Amount</th><th>Status</th><th>UTR</th><th>Payer</th><th>Note</th><th>Created</th></tr>
        ${orderRows || '<tr><td colspan="7" class="muted">No orders yet</td></tr>'}
      </table></div>
    </div>

    <div class="card" id="emails">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Bank emails seen</h2>
        <form method="post" action="/scan"><button class="secondary">Scan last 3 days</button></form>
      </div>
      <p class="muted">Use this to check that your bank's alerts are recognised. Emails are only fetched from known bank domains.</p>
      <div class="table-wrap"><table>
        <tr><th>Received</th><th>From</th><th>Subject</th><th>Result</th></tr>
        ${emailRows || '<tr><td colspan="4" class="muted">Nothing scanned yet</td></tr>'}
      </table></div>
    </div>

    <div class="card">
      <h2>API</h2>
      <p>API key: <code>${esc(merchant.apiKey)}</code></p>
      <p>Webhook secret: <code>${esc(merchant.webhookSecret)}</code></p>
      <pre>curl -X POST ${esc(baseUrl)}/api/orders \\
  -H "Authorization: Bearer ${esc(merchant.apiKey)}" \\
  -H "Content-Type: application/json" \\
  -d '{"amount": "99", "note": "Ice Cream", "redirect_url": "https://example.com/thanks"}'</pre>
      <p class="muted">Send the customer to <code>pay_url</code> from the response. When it's paid we POST
        <code>{"event":"order.paid","data":{...}}</code> to your webhook with header
        <code>x-signature: sha256=HMAC_SHA256(webhook_secret, raw body)</code>. You can also poll
        <code>GET /api/orders/:id</code>.</p>
    </div>`);
}

export function payPage({ order, payeeName, link, qr }) {
  return layout(`Pay ₹${order.amount}`, `
    <div class="card" style="max-width:420px;margin:0 auto;text-align:center">
      <div class="muted">Paying ${esc(payeeName)}${order.note ? ` · ${esc(order.note)}` : ''}</div>
      <h1 style="font-size:36px;margin:8px 0">₹${esc(order.amount)}</h1>
      <p class="muted" style="margin-top:0">Pay <strong>exactly ₹${esc(order.amount)}</strong>. The paise identify your payment.</p>

      <div id="pay-area">
        <img src="${qr}" alt="UPI QR code" width="260" height="260">
        <p><a class="btn" href="${esc(link)}">Open UPI app</a></p>
        <p class="muted">Expires in <span id="countdown">–</span></p>
      </div>

      <p id="status" class="status pending">Waiting for payment…</p>

      <details id="claim" style="text-align:left;margin-top:16px">
        <summary>Paid but still waiting, or paid a different amount?</summary>
        <p class="muted">Enter the 12 digit UPI reference number (UTR) from your UPI app's payment details.</p>
        <form id="claim-form" class="row">
          <label>UTR<input name="utr" inputmode="numeric" pattern="\\d{12}" maxlength="12" required></label>
          <button>Submit</button>
        </form>
        <p id="claim-msg" class="muted"></p>
      </details>
    </div>

    <script>
      let order = ${json(order)};
      const $ = (id) => document.getElementById(id);

      function render() {
        const el = $('status');
        el.className = 'status ' + order.status;
        if (order.status === 'paid') {
          el.textContent = 'Payment received ✓' + (order.utr ? ' (UTR ' + order.utr + ')' : '');
          $('pay-area').hidden = true;
          $('claim').hidden = true;
          if (order.redirect_url) {
            const url = new URL(order.redirect_url);
            url.searchParams.set('order_id', order.id);
            url.searchParams.set('status', 'paid');
            setTimeout(() => location.href = url, 2000);
          }
        } else if (order.status === 'expired') {
          el.textContent = 'This order has expired.';
          $('pay-area').hidden = true;
        }
        const left = Math.max(0, new Date(order.expires_at) - Date.now());
        $('countdown').textContent = Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0');
      }

      async function refresh() {
        if (order.status === 'paid') return;
        const res = await fetch('/api/orders/' + order.id);
        if (res.ok) order = await res.json();
        render();
      }

      $('claim-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/orders/' + order.id + '/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ utr: e.target.utr.value.trim() }),
        });
        const body = await res.json();
        if (!res.ok) return $('claim-msg').textContent = body.error;
        order = body;
        $('claim-msg').textContent = order.status === 'paid'
          ? '' : 'Thanks. We will confirm as soon as the bank alert reaches us.';
        render();
      });

      render();
      setInterval(render, 1000);
      setInterval(refresh, 3000);
    </script>`);
}
