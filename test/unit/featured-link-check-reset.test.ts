import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * The link check's side effects, with Prisma, Redis, Data and the Channable
 * feed as stand-ins: the Featured page's reset (and its route), what a flag
 * change clears, and the product page answering playlistNotFound for a
 * broken playlist.
 */

const h = vi.hoisted(() => {
  const prisma = {
    playlist: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $executeRaw: vi.fn(async () => 1),
  };
  const cache = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    delPattern: vi.fn(async () => {}),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
  };
  const data = {
    clearPlaylistCache: vi.fn(async () => ({ success: true })),
    createSiteMap: vi.fn(async () => ({ locales: 16, urls: 100 })),
    getProductPageLocale: vi.fn(),
  };
  return {
    prisma,
    cache,
    data,
    generateFeed: vi.fn(async () => ({ rows: 1, path: 'x' })),
    log: vi.fn(),
    reset: vi.fn(),
    getPlaylist: vi.fn(async () => ({ success: true, data: { name: 'from Spotify' } })),
    getTracks: vi.fn(async () => ({ success: true, data: { tracks: [] } })),
    probeLink: vi.fn(),
  };
});

vi.mock('../../src/linkCheck/probes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/linkCheck/probes')>()),
  probeLink: h.probeLink,
}));

vi.mock('../../src/prisma', () => ({ default: { getInstance: () => h.prisma } }));
vi.mock('../../src/cache', () => ({ default: { getInstance: () => h.cache } }));
vi.mock('../../src/logger', () => ({
  default: class {
    log(line: string) {
      h.log(line);
    }
  },
}));
vi.mock('../../src/utils', () => ({
  default: class {
    async isMainServer() {
      return false;
    }
    parseBoolean(value: any) {
      return value === true || value === 1 || value === '1' || value === 'true';
    }
  },
}));
vi.mock('../../src/pushover', () => ({ default: class { sendMessage = vi.fn(); } }));
vi.mock('../../src/spotify_api', () => ({ default: class { getAccessToken = async () => 'sp'; } }));
vi.mock('../../src/tidal_api', () => ({ default: { getInstance: () => ({ getAccessToken: async () => 'td' }) } }));
vi.mock('../../src/providers/AppleMusicProvider', () => ({
  default: { getInstance: () => ({ getDeveloperToken: async () => 'ap', getStorefrontForLocale: (l: string) => l }) },
}));
vi.mock('../../src/data/featuredPlaylists', () => ({
  CACHE_KEY_FEATURED_PLAYLISTS: 'featuredPlaylists_v4_',
  CACHE_KEY_PRODUCT_PAGE_LOCALE: 'productPageLocales_',
}));
vi.mock('../../src/data', () => ({ default: { getInstance: () => h.data } }));
vi.mock('../../src/channable', () => ({ channable: { generateFeed: h.generateFeed } }));
vi.mock('../../src/spotify', () => ({
  default: { getInstance: () => ({ getPlaylist: h.getPlaylist, getTracks: h.getTracks }) },
}));
vi.mock('../../src/progress-websocket', () => ({ default: { getInstance: () => null } }));

import FeaturedLinkCheck from '../../src/linkCheck';
import linkCheckRoutes from '../../src/routes/linkCheckRoutes';
import spotifyRoutes from '../../src/routes/spotifyRoutes';

const BROKEN_AT = new Date('2026-11-02T01:16:00Z');
const CHECKED_AT = new Date('2026-11-03T01:16:00Z');

/** The SQL of a tagged $executeRaw call, values as `?`. */
function sqlOf(call: any[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call;
  return { sql: (strings as string[]).join('?'), values };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.$executeRaw.mockResolvedValue(1);
  h.data.clearPlaylistCache.mockResolvedValue({ success: true });
  h.data.createSiteMap.mockResolvedValue({ locales: 16, urls: 100 });
  h.generateFeed.mockResolvedValue({ rows: 1, path: 'x' });
});

