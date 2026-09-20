/**
 * Whether a bank SMS really came from a bank.
 *
 * Indian commercial SMS runs on TRAI's DLT framework (Telecom Commercial Communications Customer
 * Preference Regulations, 2018, as amended). An operator only delivers an alphanumeric-sender SMS
 * if the header is registered to the entity sending it, and no international SMS may arrive with an
 * alphanumeric header at all, so the header is a meaningful claim of identity rather than free text.
 *
 * A header reaches the phone as `XY-ABCDEF-S`:
 *   XY      the originating operator (X) and licensed service area (Y), added by the network
 *   ABCDEF  up to six characters registered to the sender; TRAI publishes who holds each one
 *   -S      the kind of message: Promotional, Service, Transactional or Government
 *
 * Each part is checked here against TRAI's own published tables, so a credit alert counts only when
 * it arrives from a header a real bank holds, over a real operator, as a non-promotional message.
 *
 * Sources in data/trai/README.md.
 */
import { BANK_SMS_HEADERS } from './sms-headers.generated';
import { bankKeyFor, banksNamedInAlert, identifyRegisteredBank } from './banks';

/** Originating access provider ('X'), from TRAI's table of service-provider codes. */
export const OPERATOR_CODES: Readonly<Record<string, string>> = Object.freeze({
  A: 'Bharti Airtel / Bharti Hexacom',
  B: 'Bharat Sanchar Nigam',
  C: 'V-CON Mobile & Infra',
  D: 'Aircel / Dishnet Wireless',
  E: 'Reliance Telecom',
  J: 'Reliance Jio Infocomm',
  M: 'Mahanagar Telephone Nigam',
  R: 'Reliance Communications',
  T: 'Tata Teleservices',
  V: 'Vodafone Idea',
});

/** Licensed service area ('Y'), from TRAI's table of service-area codes. */
export const SERVICE_AREA_CODES: Readonly<Record<string, string>> = Object.freeze({
  A: 'Andhra Pradesh', B: 'Bihar', D: 'Delhi', E: 'UP-East', G: 'Gujarat', H: 'Haryana',
  I: 'Himachal Pradesh', J: 'Jammu & Kashmir', K: 'Kolkata', L: 'Kerala', M: 'Mumbai',
  N: 'North East', O: 'Orissa', P: 'Punjab', R: 'Rajasthan', S: 'Assam', T: 'Tamil Nadu',
  V: 'West Bengal', W: 'UP-West', X: 'Karnataka', Y: 'Madhya Pradesh', Z: 'Maharashtra',
});

/**
 * The suffix TRAI has operators add to say what kind of message it is. A bank's credit alert is
 * transactional or service; a promotional SMS is marketing, and never evidence that money moved.
 */
const MESSAGE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  P: 'promotional', S: 'service', T: 'transactional', G: 'government',
});
const PROMOTIONAL = 'P';

/**
 * Headers assigned after TRAI last published the register, so they are absent from it but genuine.
 * Each needs a comment saying how it was confirmed. Merchants' own banks go in TRUSTED_SMS_SENDERS.
 */
const HEADERS_ADDED_SINCE_THE_REGISTER: Readonly<Record<string, string>> = Object.freeze({
  KOTAKD: 'Kotak Mahindra Bank (Kotak811)', // seen on live Kotak811 credit alerts
});

/**
 * A header as it reaches the phone, broken into its parts. The operator prefix is optional because
 * iPhones show the header without it.
 */
const HEADER = /^(?:([A-Z])([A-Z])-)?([A-Z0-9]{2,11})(?:-([A-Z]))?$/;

export type SenderCheck = { ok: true; domain: string } | { ok: false; reason: string };

/** The bank that holds a header. */
export interface HeaderHolder {
  /** The bank's name, as TRAI's register records it. */
  name: string;
  /** Key for comparing this bank with another sighting of it, or null if we cannot tell which bank. */
  key: string | null;
}

/**
 * The bank a header belongs to, or null if no bank holds it. Looks the header up in TRAI's register
 * first, then in the headers assigned since it was published and those the merchant has configured.
 */
