import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/customerReport.ts: the top customers of the site. What
 * matters is that a customer's orders, QRGames and App Designer add up as in
 * the day and month reports, that business orders stay out of every query,
 * and that the ranking and the period are what the tabs say.
 */

const prismaMock = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  user: { findMany: vi.fn() },
  payment: { findMany: vi.fn() },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

import {
  customerReportSince,
  getCustomerReport,
  mergeCustomerFigures,
  parseCustomerReportPeriod,
  parseCustomerReportSort,
  rankCustomers,
} from '../../src/customerReport';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parsers', () => {
  it('reads an unknown period as all time and an unknown sort as spend', () => {
    expect(parseCustomerReportPeriod('year')).toBe('year');
    expect(parseCustomerReportPeriod('12m')).toBe('12m');
    expect(parseCustomerReportPeriod('forever')).toBe('all');
    expect(parseCustomerReportPeriod(undefined)).toBe('all');
    expect(parseCustomerReportSort('orders')).toBe('orders');
    expect(parseCustomerReportSort('profit')).toBe('profit');
    expect(parseCustomerReportSort('name')).toBe('spend');
  });
});

describe('customerReportSince', () => {
  const now = new Date(2026, 9, 25, 12);

  it('starts all time on the reports start date', () => {
    expect(customerReportSince('all', now).toISOString()).toBe('2024-12-05T00:00:00.000Z');
  });

  it('starts this year on 1 January', () => {
    expect(customerReportSince('year', now)).toEqual(new Date(2026, 0, 1));
  });

  it('starts the last 12 months a year ago, never before the reports start', () => {
    expect(customerReportSince('12m', now)).toEqual(new Date(2025, 9, 25, 12));
    expect(customerReportSince('12m', new Date(2025, 0, 10)).toISOString()).toBe(
      '2024-12-05T00:00:00.000Z'
    );
  });
});

describe('mergeCustomerFigures', () => {
  it('adds QRGames and App Designer to the orders of the same customer', () => {
    const rows = mergeCustomerFigures(
      [
        {
          userId: 1,
          numberOfSales: BigInt(3),
          totalPrice: 120.456,
          totalPriceWithoutTax: 99.5,
          totalRefunded: 0,
          boxAmount: '2',
          totalProfit: 40.1,
          profitAssignedCount: BigInt(2),
          firstOrderAt: new Date('2025-01-02T10:00:00.000Z'),
          lastOrderAt: new Date('2026-03-04T10:00:00.000Z'),
        },
      ],
      [{ userId: 1, gamesAmount: BigInt(2), gamesTotal: 9.99, gamesExVat: 8.26 }],
      [{ userId: 2, appDesignAmount: BigInt(1), appDesignTotal: 12.1, appDesignExVat: 10 }]
    );

    expect(rows).toHaveLength(2);
    const one = rows.find((r) => r.userId === 1)!;
    expect(one.numberOfSales).toBe(3);
    expect(one.totalPrice).toBe(120.46);
    expect(one.boxAmount).toBe(2);
    expect(one.gamesAmount).toBe(2);
    expect(one.gamesTotal).toBe(9.99);
    expect(one.profitAssignedCount).toBe(2);
    expect(one.firstOrderAt).toBe('2025-01-02T10:00:00.000Z');

    // Only App Designer on the account: no orders, no order dates.
    const two = rows.find((r) => r.userId === 2)!;
    expect(two.numberOfSales).toBe(0);
    expect(two.appDesignTotal).toBe(12.1);
    expect(two.lastOrderAt).toBeNull();
  });
});

describe('rankCustomers', () => {
  const rows = mergeCustomerFigures(
    [
      { userId: 1, numberOfSales: 1, totalPrice: 300, totalProfit: 50, profitAssignedCount: 1 },
      { userId: 2, numberOfSales: 5, totalPrice: 100, totalProfit: 60, profitAssignedCount: 5 },
      { userId: 3, numberOfSales: 5, totalPrice: 200, totalProfit: 10, profitAssignedCount: 5 },
    ],
    [{ userId: 2, gamesAmount: 1, gamesTotal: 250, gamesExVat: 206.61 }],
    []
  );

  it('ranks by spend: orders, QRGames upgrades and App Designer together', () => {
    expect(rankCustomers(rows, 'spend').map((r) => r.userId)).toEqual([2, 1, 3]);
  });

  it('ranks by orders, ties broken by spend', () => {
    expect(rankCustomers(rows, 'orders').map((r) => r.userId)).toEqual([2, 3, 1]);
  });

  it('ranks by profit ex VAT', () => {
    expect(rankCustomers(rows, 'profit').map((r) => r.userId)).toEqual([2, 1, 3]);
  });

  it('keeps the top of the list only', () => {
    expect(rankCustomers(rows, 'spend', 2)).toHaveLength(2);
  });
});

