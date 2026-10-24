import { describe, expect, it, vi } from 'vitest';
import { paymentTaxRate } from '../../../src/printers/paymentTaxRate';

describe('paymentTaxRate', () => {
  const data = () => ({
    getTaxRate: vi.fn(async (c: string) => ({ NL: 21, DE: 19 })[c] ?? null),
  });

  it('uses the rate stored on the payment, also when that is 0%', async () => {
    const d = data();
    expect(await paymentTaxRate({ taxRate: 0, countrycode: 'DE' }, d)).toBe(0);
    expect(await paymentTaxRate({ taxRate: 19, countrycode: 'DE' }, d)).toBe(19);
    expect(d.getTaxRate).not.toHaveBeenCalled();
  });

  it("falls back to the country's rate when the payment has none", async () => {
    const d = data();
    expect(await paymentTaxRate({ taxRate: null, countrycode: 'DE' }, d)).toBe(19);
    expect(await paymentTaxRate({ countrycode: null }, d)).toBe(21);
    expect(d.getTaxRate).toHaveBeenLastCalledWith('NL');
  });

  it('counts an unknown country as 0%', async () => {
    expect(await paymentTaxRate({ countrycode: 'XX' }, data())).toBe(0);
  });
});
