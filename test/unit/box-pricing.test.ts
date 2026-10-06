import { describe, it, expect, vi } from 'vitest';

/**
 * The client price of a box from the printer's cost: the admin calculator's
 * markup, to the cent. The price-list brochure prints these prices. The
 * numbers in "parity" are the ones skill-qrsong-quotation's
 * test/pricing.test.ts pins for the calculator mirror.
 */

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ get: async () => null }) },
}));

import {
  BOX_SIZES,
  MIN_BUSINESS_BOXES,
  PROFIT_TIERS,
  priceFromCost,
  productId,
  profitFor,
  profitTier,
} from '../../src/services/boxPricing';

const matrix = {
  'schneider-48': { '300': { qrsong: 50, reseller: 30 } },
  'schneider-96': { '300': { qrsong: 40, reseller: 30 } },
  'schneider-192': { '300': { qrsong: 30, reseller: 25 } },
};

describe('tiers and products', () => {
  it('sells 48, 96 and 192 cards from 100 boxes, the first tier', () => {
    expect(BOX_SIZES).toEqual([48, 96, 192]);
    expect(MIN_BUSINESS_BOXES).toBe(100);
    expect(PROFIT_TIERS[0]).toBe(MIN_BUSINESS_BOXES);
  });

  it('takes the largest tier at or below the quantity', () => {
    expect(profitTier(100)).toBe(100);
    expect(profitTier(349)).toBe(300);
    expect(profitTier(20000)).toBe(10000);
  });

  it('prices 192 from the 192 row and 144 too, like the calculator', () => {
    expect(productId(48)).toBe('schneider-48');
    expect(productId(96)).toBe('schneider-96');
    expect(productId(144)).toBe('schneider-192');
    expect(productId(192)).toBe('schneider-192');
  });

  it('has no margin rather than a zero one when the matrix lacks the cell', () => {
    expect(profitFor(matrix, 96, 320)).toEqual({ qrsong: 40, reseller: 30 });
    expect(profitFor(matrix, 96, 150)).toBeNull();
  });
});

describe('parity with the calculator', () => {
  it('direct client pays retail: printer + qrsong % + reseller %', () => {
    const o = priceFromCost(96, 300, 4.79, { qrsong: 50, reseller: 30 }, false);
    expect(o.resellerPrice).toBe(7.19);
    expect(o.retailPrice).toBe(9.35);
    expect(o.pricePerBox).toBe(9.35);
    expect(o.total).toBe(2805);
    expect(o.ourProfit).toBe(Math.round((2.4 + 2.16) * 300 * 100) / 100);
  });

  it('a reseller pays the reseller price and only our margin counts', () => {
    const o = priceFromCost(96, 300, 4.79, { qrsong: 50, reseller: 30 }, true);
    expect(o.pricePerBox).toBe(7.19);
    expect(o.ourProfit).toBe(720);
  });
});
