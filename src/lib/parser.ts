// Pure functions that turn a Gmail API message into "was this a genuine UPI credit, and for how much".
// No I/O here so it can be unit tested with real sample emails.
import { rupeesToPaise } from './money';

export const DEFAULT_TRUSTED_BANK_DOMAINS = [
  'bank.in', // RBI-reserved domain that Indian banks are moving to (e.g. hdfcbank.bank.in)
  'hdfcbank.net', 'hdfcbank.com', 'sbi.co.in', 'icicibank.com', 'axisbank.com', 'kotak.com',
  'yesbank.in', 'idfcfirstbank.com', 'indusind.com', 'pnb.co.in', 'bankofbaroda.com',
  'canarabank.com', 'unionbankofindia.co.in', 'federalbank.co.in', 'aubank.in',
];

/**
 * Core of the DLT sender header banks send SMS alerts from: "VM-HDFCBK-S" → HDFCBK. Indian operators
 * only deliver SMS from a registered header with an operator prefix, so a stranger can't send from one.
 */
export const DEFAULT_TRUSTED_SMS_SENDERS = [
  'HDFCBK', 'SBIUPI', 'SBIINB', 'CBSSBI', 'ICICIB', 'AXISBK', 'KOTAKB', 'YESBNK', 'IDFCFB', 'INDUSB',
  'PNBSMS', 'BOBTXN', 'BOBSMS', 'CANBNK', 'UNIONB', 'FEDBNK', 'AUBANK', 'IDBIBK',
];

/** Apps whose notifications are read: the major UPI apps. Banks' own apps can be added with TRUSTED_NOTIFICATION_APPS. */
export const DEFAULT_TRUSTED_NOTIFICATION_APPS = [
  'com.google.android.apps.nbu.paisa.user', // Google Pay
  'com.phonepe.app',
  'net.one97.paytm',
  'in.org.npci.upiapp', // BHIM
];

export function verifySmsSender(sender: string, trustedSenders: string[]): SenderCheck {
  // Real DLT headers: 2 letter operator/circle prefix, 6 character header, optional type suffix (-S, -T, -P, -G).
  const core = sender.trim().toUpperCase().match(/^[A-Z]{2}-([A-Z0-9]{6})(?:-[A-Z])?$/)?.[1];
  if (!core) return { ok: false, reason: `sender ${sender} is not a bank SMS header` };
  if (!trustedSenders.includes(core)) return { ok: false, reason: `sender ${sender} is not a trusted bank` };
  return { ok: true, domain: sender.trim().toUpperCase() };
}

export function verifyNotificationApp(packageName: string, trustedApps: string[]): SenderCheck {
  return trustedApps.includes(packageName)
    ? { ok: true, domain: packageName }
    : { ok: false, reason: `app ${packageName} is not trusted` };
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPart[];
}

export type SenderCheck = { ok: true; domain: string } | { ok: false; reason: string };
export type CreditAlert =
  | { ok: true; amountPaise: number; utr: string | null; payerVpa: string | null }
  | { ok: false; reason: string };

export const header = (headers: GmailHeader[], name: string): string =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const domainMatches = (domain: string, trusted: string) => domain === trusted || domain.endsWith(`.${trusted}`);
const aligned = (a: string, b: string) => domainMatches(a, b) || domainMatches(b, a);

export function verifySender(headers: GmailHeader[], trustedDomains: string[]): SenderCheck {
  const fromDomain = header(headers, 'From').match(/@([a-z0-9.-]+)>?\s*$/i)?.[1]?.toLowerCase();
  if (!fromDomain) return { ok: false, reason: 'no sender address' };
  if (!trustedDomains.some((t) => domainMatches(fromDomain, t))) {
    return { ok: false, reason: `sender ${fromDomain} is not a trusted bank` };
  }

  // Anyone can send an email with "From: alerts@hdfcbank.net". What can't be faked is Gmail's own
  // verdict: the top-most Authentication-Results header, which Gmail prepends when the mail arrives.
  // Headers an attacker adds themselves always sit below it, so only the first one is trusted.
  const auth = headers.find((h) => h.name.toLowerCase() === 'authentication-results')?.value ?? '';
  if (!/^\s*mx\.google\.com\s*;/i.test(auth)) return { ok: false, reason: 'no Gmail authentication results' };

  const dmarc = auth.match(/\bdmarc=pass\b[^;]*?header\.from=([a-z0-9.-]+)/i)?.[1]?.toLowerCase();
  const dkim = [...auth.matchAll(/\bdkim=pass\b[^;]*?header\.(?:i=[^@\s;]*@|d=)([a-z0-9.-]+)/gi)]
    .map((m) => (m[1] ?? '').toLowerCase());
  if (dmarc === fromDomain || dkim.some((d) => aligned(d, fromDomain))) return { ok: true, domain: fromDomain };
  return { ok: false, reason: 'DKIM/DMARC did not pass (spoofed or forwarded email?)' };
}

const htmlToText = (html: string) => html
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');

