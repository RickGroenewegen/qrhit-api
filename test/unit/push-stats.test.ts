import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({}) },
}));

import { buildLosses, buildMonths, buildPlatforms, monthKeys, toCount } from '../../src/pushStats';

describe('pushStats helpers', () => {
  it('reads MySQL counts: BigInt, Decimal-like strings and null', () => {
    expect(toCount(BigInt(12))).toBe(12);
    expect(toCount('7')).toBe(7);
    expect(toCount({ valueOf: () => '3' })).toBe(3);
    expect(toCount(null)).toBe(0);
    expect(toCount(undefined)).toBe(0);
    expect(toCount('not a number')).toBe(0);
  });

  it('lists months up to the current one, across a year end, in UTC', () => {
    expect(monthKeys(new Date('2026-02-15T12:00:00Z'), 4)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    // Late on the last day of a month in UTC is still that month
    expect(monthKeys(new Date('2026-10-31T23:30:00Z'), 1)).toEqual(['2026-10']);
  });

  it('fills the months with zeros and starts at the first month with anything', () => {
    const keys = ['2026-01', '2026-02', '2026-03', '2026-04'];
    const months = buildMonths(
      keys,
      [
        { month: '2026-02', platform: 'ios', n: BigInt(5) },
        { month: '2026-02', platform: 'android', n: BigInt(2) },
        { month: '2026-04', platform: 'web', n: BigInt(1) },
        { month: '2026-04', platform: 'windows', n: BigInt(9) },
        { month: '2025-12', platform: 'ios', n: BigInt(9) },
      ],
      [{ month: '2026-03', platform: 'android', n: BigInt(4) }]
    );
    expect(months).toEqual([
      { month: '2026-02', ios: 5, android: 2, web: 0, unreachable: 0 },
      { month: '2026-03', ios: 0, android: 0, web: 0, unreachable: 4 },
      { month: '2026-04', ios: 0, android: 0, web: 1, unreachable: 0 },
    ]);
    expect(buildMonths(keys, [], [])).toEqual([]);
  });

  it('adds up the platforms and finds the first registration', () => {
    const { platforms, firstRegisteredAt } = buildPlatforms([
      {
        platform: 'ios',
        reachable: '10',
        unreachable: '2',
        test: '1',
        new7d: '3',
        new30d: '4',
        sinceLastLive: '5',
        first: new Date('2025-01-02T00:00:00Z'),
      },
      // The web table without rows: one row of nulls
      {
        platform: 'web',
        reachable: null,
        unreachable: null,
        test: null,
        new7d: null,
        new30d: null,
        sinceLastLive: null,
        first: null,
      },
      {
        platform: 'android',
        reachable: '6',
        unreachable: '1',
        test: '0',
        new7d: '1',
        new30d: '2',
        sinceLastLive: '2',
        first: new Date('2024-12-01T00:00:00Z'),
      },
    ]);
    expect(platforms.ios).toEqual({ reachable: 10, unreachable: 2, test: 1, new7d: 3, new30d: 4, sinceLastLive: 5 });
    expect(platforms.web).toEqual({ reachable: 0, unreachable: 0, test: 0, new7d: 0, new30d: 0, sinceLastLive: 0 });
    expect(platforms.android.reachable).toBe(6);
    expect(firstRegisteredAt).toEqual(new Date('2024-12-01T00:00:00Z'));
  });

  it('groups the unreachable devices per broadcast, newest first', () => {
    expect(
      buildLosses([
        { id: 8, platform: 'ios', n: BigInt(214) },
        { id: 16, platform: 'android', n: BigInt(944) },
        { id: 8, platform: 'android', n: BigInt(45) },
        { id: 16, platform: 'ios', n: BigInt(244) },
        { id: 16, platform: 'web', n: BigInt(3) },
      ])
    ).toEqual([
      { id: 16, ios: 244, android: 944, web: 3 },
      { id: 8, ios: 214, android: 45, web: 0 },
    ]);
  });
});