describe('FeaturedLinkCheck.resetLinkBroken', () => {
  const brokenRow = { id: 12, playlistId: 'sp12', slug: 'dead-list', linkBroken: true };

  it('clears the flag with raw SQL, forgets the strike and brings the page, lists, sitemap and feed back', async () => {
    h.prisma.playlist.findUnique
      .mockResolvedValueOnce(brokenRow)
      .mockResolvedValueOnce({ linkBroken: false, linkBrokenAt: null, linkCheckedAt: CHECKED_AT });

    const state = await FeaturedLinkCheck.getInstance().resetLinkBroken('sp12');

    expect(state).toEqual({ linkBroken: false, linkBrokenAt: null, linkCheckedAt: CHECKED_AT });
    expect(h.prisma.playlist.findUnique.mock.calls[0][0]).toMatchObject({ where: { playlistId: 'sp12' } });

    // Raw SQL, never a Prisma update: updatedAt is the sitemap's lastmod.
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = sqlOf(h.prisma.$executeRaw.mock.calls[0]);
    expect(sql).toBe(
      'UPDATE playlists SET linkBroken = 0, linkBrokenAt = NULL, markedForMerchantCenter = 1 WHERE id = ?'
    );
    expect(values).toEqual([12]);
    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
    expect(h.prisma.playlist.updateMany).not.toHaveBeenCalled();

    // Two new nights before it is marked again.
    expect(h.cache.del).toHaveBeenCalledWith('featuredLinkGone:12');

    // The same refresh as a recovery.
    expect(h.cache.del).toHaveBeenCalledWith('productPageLocales_dead-list');
    expect(h.data.clearPlaylistCache).toHaveBeenCalledWith('sp12', undefined, { tracks: false });
    expect(h.cache.delPattern.mock.calls.map((c) => c[0])).toEqual([
      'featuredPlaylists_v4_*',
      'occasion_v1_*',
      'occasions_list_v1_*',
      'seasonal_v1_*',
    ]);
    expect(h.data.createSiteMap).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.generateFeed).toHaveBeenCalledTimes(1));
  });

  it('does not wait for the feed rebuild', async () => {
    let finish: () => void = () => {};
    h.generateFeed.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ rows: 1, path: 'x' }))));
    h.prisma.playlist.findUnique
      .mockResolvedValueOnce(brokenRow)
      .mockResolvedValueOnce({ linkBroken: false, linkBrokenAt: null, linkCheckedAt: null });

    const state = await FeaturedLinkCheck.getInstance().resetLinkBroken('sp12');
    expect(state).toMatchObject({ linkBroken: false });
    finish();
  });

  it('only forgets the strike of a playlist that was not broken', async () => {
    h.prisma.playlist.findUnique
      .mockResolvedValueOnce({ ...brokenRow, linkBroken: false })
      .mockResolvedValueOnce({ linkBroken: false, linkBrokenAt: null, linkCheckedAt: CHECKED_AT });

    await FeaturedLinkCheck.getInstance().resetLinkBroken('sp12');

    expect(h.cache.del).toHaveBeenCalledWith('featuredLinkGone:12');
    expect(h.data.createSiteMap).not.toHaveBeenCalled();
    expect(h.generateFeed).not.toHaveBeenCalled();
  });

  it('is null for a playlist it does not know, and changes nothing', async () => {
    h.prisma.playlist.findUnique.mockResolvedValueOnce(null);
    expect(await FeaturedLinkCheck.getInstance().resetLinkBroken('nope')).toBeNull();
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.cache.del).not.toHaveBeenCalled();
  });
});

