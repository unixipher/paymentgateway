/**
 * The banks whose credit alerts we can recognise by name.
 *
 * TRAI's register says which bank holds an SMS header; a credit alert also names the bank it comes
 * from, in its own words ("HDFC Bank A/c", "-SBI"). Recording both lets us check them against each
 * other, so an alert whose text belongs to one bank cannot be delivered under another bank's header.
 *
 * `registered` matches the name in TRAI's register; `inAlert` matches how the bank writes itself in
 * an SMS. A bank missing from this table is still trusted on its header alone — it only means there
 * is no second opinion to check against, which is why leaving a bank out is safe.
 */
export interface BankIdentity {
  /** Stable key used to compare two sightings of the same bank. */
  key: string;
  /** The bank's name in TRAI's register of headers. */
  registered: RegExp;
  /** How the bank names itself inside an SMS alert. Must not match another bank's alerts. */
  inAlert: RegExp;
  /** Domains this bank sends alert emails from, where we know them and trust them already. */
  emailDomains?: readonly string[];
}

export const BANK_IDENTITIES: readonly BankIdentity[] = [
  { key: 'sbi', registered: /^STATE BANK OF INDIA$/i, inAlert: /\bSBI\b|\bSTATE BANK\b/i, emailDomains: ['sbi.co.in'] },
  { key: 'hdfc', registered: /^HDFC BANK\b/i, inAlert: /\bHDFC\b/i, emailDomains: ['hdfcbank.net', 'hdfcbank.com'] },
  { key: 'icici', registered: /^ICICI BANK\b/i, inAlert: /\bICICI\b/i, emailDomains: ['icicibank.com'] },
  { key: 'axis', registered: /^AXIS BANK\b/i, inAlert: /\bAXIS BANK\b/i, emailDomains: ['axisbank.com'] },
  { key: 'kotak', registered: /^KOTAK MAHINDRA BANK\b/i, inAlert: /\bKOTAK\b/i, emailDomains: ['kotak.com'] },
  { key: 'yes', registered: /^YES BANK\b/i, inAlert: /\bYES BANK\b/i, emailDomains: ['yesbank.in'] },
  { key: 'idfc', registered: /^IDFC FIRST BANK\b/i, inAlert: /\bIDFC\b/i, emailDomains: ['idfcfirstbank.com'] },
  { key: 'indusind', registered: /^INDUSIND BANK\b/i, inAlert: /\bINDUSIND\b/i, emailDomains: ['indusind.com'] },
  { key: 'pnb', registered: /^PUNJAB NATIONAL BANK$/i, inAlert: /\bPNB\b|\bPUNJAB NATIONAL\b/i, emailDomains: ['pnb.co.in'] },
  { key: 'bob', registered: /^BANK OF BARODA$/i, inAlert: /\bBANK OF BARODA\b|\bBOBTXN\b/i, emailDomains: ['bankofbaroda.com'] },
  { key: 'canara', registered: /^CANARA BANK$/i, inAlert: /\bCANARA\b/i, emailDomains: ['canarabank.com'] },
  { key: 'union', registered: /^UNION BANK OF INDIA$/i, inAlert: /\bUNION BANK\b/i, emailDomains: ['unionbankofindia.co.in'] },
  { key: 'federal', registered: /^FEDERAL BANK\b/i, inAlert: /\bFEDERAL BANK\b/i, emailDomains: ['federalbank.co.in'] },
  { key: 'au', registered: /^AU SMALL FINANCE BANK\b/i, inAlert: /\bAU SMALL FINANCE\b|\bAU BANK\b/i, emailDomains: ['aubank.in'] },
  { key: 'idbi', registered: /^IDBI BANK\b/i, inAlert: /\bIDBI\b/i },
  { key: 'kvb', registered: /^THE KARUR VYSYA BANK\b/i, inAlert: /\bKARUR VYSYA\b|\bKVB\b/i, emailDomains: ['kvb.co.in'] },
  { key: 'boi', registered: /^BANK OF INDIA$/i, inAlert: /\bBANK OF INDIA\b/i },
  { key: 'central', registered: /^CENTRAL BANK OF INDIA$/i, inAlert: /\bCENTRAL BANK\b/i },
  { key: 'indian', registered: /^INDIAN BANK$/i, inAlert: /\bINDIAN BANK\b/i },
  { key: 'uco', registered: /^UCO BANK$/i, inAlert: /\bUCO\b/i },
  { key: 'bandhan', registered: /^BANDHAN BANK\b/i, inAlert: /\bBANDHAN\b/i },
  { key: 'rbl', registered: /^RBL BANK\b/i, inAlert: /\bRBL\b/i },
  { key: 'csb', registered: /^CSB BANK\b/i, inAlert: /\bCSB\b/i },
  { key: 'south-indian', registered: /^THE SOUTH INDIAN BANK\b/i, inAlert: /\bSOUTH INDIAN BANK\b/i },
  { key: 'punjab-sind', registered: /^PUNJAB AND SIND BANK$/i, inAlert: /\bPUNJAB (?:AND|&) SIND\b/i },
  { key: 'maharashtra', registered: /^BANK OF MAHARASHTRA$/i, inAlert: /\bBANK OF MAHARASHTRA\b|\bMAHABANK\b/i },
  { key: 'paytm', registered: /^PAYTM PAYMENTS BANK\b/i, inAlert: /\bPAYTM\b/i },
  { key: 'airtel', registered: /^AIRTEL PAYMENTS BANK\b/i, inAlert: /\bAIRTEL PAYMENTS BANK\b/i },
  { key: 'citi', registered: /^CITI BANK$/i, inAlert: /\bCITIBANK\b|\bCITI BANK\b/i },
  { key: 'standard-chartered', registered: /^STANDARD CHARTERED BANK$/i, inAlert: /\bSTANDARD CHARTERED\b/i },
  { key: 'dbs', registered: /^DBS BANK INDIA\b/i, inAlert: /\bDBS\b/i },
  { key: 'jk', registered: /^THE JAMMU AND KASHMIR BANK\b/i, inAlert: /\bJ&K BANK\b|\bJAMMU AND KASHMIR BANK\b/i },
  { key: 'karnataka', registered: /^THE KARNATAKA BANK\b/i, inAlert: /\bKARNATAKA BANK\b/i },
  { key: 'dhanlaxmi', registered: /^DHANLAXMI BANK\b/i, inAlert: /\bDHANLAXMI\b/i },
  { key: 'tmb', registered: /^TAMILNAD MERCANTILE BANK\b/i, inAlert: /\bTAMILNAD\b|\bTMB\b/i },
  { key: 'equitas', registered: /^EQUITAS SMALL FINANCE BANK\b/i, inAlert: /\bEQUITAS\b/i },
  { key: 'ujjivan', registered: /^UJJIVAN SMALL FINANCE BANK\b/i, inAlert: /\bUJJIVAN\b/i },
  { key: 'jana', registered: /^JANA SMALL FINANCE BANK\b/i, inAlert: /\bJANA SMALL FINANCE\b/i },
  { key: 'fincare', registered: /^FINCARE SMALL FINANCE BANK\b/i, inAlert: /\bFINCARE\b/i },
  { key: 'esaf', registered: /^ESAF SMALL FINANCE BANK\b/i, inAlert: /\bESAF\b/i },
  { key: 'suryoday', registered: /^SURYODAY SMALL FINANCE BANK\b/i, inAlert: /\bSURYODAY\b/i },
  { key: 'utkarsh', registered: /^UTKARSH SMALL FINANCE BANK\b/i, inAlert: /\bUTKARSH SMALL FINANCE\b/i },
  { key: 'ippb', registered: /^INDIA POST PAYMENTS BANK\b/i, inAlert: /\bIPPB\b|\bINDIA POST\b/i },
];

