import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/charts.ts.
 *
 * The Charts class uses $queryRawUnsafe (raw SQL) which is mocked here.
 * The private `buildDateFilter` method is exercised through the public API.
 * No real database is touched.
 */

const queryRawUnsafe = vi.fn(async () => [] as any[]);

vi.mock('../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      $queryRawUnsafe: queryRawUnsafe,
    }),
  },
}));

// Dynamically import after mocks
let Charts: typeof import('../../src/charts').default;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  // Re-hoisted mock survives resetModules because vi.mock is hoisted
  const mod = await import('../../src/charts');
  Charts = mod.default;
  // Reset singleton
  (Charts as any).instance = undefined;
});

function makeSvc() {
  return Charts.getInstance();
}

// ──────────────────────────────────────────────
// buildDateFilter (exercised via public methods)
// ──────────────────────────────────────────────

describe('Charts.buildDateFilter via getMovingAverage', () => {
  it('passes no date argument → uses default 90-day interval', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage();
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('INTERVAL 90 DAY');
  });

  it('accepts days=30', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(30);
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('INTERVAL 30 DAY');
  });

  it('accepts days=365', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(365);
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('INTERVAL 365 DAY');
  });

  it('throws on invalid days value', async () => {
    const svc = makeSvc();
    await expect(svc.getMovingAverage(7)).rejects.toThrow('Invalid days parameter');
  });

  it('uses custom date range when startDate and endDate are provided', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(undefined, '2024-01-01', '2024-03-31');
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain("BETWEEN '2024-01-01' AND '2024-03-31'");
  });

  it('custom date range takes precedence over days param', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(30, '2024-01-01', '2024-03-31');
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    // startDate+endDate wins; should NOT contain INTERVAL
    expect(sql).not.toContain('INTERVAL 30 DAY');
    expect(sql).toContain('BETWEEN');
  });

  it('refuses a date that is not YYYY-MM-DD (SQL injection)', async () => {
    const svc = makeSvc();
    await expect(
      svc.getMovingAverage(undefined, "2024-01-01' OR '1'='1", '2024-03-31')
    ).rejects.toThrow('Invalid date range');
    await expect(
      svc.getHourlySales(undefined, '2024-01-01', '2024-03-31; DROP TABLE users')
    ).rejects.toThrow('Invalid date range');
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// getMovingAverage
// ──────────────────────────────────────────────

describe('Charts.getMovingAverage', () => {
  it('has nothing to show while nothing has been sold', async () => {
    const svc = makeSvc();
    expect(await svc.getMovingAverage(90)).toEqual([]);
  });

  it('adds App Designer gross to daily_sales and its ex-VAT to daily_profit', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(90);
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    const salesExpr = sql.slice(sql.indexOf('DATE(p.createdAt) as date'), sql.indexOf('as daily_sales'));
    const profitExpr = sql.slice(sql.indexOf('as daily_sales'), sql.indexOf('as daily_profit'));
    expect(salesExpr).toContain('SUM(adp.totalPrice) FROM app_design_purchases adp');
    expect(salesExpr).toContain('DATE(adp.createdAt) = DATE(p.createdAt)');
    expect(profitExpr).toContain('SUM(adp.totalPriceWithoutTax) FROM app_design_purchases adp');
    expect(profitExpr).not.toContain('SUM(adp.totalPrice)');
    // the QRGames subquery stays as it was
    expect(profitExpr).toContain('SUM(gp.totalPrice) FROM games_purchases gp');
  });

  it('asks the days with a sale, then the first sale', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(90);
    const [days, firstSale] = (queryRawUnsafe.mock.calls as any[]).map((c) => c[0] as string);
    expect(days).toContain('GROUP BY DATE(p.createdAt)');
    expect(days).not.toContain('PRECEDING');
    expect(firstSale).toContain('AS firstSale');
  });
});

// ──────────────────────────────────────────────
// getMovingAverage: every day, averages over calendar days
// ──────────────────────────────────────────────

