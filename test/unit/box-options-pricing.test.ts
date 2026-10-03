import { describe, it, expect, vi } from 'vitest';

/**
 * The three-size quotation's prices: the admin calculator's markup, to the
 * cent. The numbers in "parity" are the ones skill-qrsong-quotation's
 * test/pricing.test.ts pins for the calculator mirror.
 */

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ get: async () => null }) },
}));

import {
  BoxOptionsError,
  MIN_BOX_OPTIONS_QUANTITY,
  priceBoxOptions,
  priceFromCost,
  productId,
  profitFor,
  profitTier,
} from '../../src/services/boxOptionsPricing';

const matrix = {
  'schneider-48': { '300': { qrsong: 50, reseller: 30 } },
  'schneider-96': { '300': { qrsong: 40, reseller: 30 } },
  'schneider-192': { '300': { qrsong: 30, reseller: 25 } },
};

const costs: Record<number, number> = { 48: 2.01, 96: 4.79, 192: 8.23 };
const calculate = vi.fn(async ({ cardCount }: { cardCount: number }) => ({
  success: true,
  calculation: { pricePerBox: costs[cardCount] },
}));

describe('tiers and products', () => {
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

describe('priceBoxOptions', () => {
  it('prices 48, 96 and 192 in that order with each size its own margin', async () => {
    const options = await priceBoxOptions(300, { matrix, calculate });
    expect(options.map((o) => o.cards)).toEqual([48, 96, 192]);
    expect(options[1].pricePerBox).toBe(priceFromCost(96, 300, 4.79, matrix['schneider-96']['300'], false).pricePerBox);
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 300, includeStansmes: false, profitMargin: 0 })
    );
  });

  it(`refuses fewer than ${MIN_BOX_OPTIONS_QUANTITY} boxes`, async () => {
    await expect(priceBoxOptions(99, { matrix, calculate })).rejects.toBeInstanceOf(BoxOptionsError);
    await expect(priceBoxOptions(150.5, { matrix, calculate })).rejects.toBeInstanceOf(BoxOptionsError);
  });

  it('never quotes at the printer cost when a size has no margin', async () => {
    const partial = { 'schneider-48': matrix['schneider-48'], 'schneider-96': matrix['schneider-96'] };
    await expect(priceBoxOptions(300, { matrix: partial, calculate })).rejects.toThrow(/192 cards/);
  });

  it('needs a profit table', async () => {
    await expect(priceBoxOptions(300, { matrix: null, calculate })).rejects.toThrow(/Pricing Tables/);
  });
});
