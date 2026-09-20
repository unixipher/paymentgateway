import { describe, expect, test } from 'vitest';
import { BANK_IDENTITIES, bankKeyFor, bankKeyForDomain, banksNamedInAlert, identifyRegisteredBank } from '@/lib/banks';
import { allBankHeaders, bankChoices, bankForHeader, verifySmsSender } from '@/lib/dlt';
import { BANK_SMS_HEADERS } from '@/lib/sms-headers.generated';

describe("TRAI's register of headers", () => {
  test('resolves a header to the bank that holds it', () => {
    expect(bankForHeader('HDFCBK')).toEqual({ name: 'HDFC BANK LIMITED', key: 'hdfc' });
    expect(bankForHeader('SBIUPI')).toEqual({ name: 'STATE BANK OF INDIA', key: 'sbi' });
    expect(bankForHeader('CENTBK')).toEqual({ name: 'Central Bank of India', key: 'central' });
  });

  test('covers banks well past the major ones', () => {
    // Every co-operative, small finance and regional bank in the register is trusted on its own
    // header, which is the point of using the register instead of a hand-written list.
    expect(Object.keys(BANK_SMS_HEADERS).length).toBeGreaterThan(1500);
    expect(new Set(Object.values(BANK_SMS_HEADERS)).size).toBeGreaterThan(600);
    for (const header of ['RBLBNK', 'CSBBNK', 'UCOBNK', 'BOIIND', 'SIBSMS', '111917']) {
      expect(verifySmsSender(header).ok).toBe(true);
    }
  });

  test('a header no bank holds is refused', () => {
    expect(bankForHeader('HDFCBX')).toBeNull();
    expect(verifySmsSender('VM-HDFCBX')).toMatchObject({ ok: false, reason: /not a header registered to a bank/ });
  });

  test('a header held by an entity that is not a bank is refused', () => {
    // CANMNY is Canara Bank Securities, CHOINS an insurer, BANKIT a fintech: all excluded.
    for (const header of ['CANMNY', 'CHOINS', 'BANKIT', 'BOMSCT', 'STELLA']) {
      expect(bankForHeader(header)).toBeNull();
    }
  });

  test('headers assigned after the register was published are kept by hand', () => {
    expect(BANK_SMS_HEADERS.KOTAKD).toBeUndefined();
    expect(bankForHeader('KOTAKD')?.key).toBe('kotak');
  });

  test('a merchant can add their own bank', () => {
    expect(verifySmsSender('VM-NEWBNK').ok).toBe(false);
    expect(verifySmsSender('VM-NEWBNK', { extraTrusted: ['NEWBNK'] }).ok).toBe(true);
  });

  test('the phone is told every header a bank alert may come from', () => {
    const headers = allBankHeaders(['NEWBNK']);
    expect(headers).toContain('HDFCBK');
    expect(headers).toContain('KOTAKD');
    expect(headers).toContain('NEWBNK');
    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe('header structure', () => {
  test('the operator prefix must be one TRAI assigned', () => {
    expect(verifySmsSender('VM-HDFCBK').ok).toBe(true); // Vodafone Idea, Mumbai
    expect(verifySmsSender('ZD-HDFCBK')).toMatchObject({ ok: false, reason: /no such operator code "Z"/ });
    expect(verifySmsSender('AQ-HDFCBK')).toMatchObject({ ok: false, reason: /no such service area code "Q"/ });
  });

  test('a promotional SMS is never a bank alert', () => {
    expect(verifySmsSender('VM-HDFCBK-T').ok).toBe(true);
    expect(verifySmsSender('VM-HDFCBK-S').ok).toBe(true);
    expect(verifySmsSender('VM-HDFCBK-G').ok).toBe(true);
    expect(verifySmsSender('VM-HDFCBK-P')).toMatchObject({ ok: false, reason: /promotional/ });
    expect(verifySmsSender('VM-HDFCBK-X')).toMatchObject({ ok: false, reason: /no such message type "X"/ });
  });

  test('anything that is not a header is refused', () => {
    for (const sender of ['+919812345678', '9812345678', 'VM-HDFCBK-SPAM', 'VM HDFCBK', 'HDFC BK']) {
      expect(verifySmsSender(sender).ok).toBe(false);
    }
  });
});

describe('the bank the alert names', () => {
  const HDFC_ALERT = 'Credit Alert! Rs.10.01 credited to HDFC Bank A/c XX1234 on 18-09-26 from VPA payer@okaxis (UPI 425100000001)';
  const SBI_ALERT = 'Dear UPI user A/C X1234 credited by 10.01 on date 18Sep26 trf from PAYER NAME Refno 425100000002. If not u? call 1800111109. -SBI';

  test('agrees with the header on a genuine alert', () => {
    expect(verifySmsSender('VM-HDFCBK-S', { text: HDFC_ALERT }).ok).toBe(true);
    expect(verifySmsSender('JD-SBIUPI-S', { text: SBI_ALERT }).ok).toBe(true);
  });

  test("refuses one bank's alert sent under another bank's header", () => {
    expect(verifySmsSender('VM-HDFCBK-S', { text: SBI_ALERT }))
      .toMatchObject({ ok: false, reason: /belongs to HDFC BANK LIMITED but the alert names sbi/ });
    expect(verifySmsSender('JD-SBIUPI-S', { text: HDFC_ALERT }))
      .toMatchObject({ ok: false, reason: /belongs to STATE BANK OF INDIA but the alert names hdfc/ });
  });

  test("the payer's VPA is their bank, not the sender's", () => {
    // okaxis would otherwise make an HDFC alert look like it came from Axis.
    expect(banksNamedInAlert(HDFC_ALERT)).toEqual(new Set(['hdfc']));
    expect(banksNamedInAlert('Rs.10.01 credited to A/c XX1 from payer@oksbi')).toEqual(new Set());
  });

  test('an alert that names no bank we know is left to the header alone', () => {
    expect(banksNamedInAlert('Rs.10.01 credited to A/c XX1234 UPI Ref 425100000001')).toEqual(new Set());
    expect(verifySmsSender('VM-HDFCBK-S', { text: 'Rs.10.01 credited to A/c XX1234 UPI Ref 425100000001' }).ok).toBe(true);
  });

  test('a bank we cannot recognise in an alert is still trusted on its header', () => {
    const coOp = '111917'; // The Karad Urban Cooperative Bank
    expect(identifyRegisteredBank(BANK_SMS_HEADERS[coOp]!)).toBeNull();
    expect(verifySmsSender(coOp, { text: SBI_ALERT }).ok).toBe(true);
  });

  test('every bank in the table matches a real name in the register', () => {
    // Keeps the table honest: a name that stops matching the register would silently stop checking.
    const names = [...new Set(Object.values(BANK_SMS_HEADERS))];
    for (const bank of BANK_IDENTITIES) {
      expect(names.filter((name) => bank.registered.test(name)), `${bank.key} matches no registered bank`)
        .not.toHaveLength(0);
    }
  });

  test('no two banks in the table claim the same alert text', () => {
    for (const bank of BANK_IDENTITIES) {
      const others = BANK_IDENTITIES.filter((o) => o.key !== bank.key && o.registered.test(bankNameFor(bank.key)));
      expect(others, `${bank.key} overlaps ${others.map((o) => o.key).join(', ')}`).toHaveLength(0);
    }
  });
});

function bankNameFor(key: string): string {
  const bank = BANK_IDENTITIES.find((b) => b.key === key)!;
  return [...new Set(Object.values(BANK_SMS_HEADERS))].find((name) => bank.registered.test(name))!;
}

describe("the bank the merchant says they're with", () => {
  const HDFC_ALERT = 'Credit Alert! Rs.10.01 credited to HDFC Bank A/c XX1234 (UPI 425100000001)';

  test('offers every bank in the register, once each', () => {
    const choices = bankChoices();
    expect(choices.length).toBeGreaterThan(600);
    expect(new Set(choices.map((c) => c.key)).size).toBe(choices.length);
    expect(choices).toContainEqual({ key: 'hdfc', name: 'HDFC BANK LIMITED' });
  });

  test('every choice can be matched back to a header', () => {
    for (const key of ['hdfc', 'sbi', 'kotak']) {
      expect(bankChoices().some((c) => c.key === key)).toBe(true);
    }
  });

  test('accepts an alert from the bank the merchant named', () => {
    expect(verifySmsSender('VM-HDFCBK-S', { text: HDFC_ALERT, expectedBank: 'hdfc' }).ok).toBe(true);
  });

  test('refuses an alert from any other bank', () => {
    expect(verifySmsSender('JD-SBIUPI-S', { expectedBank: 'hdfc' }))
      .toMatchObject({ ok: false, reason: /is STATE BANK OF INDIA, not the bank this account is with/ });
    expect(verifySmsSender('VM-CENTBK', { expectedBank: 'hdfc' }).ok).toBe(false);
  });

  test("all of a bank's headers count as that bank", () => {
    // Kotak811's KOTAKD is not in the register but is still Kotak, like KOTAKB.
    for (const header of ['KOTAKB', 'KOTAKD']) {
      expect(verifySmsSender(header, { expectedBank: 'kotak' }).ok).toBe(true);
    }
    expect(bankKeyFor('Kotak Mahindra Bank Ltd')).toBe(bankKeyFor('Kotak Mahindra Bank (Kotak811)'));
  });

  test('a co-operative bank can be named just as exactly', () => {
    const karad = bankChoices().find((c) => /Karad Urban/i.test(c.name))!;
    expect(verifySmsSender('111917', { expectedBank: karad.key }).ok).toBe(true);
    expect(verifySmsSender('VM-HDFCBK', { expectedBank: karad.key }).ok).toBe(false);
  });

  test('a header we cannot attribute to a bank narrows nothing', () => {
    // TRUSTED_SMS_SENDERS names no bank, so it stays trusted whatever the merchant chose.
    expect(verifySmsSender('VM-NEWBNK', { extraTrusted: ['NEWBNK'], expectedBank: 'hdfc' }).ok).toBe(true);
  });

  test('saying nothing keeps every bank trusted, as before', () => {
    expect(verifySmsSender('JD-SBIUPI-S', { expectedBank: null }).ok).toBe(true);
    expect(verifySmsSender('JD-SBIUPI-S').ok).toBe(true);
  });

  test('a bank email domain resolves to the same key as its headers', () => {
    expect(bankKeyForDomain('hdfcbank.net')).toBe('hdfc');
    expect(bankKeyForDomain('alerts.icicibank.com')).toBe('icici');
    expect(bankKeyForDomain('bank.in')).toBeNull(); // shared by many banks, so it narrows nothing
    expect(bankKeyForDomain('example.com')).toBeNull();
  });
});
