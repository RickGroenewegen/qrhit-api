import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * "Change the songs": the temporary copy of a featured playlist in our
 * Spotify account, its cleanup and its route. Prisma, Spotify, Redis,
 * reCAPTCHA and cron are mocked. No database.
 */

const h = vi.hoisted(() => ({
  sortedSet: new Map<string, number>(),
  counters: new Map<string, number>(),
  prismaMock: {
    playlist: { findFirst: vi.fn() },
    playlistHasTrack: { findMany: vi.fn() },
    paymentHasPlaylist: { findFirst: vi.fn() },
  },
  spotifyCreate: vi.fn(),
  spotifyDelete: vi.fn(),
  recaptcha: { isHuman: true },
  cronCtorCalls: [] as any[][],
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prismaMock },
}));

vi.mock('../../../src/spotify', () => ({
  default: {
    getInstance: () => ({
      createOrUpdatePlaylist: h.spotifyCreate,
      deletePlaylist: h.spotifyDelete,
    }),
  },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      addToSortedSet: async (_key: string, score: number, member: string) => {
        h.sortedSet.set(member, score);
      },
      removeFromSortedSet: async (_key: string, member: string) => {
        h.sortedSet.delete(member);
      },
      getSortedSetWithScores: async () =>
        [...h.sortedSet.entries()].map(([member, score]) => ({ member, score })),
      increment: async (key: string) => {
        const next = (h.counters.get(key) || 0) + 1;
        h.counters.set(key, next);
        return next;
      },
    }),
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = async () => true;
    verifyRecaptcha = async () => h.recaptcha;
    getClientIp = () => '203.0.113.7';
    isTrustedIp = () => false;
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

vi.mock('cron', () => ({
  CronJob: class {
    constructor(...args: any[]) {
      h.cronCtorCalls.push(args);
    }
    start() {}
  },
}));

import FeaturedCopies, { COPY_LIFETIME_MS } from '../../../src/featuredCopy';
import featuredCopyRoutes from '../../../src/routes/featuredCopyRoutes';

const copies = FeaturedCopies.getInstance();
const link = (id: string) => `https://open.spotify.com/track/${id}`;
// Spotify track ids are 22 characters.
const id = (n: number) => `track${String(n).padStart(17, '0')}`;

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await featuredCopyRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.sortedSet.clear();
  h.counters.clear();
  h.recaptcha = { isHuman: true };
  h.prismaMock.playlist.findFirst.mockReset().mockResolvedValue({ id: 12, name: '80s Hits' });
  h.prismaMock.playlistHasTrack.findMany.mockReset().mockResolvedValue([
    { track: { spotifyLink: link(id(1)) } },
    { track: { spotifyLink: null } },
    { track: { spotifyLink: `${link(id(2))}?si=abc` } },
    { track: { spotifyLink: link(id(1)) } },
  ]);
  h.prismaMock.paymentHasPlaylist.findFirst.mockReset().mockResolvedValue(null);
  let n = 0;
  h.spotifyCreate.mockReset().mockImplementation(async (name: string) => {
    n += 1;
    return {
      success: true,
      data: { playlistId: `copy${n}`, playlistUrl: `https://open.spotify.com/playlist/copy${n}`, playlistName: name },
    };
  });
  h.spotifyDelete.mockReset().mockResolvedValue({ success: true });
});

describe('the cleanup cron', () => {
  it('runs every minute', () => {
    expect(h.cronCtorCalls[0][0]).toBe('* * * * *');
  });
});