describe('getCustomerReport', () => {
  const env = process.env['ENVIRONMENT'];

  afterEach(() => {
    process.env['ENVIRONMENT'] = env;
  });

  function mockQueries() {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        { userId: 1, numberOfSales: 2, totalPrice: 80, totalProfit: 20, profitAssignedCount: 2 },
        { userId: 2, numberOfSales: 1, totalPrice: 500, totalProfit: 90, profitAssignedCount: 1 },
        { userId: 3, numberOfSales: 1, totalPrice: 40, totalProfit: 9, profitAssignedCount: 1 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: 1, email: 'anna@example.com', displayName: 'anna', country: 'NL' },
      { id: 2, email: 'west14@gmail.com', displayName: 'Rick', country: 'NL' },
      { id: 3, email: 'bert@example.com', displayName: 'Bert', country: null },
    ]);
    prismaMock.payment.findMany.mockResolvedValue([
      { userId: 1, fullname: 'Anna de Vries', countrycode: 'BE' },
      { userId: 1, fullname: 'Anna old name', countrycode: 'NL' },
    ]);
  }

  it('leaves business orders out of all three queries', async () => {
    mockQueries();
    await getCustomerReport();

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    for (const [sql] of prismaMock.$queryRawUnsafe.mock.calls) {
      expect(sql).toContain('p.isBusinessOrder = 0');
      expect(sql).toContain("p.paymentId NOT LIKE 'toolkit\\_%'");
      expect(sql).toContain("p.paymentId NOT LIKE 'reseller\\_%'");
      expect(sql).toContain('company_lists cl WHERE cl.paymentId = p.id');
    }
  });

  it('names a customer after the latest order and skips our own addresses in production', async () => {
    process.env['ENVIRONMENT'] = 'production';
    mockQueries();

    const rows = await getCustomerReport('all', 'spend');

    expect(rows.map((r) => r.userId)).toEqual([1, 3]);
    expect(rows[0]).toMatchObject({
      name: 'Anna de Vries',
      email: 'anna@example.com',
      country: 'BE',
    });
    // No order to take a name from: the account's display name.
    expect(rows[1]).toMatchObject({ name: 'Bert', country: null });
  });

  it('keeps our own addresses outside production', async () => {
    process.env['ENVIRONMENT'] = 'development';
    mockQueries();

    const rows = await getCustomerReport('all', 'spend');

    expect(rows.map((r) => r.userId)).toEqual([2, 1, 3]);
  });

  it('narrows every query to a channel, and asks what it always did for all', async () => {
    const appOrder = (alias: string) =>
      `EXISTS (SELECT 1 FROM payments cp WHERE cp.id = ${alias}.paymentId AND cp.channel = 'app')`;
    const sqls = () => prismaMock.$queryRawUnsafe.mock.calls.map((c: any[]) => c[0] as string);

    mockQueries();
    await getCustomerReport('year', 'profit');
    for (const sql of sqls()) expect(sql).not.toContain('channel');

    vi.clearAllMocks();
    mockQueries();
    await getCustomerReport('all', 'spend', 'app');
    const [orders, games, appDesign] = sqls();
    expect(orders).toContain("AND p.createdAt >= ? AND p.channel = 'app'");
    expect(games).toContain(`AND ${appOrder('gp')}`);
    expect(appDesign).toContain(`AND ${appOrder('adp')}`);

    vi.clearAllMocks();
    mockQueries();
    await getCustomerReport('all', 'spend', 'web');
    const [webOrders, webGames, webAppDesign] = sqls();
    expect(webOrders).toContain('AND p.createdAt >= ? AND p.channel IS NULL');
    expect(webGames).toContain(`AND NOT ${appOrder('gp')}`);
    expect(webAppDesign).toContain(`AND NOT ${appOrder('adp')}`);
  });

  it('asks nothing more when there are no customers', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);

    expect(await getCustomerReport()).toEqual([]);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });
});
