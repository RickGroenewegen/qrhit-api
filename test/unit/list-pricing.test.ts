import { describe, it, expect } from 'vitest';
import {
  listPricingFromCalculation,
  listPricingTotals,
  parseListPricing,
  paymentAmounts,
  round2,
  variantCalculationColumn,
} from '../../src/listPricing';

/**
 * The price snapshot a calculator saves with a company list. The Sell column,
 * the invoice preview and the MoneyBird invoices all come from these
 * functions, and the frontend mirrors them in list-pricing.util.ts.
 */

const base = {
  quantity: 250,
  unitPrice: 6.83,
  extras: [],
  customAppFee: 350,
  votingPortalFee: 500,
  discountPercent: 0,
};

describe('round2', () => {
  it('rounds half-cents the way they read, not the way binary stores them', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(30.015)).toBe(30.02);
    expect(round2(2610.9)).toBe(2610.9);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe('variantCalculationColumn', () => {
  it('maps each printer to the column its calculator saves into', () => {
    expect(variantCalculationColumn('onzevibe')).toBe('calculation');
    expect(variantCalculationColumn('qrsong')).toBe('calculationTromp');
    expect(variantCalculationColumn('schneider')).toBe('calculationSchneider');
  });
});

describe('parseListPricing', () => {
  it('accepts a complete snapshot and rounds money to cents', () => {
    expect(parseListPricing({ ...base, unitPrice: 6.8349 })).toEqual({
      ...base,
      unitPrice: 6.83,
    });
  });

  it('rejects anything that cannot be invoiced', () => {
    expect(parseListPricing(null)).toBeNull();
    expect(parseListPricing('x')).toBeNull();
    expect(parseListPricing({ ...base, quantity: 0 })).toBeNull();
    expect(parseListPricing({ ...base, quantity: 2.5 })).toBeNull();
    expect(parseListPricing({ ...base, unitPrice: -1 })).toBeNull();
    expect(parseListPricing({ ...base, unitPrice: 'abc' })).toBeNull();
    expect(parseListPricing({ quantity: 10 })).toBeNull();
  });

  it('drops app and voting portal extras, which have fee fields of their own', () => {
    const p = parseListPricing({
      ...base,
      extras: [
        { key: 'customApp', name: 'App in eigen stijl', price: 350 },
        { key: 'votingPortal', name: 'Voting Portal', price: 500 },
        { key: 'cuttingDie', name: 'Stansvorm', price: 425 },
        { name: 'free', price: 0 },
      ],
    });
    expect(p!.extras).toEqual([{ key: 'cuttingDie', name: 'Stansvorm', price: 425 }]);
  });

  it('clamps the discount to 0-100% and fees to zero or more', () => {
    expect(parseListPricing({ ...base, discountPercent: 140 })!.discountPercent).toBe(100);
    expect(parseListPricing({ ...base, discountPercent: -5 })!.discountPercent).toBe(0);
    expect(parseListPricing({ ...base, customAppFee: -350 })!.customAppFee).toBe(0);
    expect(parseListPricing({ ...base, votingPortalFee: undefined })!.votingPortalFee).toBe(0);
  });
});

describe('listPricingFromCalculation', () => {
  it('reads the snapshot from a calculation JSON, or null', () => {
    expect(listPricingFromCalculation(JSON.stringify({ quantity: 250, pricing: base }))).toEqual(base);
    expect(listPricingFromCalculation(JSON.stringify({ quantity: 250 }))).toBeNull();
    expect(listPricingFromCalculation('{broken')).toBeNull();
    expect(listPricingFromCalculation(null)).toBeNull();
  });
});

describe('listPricingTotals', () => {
  it('adds product, extras and fees, then takes the discount off', () => {
    expect(
      listPricingTotals({
        ...base,
        extras: [{ name: 'Stansvorm', price: 425 }],
        discountPercent: 10,
      })
    ).toEqual({
      productTotal: 1707.5,
      extrasTotal: 425,
      subtotal: 2982.5,
      discountAmount: 298.25,
      total: 2684.25,
    });
  });

  it('rounds the discount to cents, like the discount line on the invoice', () => {
    const t = listPricingTotals({ ...base, discountPercent: 7.5 });
    // 2557.50 * 7.5% = 191.8125
    expect(t.discountAmount).toBe(191.81);
    expect(t.total).toBe(2365.69);
  });
});

describe('paymentAmounts', () => {
  it('splits 30% off and leaves the rest', () => {
    expect(paymentAmounts(11565)).toEqual({ full: 11565, down: 3469.5, remaining: 8095.5 });
  });

  it('takes the down payment actually invoiced off the remainder', () => {
    expect(paymentAmounts(11565, 3000).remaining).toBe(8565);
  });

  it('down and remaining add up to the total, to the cent', () => {
    for (const total of [100.05, 0.01, 333.33, 1269.39, 99999.99]) {
      const { down, remaining } = paymentAmounts(total);
      expect(round2(down + remaining)).toBe(total);
    }
  });
});
