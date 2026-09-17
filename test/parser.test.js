import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TRUSTED_BANK_DOMAINS as TRUSTED, parseCreditAlert, parseCreditEmail, rupeesToPaise, verifySender } from '../src/parser.js';

const gmailAuth = (value) => ({ name: 'Authentication-Results', value });
const from = (value) => ({ name: 'From', value });
const GENUINE_HDFC = 'mx.google.com; dkim=pass header.i=@hdfcbank.net header.s=sel1 header.b=abc; '
  + 'spf=pass (google.com: domain of alerts@hdfcbank.net designates 1.2.3.4 as permitted sender) smtp.mailfrom=alerts@hdfcbank.net; '
  + 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=hdfcbank.net';

test('rupeesToPaise', () => {
  assert.equal(rupeesToPaise('99'), 9900);
  assert.equal(rupeesToPaise('99.5'), 9950);
  assert.equal(rupeesToPaise('99.07'), 9907);
  assert.equal(rupeesToPaise('99.071'), null);
  assert.equal(rupeesToPaise('-1'), null);
});

test('HDFC style UPI credit', () => {
  const r = parseCreditAlert(`Dear Customer, Rs.99.07 has been credited to your account **1234 by VPA rahul.k@okaxis
    RAHUL KUMAR on 17-09-26. Your UPI transaction reference number is 425112345678. Warm Regards, HDFC Bank`);
  assert.deepEqual(r, { ok: true, amountPaise: 9907, utr: '425112345678', payerVpa: 'rahul.k@okaxis' });
});

test('ICICI style credit with UPI/ info string and balance after the amount', () => {
  const r = parseCreditAlert('Your ICICI Bank Account XX123 has been credited with INR 1,299.50 on 17-Sep-26. '
    + 'Info: UPI/P2A/425198765432/Payment from PhonePe. The Available Balance is INR 45,000.00.');
  assert.equal(r.ok, true);
  assert.equal(r.amountPaise, 129950);
  assert.equal(r.utr, '425198765432');
});

test('Kotak style "received" with UPI ref', () => {
  const r = parseCreditAlert('Received Rs.250.00 in your Kotak Bank a/c XX4321 from priya@ybl on 17-09-26. UPI Ref:425100001111.');
  assert.deepEqual(r, { ok: true, amountPaise: 25000, utr: '425100001111', payerVpa: 'priya@ybl' });
});

test('debit alerts are ignored', () => {
  const r = parseCreditAlert('Rs.500.00 has been debited from account **1234 to VPA shop@paytm. UPI Ref No 425100002222');
  assert.deepEqual(r, { ok: false, reason: 'debit alert' });
});

test('marketing mail mentioning money is ignored', () => {
  assert.equal(parseCreditAlert('You have received a special offer! Cashback up to Rs 500 on your credit card.').ok, false);
});

test('email addresses are not mistaken for the payer VPA', () => {
  const r = parseCreditAlert('Rs 10 credited. UTR 425100003333. Queries: support@hdfcbank.net');
  assert.equal(r.payerVpa, null);
});

test('falls back to the HTML part', () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('Please view this email in HTML') } },
      { mimeType: 'text/html', body: { data: b64('<p>&#8377;&nbsp;10.03 credited to a/c **99</p><td>UTR: 425100004444</td>') } },
    ],
  };
  assert.deepEqual(parseCreditEmail(payload), { ok: true, amountPaise: 1003, utr: '425100004444', payerVpa: null });
});

test('genuine bank email passes sender verification', () => {
  const r = verifySender([gmailAuth(GENUINE_HDFC), from('HDFC Bank InstaAlerts <alerts@hdfcbank.net>')], TRUSTED);
  assert.deepEqual(r, { ok: true, domain: 'hdfcbank.net' });
});

test('new .bank.in domains are trusted', () => {
  const auth = 'mx.google.com; dkim=pass header.i=@hdfcbank.bank.in; dmarc=pass (p=REJECT) header.from=hdfcbank.bank.in';
  assert.equal(verifySender([gmailAuth(auth), from('alerts@hdfcbank.bank.in')], TRUSTED).ok, true);
});

test('spoofed From address fails DMARC', () => {
  const auth = 'mx.google.com; spf=softfail smtp.mailfrom=evil@attacker.com; dmarc=fail (p=REJECT) header.from=hdfcbank.net';
  assert.equal(verifySender([gmailAuth(auth), from('alerts@hdfcbank.net')], TRUSTED).ok, false);
});

test('attacker-added Authentication-Results below Gmail\'s is not trusted', () => {
  const real = 'mx.google.com; dkim=pass header.i=@attacker.com; dmarc=fail header.from=hdfcbank.net';
  const forged = 'mx.google.com; dkim=pass header.i=@hdfcbank.net; dmarc=pass header.from=hdfcbank.net';
  assert.equal(verifySender([gmailAuth(real), gmailAuth(forged), from('alerts@hdfcbank.net')], TRUSTED).ok, false);
});

test('look-alike domains are not trusted', () => {
  for (const addr of ['alerts@hdfcbank.net.evil.com', 'alerts@evilhdfcbank.net', 'alerts@gmail.com']) {
    const domain = addr.split('@')[1];
    const auth = `mx.google.com; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain}`;
    assert.equal(verifySender([gmailAuth(auth), from(addr)], TRUSTED).ok, false, addr);
  }
});
