import { describe, expect, test } from 'vitest';
import { rupeesToPaise } from '@/lib/money';
import {
  DEFAULT_TRUSTED_BANK_DOMAINS as TRUSTED, DEFAULT_TRUSTED_NOTIFICATION_APPS, DEFAULT_TRUSTED_SMS_SENDERS, parseCreditAlert,
  parseCreditEmail, parseFailedPayment, verifyNotificationApp, verifySender, verifySmsSender, type GmailHeader,
} from '@/lib/parser';

const gmailAuth = (value: string): GmailHeader => ({ name: 'Authentication-Results', value });
const from = (value: string): GmailHeader => ({ name: 'From', value });
const GENUINE_HDFC = 'mx.google.com; dkim=pass header.i=@hdfcbank.net header.s=sel1 header.b=abc; '
  + 'spf=pass (google.com: domain of alerts@hdfcbank.net designates 1.2.3.4 as permitted sender) smtp.mailfrom=alerts@hdfcbank.net; '
  + 'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=hdfcbank.net';
// Real Kotak811 / Kotak emails (names, accounts and references changed).
const DISCLAIMER = 'The recipient if not the addressee should not use this message if erroneously received, and access and use of this e-mail in any manner by anyone other than the addressee is unauthorized.';

test('rupeesToPaise', () => {
  expect(rupeesToPaise('99')).toBe(9900);
  expect(rupeesToPaise('99.5')).toBe(9950);
  expect(rupeesToPaise('99.07')).toBe(9907);
  expect(rupeesToPaise('99.071')).toBeNull();
  expect(rupeesToPaise('-1')).toBeNull();
});

describe('credit alerts', () => {
  test('HDFC style UPI credit', () => {
    expect(parseCreditAlert(`Dear Customer, Rs.99.07 has been credited to your account **1234 by VPA rahul.k@okaxis
      RAHUL KUMAR on 17-09-26. Your UPI transaction reference number is 425112345678. Warm Regards, HDFC Bank`))
      .toEqual({ ok: true, amountPaise: 9907, utr: '425112345678', payerVpa: 'rahul.k@okaxis', payerName: null });
  });

  test('ICICI style credit with UPI/ info string and balance after the amount', () => {
    const r = parseCreditAlert('Your ICICI Bank Account XX123 has been credited with INR 1,299.50 on 17-Sep-26. '
      + 'Info: UPI/P2A/425198765432/Payment from PhonePe. The Available Balance is INR 45,000.00.');
    expect(r).toMatchObject({ ok: true, amountPaise: 129950, utr: '425198765432' });
  });

  test('Kotak style "received" with UPI ref', () => {
    expect(parseCreditAlert('Received Rs.250.00 in your Kotak Bank a/c XX4321 from priya@ybl on 17-09-26. UPI Ref:425100001111.'))
      .toEqual({ ok: true, amountPaise: 25000, utr: '425100001111', payerVpa: 'priya@ybl', payerName: null });
  });

  test('Kotak811 UPI credit alert', () => {
    expect(parseCreditAlert(`If you are unable to view the below e-mailer, please click here . Hi 811 Customer, You’ve received a
      UPI Credit in your Kotak A/c (XX1111). Here's the summary of your transaction: Date: 17-Sep-26 Amount: ₹1.01
      Sender: SOME PERSON UPI Reference Number (RRN): 626000000001 View balance: https://kotak811.com/mbapp/pay
      Digitally yours, Kotak811. Please do not reply to this mail. ${DISCLAIMER}`))
      .toEqual({ ok: true, amountPaise: 101, utr: '626000000001', payerVpa: null, payerName: 'SOME PERSON' });
  });

  test('falls back to the HTML part', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(parseCreditEmail({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Please view this email in HTML') } },
        { mimeType: 'text/html', body: { data: b64('<p>&#8377;&nbsp;10.03 credited to a/c **99</p><td>UTR: 425100004444</td>') } },
      ],
    })).toEqual({ ok: true, amountPaise: 1003, utr: '425100004444', payerVpa: null, payerName: null });
  });

  test('email addresses are not mistaken for the payer VPA', () => {
    expect(parseCreditAlert('Rs 10 credited. UTR 425100003333. Queries: support@hdfcbank.net')).toMatchObject({ payerVpa: null });
  });
});

