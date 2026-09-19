import { z } from 'zod';
// Comparing the name a payer typed with the name their bank puts in its credit alert.
//
// Banks print the account holder's name, often in capitals, abbreviated or cut short: "AMAL KUMAR S",
// "MR A K DAS". A payer types "Amal" or "amal das". So names are compared word by word, where a word
// also matches its initial or a truncated form of itself.

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'SHRI', 'SRI', 'SMT', 'KUMARI', 'KU', 'DR', 'M/S', 'MX']);

/** Upper-case words of a name, without titles or punctuation. */
export function nameWords(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !TITLES.has(word));
}

/** "AMAL" matches "AMAL", "A" (an initial) and "AMA" (the bank cut it short), and the other way round. */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Could one bank alert plausibly match both names? If so they must never share a payment amount.
 * Deliberately broad: any matching word, even just an initial, counts.
 */
export function namesConflict(a: string, b: string): boolean {
  const wordsA = nameWords(a);
  const wordsB = nameWords(b);
  if (!wordsA.length || !wordsB.length) return true;
  return wordsA.some((x) => wordsB.some((y) => wordsMatch(x, y)));
}

/**
 * Does the name in a bank alert belong to the payer who typed `typed`? At least one full word (not
 * just an initial) has to match, so "A KUMAR" is not taken to be "Amal".
 */
export function nameMatchesAlert(typed: string, alertName: string): boolean {
  const alertWords = nameWords(alertName);
  return nameWords(typed).some((word) => word.length > 1 && alertWords.some((a) => a.length > 1 && wordsMatch(word, a)));
}

/** A payer's name as the merchant or the payer enters it: the name on the bank account they pay from. */
export const payerNameSchema = z.string().trim().min(2).max(60).regex(/[A-Za-z]{2}/, 'must contain letters');
