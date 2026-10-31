import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/reportPeriods.ts: every day or month from the first
 * sale's up to the current one gets a row in the day and month reports and
 * the charts' moving average. What matters is that no period in between is
 * missing (also across month and year ends and leap days), that a row is
 * never dropped, and that the first sale is the same whatever the toggles.
 */

const prismaMock = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

import { getFirstSale, notOwnOrderSql, periodOf, reportPeriods } from '../../src/reportPeriods';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
});

describe('periodOf', () => {
  it('is the UTC day or month, like MySQL formats the stored timestamps', () => {
    // 00:30 in Amsterdam on 1 October is still 30 September in UTC.
    const lateNight = new Date('2026-09-30T22:30:00.000Z');
    expect(periodOf(lateNight, 'day')).toBe('2026-09-30');
    expect(periodOf(lateNight, 'month')).toBe('2026-09');
  });
});

describe('reportPeriods', () => {
  it('lists every day from the first to the last, across month and year ends', () => {
    expect(reportPeriods([], 'day', '2024-12-30', '2025-01-02')).toEqual([
      '2024-12-30',
      '2024-12-31',
      '2025-01-01',
      '2025-01-02',
    ]);
    expect(reportPeriods([], 'day', '2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('lists every month from the first to the last, across a year end', () => {
    expect(reportPeriods([], 'month', '2024-11', '2025-02')).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
  });

  it('fills the gaps between the rows', () => {
    expect(reportPeriods(['2026-09', '2026-06'], 'month', '2026-05', '2026-10')).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
  });

  it('keeps a row outside the range and widens the range to it', () => {
    expect(reportPeriods(['2026-03', '2026-12'], 'month', '2026-05', '2026-10')).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
  });

  it('gives the first and only period when the first sale was this period', () => {
    expect(reportPeriods([], 'day', '2026-10-31', '2026-10-31')).toEqual(['2026-10-31']);
  });

  it('gives nothing for a range that ends before it starts, except the rows in it', () => {
    expect(reportPeriods([], 'day', '2024-12-05', '2024-06-30')).toEqual([]);
    expect(reportPeriods(['2024-06-01', '2024-06-03'], 'day', '2024-12-05', '2024-06-30')).toEqual(
      reportPeriods([], 'day', '2024-06-01', '2024-06-30')
    );
  });

  it('without a first sale only has the rows, once each and sorted', () => {
    expect(reportPeriods(['2026-09', '2026-07', '2026-09'], 'month', null, '2026-10')).toEqual([
      '2026-07',
      '2026-09',
    ]);
    expect(reportPeriods([], 'month', null, '2026-10')).toEqual([]);
  });
});

describe('notOwnOrderSql', () => {
  const environment = process.env['ENVIRONMENT'];
  afterEach(() => {
    process.env['ENVIRONMENT'] = environment;
  });

  it("leaves Rick's own orders out in production only", () => {
    process.env['ENVIRONMENT'] = 'production';
    expect(notOwnOrderSql('p')).toBe(
      " AND p.email NOT IN ('west14@gmail.com','info@rickgroenewegen.nl')"
    );
    process.env['ENVIRONMENT'] = 'development';
    expect(notOwnOrderSql('p')).toBe('');
  });
});

describe('getFirstSale', () => {
  it('is the earliest paid order, QRGames, App Designer or sold list', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { firstSale: new Date('2024-12-05T09:14:00.000Z') },
    ]);

    expect(await getFirstSale()).toEqual(new Date('2024-12-05T09:14:00.000Z'));

    const sql: string = prismaMock.$queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain("p.status = 'paid'");
    expect(sql).toContain("p.createdAt > '2024-12-05'");
    expect(sql).toContain("(p.storeEnvironment IS NULL OR p.storeEnvironment <> 'sandbox')");
    expect(sql).toContain('FROM games_purchases gp');
    expect(sql).toContain('FROM app_design_purchases adp');
    expect(sql).toContain('FROM company_lists cl WHERE cl.sold = 1');
    // The same for every channel, so the toggle never changes the rows.
    expect(sql).not.toContain('channel');
  });

  it('is null while nothing has been sold', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ firstSale: null }]);
    expect(await getFirstSale()).toBeNull();
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    expect(await getFirstSale()).toBeNull();
  });
});