describe('FeaturedLinkCheck.run: what a flag change clears', () => {
  const row = {
    id: 7,
    playlistId: 'sp7',
    serviceType: 'spotify',
    slug: 'back-again',
    name: 'Back again',
    promotionalTitle: null,
    featuredLocale: null,
    linkBroken: true,
  };

  it('brings a recovered playlist back: product page answer, playlist caches, sitemap, feed (waited for)', async () => {
    h.prisma.playlist.findMany.mockResolvedValueOnce([row] as any);
    h.probeLink.mockResolvedValue({ verdict: 'available', transient: false, reason: 'Spotify answers 200' });

    const report = await FeaturedLinkCheck.getInstance().run({ dryRun: false });

    expect(report?.recovered.map((e) => e.id)).toEqual([7]);
    expect(h.prisma.playlist.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] } },
      data: { linkBroken: false, linkBrokenAt: null, markedForMerchantCenter: true },
    });
    expect(h.cache.del).toHaveBeenCalledWith('productPageLocales_back-again');
    expect(h.data.clearPlaylistCache).toHaveBeenCalledWith('sp7', undefined, { tracks: false });
    expect(h.data.createSiteMap).toHaveBeenCalledTimes(1);
    expect(h.generateFeed).toHaveBeenCalledTimes(1);
  });

  it('touches none of it in a dry run', async () => {
    h.prisma.playlist.findMany.mockResolvedValueOnce([row] as any);
    h.probeLink.mockResolvedValue({ verdict: 'available', transient: false, reason: 'Spotify answers 200' });

    const report = await FeaturedLinkCheck.getInstance().run({ dryRun: true });

    expect(report?.recovered.map((e) => e.id)).toEqual([7]);
    expect(h.cache.acquireLock).not.toHaveBeenCalled();
    expect(h.prisma.playlist.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.cache.del).not.toHaveBeenCalled();
    expect(h.data.clearPlaylistCache).not.toHaveBeenCalled();
    expect(h.data.createSiteMap).not.toHaveBeenCalled();
    expect(h.generateFeed).not.toHaveBeenCalled();
  });
});

describe('POST /admin/featured/:playlistId/link-broken/reset', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    const instance = FeaturedLinkCheck.getInstance();
    vi.spyOn(instance, 'resetLinkBroken').mockImplementation((id: string) => h.reset(id));
    await linkCheckRoutes(app, () => ({ preHandler: async () => {} }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the new state', async () => {
    h.reset.mockResolvedValueOnce({ linkBroken: false, linkBrokenAt: null, linkCheckedAt: CHECKED_AT });
    const res = await app.inject({ method: 'POST', url: '/admin/featured/37i9abc/link-broken/reset' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      linkBroken: false,
      linkBrokenAt: null,
      linkCheckedAt: CHECKED_AT.toISOString(),
    });
    expect(h.reset).toHaveBeenCalledWith('37i9abc');
  });

  it('is a 404 for an unknown playlist', async () => {
    h.reset.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'POST', url: '/admin/featured/nope/link-broken/reset' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, error: 'Playlist not found' });
  });

  it('is a 500 when the reset fails', async () => {
    h.reset.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({ method: 'POST', url: '/admin/featured/sp12/link-broken/reset' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ success: false, error: 'db down' });
  });
});

describe('the product page of a broken playlist (POST /spotify/playlists with slug)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(spotifyRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, body: any) => app.inject({ method: 'POST', url, payload: body });

  it('answers playlistNotFound, like an unknown slug, before any cache or service is asked', async () => {
    h.data.getProductPageLocale.mockResolvedValue({ exists: false, indexableLocales: null });

    for (const url of ['/spotify/playlists', '/spotify/playlists/tracks']) {
      const res = await post(url, { playlistId: 'dead-list', slug: 1, featured: 1, cache: 1 });
      expect(res.json()).toEqual({ success: false, error: 'playlistNotFound' });
    }
    expect(h.data.getProductPageLocale).toHaveBeenCalledWith('dead-list');
    expect(h.getPlaylist).not.toHaveBeenCalled();
    expect(h.getTracks).not.toHaveBeenCalled();
  });

  it('serves a playlist whose page exists as before', async () => {
    h.data.getProductPageLocale.mockResolvedValue({ exists: true, indexableLocales: null });
    const res = await post('/spotify/playlists', { playlistId: 'live-list', slug: 1, featured: 1 });
    expect(res.json()).toEqual({ success: true, data: { name: 'from Spotify' } });
    expect(h.getPlaylist).toHaveBeenCalledTimes(1);
  });

  it('never asks for a playlist id (not a product page)', async () => {
    const res = await post('/spotify/playlists', { playlistId: '4rOoJ6Egrf8K2IrywzwOMk', slug: 0 });
    expect(res.json()).toMatchObject({ success: true });
    expect(h.data.getProductPageLocale).not.toHaveBeenCalled();
  });

  it('lets the request through when the check itself fails', async () => {
    h.data.getProductPageLocale.mockRejectedValue(new Error('redis down'));
    const res = await post('/spotify/playlists', { playlistId: 'live-list', slug: 1 });
    expect(res.json()).toMatchObject({ success: true });
  });
});
