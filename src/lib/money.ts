/** Parses "99", "99.5" or "99.07" into integer paise. Returns null for anything else. */
export function rupeesToPaise(value: string | number): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export const formatRupees = (paise: number): string => (paise / 100).toFixed(2);
