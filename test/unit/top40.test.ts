import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/top40.ts.
 *
 * Mocks:
 *  - axios       → returns controlled CSV data
 *  - src/prisma  → in-memory top40Chart model
 *  - src/logger  → no-op
 */

const top40ChartMock = vi.hoisted(() => ({
  findMany: vi.fn(async () => [] as any[]),
  createMany: vi.fn(async () => ({ count: 0 })),
  findFirst: vi.fn(async () => null as any),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({ top40Chart: top40ChartMock }) },
}));

vi.mock('axios');
import axios from 'axios';

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import Top40 from '../../src/top40';

const axiosGet = vi.mocked(axios.get);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset singleton
  (Top40 as any).instance = undefined;
});

function makeSvc() {
  return Top40.getInstance();
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Build a valid tab-separated CSV row with at least 9 columns.
 */
function csvRow(
  year: number,
  week: number,
  pos: number,
  artist = 'Artist',
  title = 'Title',
  prevPos = 0,
  weeks = 1,
  status = 'NEW',
  externalId = 'EXT001'
) {
  return [year, week, pos, artist, title, prevPos, weeks, status, externalId].join('\t');
}

function csvWithHeader(...rows: string[]) {
  return ['year\tweek\tpos\tartist\ttitle\tprevPos\tweeks\tstatus\texId', ...rows].join('\n');
}

// ──────────────────────────────────────────────
// importTop40Data – CSV parsing
// ──────────────────────────────────────────────

describe('Top40.importTop40Data – CSV parsing', () => {
  it('returns success with 0 imported when all rows already exist', async () => {
    const csv = csvWithHeader(csvRow(2024, 1, 1, 'ABBA', 'Dancing Queen'));
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([{ year: 2024, weekNumber: 1, position: 1 }]);
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    expect(res.success).toBe(true);
    expect(res.imported).toBe(0);
    expect(top40ChartMock.createMany).not.toHaveBeenCalled();
  });

  it('imports new entries not in the DB', async () => {
    const csv = csvWithHeader(
      csvRow(2024, 2, 1, 'Queen', 'Bohemian Rhapsody'),
      csvRow(2024, 2, 2, 'ABBA', 'Dancing Queen')
    );
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([]); // nothing in DB
    top40ChartMock.createMany.mockResolvedValueOnce({ count: 2 });
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    expect(res.success).toBe(true);
    expect(res.imported).toBe(2);
    expect(res.totalRows).toBe(2);
    expect(top40ChartMock.createMany).toHaveBeenCalledTimes(1);
  });

  it('skips rows with fewer than 9 columns (too short)', async () => {
    const csv = ['header', 'only\tfive\tcolumns\there\t.'].join('\n');
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([]);
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    // 0 valid entries → nothing imported
    expect(res.totalRows).toBe(0);
    expect(res.success).toBe(true);
  });

  it('skips empty lines in CSV', async () => {
    const csv = csvWithHeader(
      '', // empty line
      csvRow(2024, 3, 1, 'Eagles', 'Hotel California'),
      '' // trailing empty
    );
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([]);
    top40ChartMock.createMany.mockResolvedValueOnce({ count: 1 });
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    expect(res.totalRows).toBe(1);
  });

  it('skips rows where year/weekNumber/position are NaN', async () => {
    // Non-numeric year
    const row = ['notAnYear', '1', '1', 'Artist', 'Title', '0', '1', 'NEW', 'EXT'].join('\t');
    const csv = ['header', row].join('\n');
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([]);
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    expect(res.totalRows).toBe(0);
  });

  it('handles batch insert failure gracefully', async () => {
    const csv = csvWithHeader(csvRow(2024, 4, 1));
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([]);
    top40ChartMock.createMany.mockRejectedValueOnce(new Error('DB constraint'));
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    expect(res.success).toBe(true);
    expect(res.errors).toBe(1);
    expect(res.imported).toBe(0);
  });

  it('returns failure when axios throws', async () => {
    axiosGet.mockRejectedValueOnce(new Error('Network error'));
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    expect(res.success).toBe(false);
    expect(res.error).toContain('Network error');
  });

  it('includes correct batch data fields', async () => {
    const csv = csvWithHeader(csvRow(2023, 10, 3, 'David Bowie', 'Heroes', 5, 4, 'UP', 'EXT100'));
    axiosGet.mockResolvedValueOnce({ data: csv });
    top40ChartMock.findMany.mockResolvedValueOnce([]);
    top40ChartMock.createMany.mockResolvedValueOnce({ count: 1 });
    const svc = makeSvc();
    await svc.importTop40Data();
    const callData = top40ChartMock.createMany.mock.calls[0][0].data[0];
    expect(callData).toMatchObject({
      year: 2023,
      weekNumber: 10,
      position: 3,
      artist: 'David Bowie',
      title: 'Heroes',
      previousPosition: 5,
      weeksOnChart: 4,
      status: 'UP',
      externalId: 'EXT100',
    });
  });

  it('only imports entries not already in DB (key deduplication)', async () => {
    const csv = csvWithHeader(
      csvRow(2024, 5, 1), // already in DB
      csvRow(2024, 5, 2)  // new
    );
    axiosGet.mockResolvedValueOnce({ data: csv });
    // Simulate existing entry for position 1
    top40ChartMock.findMany.mockResolvedValueOnce([{ year: 2024, weekNumber: 5, position: 1 }]);
    top40ChartMock.createMany.mockResolvedValueOnce({ count: 1 });
    const svc = makeSvc();
    const res = await svc.importTop40Data();
    // Only 1 new entry should be imported
    const batchData = top40ChartMock.createMany.mock.calls[0][0].data;
    expect(batchData).toHaveLength(1);
    expect(batchData[0].position).toBe(2);
    expect(res.imported).toBe(1);
  });
});

// ──────────────────────────────────────────────
// getNumberOneOnDate
// ──────────────────────────────────────────────

describe('Top40.getNumberOneOnDate', () => {
  it('returns exact week entry when found', async () => {
    const entry = { artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975, weekNumber: 42 };
    top40ChartMock.findFirst.mockResolvedValueOnce(entry);
    const svc = makeSvc();
    const date = new Date('1975-10-15'); // fall of 1975
    const result = await svc.getNumberOneOnDate(date);
    expect(result).toEqual(entry);
  });

  it('falls back to previous entry when exact week not found', async () => {
    // First call returns null (exact week), second returns fallback
    const fallback = { artist: 'ABBA', title: 'Waterloo', year: 1974, weekNumber: 15 };
    top40ChartMock.findFirst
      .mockResolvedValueOnce(null)     // exact week: not found
      .mockResolvedValueOnce(fallback); // fallback: found
    const svc = makeSvc();
    const result = await svc.getNumberOneOnDate(new Date('1975-10-15'));
    expect(result).toEqual(fallback);
    // Should have been called twice
    expect(top40ChartMock.findFirst).toHaveBeenCalledTimes(2);
  });

  it('returns null when nothing found at all', async () => {
    top40ChartMock.findFirst.mockResolvedValue(null);
    const svc = makeSvc();
    const result = await svc.getNumberOneOnDate(new Date('1975-10-15'));
    expect(result).toBeNull();
  });

  it('handles dates before Top 40 started (before 1965-01-02) by using first ever #1', async () => {
    const firstEver = { artist: 'Beatles', title: 'Love Me Do', year: 1965, weekNumber: 1 };
    top40ChartMock.findFirst.mockResolvedValueOnce(firstEver);
    const svc = makeSvc();
    // Date before 1965
    const result = await svc.getNumberOneOnDate(new Date('1960-06-01'));
    expect(result).toEqual(firstEver);
    // The findFirst call should look for position: 1, ordered asc
    expect(top40ChartMock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ position: 1 }),
        orderBy: expect.arrayContaining([{ year: 'asc' }]),
      })
    );
  });

  it('returns null on DB error', async () => {
    top40ChartMock.findFirst.mockRejectedValueOnce(new Error('DB fail'));
    const svc = makeSvc();
    const result = await svc.getNumberOneOnDate(new Date('1975-10-15'));
    expect(result).toBeNull();
  });
});

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

describe('Top40 singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const svc = makeSvc();
    expect(Top40.getInstance()).toBe(svc);
  });
});