describe('emails that must not count as payments', () => {
  test('debit alerts', () => {
    expect(parseCreditAlert('Rs.500.00 has been debited from account **1234 to VPA shop@paytm. UPI Ref No 425100002222'))
      .toEqual({ ok: false, reason: 'debit alert' });
  });

  test('Kotak811 failed UPI payment with refund', () => {
    expect(parseCreditAlert(`Hi 811 Customer, Your UPI payment failed. Here's the summary of your transaction: Date: 17-Sep-26
      Amount: ₹1.01 Debit A/c/Card Details: XX1111 Receiver: SOME PERSON UPI Reference Number (RRN): 626000000002
      Refund has now been successfully credited back to your Kotak Account.`))
      .toEqual({ ok: false, reason: 'failed or reversed transaction' });
  });

  test('Kotak debit card purchase', () => {
    expect(parseCreditAlert(`Dear Customer, Your transaction of Rs.166.00 on SWIGGY using Kotak Bank Debit Card XX2222 on
      16/09/2026 18:35:19 from your account XX1111 has been processed. The transaction reference No is 625000000003 &
      Available balance is Rs.647.59. please do not share any senstitive information such as your Debit/ Credit/ Spendz
      Card details. Regards Kotak Mahindra Bank. ${DISCLAIMER}`).ok).toBe(false);
  });

  test('"received" in a legal footer', () => {
    expect(parseCreditAlert(`Your transaction of Rs.86.00 on FLIPKART has been processed. Reference No is 625000000004. ${DISCLAIMER}`))
      .toEqual({ ok: false, reason: 'not a credit alert' });
  });

  test.each([
    'Your UPI transaction of Rs.99.07 to be credited to your account **1234 has failed. UPI Ref No 425100005555.',
    'UPI transaction FAILED: Rs 99.07 from rahul@okaxis. UTR 425100005556',
    'Rs.99.07 credit to your a/c XX1234 was unsuccessful. UPI Ref 425100005557',
    'The credit of INR 99.07 could not be processed. RRN 425100005558',
    'Rs.99.07 has not been credited to your account. UPI Ref No 425100005559',
    'Rs.99.07 has been credited to your account towards reversal of UPI txn 425100005560',
    'Transaction declined. Rs.99.07 received from priya@ybl. UPI Ref:425100005561',
    'Rs.99.07 will be credited back to your account. UTR 425100005562',
  ])('failed/declined/reversed: %s', (text) => {
    expect(parseCreditAlert(text)).toEqual({ ok: false, reason: 'failed or reversed transaction' });
  });

  test('a failure in the subject line rules out the email even if the body looks like a credit', () => {
    expect(parseCreditEmail({
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: 'Alert: UPI transaction failed' }],
      body: { data: Buffer.from('Rs.99.07 credited to a/c **1234. UPI Ref No 425100005563').toString('base64url') },
    })).toEqual({ ok: false, reason: 'failed or reversed transaction' });
  });

  test('marketing mail mentioning money', () => {
    expect(parseCreditAlert('You have received a special offer! Cashback up to Rs 500 on your credit card.').ok).toBe(false);
  });
});

describe('sender verification', () => {
  test('genuine bank email passes', () => {
    expect(verifySender([gmailAuth(GENUINE_HDFC), from('HDFC Bank InstaAlerts <alerts@hdfcbank.net>')], TRUSTED))
      .toEqual({ ok: true, domain: 'hdfcbank.net' });
  });

  test('new .bank.in domains are trusted', () => {
    const auth = 'mx.google.com; dkim=pass header.i=@hdfcbank.bank.in; dmarc=pass (p=REJECT) header.from=hdfcbank.bank.in';
    expect(verifySender([gmailAuth(auth), from('alerts@hdfcbank.bank.in')], TRUSTED).ok).toBe(true);
  });

  test('spoofed From address fails DMARC', () => {
    const auth = 'mx.google.com; spf=softfail smtp.mailfrom=evil@attacker.com; dmarc=fail (p=REJECT) header.from=hdfcbank.net';
    expect(verifySender([gmailAuth(auth), from('alerts@hdfcbank.net')], TRUSTED).ok).toBe(false);
  });

  test("attacker-added Authentication-Results below Gmail's is not trusted", () => {
    const real = 'mx.google.com; dkim=pass header.i=@attacker.com; dmarc=fail header.from=hdfcbank.net';
    const forged = 'mx.google.com; dkim=pass header.i=@hdfcbank.net; dmarc=pass header.from=hdfcbank.net';
    expect(verifySender([gmailAuth(real), gmailAuth(forged), from('alerts@hdfcbank.net')], TRUSTED).ok).toBe(false);
  });

  test.each(['alerts@hdfcbank.net.evil.com', 'alerts@evilhdfcbank.net', 'alerts@gmail.com'])('look-alike domain %s', (addr) => {
    const domain = addr.split('@')[1];
    const auth = `mx.google.com; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain}`;
    expect(verifySender([gmailAuth(auth), from(addr)], TRUSTED).ok).toBe(false);
  });
});