describe('Charts.getMovingAverage: every day', () => {
  // A day with a sale, as MySQL returns it through Prisma.
  const saleDay = (date: string, sales: number, orders: number) => ({
    date: new Date(`${date}T00:00:00.000Z`),
    daily_sales: String(sales),
    daily_profit: String(sales / 2),
    payment_count: BigInt(orders),
    daily_aov: String(sales / orders),
  });

  /** The days with a sale, then the first sale (reportPeriods.ts). */
  function mockChart(rows: any[], firstSale: Date | null = new Date('2024-12-05T09:00:00.000Z')) {
    queryRawUnsafe
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ firstSale }]);
  }

  const day = (d: { date: Date }) => d.date.toISOString().slice(0, 10);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives every day of the range up to today, zeros on a day without sales', async () => {
    mockChart([saleDay('2026-10-10', 100, 2)]);

    const result = await makeSvc().getMovingAverage(30);

    expect(result).toHaveLength(31);
    expect(day(result[0])).toBe('2026-10-01');
    expect(day(result[30])).toBe('2026-10-31');
    expect(result[9]).toMatchObject({ daily_sales: 100, daily_profit: 50, payment_count: 2, daily_aov: 50 });
    // No orders, so no order value either.
    expect(result[8]).toMatchObject({ daily_sales: 0, daily_profit: 0, payment_count: 0, daily_aov: null });
  });

  it('averages the days before each day, the days without sales as zero', async () => {
    mockChart([saleDay('2026-10-01', 30, 1), saleDay('2026-10-03', 90, 3)]);

    const result = await makeSvc().getMovingAverage(30);

    // Nothing before the first day of the range.
    expect(result[0]).toMatchObject({ sales_ma_30d: null, orders_ma_30d: null, aov_ma_30d: null });
    expect(result[1]).toMatchObject({ sales_ma_30d: 30, profit_ma_30d: 15, orders_ma_30d: 1, aov_ma_30d: 30 });
    expect(result[2]).toMatchObject({ sales_ma_30d: 15, orders_ma_30d: 0.5, aov_ma_30d: 30 });
    // 1, 2 and 3 October: (30 + 0 + 90) / 3; the order value of the days with orders.
    expect(result[3]).toMatchObject({ sales_ma_30d: 40, orders_ma_30d: 1.33, aov_ma_30d: 30 });
    expect(result[30]).toMatchObject({ sales_ma_30d: 4, orders_ma_30d: 0.13 });
  });

  it('drops a sale from the average after 30 days, however few days had one', async () => {
    mockChart([saleDay('2026-09-01', 300, 1), saleDay('2026-10-20', 60, 1)]);

    const result = await makeSvc().getMovingAverage(undefined, '2026-09-01', '2026-10-31');
    const on = (date: string) => result.find((d) => day(d) === date)!;

    expect(on('2026-10-01').sales_ma_30d).toBe(10); // 1 to 30 September
    expect(on('2026-10-02').sales_ma_30d).toBe(0); // 2 September to 1 October
    expect(on('2026-10-21').sales_ma_30d).toBe(2); // 21 September to 20 October
  });

  it('starts at the first sale when the range reaches back further', async () => {
    mockChart([saleDay('2024-12-06', 50, 1)], new Date('2024-12-05T09:00:00.000Z'));

    const result = await makeSvc().getMovingAverage(undefined, '2024-11-01', '2024-12-10');

    expect(result.map(day)).toEqual([
      '2024-12-05',
      '2024-12-06',
      '2024-12-07',
      '2024-12-08',
      '2024-12-09',
      '2024-12-10',
    ]);
  });

  it('ends today when the range reaches into the future', async () => {
    mockChart([]);

    const result = await makeSvc().getMovingAverage(undefined, '2026-10-25', '2026-11-30');

    expect(result.map(day)).toEqual([
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
    ]);
  });

  it('shows the app the same days as the website, from the first sale of either', async () => {
    mockChart([saleDay('2026-10-30', 13, 1)]);

    const result = await makeSvc().getMovingAverage(90, undefined, undefined, 'app');

    expect(result).toHaveLength(91);
    const firstSaleSql: string = (queryRawUnsafe.mock.calls as any[])[1][0];
    expect(firstSaleSql).toContain('AS firstSale');
    expect(firstSaleSql).not.toContain('channel');
  });
});

// ──────────────────────────────────────────────
// getHourlySales
// ──────────────────────────────────────────────

describe('Charts.getHourlySales', () => {
  it('returns raw query result', async () => {
    const fakeRows = [{ hour: 10, avg_sales: 50 }];
    queryRawUnsafe.mockResolvedValueOnce(fakeRows);
    const svc = makeSvc();
    const result = await svc.getHourlySales(30);
    expect(result).toEqual(fakeRows);
  });

  it('SQL groups by HOUR(createdAt)', async () => {
    const svc = makeSvc();
    await svc.getHourlySales();
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('HOUR(createdAt)');
    expect(sql).toContain('GROUP BY HOUR(createdAt)');
  });

  it('applies date filter with custom range', async () => {
    const svc = makeSvc();
    await svc.getHourlySales(undefined, '2024-06-01', '2024-06-30');
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain("BETWEEN '2024-06-01' AND '2024-06-30'");
  });

  it('throws on invalid days', async () => {
    const svc = makeSvc();
    await expect(svc.getHourlySales(7)).rejects.toThrow('Invalid days parameter');
  });
});

