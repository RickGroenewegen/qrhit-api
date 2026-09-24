import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/businessSales.ts: company lists marked as sold, as
 * business sales in the financial reports. What matters is that a sold list
 * adds what the Lists table shows (sell price, sell minus buy), gross at the
 * VAT its invoice carries, on the day it was sold, and that the Sold toggle
 * cannot put a list without a price in the books.
 */

const prismaMock = vi.hoisted(() => ({
  companyList: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

import {
  businessPeriodKey,
  getBusinessSales,
  groupBusinessSales,
  markListSold,
  parseSalesSegment,
  soldDateToTimestamp,
  toBusinessSale,
} from '../../src/businessSales';

function list(over: Record<string, any> = {}) {
  return {
    id: 7,
    soldAt: new Date('2026-09-14T12:00:00.000Z'),
    sellPrice: 1000,
    buyPrice: 600,
    numberOfBoxes: 50,
    printer: 'schneider',
    calculationTromp: null,
    calculationSchneider: null,
    Company: { countrycode: 'NL' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.companyList.update.mockResolvedValue({});
});

describe('parseSalesSegment', () => {
  it('accepts business and both, and reads anything else as consumer', () => {
    expect(parseSalesSegment('business')).toBe('business');
    expect(parseSalesSegment('both')).toBe('both');
    expect(parseSalesSegment('consumer')).toBe('consumer');
    expect(parseSalesSegment(undefined)).toBe('consumer');
    expect(parseSalesSegment('BOTH')).toBe('consumer');
  });
});

describe('toBusinessSale', () => {
  it('adds 21% VAT for a Dutch company and takes profit as sell minus buy', () => {
    expect(toBusinessSale(list())).toEqual({
      listId: 7,
      soldAt: new Date('2026-09-14T12:00:00.000Z'),
      country: 'NL',
      boxes: 50,
      exVat: 1000,
      vatRate: 21,
      total: 1210,
      profit: 400,
      profitKnown: true,
    });
  });

  it('adds no VAT inside the EU (reverse charge) or outside it (export)', () => {
    expect(toBusinessSale(list({ Company: { countrycode: 'DE' } }))).toMatchObject({
      country: 'DE',
      vatRate: 0,
      total: 1000,
    });
    expect(toBusinessSale(list({ Company: { countrycode: 'United States' } }))).toMatchObject({
      country: 'US',
      vatRate: 0,
      total: 1000,
    });
  });

  it('treats a company without a country as Dutch for VAT, and reports it as Unknown', () => {
    expect(toBusinessSale(list({ Company: { countrycode: null } }))).toMatchObject({
      country: 'Unknown',
      vatRate: 21,
    });
  });

  it('counts no profit while the buy price is unknown', () => {
    expect(toBusinessSale(list({ buyPrice: null }))).toMatchObject({
      profit: 0,
      profitKnown: false,
    });
  });

  it("reads the boxes from the calculator of the list's printer when numberOfBoxes is empty", () => {
    const calcs = {
      numberOfBoxes: 0,
      calculationTromp: JSON.stringify({ quantity: 30 }),
      calculationSchneider: JSON.stringify({ quantity: 20 }),
    };
    expect(toBusinessSale(list({ ...calcs, printer: 'qrsong' })).boxes).toBe(30);
    expect(toBusinessSale(list({ ...calcs, printer: 'schneider' })).boxes).toBe(20);
    expect(toBusinessSale(list({ numberOfBoxes: 0, calculationSchneider: '{bad' })).boxes).toBe(0);
  });
});

describe('getBusinessSales', () => {
  // Company.test is the admin's "Lead" flag: a lead's sold list counts too
  // (Kranen Kerstpakketten's Kramp list went missing on the first deploy).
  it('reads every sold list, within the range when one is given, whatever the company status', async () => {
    prismaMock.companyList.findMany.mockResolvedValue([list()]);
    const start = new Date(2026, 8, 1);
    const end = new Date(2026, 9, 0, 23, 59, 59);

    const sales = await getBusinessSales({ start, end });

    expect(sales).toHaveLength(1);
    expect(prismaMock.companyList.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sold: true, soldAt: { gte: start, lte: end } },
      })
    );
  });
});

describe('groupBusinessSales', () => {
  it('sums per key and keys periods on the UTC day or month', () => {
    const sales = [
      toBusinessSale(list({ id: 1 })),
      toBusinessSale(list({ id: 2, sellPrice: 0.1, buyPrice: 0.2, numberOfBoxes: 1 })),
      toBusinessSale(list({ id: 3, soldAt: new Date('2026-09-30T12:00:00.000Z'), buyPrice: null })),
    ];

    const byDay = groupBusinessSales(sales, businessPeriodKey('day'));
    expect([...byDay.keys()]).toEqual(['2026-09-14', '2026-09-30']);
    expect(byDay.get('2026-09-14')).toEqual({
      businessAmount: 2,
      businessBoxes: 51,
      businessTotal: 1210.12,
      businessExVat: 1000.1,
      businessProfit: 399.9,
      businessProfitKnownCount: 2,
    });

    const byMonth = groupBusinessSales(sales, businessPeriodKey('month'));
    expect([...byMonth.keys()]).toEqual(['2026-09']);
    expect(byMonth.get('2026-09')).toMatchObject({
      businessAmount: 3,
      businessProfitKnownCount: 2,
    });
  });
});

describe('soldDateToTimestamp', () => {
  it('stores a day at 12:00 UTC', () => {
    expect(soldDateToTimestamp('2026-09-14')?.toISOString()).toBe(
      '2026-09-14T12:00:00.000Z'
    );
  });

  it('refuses anything that is not a real YYYY-MM-DD date', () => {
    expect(soldDateToTimestamp('2026-02-30')).toBeNull();
    expect(soldDateToTimestamp('14-09-2026')).toBeNull();
    expect(soldDateToTimestamp('2026-09-14T10:00')).toBeNull();
    expect(soldDateToTimestamp('')).toBeNull();
  });
});

describe('markListSold', () => {
  it('404s for a list of another company', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 99,
      sellPrice: 1000,
      soldAt: null,
    });

    const result = await markListSold(50, 7, true);

    expect(result).toEqual({ success: false, status: 404, error: 'List not found' });
    expect(prismaMock.companyList.update).not.toHaveBeenCalled();
  });

  it('refuses to sell a list without a sell price', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 50,
      sellPrice: null,
      soldAt: null,
    });

    const result = await markListSold(50, 7, true);

    expect(result).toMatchObject({ success: false, status: 400 });
    expect(prismaMock.companyList.update).not.toHaveBeenCalled();
  });

  it('stores the given sold date', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 50,
      sellPrice: 1000,
      soldAt: null,
    });

    const result = await markListSold(50, 7, true, '2026-03-02');

    const soldAt = new Date('2026-03-02T12:00:00.000Z');
    expect(result).toEqual({ success: true, sold: true, soldAt });
    expect(prismaMock.companyList.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { sold: true, soldAt },
    });
  });

  it('keeps the date a list already had, and uses today for a first sale', async () => {
    const earlier = new Date('2026-03-02T12:00:00.000Z');
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 50,
      sellPrice: 1000,
      soldAt: earlier,
    });
    expect(await markListSold(50, 7, true)).toMatchObject({ soldAt: earlier });

    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 50,
      sellPrice: 1000,
      soldAt: null,
    });
    const today = new Date().toISOString().slice(0, 10);
    const result = await markListSold(50, 7, true);
    expect(result.success && result.soldAt?.toISOString()).toBe(`${today}T12:00:00.000Z`);
  });

  it('rejects an invalid date', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 50,
      sellPrice: 1000,
      soldAt: null,
    });

    expect(await markListSold(50, 7, true, 'yesterday')).toMatchObject({
      success: false,
      status: 400,
    });
  });

  it('clears the date when the toggle goes off, price or not', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 50,
      sellPrice: null,
      soldAt: new Date(),
    });

    const result = await markListSold(50, 7, false);

    expect(result).toEqual({ success: true, sold: false, soldAt: null });
    expect(prismaMock.companyList.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { sold: false, soldAt: null },
    });
  });
});
