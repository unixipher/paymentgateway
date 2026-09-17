// Pure functions that turn a Gmail API message into "was this a genuine UPI credit, and for how much".
// No I/O here so it can be unit tested with sample emails.

export const DEFAULT_TRUSTED_BANK_DOMAINS = [
  'bank.in', // RBI-reserved domain that Indian banks are moving to (e.g. hdfcbank.bank.in)
  'hdfcbank.net', 'hdfcbank.com', 'sbi.co.in', 'icicibank.com', 'axisbank.com', 'kotak.com',
  'yesbank.in', 'idfcfirstbank.com', 'indusind.com', 'pnb.co.in', 'bankofbaroda.com',
  'canarabank.com', 'unionbankofindia.co.in', 'federalbank.co.in', 'aubank.in',
];

export const header = (headers, name) =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const domainMatches = (domain, trusted) => domain === trusted || domain.endsWith('.' + trusted);
const aligned = (a, b) => domainMatches(a, b) || domainMatches(b, a);

export function verifySender(headers, trustedDomains) {
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
    .map((m) => m[1].toLowerCase());
  if (dmarc === fromDomain || dkim.some((d) => aligned(d, fromDomain))) return { ok: true, domain: fromDomain };
  return { ok: false, reason: 'DKIM/DMARC did not pass (spoofed or forwarded email?)' };
}

export function rupeesToPaise(value) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

const htmlToText = (html) => html
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');

// A 12 digit UPI reference (UTR/RRN), preferring one that is explicitly labelled.
function findUtr(text) {
  const labelled = text.match(/\b(?:UTR|RRN|ref(?:erence)?)(?:\s*(?:no|number|id))?\.?(?:\s*is)?\s*[:#-]?\s*(\d{12})\b/i);
  if (labelled) return labelled[1];
  const slashed = text.match(/\bUPI\/(?:[A-Z0-9]+\/)?(\d{12})\b/i); // e.g. "Info: UPI/P2A/425112345678/NAME"
  if (slashed) return slashed[1];
  return /\b(UPI|IMPS)\b/i.test(text) ? text.match(/\b(\d{12})\b/)?.[1] ?? null : null;
}

export function parseCreditAlert(rawText) {
  const text = rawText.replace(/\s+/g, ' ');
  if (/\b(debited|withdrawn|spent)\b/i.test(text)) return { ok: false, reason: 'debit alert' };

  const credited = /\b(credited|has credit|credit of)\b/i.test(text);
  const received = /\b(received|deposited)\b/i.test(text);
  if (!credited && !received) return { ok: false, reason: 'not a credit alert' };

  const amount = text.match(/(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amountPaise = amount && rupeesToPaise(amount[1].replace(/,/g, ''));
  if (!amountPaise) return { ok: false, reason: 'no amount found' };

  const utr = findUtr(text);
  // "received" alone shows up in marketing mail too, so demand a UPI reference in that case.
  if (!credited && !utr) return { ok: false, reason: 'no UPI reference found' };

  const payerVpa = text.match(/\b([a-z0-9][a-z0-9._-]*@[a-z][a-z0-9]*)\b(?!\.[a-z0-9])/i)?.[1] ?? null;
  return { ok: true, amountPaise, utr, payerVpa };
}

export function parseCreditEmail(payload) {
  const plain = [];
  const html = [];
  (function walk(part) {
    if (!part) return;
    if (part.body?.data) {
      const content = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (part.mimeType === 'text/plain') plain.push(content);
      else if (part.mimeType === 'text/html') html.push(content);
    }
    part.parts?.forEach(walk);
  })(payload);

  // Some banks put junk like "view this mail in HTML" in the plain part, so fall back to the HTML.
  const candidates = [plain.join('\n'), htmlToText(html.join('\n'))].filter((t) => t.trim());
  let result = { ok: false, reason: 'empty body' };
  for (const text of candidates) {
    result = parseCreditAlert(text);
    if (result.ok) break;
  }
  return result;
}