// ──────────────────────────────────────────────
// getDailySales
// ──────────────────────────────────────────────

describe('Charts.getDailySales', () => {
  it('returns raw query result', async () => {
    const fakeRows = [{ day_of_week: 2, avg_sales: 80 }];
    queryRawUnsafe.mockResolvedValueOnce(fakeRows);
    const svc = makeSvc();
    const result = await svc.getDailySales(90);
    expect(result).toEqual(fakeRows);
  });

  it('SQL groups by DAYOFWEEK(createdAt)', async () => {
    const svc = makeSvc();
    await svc.getDailySales();
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('DAYOFWEEK(createdAt)');
    expect(sql).toContain('GROUP BY DAYOFWEEK(createdAt)');
  });

  it('throws on invalid days', async () => {
    const svc = makeSvc();
    await expect(svc.getDailySales(1)).rejects.toThrow('Invalid days parameter');
  });
});

// ──────────────────────────────────────────────
// Channel (the reports' Website / App toggle)
// ──────────────────────────────────────────────

describe('Charts: channel', () => {
  const appOrder = (alias: string) =>
    `EXISTS (SELECT 1 FROM payments cp WHERE cp.id = ${alias}.paymentId AND cp.channel = 'app')`;

  it('all: no channel in any chart query', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(90);
    await svc.getHourlySales(90, undefined, undefined, 'all');
    await svc.getDailySales(90);
    for (const [sql] of queryRawUnsafe.mock.calls as any[]) {
      expect(sql).not.toContain('channel');
    }
  });

  it('leaves store test purchases out of every chart', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(90);
    await svc.getHourlySales(90, undefined, undefined, 'all');
    await svc.getDailySales(90);
    for (const [sql] of queryRawUnsafe.mock.calls as any[]) {
      expect(sql).toMatch(/storeEnvironment <> 'sandbox'/);
    }
  });

  it('app: the moving average reads the app orders and what came with them', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(30, undefined, undefined, 'app');
    const sql: string = (queryRawUnsafe.mock.calls as any[])[0][0];
    expect(sql).toContain("INTERVAL 30 DAY) AND (p.storeEnvironment IS NULL OR p.storeEnvironment <> 'sandbox') AND p.channel = 'app'");
    expect(sql).toContain(`DATE(gp.createdAt) = DATE(p.createdAt) AND ${appOrder('gp')}`);
    // App Designer bought on the account (no order) is the website's: none here.
    expect(sql.split(`adp.paymentId IS NULL AND ${appOrder('adp')}`)).toHaveLength(3);
  });

  it('web: the moving average reads the website orders, upgrades and account purchases', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(30, undefined, undefined, 'web');
    const sql: string = (queryRawUnsafe.mock.calls as any[])[0][0];
    expect(sql).toContain("INTERVAL 30 DAY) AND (p.storeEnvironment IS NULL OR p.storeEnvironment <> 'sandbox') AND p.channel IS NULL");
    expect(sql).toContain(`AND NOT ${appOrder('gp')}`);
    expect(sql.split(`AND NOT ${appOrder('adp')}`)).toHaveLength(3);
  });

  it('narrows the hourly and daily averages', async () => {
    const svc = makeSvc();
    await svc.getHourlySales(undefined, '2024-06-01', '2024-06-30', 'app');
    await svc.getDailySales(365, undefined, undefined, 'web');
    const [hourly, daily] = (queryRawUnsafe.mock.calls as any[]).map((c) => c[0] as string);
    expect(hourly).toContain("BETWEEN '2024-06-01' AND '2024-06-30' AND (storeEnvironment IS NULL OR storeEnvironment <> 'sandbox') AND channel = 'app'");
    expect(daily).toContain("INTERVAL 365 DAY) AND (storeEnvironment IS NULL OR storeEnvironment <> 'sandbox') AND channel IS NULL");
  });
});

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

describe('Charts singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const svc = makeSvc();
    expect(Charts.getInstance()).toBe(svc);
  });
});
