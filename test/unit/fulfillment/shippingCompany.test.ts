import { describe, it, expect } from 'vitest';
import { shippingCompany } from '../../../src/printers/shippingCompany';

describe('shippingCompany', () => {
  it('gives the company of a business order, trimmed', () => {
    expect(
      shippingCompany({ isBusinessOrder: true, companyName: '  Acme GmbH ' })
    ).toBe('Acme GmbH');
  });

  it('ignores a company left on a personal order', () => {
    expect(
      shippingCompany({ isBusinessOrder: false, companyName: 'Acme GmbH' })
    ).toBeUndefined();
  });

  it('gives nothing for a business order without a company', () => {
    expect(shippingCompany({ isBusinessOrder: true, companyName: ' ' })).toBeUndefined();
    expect(shippingCompany({ isBusinessOrder: true, companyName: null })).toBeUndefined();
  });
});
