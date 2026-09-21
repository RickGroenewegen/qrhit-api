import { describe, it, expect } from 'vitest';
import {
  productPageLocales,
  isProductPageIndexable,
} from '../../src/data/productPageLocales';

const ALL = ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'jp', 'cn', 'sv', 'no'];

describe('productPageLocales', () => {
  it('treats a list without a locale as international: no restriction', () => {
    expect(productPageLocales(null, ALL)).toBeNull();
    expect(productPageLocales(undefined, ALL)).toBeNull();
    expect(productPageLocales('', ALL)).toBeNull();
  });

  it('always adds en to a locale-specific list', () => {
    expect(productPageLocales('de', ALL)).toEqual(['de', 'en']);
  });

  it('reads the comma-separated form, with spaces and case tolerated', () => {
    expect(productPageLocales('de, NL', ALL)).toEqual(['de', 'nl', 'en']);
  });

  it('does not list en twice for an English-market list', () => {
    expect(productPageLocales('en', ALL)).toEqual(['en']);
    expect(productPageLocales('nl,en', ALL)).toEqual(['nl', 'en']);
  });

  it('falls back to international when the column holds nothing usable', () => {
    // A typo must not take the product out of every sitemap.
    expect(productPageLocales('xx', ALL)).toBeNull();
    expect(productPageLocales(' , ', ALL)).toBeNull();
    expect(productPageLocales('xx,de', ALL)).toEqual(['de', 'en']);
  });
});

describe('isProductPageIndexable', () => {
  it('indexes an international list everywhere', () => {
    for (const locale of ALL) {
      expect(isProductPageIndexable(null, locale, ALL)).toBe(true);
    }
  });

  it('indexes a German list in de and en only', () => {
    const indexable = ALL.filter((l) => isProductPageIndexable('de', l, ALL));
    expect(indexable).toEqual(['en', 'de']);
  });

  it('indexes a "de,nl" list in both markets and en', () => {
    const indexable = ALL.filter((l) => isProductPageIndexable('de,nl', l, ALL));
    expect(indexable).toEqual(['en', 'nl', 'de']);
  });
});
