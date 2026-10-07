import { describe, it, expect, vi, beforeEach } from 'vitest';

// Map-backed stand-in for the ioredis client (db 1) - unit tests: no Redis.
const { redisStore, sortedSets, expiries, replyShape, prismaMock } = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  sortedSets: new Map<string, Map<string, number>>(),
  expiries: new Map<string, number>(),
  // 'flat': RESP2 / ioredis legacy mapping; 'pairs': RESP3 proper.
  replyShape: { zrange: 'flat' as 'flat' | 'pairs' },
  prismaMock: {
    paymentHasPlaylist: { groupBy: vi.fn() },
  },
}));

vi.mock('ioredis', () => {
  // multi() and pipeline() queue calls and run them in order on exec(),
  // answering [error, result] pairs like ioredis.
  const queue = (client: any) => {
    const ops: [string, any[]][] = [];
    const chain: any = new Proxy(
      {},
      {
        get(_target, name: string) {
          if (name === 'exec') {
            return async () => {
              const replies: [Error | null, any][] = [];
              for (const [op, args] of ops) {
                try {
                  replies.push([null, await client[op](...args)]);
                } catch (error) {
                  replies.push([error as Error, null]);
                }
              }
              return replies;
            };
          }
          return (...args: any[]) => {
            ops.push([name, args]);
            return chain;
          };
        },
      }
    );
    return chain;
  };

  return {
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
      async set(key: string, value: string, mode?: string) {
        if (mode === 'NX' && redisStore.has(key)) return null;
        redisStore.set(key, value);
        return 'OK';
      }
      async keys(pattern: string) {
        const prefix = pattern.replace(/\*$/, '');
        return [...redisStore.keys(), ...sortedSets.keys()].filter((k) =>
          k.startsWith(prefix)
        );
      }
      async zincrby(key: string, n: number, member: string) {
        const set = sortedSets.get(key) ?? new Map<string, number>();
        set.set(member, (set.get(member) || 0) + n);
        sortedSets.set(key, set);
        return String(set.get(member));
      }
      async zrange(key: string, _start: number, _stop: number, _withScores: string) {
        const set = sortedSets.get(key);
        if (!set) return [];
        const entries = [...set.entries()].sort((a, b) => a[1] - b[1]);
        if (replyShape.zrange === 'pairs') return entries;
        return entries.flatMap(([member, score]) => [member, String(score)]);
      }
      async expire(key: string, seconds: number) {
        expiries.set(key, seconds);
        return 1;
      }
      multi() {
        return queue(this);
      }
      pipeline() {
        return queue(this);
      }
    },
  };
});

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6379';

import AnalyticsClient, { playPhpId, playsHourKey } from '../../src/analytics';

const analytics = AnalyticsClient.getInstance();

