import { describe, it, expect, vi, beforeEach } from 'vitest';

// Map-backed stand-in for the ioredis client (db 1) - unit tests: no Redis.
const { redisStore, prismaMock } = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  prismaMock: {
    paymentHasPlaylist: { groupBy: vi.fn() },
  },
}));

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    constructor(_url: string, _opts: any) {}
    async incrby(key: string, n: number) {
      const next = parseInt(redisStore.get(key) || '0', 10) + n;
      redisStore.set(key, next.toString());
      return next;
    }
    async decrby(key: string, n: number) {
      const next = parseInt(redisStore.get(key) || '0', 10) - n;
      redisStore.set(key, next.toString());
      return next;
    }
    async get(key: string) {
      return redisStore.get(key) ?? null;
    }
    async set(key: string, value: string) {
      redisStore.set(key, value);
    }
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, '');
      return [...redisStore.keys()].filter((k) => k.startsWith(prefix));
    }
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379';

import AnalyticsClient from '../../src/analytics';

const analytics = AnalyticsClient.getInstance();

beforeEach(() => {
  redisStore.clear();
  prismaMock.paymentHasPlaylist.groupBy.mockReset();
});

describe('counters', () => {
  it('is a singleton', () => {
    expect(AnalyticsClient.getInstance()).toBe(analytics);
  });

  it('increments under the analytics:category:action key (default 1)', async () => {
    expect(await analytics.increaseCounter('page', 'views')).toBe(1);
    expect(await analytics.increaseCounter('page', 'views', 5)).toBe(6);
    expect(redisStore.get('analytics:page:views')).toBe('6');
  });

  it('decrements counters', async () => {
    await analytics.setCounter('page', 'views', 10);
    expect(await analytics.decreaseCounter('page', 'views')).toBe(9);
    expect(await analytics.decreaseCounter('page', 'views', 4)).toBe(5);
  });

  it('reads back counters, defaulting to 0 for unknown keys', async () => {
    await analytics.setCounter('mail', 'sent', 42);
    expect(await analytics.getCounter('mail', 'sent')).toBe(42);
    expect(await analytics.getCounter('mail', 'bounced')).toBe(0);
  });
});

describe('getTotalPlaylistsSoldByType', () => {
  it('maps groupBy rows onto the digital/physical defaults', async () => {
    prismaMock.paymentHasPlaylist.groupBy.mockResolvedValue([
      { type: 'digital', _sum: { amount: 5, numberOfTracks: 200 } },
    ]);
    const result = await analytics.getTotalPlaylistsSoldByType();
    expect(result).toEqual({
      digital: { amount: 5, tracks: 200 },
      physical: { amount: 0, tracks: 0 },
    });
    // excludes test/vibe payments and the default owner emails
    expect(prismaMock.paymentHasPlaylist.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['type'],
        where: {
          payment: {
            vibe: false,
            test: false,
            user: {
              email: {
                notIn: ['west14@gmail.com', 'info@rickgroenewegen.nl'],
              },
            },
          },
        },
      })
    );
  });

  it('treats null sums as zero and honors a custom exclusion list', async () => {
    prismaMock.paymentHasPlaylist.groupBy.mockResolvedValue([
      { type: 'physical', _sum: { amount: null, numberOfTracks: null } },
    ]);
    const result = await analytics.getTotalPlaylistsSoldByType(['x@y.com']);
    expect(result.physical).toEqual({ amount: 0, tracks: 0 });
    expect(
      prismaMock.paymentHasPlaylist.groupBy.mock.calls[0][0].where.payment.user
        .email.notIn
    ).toEqual(['x@y.com']);
  });
});

describe('getAllCounters', () => {
  it('merges Redis counters with the purchase aggregates (finance comes from the sales report)', async () => {
    await analytics.increaseCounter('page', 'views', 3);
    await analytics.increaseCounter('page', 'clicks', 2);
    await analytics.increaseCounter('mail', 'sent', 9);

    prismaMock.paymentHasPlaylist.groupBy.mockResolvedValue([
      { type: 'digital', _sum: { amount: 2, numberOfTracks: 80 } },
      { type: 'physical', _sum: { amount: 1, numberOfTracks: 40 } },
    ]);

    const all = await analytics.getAllCounters();
    expect(all.page).toEqual({ views: 3, clicks: 2 });
    expect(all.mail).toEqual({ sent: 9 });
    expect(all.finance).toBeUndefined();
    expect(all.purchase).toEqual({
      digital: 2,
      physical: 1,
      cards: 120,
    });
  });
});