describe('failed payments (any bank)', () => {
  test.each([
    [`UPI Transaction Alert: Payment could not be processed Hi 811 Customer, Your UPI payment failed. Here's the summary of your
      transaction: Date: 17-Sep-26 Amount: ₹1.01 Debit A/c/Card Details: XX1111 Receiver: SOME PERSON UPI Reference Number (RRN):
      662600000002 Refund has now been successfully credited back to your Kotak Account.`, '662600000002', 101],
    ['Your UPI transaction of Rs.99.07 to shop@okhdfcbank has failed. UPI Ref No 425100005555.', '425100005555', 9907],
    ['Txn of INR 250.00 declined. Amount will be reversed. RRN: 425100005556', '425100005556', 25000],
  ])('%s', (text, utr, amountPaise) => {
    expect(parseFailedPayment(text)).toEqual({ ok: true, utr, amountPaise });
  });

  test('successful payments and failures without a reference are not failed payments', () => {
    expect(parseFailedPayment('You have successfully made a UPI payment of INR 1.00. UPI Reference Number: 662609379427').ok).toBe(false);
    expect(parseFailedPayment('Your UPI payment failed. Please try again.').ok).toBe(false);
  });
});

describe('bank SMS and app notifications', () => {
  test.each([
    ['HDFC', 'Credit Alert!\nRs.10.01 credited to HDFC Bank A/c XX1234 on 18-09-26 from VPA payer@okaxis (UPI 425100000001)', 1001, '425100000001'],
    ['SBI, no currency', 'Dear UPI user A/C X1234 credited by 10.01 on date 18Sep26 trf from PAYER NAME Refno 425100000002. If not u? call 1800111109. -SBI', 1001, '425100000002'],
    ['ICICI', 'ICICI Bank Account XX123 credited:Rs. 1,250.50 on 18-Sep-26. Info UPI/P2A/425100000003/PAYER. Available Balance is Rs. 5,000.00.', 125050, '425100000003'],
  ])('%s credit SMS', (_, sms, amountPaise, utr) => {
    expect(parseCreditAlert(sms)).toMatchObject({ ok: true, amountPaise, utr });
  });

  test('debit and failed SMS are not credits', () => {
    expect(parseCreditAlert('Rs.500.00 debited from A/c XX1234 on 18-09-26 to VPA shop@okaxis (UPI 425100000004)').ok).toBe(false);
    expect(parseCreditAlert('UPI txn of Rs 10.01 failed. Amount will be credited back to A/c XX1234. Ref 425100000005').ok).toBe(false);
  });

  test.each(['VM-HDFCBK', 'JD-HDFCBK-S', 'ax-sbiupi-t'])('trusted SMS sender %s', (sender) => {
    expect(verifySmsSender(sender, DEFAULT_TRUSTED_SMS_SENDERS).ok).toBe(true);
  });

  test.each(['+919812345678', 'HDFCBK', 'VM-HDFCBX', 'VM-HDFCBK-SPAM', 'VM-HDFCBK1'])('untrusted SMS sender %s', (sender) => {
    expect(verifySmsSender(sender, DEFAULT_TRUSTED_SMS_SENDERS).ok).toBe(false);
  });

  test('notifications count only from trusted apps', () => {
    expect(verifyNotificationApp('com.phonepe.app', DEFAULT_TRUSTED_NOTIFICATION_APPS).ok).toBe(true);
    expect(verifyNotificationApp('com.example.phonepe.app', DEFAULT_TRUSTED_NOTIFICATION_APPS).ok).toBe(false);
  });
});

test('Kotak811 UPI credit email names the sender', () => {
  const email = `Hi 811 Customer,

You’ve received a UPI Credit in your Kotak A/c (XX4007).

Here's the summary of your transaction:
Date: 18-Sep-26
Amount: ₹1.02
Sender: MRINMOY HALDER
UPI Reference Number (RRN): 314961406046

View balance: https://kotak811.com/mbapp/pay

For any queries or assistance, please contact our customer care at 1800 4100.`;
  expect(parseCreditAlert(email)).toEqual({ ok: true, amountPaise: 102, utr: '314961406046', payerVpa: null, payerName: 'MRINMOY HALDER' });
  expect(parseCreditAlert('A/C X1234 credited by 10.01 on date 18Sep26 trf from AMAL DAS Refno 425100000002. -SBI')).toMatchObject({ payerName: 'AMAL DAS' });
});
