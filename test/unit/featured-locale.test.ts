import { describe, it, expect } from 'vitest';
import { featuredLocaleWhere, normalizeFeaturedLocale } from '../../src/data/featuredLocale';

describe('normalizeFeaturedLocale', () => {
  it('keeps the order ticked, lower case, without repeats or spaces', () => {
    expect(normalizeFeaturedLocale('de,tr')).toBe('de,tr');
    expect(normalizeFeaturedLocale(' TR, de ,tr')).toBe('tr,de');
    expect(normalizeFeaturedLocale(['de', 'ru'])).toBe('de,ru');
  });

  it('reads nothing usable as every language (null)', () => {
    expect(normalizeFeaturedLocale(null)).toBeNull();
    expect(normalizeFeaturedLocale(undefined)).toBeNull();
    expect(normalizeFeaturedLocale('')).toBeNull();
    expect(normalizeFeaturedLocale(' , ')).toBeNull();
    expect(normalizeFeaturedLocale([])).toBeNull();
  });

  it('drops what is not a language code', () => {
    expect(normalizeFeaturedLocale('de,german,x')).toBe('de');
  });
});

describe('featuredLocaleWhere', () => {
  // The same matching as the filter, in memory, to check the patterns.
  function matches(value: string, locale: string): boolean {
    return featuredLocaleWhere(locale).OR.some(({ featuredLocale: f }) => {
      if (typeof f === 'string') return value === f;
      if ('startsWith' in f) return value.startsWith(f.startsWith!);
      if ('endsWith' in f) return value.endsWith(f.endsWith!);
      return value.includes((f as { contains: string }).contains);
    });
  }

  it('finds a language alone, first, last or in the middle', () => {
    expect(matches('de', 'de')).toBe(true);
    expect(matches('de,tr', 'de')).toBe(true);
    expect(matches('de,tr', 'tr')).toBe(true);
    expect(matches('nl,de,tr', 'de')).toBe(true);
    expect(matches('de, tr', 'tr')).toBe(true);
    expect(matches('nl, de, tr', 'de')).toBe(true);
  });

  it('does not find a language the list lacks', () => {
    expect(matches('de,tr', 'nl')).toBe(false);
    expect(matches('nl', 'de')).toBe(false);
  });
});