describe('createCopy', () => {
  it('copies the featured songs in order, once each, and schedules the cleanup', async () => {
    const before = Date.now();
    const result = await copies.createCopy('80s-hits');

    expect(h.prismaMock.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: '80s-hits', featured: true },
      select: { id: true, name: true },
    });
    expect(h.prismaMock.playlistHasTrack.findMany.mock.calls[0][0]).toMatchObject({
      where: { playlistId: 12 },
      orderBy: { order: 'asc' },
    });
    const [name, trackIds] = h.spotifyCreate.mock.calls[0];
    expect(trackIds).toEqual([id(1), id(2)]);
    expect(name).toMatch(/^80s Hits \(QRSong! copy [a-z0-9]{6}\)$/);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      playlistId: 'copy1',
      trackCount: 2,
      missing: 1,
      expiresInMs: COPY_LIFETIME_MS,
    });
    expect(result.data.expiresAt).toBeGreaterThanOrEqual(before + COPY_LIFETIME_MS);
    expect(h.sortedSet.get('copy1')).toBe(result.data.expiresAt);
  });

  it('gives every copy a name of its own', async () => {
    await copies.createCopy('80s-hits');
    await copies.createCopy('80s-hits');
    const names = h.spotifyCreate.mock.calls.map((c) => c[0]);
    expect(names[0]).not.toBe(names[1]);
  });

  it('refuses a playlist that is not featured', async () => {
    h.prismaMock.playlist.findFirst.mockResolvedValue(null);
    expect(await copies.createCopy('mine')).toMatchObject({ success: false, reason: 'not_found' });
    expect(h.spotifyCreate).not.toHaveBeenCalled();
  });

  it('refuses a playlist without a single Spotify link', async () => {
    h.prismaMock.playlistHasTrack.findMany.mockResolvedValue([{ track: { spotifyLink: null } }]);
    expect(await copies.createCopy('80s-hits')).toMatchObject({ success: false, reason: 'no_tracks' });
    expect(h.spotifyCreate).not.toHaveBeenCalled();
  });

  it('reports Spotify refusing the copy and schedules nothing', async () => {
    h.spotifyCreate.mockResolvedValue({ success: false, error: 'needs re-auth' });
    expect(await copies.createCopy('80s-hits')).toMatchObject({ success: false, reason: 'spotify' });
    expect(h.sortedSet.size).toBe(0);
  });
});

describe('cleanupExpired', () => {
  it('unfollows expired copies only, keeps ordered ones and retries failures', async () => {
    const now = Date.now();
    h.sortedSet.set('expired', now - 1000);
    h.sortedSet.set('ordered', now - 1000);
    h.sortedSet.set('refused', now - 1000);
    h.sortedSet.set('fresh', now + 60_000);
    h.prismaMock.paymentHasPlaylist.findFirst.mockImplementation(async ({ where }: any) =>
      where.playlist.playlistId === 'ordered' ? { id: 5 } : null
    );
    h.spotifyDelete.mockImplementation(async (playlistId: string) =>
      playlistId === 'refused' ? { success: false, error: 'denied' } : { success: true }
    );

    expect(await copies.cleanupExpired()).toEqual({ deleted: 1, kept: 1, errors: 1 });

    expect(h.spotifyDelete.mock.calls.map((c) => c[0]).sort()).toEqual(['expired', 'refused']);
    // The refused one waits for the next run; the fresh one is not due yet.
    expect([...h.sortedSet.keys()].sort()).toEqual(['fresh', 'refused']);
    expect(h.prismaMock.paymentHasPlaylist.findFirst).toHaveBeenCalledWith({
      where: {
        playlist: { playlistId: 'expired' },
        payment: { status: { in: ['open', 'pending', 'authorized', 'paid'] } },
      },
      select: { id: true },
    });
  });
});

describe('POST /featured/copy', () => {
  const post = (payload: object) => app.inject({ method: 'POST', url: '/featured/copy', payload });

  it('answers with the copy', async () => {
    const res = await post({ slug: '80s-hits', captchaToken: 'ok' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ playlistId: 'copy1', trackCount: 2, missing: 1 });
  });

  it('needs a slug and a passing captcha', async () => {
    expect((await post({ captchaToken: 'ok' })).statusCode).toBe(400);
    expect((await post({ slug: '80s-hits' })).statusCode).toBe(400);
    h.recaptcha = { isHuman: false };
    expect((await post({ slug: '80s-hits', captchaToken: 'bot' })).statusCode).toBe(400);
    expect(h.spotifyCreate).not.toHaveBeenCalled();
  });

  it('answers 404 for a playlist that is not featured and 502 when Spotify refuses', async () => {
    h.prismaMock.playlist.findFirst.mockResolvedValueOnce(null);
    expect((await post({ slug: 'mine', captchaToken: 'ok' })).statusCode).toBe(404);
    h.spotifyCreate.mockResolvedValueOnce({ success: false, error: 'down' });
    expect((await post({ slug: '80s-hits', captchaToken: 'ok' })).statusCode).toBe(502);
  });

  it('allows ten copies per IP per hour', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post({ slug: '80s-hits', captchaToken: 'ok' })).statusCode).toBe(200);
    }
    expect((await post({ slug: '80s-hits', captchaToken: 'ok' })).statusCode).toBe(429);
    expect(h.spotifyCreate).toHaveBeenCalledTimes(10);
  });
});