/** The bank a registered header-holder's name refers to, if it is one we can recognise in an alert. */
export function identifyRegisteredBank(entity: string): BankIdentity | null {
  return BANK_IDENTITIES.find((bank) => bank.registered.test(entity.trim())) ?? null;
}

/**
 * The banks an alert names. A payer's VPA carries a bank's name too ("payer@okaxis"), and that is
 * the payer's bank, not the sender of the alert, so VPAs are removed before looking.
 */
export function banksNamedInAlert(text: string): Set<string> {
  const withoutVpas = text.replace(/\S+@\S+/g, ' ');
  return new Set(BANK_IDENTITIES.filter((bank) => bank.inAlert.test(withoutVpas)).map((bank) => bank.key));
}

/**
 * A key for the bank a header-holder's registered name refers to. Recognisable banks share one key
 * across all the names they are registered under; any other bank gets a key of its own name, so
 * co-operative and regional banks can be compared just as exactly.
 */
export function bankKeyFor(entity: string): string {
  return identifyRegisteredBank(entity)?.key
    ?? entity.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The bank that sends alert emails from a domain, or null if the domain does not name one bank. */
export function bankKeyForDomain(domain: string): string | null {
  const host = domain.trim().toLowerCase();
  const bank = BANK_IDENTITIES.find(
    (b) => b.emailDomains?.some((d) => host === d || host.endsWith(`.${d}`)),
  );
  return bank?.key ?? null;
}