export function bankForHeader(header: string, extraTrusted: readonly string[] = []): HeaderHolder | null {
  const core = header.trim().toUpperCase();
  const registered = BANK_SMS_HEADERS[core] ?? HEADERS_ADDED_SINCE_THE_REGISTER[core];
  if (registered) return { name: registered, key: bankKeyFor(registered) };
  // A header added by hand names no bank, so it can be trusted but not compared with one.
  if (extraTrusted.includes(core)) return { name: 'a bank set in TRUSTED_SMS_SENDERS', key: null };
  return null;
}

let choices: ReadonlyArray<{ key: string; name: string }> | undefined;

/** Every bank a merchant can say their account is with, for the dashboard to offer. */
export function bankChoices(): ReadonlyArray<{ key: string; name: string }> {
  if (choices) return choices;
  const byKey = new Map<string, string>();
  for (const name of Object.values(BANK_SMS_HEADERS)) {
    const key = bankKeyFor(name);
    // Prefer the shortest name a bank is registered under: "FEDERAL BANK" over "THE FEDERAL BANK LTD".
    const existing = byKey.get(key);
    if (!existing || name.length < existing.length) byKey.set(key, name);
  }
  choices = [...byKey]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return choices;
}

/**
 * Whether an SMS is a genuine bank alert, by its sender header and, where both are recognisable,
 * by whether the bank the alert names is the bank that holds the header.
 */
export function verifySmsSender(sender: string, options: {
  /** Headers trusted beyond the register, from TRUSTED_SMS_SENDERS. */
  extraTrusted?: readonly string[];
  /** The alert itself, so the bank it names can be checked against the header. */
  text?: string;
  /** The bank the merchant says their account is with. An alert from another bank is not theirs. */
  expectedBank?: string | null;
} = {}): SenderCheck {
  const { extraTrusted = [], text = '', expectedBank = null } = options;
  const raw = sender.trim().toUpperCase();
  const parts = HEADER.exec(raw);
  if (!parts) return { ok: false, reason: `sender ${sender} is not a bank SMS header` };
  const [, operator, serviceArea, core = '', kind] = parts;

  // The network writes the prefix, so a header carrying one that TRAI has not assigned did not
  // come over an Indian operator as it claims.
  if (operator && !OPERATOR_CODES[operator]) {
    return { ok: false, reason: `sender ${sender} has no such operator code "${operator}"` };
  }
  if (serviceArea && !SERVICE_AREA_CODES[serviceArea]) {
    return { ok: false, reason: `sender ${sender} has no such service area code "${serviceArea}"` };
  }
  if (kind && !MESSAGE_KINDS[kind]) {
    return { ok: false, reason: `sender ${sender} has no such message type "${kind}"` };
  }
  if (kind === PROMOTIONAL) {
    return { ok: false, reason: `sender ${sender} sent a promotional SMS, which is not a bank alert` };
  }

  const bank = bankForHeader(core, extraTrusted);
  if (!bank) return { ok: false, reason: `sender ${sender} is not a header registered to a bank` };

  // The merchant told us which bank their account is with, so an alert from a different bank is
  // about somebody else's account and can never pay one of their orders.
  if (expectedBank && bank.key && bank.key !== expectedBank) {
    return { ok: false, reason: `sender ${sender} is ${bank.name}, not the bank this account is with` };
  }

  // The alert names its own bank. If that is a bank we can recognise, and it is not the bank the
  // header belongs to, then the text and the header disagree about who sent this.
  const holder = identifyRegisteredBank(bank.name);
  if (holder && text) {
    const named = banksNamedInAlert(text);
    if (named.size > 0 && !named.has(holder.key)) {
      const others = [...named].join(', ');
      return { ok: false, reason: `sender ${sender} belongs to ${bank.name} but the alert names ${others}` };
    }
  }
  return { ok: true, domain: raw };
}

/**
 * Every header a bank alert may arrive from. The phone app filters on this, so that personal SMS
 * never leave the phone; the server checks each message again on arrival regardless.
 */
export function allBankHeaders(extraTrusted: readonly string[] = []): string[] {
  return [...new Set([
    ...Object.keys(BANK_SMS_HEADERS),
    ...Object.keys(HEADERS_ADDED_SINCE_THE_REGISTER),
    ...extraTrusted,
  ])].sort();
}

export function verifyNotificationApp(packageName: string, trustedApps: readonly string[]): SenderCheck {
  return trustedApps.includes(packageName)
    ? { ok: true, domain: packageName }
    : { ok: false, reason: `app ${packageName} is not trusted` };
}
