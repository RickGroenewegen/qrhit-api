import { describe, it, expect, vi } from 'vitest';

/**
 * The price-list brochures (retail, reseller, client): priced like a
 * three-size quotation, never at the printer's cost, and only rendered from a
 * signed URL.
 */

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ get: async () => null }) },
}));

import {
  PriceListError,
  assertProfitTable,
  buildPriceList,
  priceListQuery,
  priceListSignature,
  resolveProfitMatrix,
  verifyPriceListSignature,
} from '../../src/priceList';
import {
  PROFIT_TIERS,
  ProfitMatrix,
  priceBoxOptions,
} from '../../src/services/boxOptionsPricing';

const fullMatrix = (entry = { qrsong: 25, reseller: 30 }): ProfitMatrix => {
  const m: ProfitMatrix = {};
  for (const id of ['schneider-48', 'schneider-96', 'schneider-192']) {
    m[id] = {};
    for (const q of PROFIT_TIERS) m[id][String(q)] = { ...entry };
  }
  return m;
};

const costs: Record<number, number> = { 48: 2.01, 96: 4.79, 192: 8.23 };
const calculate = vi.fn(async ({ cardCount }: { cardCount: number }) => ({
  success: true,
  calculation: { pricePerBox: costs[cardCount] },
}));

describe('buildPriceList', () => {
  it('has a row per tier and a cell per size', async () => {
    const list = await buildPriceList(fullMatrix(), calculate);
    expect(list.rows.map((r) => r.quantity)).toEqual(PROFIT_TIERS);
    expect(list.sizes).toEqual([48, 96, 192]);
    expect(Object.keys(list.rows[0].cells).map(Number)).toEqual([48, 96, 192]);
  });

  it('prints the same cents as a three-size quotation for that quantity', async () => {
    const matrix = fullMatrix();
    const list = await buildPriceList(matrix, calculate);
    const row = list.rows.find((r) => r.quantity === 300)!;
    const retail = await priceBoxOptions(300, { matrix, calculate });
    const reseller = await priceBoxOptions(300, { matrix, calculate, isReseller: true });
    for (const option of retail) {
      expect(row.cells[option.cards].advice).toBe(option.pricePerBox);
    }
    for (const option of reseller) {
      expect(row.cells[option.cards].purchase).toBe(option.pricePerBox);
    }
  });

  it('says the mark-up once when every tier uses the same one', async () => {
    const list = await buildPriceList(fullMatrix({ qrsong: 25, reseller: 30 }), calculate);
    expect(list.uniformMarkupPercent).toBe(30);
  });

  it('leaves the mark-up per cell when tiers differ', async () => {
    const matrix = fullMatrix();
    matrix['schneider-96']['5000'] = { qrsong: 25, reseller: 20 };
    const list = await buildPriceList(matrix, calculate);
    expect(list.uniformMarkupPercent).toBeNull();
    expect(list.rows.find((r) => r.quantity === 5000)!.cells[96].markupPercent).toBe(20);
  });

  it('refuses a printer price that is missing', async () => {
    const failing = vi.fn(async () => ({ success: false, error: 'no price' }));
    await expect(buildPriceList(fullMatrix(), failing)).rejects.toThrow('no price');
  });
});

describe('never at the printer cost', () => {
  it('refuses a table without our margin in one tier', () => {
    const matrix = fullMatrix();
    matrix['schneider-192']['750'] = { qrsong: 0, reseller: 30 };
    expect(() => assertProfitTable(matrix)).toThrow(PriceListError);
    expect(() => assertProfitTable(matrix)).toThrow('192 cards at 750 boxes');
  });

  it('refuses a table that lacks a tier', () => {
    const matrix = fullMatrix();
    delete matrix['schneider-48']['100'];
    expect(() => assertProfitTable(matrix)).toThrow('48 cards at 100 boxes');
  });

  it('refuses an empty or missing table', () => {
    expect(() => assertProfitTable(null)).toThrow(PriceListError);
    expect(() => assertProfitTable({})).toThrow(PriceListError);
  });

  it('uses the saved table when the request sends none, and fails without one', async () => {
    // The mocked cache has no saved table.
    await expect(resolveProfitMatrix(undefined)).rejects.toThrow(PriceListError);
    await expect(resolveProfitMatrix({})).rejects.toThrow(PriceListError);
    const given = fullMatrix();
    await expect(resolveProfitMatrix(given)).resolves.toBe(given);
  });
});

describe('signed view URL', () => {
  it('verifies its own signature', () => {
    const json = JSON.stringify(fullMatrix());
    const sig = priceListSignature('retail', 'nl', json);
    expect(verifyPriceListSignature('retail', 'nl', json, sig)).toBe(true);
  });

  it('rejects another edition, language or matrix', () => {
    const json = JSON.stringify(fullMatrix());
    const sig = priceListSignature('client', 'nl', json);
    expect(verifyPriceListSignature('reseller', 'nl', json, sig)).toBe(false);
    expect(verifyPriceListSignature('client', 'de', json, sig)).toBe(false);
    expect(verifyPriceListSignature('client', 'nl', '{}', sig)).toBe(false);
    expect(verifyPriceListSignature('client', 'nl', json, undefined)).toBe(false);
    expect(verifyPriceListSignature('client', 'nl', json, 'x'.repeat(32))).toBe(false);
  });

  it('builds a query the view route can verify', () => {
    const matrix = fullMatrix();
    const params = new URLSearchParams(priceListQuery('reseller', 'de', matrix));
    expect(params.get('locale')).toBe('de');
    expect(JSON.parse(params.get('profitMatrix')!)).toEqual(matrix);
    expect(
      verifyPriceListSignature('reseller', 'de', params.get('profitMatrix')!, params.get('sig'))
    ).toBe(true);
  });
});