beforeEach(() => {
  redisStore.clear();
  sortedSets.clear();
  expiries.clear();
  replyShape.zrange = 'flat';
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
    // excludes the default owner emails
    expect(prismaMock.paymentHasPlaylist.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['type'],
        where: {
          payment: {
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

  it('ignores the play ranking keys, which are sorted sets', async () => {
    await analytics.increaseCounter('songs', 'played');
    await analytics.recordPlaylistPlay(7);
    prismaMock.paymentHasPlaylist.groupBy.mockResolvedValue([]);

    const all = await analytics.getAllCounters();
    expect(all.songs).toEqual({ played: 1 });
    expect(all.plays).toBeUndefined();
    expect(all.php).toBeUndefined();
  });
});

describe('playPhpId', () => {
  it('accepts a positive integer, also as a route-param string', () => {
    expect(playPhpId('12')).toBe(12);
    expect(playPhpId(12)).toBe(12);
  });

  it('refuses anything else', () => {
    for (const value of [undefined, null, '', 'abc', '0', '-3', '1.5', 0, NaN]) {
      expect(playPhpId(value)).toBeNull();
    }
  });
});

describe('playsHourKey', () => {
  it('buckets by UTC hour', () => {
    expect(playsHourKey(new Date('2026-10-03T15:42:10Z'))).toBe(
      'plays:php:hour:2026100315'
    );
    expect(playsHourKey(new Date('2026-01-09T00:00:00Z'))).toBe(
      'plays:php:hour:2026010900'
    );
  });
});

const NOW = new Date('2026-10-03T15:30:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3600_000);

describe('recordPlaylistPlay', () => {
  it('counts the play in the total and its hour, which expires after 8 days', async () => {
    await analytics.recordPlaylistPlay(42, NOW);
    await analytics.recordPlaylistPlay(42, NOW);

    expect(sortedSets.get('plays:php:total')?.get('42')).toBe(2);
    expect(sortedSets.get('plays:php:hour:2026100315')?.get('42')).toBe(2);
    expect(expiries.get('plays:php:hour:2026100315')).toBe(8 * 24 * 3600);
    expect(expiries.has('plays:php:total')).toBe(false);
  });

  it('remembers when counting started, and only the first time', async () => {
    await analytics.recordPlaylistPlay(1, hoursAgo(5));
    await analytics.recordPlaylistPlay(1, NOW);
    expect(redisStore.get('plays:php:since')).toBe(hoursAgo(5).toISOString());
  });
});

describe('getPlaylistPlayRanking', () => {
  it('keeps two order lines apart, even of the same playlist', async () => {
    await analytics.recordPlaylistPlay(10, NOW);
    await analytics.recordPlaylistPlay(11, NOW);
    await analytics.recordPlaylistPlay(11, NOW);

    const ranking = await analytics.getPlaylistPlayRanking(NOW);
    expect(ranking.day.top).toEqual([
      { php: 11, plays: 2 },
      { php: 10, plays: 1 },
    ]);
  });

  it('reads 24 hours for the day, 168 for the week and everything for all time', async () => {
    await analytics.recordPlaylistPlay(4, hoursAgo(8 * 24)); // all time only
    await analytics.recordPlaylistPlay(3, hoursAgo(25)); // week and all time
    await analytics.recordPlaylistPlay(2, hoursAgo(23)); // every window
    await analytics.recordPlaylistPlay(1, NOW);
    await analytics.recordPlaylistPlay(1, NOW);

    const ranking = await analytics.getPlaylistPlayRanking(NOW);
    expect(ranking.day).toEqual({
      plays: 3,
      orders: 2,
      top: [
        { php: 1, plays: 2 },
        { php: 2, plays: 1 },
      ],
    });
    expect(ranking.week.plays).toBe(4);
    expect(ranking.week.top.map((r) => r.php)).toEqual([1, 2, 3]);
    expect(ranking.total.plays).toBe(5);
    expect(ranking.total.orders).toBe(4);
    expect(ranking.since).toBe(hoursAgo(8 * 24).toISOString());
  });

  it('lists the top only, but counts every play and order line', async () => {
    for (const php of [1, 2, 3]) await analytics.recordPlaylistPlay(php, NOW);
    await analytics.recordPlaylistPlay(3, NOW);

    const ranking = await analytics.getPlaylistPlayRanking(NOW, 2);
    expect(ranking.total.top).toEqual([
      { php: 3, plays: 2 },
      { php: 1, plays: 1 },
    ]);
    expect(ranking.total.plays).toBe(4);
    expect(ranking.total.orders).toBe(3);
  });

  it('reads RESP3 [member, score] pairs as well as the flat RESP2 reply', async () => {
    replyShape.zrange = 'pairs';
    await analytics.recordPlaylistPlay(8, NOW);
    await analytics.recordPlaylistPlay(8, NOW);
    await analytics.recordPlaylistPlay(9, NOW);

    const ranking = await analytics.getPlaylistPlayRanking(NOW);
    expect(ranking.day.top).toEqual([
      { php: 8, plays: 2 },
      { php: 9, plays: 1 },
    ]);
    expect(ranking.total.plays).toBe(3);
  });

  it('gives every order line unranked through getPlayCounts', async () => {
    await analytics.recordPlaylistPlay(4, hoursAgo(30));
    await analytics.recordPlaylistPlay(5, NOW);
    await analytics.recordPlaylistPlay(5, NOW);

    const counts = await analytics.getPlayCounts(NOW);
    expect([...counts.day]).toEqual([[5, 2]]);
    expect(new Map(counts.week)).toEqual(new Map([[4, 1], [5, 2]]));
    expect(new Map(counts.total)).toEqual(new Map([[4, 1], [5, 2]]));
    expect(counts.since).toBe(hoursAgo(30).toISOString());
  });

  it('answers empty windows before anything was played', async () => {
    const ranking = await analytics.getPlaylistPlayRanking(NOW);
    expect(ranking.since).toBeNull();
    expect(ranking.day).toEqual({ plays: 0, orders: 0, top: [] });
    expect(ranking.total).toEqual({ plays: 0, orders: 0, top: [] });
  });
});

describe('seedPlaylistPlays', () => {
  const scanLog = [
    { php: 5, at: hoursAgo(2) },
    { php: 5, at: hoursAgo(30) },
    { php: 6, at: hoursAgo(10 * 24) },
  ];

  it('only reports without write', async () => {
    const result = await analytics.seedPlaylistPlays(scanLog, { now: NOW });
    expect(result).toMatchObject({
      alreadySeeded: false,
      scans: 3,
      orders: 2,
      oldest: hoursAgo(10 * 24).toISOString(),
      written: false,
    });
    expect(sortedSets.size).toBe(0);
    expect(redisStore.has('plays:php:seeded')).toBe(false);
  });

  it('adds the scans to the total and to their hour while it is kept', async () => {
    const result = await analytics.seedPlaylistPlays(scanLog, { write: true, now: NOW });
    expect(result.written).toBe(true);

    expect(sortedSets.get('plays:php:total')?.get('5')).toBe(2);
    expect(sortedSets.get('plays:php:total')?.get('6')).toBe(1);
    expect(sortedSets.get(playsHourKey(hoursAgo(2)))?.get('5')).toBe(1);
    // Older than the hour buckets live: in the total only.
    expect(sortedSets.has(playsHourKey(hoursAgo(10 * 24)))).toBe(false);
    expect(redisStore.get('plays:php:since')).toBe(hoursAgo(10 * 24).toISOString());

    const ranking = await analytics.getPlaylistPlayRanking(NOW);
    expect(ranking.day.top).toEqual([{ php: 5, plays: 1 }]);
    expect(ranking.week.top).toEqual([{ php: 5, plays: 2 }]);
  });

  it('skips scans that were already counted live', async () => {
    await analytics.recordPlaylistPlay(5, hoursAgo(2));

    const result = await analytics.seedPlaylistPlays(scanLog, { write: true, now: NOW });
    expect(result.cutoff).toBe(hoursAgo(2).toISOString());
    expect(result.scans).toBe(2);
    expect(sortedSets.get('plays:php:total')?.get('5')).toBe(2);
  });

  it('refuses a second run', async () => {
    await analytics.seedPlaylistPlays(scanLog, { write: true, now: NOW });
    const again = await analytics.seedPlaylistPlays(scanLog, { write: true, now: NOW });

    expect(again).toMatchObject({ alreadySeeded: true, written: false });
    expect(sortedSets.get('plays:php:total')?.get('5')).toBe(2);
  });
});