// A 12 digit UPI reference (UTR/RRN), preferring one that is explicitly labelled.
function findUtr(text: string): string | null {
  // e.g. "UPI Ref No. 425112345678", "reference number is 425112345678", "Reference Number (RRN): 425112345678"
  const labelled = text.match(/\b(?:UTR|RRN|ref(?:erence)?)(?:\s*(?:no|number|id))?\.?(?:\s*is)?[\s:#().-]*(\d{12})\b/i);
  if (labelled?.[1]) return labelled[1];
  const slashed = text.match(/\bUPI\/(?:[A-Z0-9]+\/)?(\d{12})\b/i); // e.g. "Info: UPI/P2A/425112345678/NAME"
  if (slashed?.[1]) return slashed[1];
  return /\b(UPI|IMPS)\b/i.test(text) ? text.match(/\b(\d{12})\b/)?.[1] ?? null : null;
}

// Failed, declined or reversed transactions still mention the amount and often the words
// "credit"/"credited" ("could not be credited", "will be credited back"), so they must be ruled out first.
const FAILED = new RegExp([
  String.raw`\bfail(?:s|ed|ure)?\b`,
  String.raw`\bunsuccessful(?:ly)?\b`,
  String.raw`\b(?:declined|rejected|reversed|reversal|refund(?:ed)?|timed out)\b`,
  String.raw`\bnot (?:been )?(?:credited|successful|processed|completed)\b`,
  String.raw`\bcould not be (?:credited|processed|completed)\b`,
  String.raw`\bcredited back\b`,
].join('|'), 'i');

export function parseCreditAlert(rawText: string): CreditAlert {
  const text = rawText.replace(/\s+/g, ' ');
  if (FAILED.test(text)) return { ok: false, reason: 'failed or reversed transaction' };
  if (/\b(debited|withdrawn|spent)\b|\busing\b[\w ]{0,40}\b(debit|credit) card\b/i.test(text)) {
    return { ok: false, reason: 'debit alert' };
  }

  const credited = /\b(credited|has credit|credit of|UPI credit)\b/i.test(text);
  // Bare "received" is everywhere in legal footers ("if erroneously received"), so it only counts
  // when it's about money: "Received Rs.250", "received a UPI Credit", "deposited in your a/c".
  const received = /\b(received|deposited)\s+(?:a\s+)?(?:UPI\s+)?(?:₹|Rs\b|INR\b|credit\b|payment\b|money\b|in\b|into\b|to\b)/i.test(text);
  if (!credited && !received) return { ok: false, reason: 'not a credit alert' };

  // SBI's SMS has no currency at all: "A/C X1234 credited by 10.01 on date 18Sep26".
  const amount = text.match(/(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1]
    ?? text.match(/\bcredited (?:by|with|for) ([\d,]+(?:\.\d{1,2})?)\b/i)?.[1];
  const amountPaise = amount ? rupeesToPaise(amount.replace(/,/g, '')) : null;
  if (!amountPaise) return { ok: false, reason: 'no amount found' };

  const utr = findUtr(text);
  // "received" alone shows up in marketing mail too, so demand a UPI reference in that case.
  if (!credited && !utr) return { ok: false, reason: 'no UPI reference found' };

  const payerVpa = text.match(/\b([a-z0-9][a-z0-9._-]*@[a-z][a-z0-9]*)\b(?!\.[a-z0-9])/i)?.[1] ?? null;
  return { ok: true, amountPaise, utr, payerVpa };
}

/** The subject and readable body texts of an email: the plain part first, then the HTML part as text. */
function emailTexts(payload: GmailPart | undefined) {
  const plain: string[] = [];
  const html: string[] = [];
  (function walk(part?: GmailPart) {
    if (!part) return;
    if (part.body?.data) {
      const content = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (part.mimeType === 'text/plain') plain.push(content);
      else if (part.mimeType === 'text/html') html.push(content);
    }
    part.parts?.forEach(walk);
  })(payload);
  // Some banks put junk like "view this mail in HTML" in the plain part, so fall back to the HTML.
  const bodies = [plain.join('\n'), htmlToText(html.join('\n'))].filter((t) => t.trim());
  return { subject: header(payload?.headers ?? [], 'Subject'), bodies };
}

export function parseCreditEmail(payload: GmailPart | undefined): CreditAlert {
  const { subject, bodies } = emailTexts(payload);
  // A failure mentioned anywhere (subject, plain or HTML part) rules the whole email out.
  if (FAILED.test([subject, ...bodies].join(' '))) {
    return { ok: false, reason: 'failed or reversed transaction' };
  }
  let result: CreditAlert = { ok: false, reason: 'empty body' };
  for (const text of bodies) {
    result = parseCreditAlert(text);
    if (result.ok) break;
  }
  return result;
}

export type FailedPaymentAlert = { ok: true; utr: string; amountPaise: number | null } | { ok: false };

/**
 * A failed, declined or reversed UPI payment, in any bank's wording: a failure phrase plus a 12 digit
 * UPI reference. Used only to tell a payer that the reference they submitted belongs to a failed
 * payment, never to mark anything paid, so it can afford to be broad.
 */
export function parseFailedPayment(rawText: string): FailedPaymentAlert {
  const text = rawText.replace(/\s+/g, ' ');
  if (!FAILED.test(text)) return { ok: false };
  const utr = findUtr(text);
  if (!utr) return { ok: false };
  const amount = text.match(/(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  return { ok: true, utr, amountPaise: amount ? rupeesToPaise(amount.replace(/,/g, '')) : null };
}

export function parseFailedPaymentEmail(payload: GmailPart | undefined): FailedPaymentAlert {
  const { subject, bodies } = emailTexts(payload);
  for (const body of bodies) {
    const result = parseFailedPayment(`${subject} ${body}`);
    if (result.ok) return result;
  }
  return { ok: false };
}
