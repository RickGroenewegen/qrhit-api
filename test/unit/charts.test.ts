import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});

// ──────────────────────────────────────────────
// getMovingAverage
// ──────────────────────────────────────────────

describe('Charts.getMovingAverage', () => {
  it('returns the raw query result directly', async () => {
    const fakeRows = [{ date: '2024-01-01', daily_sales: 100 }];
    queryRawUnsafe.mockResolvedValueOnce(fakeRows);
    const svc = makeSvc();
    const result = await svc.getMovingAverage(90);
    expect(result).toEqual(fakeRows);
  });

  it('generated SQL includes moving average window', async () => {
    const svc = makeSvc();
    await svc.getMovingAverage(90);
    const sql: string = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('30 PRECEDING AND 1 PRECEDING');
    expect(sql).toContain('sales_ma_30d');
    expect(sql).toContain('profit_ma_30d');
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
// Singleton
// ──────────────────────────────────────────────

describe('Charts singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const svc = makeSvc();
    expect(Charts.getInstance()).toBe(svc);
  });
});
