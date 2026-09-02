import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveTaxContext,
  resolveVatRegion,
  quotationVatContext,
} from '../../src/services/vat';
import type { VatIdCheckResult } from '../../src/services/vies';

// Controls what the mocked VIES client returns per test.
let viesResult: VatIdCheckResult | null = null;
const validateSpy = vi.fn(async () => viesResult);

vi.mock('../../src/services/vies', () => ({
  default: { getInstance: () => ({ validate: validateSpy }) },
}));

// Minimal DataDeps: resolveTaxContext only touches deps.prisma.taxRate.
const NL_RATE = 21;
const DE_RATE = 19;
const makeDeps = () =>
  ({
    prisma: {
      taxRate: {
        findFirst: vi.fn(async ({ where }: any) => {
          const country = where.AND?.[0]?.countryCode;
          if (country === 'NL') return { rate: NL_RATE };
          if (country === 'DE') return { rate: DE_RATE };
          if (country === null) return { rate: NL_RATE }; // legacy fallback row
          return null;
        }),
      },
    },
  }) as any;

describe('resolveTaxContext (EU reverse charge)', () => {
  beforeEach(() => {
    viesResult = null;
    validateSpy.mockClear();
  });

  it('non-EU buyer: 0% export, no VIES call', async () => {
    const res = await resolveTaxContext(makeDeps(), { buyerCountry: 'US' });
    expect(res).toEqual({
      taxRate: 0,
      reverseCharge: false,
      vatIdStatus: 'not-checked',
    });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('EU consumer: local rate, no VIES call', async () => {
    const res = await resolveTaxContext(makeDeps(), { buyerCountry: 'DE' });
    expect(res.taxRate).toBe(DE_RATE);
    expect(res.reverseCharge).toBe(false);
    expect(res.vatIdStatus).toBe('not-checked');
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('domestic B2B (NL→NL) with VAT ID: still charges NL VAT', async () => {
    const res = await resolveTaxContext(makeDeps(), {
      buyerCountry: 'NL',
      isBusinessOrder: true,
      vatId: 'NL123456789B01',
    });
    expect(res.taxRate).toBe(NL_RATE);
    expect(res.reverseCharge).toBe(false);
    expect(res.vatIdStatus).toBe('not-checked');
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('cross-border B2B with valid VIES ID: 0% reverse charge', async () => {
    viesResult = {
      valid: true,
      normalized: 'DE123456789',
      checkedAt: new Date().toISOString(),
    };
    const res = await resolveTaxContext(makeDeps(), {
      buyerCountry: 'DE',
      isBusinessOrder: true,
      vatId: 'DE 123.456.789',
    });
    expect(res).toEqual({
      taxRate: 0,
      reverseCharge: true,
      vatIdChecked: 'DE123456789',
      vatIdStatus: 'valid',
    });
  });

  it('cross-border B2B with invalid VIES ID: local VAT + invalid status', async () => {
    viesResult = {
      valid: false,
      normalized: 'DE123456789',
      checkedAt: new Date().toISOString(),
    };
    const res = await resolveTaxContext(makeDeps(), {
      buyerCountry: 'DE',
      isBusinessOrder: true,
      vatId: 'DE123456789',
    });
    expect(res.taxRate).toBe(DE_RATE);
    expect(res.reverseCharge).toBe(false);
    expect(res.vatIdStatus).toBe('invalid');
  });

  it('VIES unreachable: over-collects VAT (safe fallback)', async () => {
    viesResult = {
      valid: false,
      normalized: 'DE123456789',
      checkedAt: new Date().toISOString(),
      unreachable: true,
    };
    const res = await resolveTaxContext(makeDeps(), {
      buyerCountry: 'DE',
      isBusinessOrder: true,
      vatId: 'DE123456789',
    });
    expect(res.taxRate).toBe(DE_RATE);
    expect(res.vatIdStatus).toBe('unreachable');
  });

  it('unparseable VAT ID (normalize fails): invalid without VIES call result', async () => {
    viesResult = null;
    const res = await resolveTaxContext(makeDeps(), {
      buyerCountry: 'DE',
      isBusinessOrder: true,
      vatId: '!!!',
    });
    expect(res.taxRate).toBe(DE_RATE);
    expect(res.vatIdStatus).toBe('invalid');
  });
});

describe('resolveVatRegion / quotationVatContext (quotation VAT buckets)', () => {
  it('maps ISO codes to the three buckets', () => {
    expect(resolveVatRegion('NL')).toBe('nl');
    expect(resolveVatRegion('nl')).toBe('nl');
    expect(resolveVatRegion('DE')).toBe('eu');
    expect(resolveVatRegion('be')).toBe('eu');
    expect(resolveVatRegion('CH')).toBe('world');
    expect(resolveVatRegion('US')).toBe('world');
    // any real ISO country outside the EU is an export, not a typo
    expect(resolveVatRegion('TH')).toBe('world');
    expect(resolveVatRegion('AR')).toBe('world');
    // EU-VAT prefix for Greece maps to the ISO code
    expect(resolveVatRegion('EL')).toBe('eu');
  });

  it('normalizes legacy free-text country names', () => {
    expect(resolveVatRegion('Nederland')).toBe('nl');
    expect(resolveVatRegion('The Netherlands')).toBe('nl');
    expect(resolveVatRegion('Duitsland')).toBe('eu');
    expect(resolveVatRegion('Germany')).toBe('eu');
    expect(resolveVatRegion('Switzerland')).toBe('world');
    expect(resolveVatRegion('  Belgien  ')).toBe('eu');
    expect(resolveVatRegion('UK')).toBe('world');
  });

  it('falls back to nl (over-collect) for empty or unrecognized input', () => {
    expect(resolveVatRegion(null)).toBe('nl');
    expect(resolveVatRegion(undefined)).toBe('nl');
    expect(resolveVatRegion('')).toBe('nl');
    expect(resolveVatRegion('XX')).toBe('nl'); // 2-letter but not a known country
    expect(resolveVatRegion('Atlantis')).toBe('nl');
  });

  it('quotationVatContext maps region to rate and reverse charge', () => {
    expect(quotationVatContext('NL')).toEqual({
      region: 'nl',
      rate: 21,
      reverseCharge: false,
    });
    expect(quotationVatContext('DE')).toEqual({
      region: 'eu',
      rate: 0,
      reverseCharge: true,
    });
    expect(quotationVatContext('US')).toEqual({
      region: 'world',
      rate: 0,
      reverseCharge: false,
    });
  });
});
