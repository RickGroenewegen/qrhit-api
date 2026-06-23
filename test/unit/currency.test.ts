import { describe, it, expect } from 'vitest';
import {
  getCurrencyForCountry,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
} from '../../src/data/currency-map';
import { roundTotal } from '../../src/services/currency-format';

describe('getCurrencyForCountry', () => {
  it('maps known countries case-insensitively', () => {
    expect(getCurrencyForCountry('NO')).toBe('NOK');
    expect(getCurrencyForCountry('gb')).toBe('GBP');
    expect(getCurrencyForCountry('us')).toBe('USD');
  });

  it('defaults to EUR for eurozone, unknown, and missing countries', () => {
    expect(getCurrencyForCountry('NL')).toBe('EUR');
    expect(getCurrencyForCountry('XX')).toBe('EUR');
    expect(getCurrencyForCountry(null)).toBe('EUR');
    expect(getCurrencyForCountry(undefined)).toBe('EUR');
  });

  it('deliberately does NOT auto-map Poland to PLN (Mollie card support)', () => {
    expect(getCurrencyForCountry('PL')).toBe('EUR');
  });
});

describe('isSupportedCurrency', () => {
  it('accepts every supported code and rejects others', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      expect(isSupportedCurrency(code)).toBe(true);
    }
    expect(isSupportedCurrency('JPY')).toBe(false);
    expect(isSupportedCurrency('eur')).toBe(false);
    expect(isSupportedCurrency(null)).toBe(false);
  });
});

describe('roundTotal (psychological price snapping)', () => {
  it('EUR keeps plain 2-decimal rounding', () => {
    expect(roundTotal(12.345, 'EUR')).toBe(12.35);
    expect(roundTotal(12.344, 'EUR')).toBe(12.34);
  });

  it('Nordic currencies snap to 5', () => {
    expect(roundTotal(12.4, 'NOK')).toBe(10);
    expect(roundTotal(12.6, 'SEK')).toBe(15);
    expect(roundTotal(1207.5, 'DKK')).toBe(1210);
  });

  it('GBP/CHF/USD snap to 0.5', () => {
    expect(roundTotal(8.82, 'GBP')).toBe(9);
    expect(roundTotal(8.7, 'CHF')).toBe(8.5);
    expect(roundTotal(8.74, 'USD')).toBe(8.5);
  });

  it('PLN snaps to whole units', () => {
    expect(roundTotal(49.49, 'PLN')).toBe(49);
    expect(roundTotal(49.5, 'PLN')).toBe(50);
  });
});
