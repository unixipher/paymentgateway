import { describe, expect, test } from 'vitest';
import { nameMatchesAlert, namesConflict, nameWords } from '@/lib/names';

describe('payer names', () => {
  test('words are upper-cased without titles or punctuation', () => {
    expect(nameWords('Mr. Amal K. Das')).toEqual(['AMAL', 'K', 'DAS']);
  });

  test.each([
    ['Amal', 'AMAL KUMAR S'],
    ['amal das', 'MR A K DAS'],
    ['Mrinmoy Halder', 'MRINMOY HALDER'],
    ['Mrinmoy', 'MRINMO'], // the bank cut the name short
  ])('%s paid as %s', (typed, alert) => {
    expect(nameMatchesAlert(typed, alert)).toBe(true);
  });

  test.each([
    ['Amal', 'DILIP ROY'],
    ['Amal', 'A KUMAR'], // an initial alone is not enough to say who paid
    ['Dilip', 'RAMESH KUMAR'],
  ])('%s is not %s', (typed, alert) => {
    expect(nameMatchesAlert(typed, alert)).toBe(false);
  });

  test('names that one alert could match never share an amount', () => {
    expect(namesConflict('Amal Das', 'Amal Roy')).toBe(true);
    expect(namesConflict('A Das', 'Amal Roy')).toBe(true);
    expect(namesConflict('Amal', 'Amalendu')).toBe(true);
    expect(namesConflict('Amal', 'Dilip')).toBe(false);
    expect(namesConflict('Amal Das', 'Dilip Roy')).toBe(false);
  });
});
