import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pure unit tests for src/data/featuredPlaylists.ts.
 *
 * The module imports cache-key constants from src/spotify (a heavy module
 * with cron/cluster side effects) and clearPlaylistCache from src/data/misc
 * (exceljs, translation, ...). Both are mocked BEFORE import so nothing
 * real loads; everything else comes in via the DataDeps parameter object.
 */

const h = vi.hoisted(() => ({
  clearPlaylistCache: vi.fn(async () => undefined),
  createSiteMap: vi.fn(async () => ({ locales: 0, urls: 0 })),
  queueProductPhoto: vi.fn(),
  productPhotoFeatured: vi.fn(),
}));

// the triggers load the BullMQ queue (and Redis); only whether they fire matters here
vi.mock('../../../src/productPhoto/triggers', () => ({
  queueProductPhoto: h.queueProductPhoto,
  productPhotoFeatured: h.productPhotoFeatured,
}));

vi.mock('../../../src/spotify', () => ({
  CACHE_KEY_PLAYLIST: 'playlist2_',
  CACHE_KEY_PLAYLIST_DB: 'playlistdb2_',
  CACHE_KEY_TRACKS: 'tracks2_',
  CACHE_KEY_TRACK_COUNT: 'trackcount2_',
}));

vi.mock('../../../src/data/misc', () => ({
  clearPlaylistCache: h.clearPlaylistCache,
  createSiteMap: h.createSiteMap,
}));

import {
  getFeaturedPlaylists,
  searchFeaturedPlaylists,
  getPendingPromotionalPlaylists,
  updatePlaylistFeatured,
  updateFeaturedHidden,
  updateDesignHidden,
  unfeaturePlaylist,
  refeaturePlaylist,
  updatePromotionalPlaylist,
  acceptPromotionalPlaylist,
  declinePromotionalPlaylist,
  getProductPageLocale,
  getRelatedFeaturedPlaylists,
  rankRelated,
  relatedLocales,
  CACHE_KEY_FEATURED_PLAYLISTS,
} from '../../../src/data/featuredPlaylists';
import { CACHE_KEY_MARKET_RANKING, WORLD } from '../../../src/data/marketRanking';
import { featuredLocaleWhere } from '../../../src/data/featuredLocale';

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

function makeDeps() {
  const cacheStore = new Map<string, string>();
  const prisma = {
    playlist: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(async () => ({})),
      count: vi.fn(),
    },
    paymentHasPlaylist: { groupBy: vi.fn(async () => []) },
    eventBasePlaylist: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => null) },
    $queryRawUnsafe: vi.fn(async () => []),
  };
  const cache = {
    store: cacheStore,
    get: vi.fn(async (k: string) => cacheStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      cacheStore.set(k, v);
    }),
    del: vi.fn(async (k: string) => {
      cacheStore.delete(k);
    }),
    delPattern: vi.fn(async () => 0),
  };
  return {
    deps: {
      prisma,
      cache,
      logger: { log: vi.fn() },
      translate: {
        isValidLocale: vi.fn((l: string) => ['en', 'nl', 'de'].includes(l)),
      },
      // Traceable brand-term replacement so mapping order is observable.
      utils: { replaceBrandTerms: vi.fn((s: string) => `B:${s}`) },
    } as any,
    prisma,
    cache,
  };
}

beforeEach(() => {
  h.clearPlaylistCache.mockClear();
  h.createSiteMap.mockClear();
});

describe('getFeaturedPlaylists', () => {
  it('cache miss: builds a locale-specific query, maps rows and stores the result', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: 1,
        name: 'Hits',
        description: 'Desc NL',
        genreId: 1,
        genreName: 'Pop',
        isPromotional: 0,
        promotionalTitle: null,
        promotionalDescription: null,
      },
      {
        id: 2,
        name: 'Promo',
        description: null,
        description_en: 'EN desc',
        genreId: null,
        genreName: null,
        isPromotional: 1,
        promotionalTitle: 'Promo title',
        promotionalDescription: 'Promo desc',
      },
      {
        id: 3,
        name: 'NoGenreName',
        description: 'd',
        genreId: 7,
        genreName: null, // translated genre column empty -> 'Unknown' fallback
        isPromotional: 0,
        promotionalTitle: null,
        promotionalDescription: null,
      },
    ]);

    const result = await getFeaturedPlaylists(deps, 'nl');

    const query: string = prisma.$queryRawUnsafe.mock.calls[0][0];
    expect(query).toContain('playlists.description_nl as description');
    expect(query).toContain('g.name_nl as genreName');
    expect(query).toContain("FIND_IN_SET('nl', playlists.featuredLocale) > 0");
    expect(query).toContain('playlists.featured = 1');
    // A playlist whose source is gone (the nightly link check) stays featured
    // but leaves the list and, through it, the related rows.
    expect(query).toContain('playlists.linkBroken = 0');
    expect(query).toContain(
      '(playlists.promotionalActive = 0 OR playlists.promotionalAccepted = 1)'
    );
    expect(query).toContain('ORDER BY');
    expect(query).toContain('CASE');

    // Regular playlist: brand terms replaced, isPromotional coerced to false.
    expect(result[0].isPromotional).toBe(false);
    expect(result[0].name).toBe('B:Hits');
    expect(result[0].description).toBe('B:Desc NL');

    // Promotional playlist: promotional title/description win.
    expect(result[1].isPromotional).toBe(true);
    expect(result[1].name).toBe('B:Promo title');
    expect(result[1].description).toBe('B:Promo desc');

    // Missing translated genre name falls back to 'Unknown'.
    expect(result[2].genreName).toBe('Unknown');

    // Stored under the dated, locale-suffixed key.
    const key = `${CACHE_KEY_FEATURED_PLAYLISTS}${today()}_nl`;
    expect(cache.set).toHaveBeenCalledWith(key, JSON.stringify(result));
  });

  it('falls back to description_en when the locale description is empty', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: 3,
        name: 'N',
        description: null,
        descriptionEnFallback: 'fallback EN',
        isPromotional: 0,
        genreId: null,
      },
    ]);

    const result = await getFeaturedPlaylists(deps, 'de');
    expect(result[0].description).toBe('B:fallback EN');
    // The helper column never leaks into the cached/returned row.
    expect(result[0]).not.toHaveProperty('descriptionEnFallback');
  });

  it('invalid locale falls back to en columns and cache key', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await getFeaturedPlaylists(deps, 'xx');

    const query: string = prisma.$queryRawUnsafe.mock.calls[0][0];
    expect(query).toContain('playlists.description_en as description');
    expect(query).toContain("FIND_IN_SET('en'");
    expect(cache.set).toHaveBeenCalledWith(
      `${CACHE_KEY_FEATURED_PLAYLISTS}${today()}_en`,
      '[]'
    );
  });

  it('skipLocaleFilter: no locale filter, plain score ordering, _all key suffix', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await getFeaturedPlaylists(deps, 'nl', true);

    const query: string = prisma.$queryRawUnsafe.mock.calls[0][0];
    expect(query).not.toContain('FIND_IN_SET');
    expect(query).toContain('ORDER BY score DESC');
    expect(cache.set).toHaveBeenCalledWith(
      `${CACHE_KEY_FEATURED_PLAYLISTS}${today()}_nl_all`,
      '[]'
    );
  });

  it('cache hit: returns the parsed payload without querying the DB', async () => {
    const { deps, prisma, cache } = makeDeps();
    cache.store.set(
      `${CACHE_KEY_FEATURED_PLAYLISTS}${today()}_en`,
      JSON.stringify([{ id: 9, name: 'cached' }])
    );

    const result = await getFeaturedPlaylists(deps, 'en');

    expect(result).toEqual([{ id: 9, name: 'cached' }]);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('getProductPageLocale', () => {
  it('does not know a playlist whose source is gone (linkBroken): its product page is a 404', async () => {
    const { deps, prisma, cache } = makeDeps();
    (deps.translate as any).allLocales = ['en', 'nl', 'de'];
    prisma.playlist.findFirst.mockResolvedValueOnce(null);

    const info = await getProductPageLocale(deps, 'dead-list');

    expect(prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'dead-list', featured: true, linkBroken: false },
      select: { featuredLocale: true },
    });
    expect(info.exists).toBe(false);
    // Under the key the link check drops when the flag changes.
    expect(cache.set).toHaveBeenCalledWith('productPageLocales_dead-list', expect.any(String), 600);
  });
});

describe('searchFeaturedPlaylists', () => {
  function approvedRow(id: number, over: Record<string, any> = {}) {
    return {
      id,
      playlistId: `pl${id}`,
      name: `N${id}`,
      slug: `s${id}`,
      image: null,
      customImage: null,
      featuredHidden: false,
      featuredLocale: null,
      promotionalActive: false,
      promotionalAccepted: false,
      promotionalTitle: null,
      promotionalDescription: null,
      promotionalUserId: null,
      ...over,
    };
  }

  it('applies search/locale filters, pagination and sort whitelist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany
      .mockResolvedValueOnce([]) // pending
      .mockResolvedValueOnce([approvedRow(1)]); // approved
    prisma.playlist.count.mockResolvedValue(25);

    const result = await searchFeaturedPlaylists(deps, 'abc', 'de', 2, 10, 'name', 'asc');

    const pendingArgs = prisma.playlist.findMany.mock.calls[0][0];
    expect(pendingArgs.where).toEqual({
      promotionalActive: true,
      promotionalAccepted: false,
      promotionalHide: false,
      OR: [
        { name: { contains: 'abc' } },
        { promotionalTitle: { contains: 'abc' } },
      ],
      // German alone or among other languages ("de,tr")
      AND: [featuredLocaleWhere('de')],
    });

    const approvedArgs = prisma.playlist.findMany.mock.calls[1][0];
    // Removed playlists (unfeaturedAt set) stay listed so they can come back;
    // the search must AND with that, not replace it.
    expect(approvedArgs.where).toEqual({
      AND: [
        { OR: [{ featured: true }, { unfeaturedAt: { not: null } }] },
        {
          OR: [
            { name: { contains: 'abc' } },
            { promotionalTitle: { contains: 'abc' } },
          ],
        },
        featuredLocaleWhere('de'),
      ],
      NOT: { promotionalActive: true, promotionalAccepted: false },
    });
    expect(approvedArgs.orderBy).toEqual({ name: 'asc' });
    expect(approvedArgs.skip).toBe(10);
    expect(approvedArgs.take).toBe(10);
    expect(prisma.playlist.count).toHaveBeenCalledWith({
      where: approvedArgs.where,
    });

    expect(result.approved.total).toBe(25);
    expect(result.approved.page).toBe(2);
    expect(result.approved.totalPages).toBe(3);
  });

  it('defaults: no filters, id desc, page 1 of 20, skips groupBy for empty results', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.playlist.count.mockResolvedValue(0);

    const result = await searchFeaturedPlaylists(deps);

    expect(prisma.playlist.findMany.mock.calls[0][0].where).toEqual({
      promotionalActive: true,
      promotionalAccepted: false,
      promotionalHide: false,
    });
    const approvedArgs = prisma.playlist.findMany.mock.calls[1][0];
    expect(approvedArgs.orderBy).toEqual({ id: 'desc' });
    expect(approvedArgs.skip).toBe(0);
    expect(approvedArgs.take).toBe(20);
    expect(prisma.paymentHasPlaylist.groupBy).not.toHaveBeenCalled();
    expect(result).toEqual({
      pending: [],
      approved: { data: [], total: 0, page: 1, totalPages: 0 },
    });
  });

  it('sortColumn purchaseCount falls back to id in SQL and sorts in memory', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        approvedRow(1),
        // Approved promo: owner purchase is subtracted (6 -> 5) and the
        // promotional user is looked up.
        approvedRow(2, {
          promotionalActive: true,
          promotionalAccepted: true,
          promotionalUserId: 9,
        }),
      ]);
    prisma.playlist.count.mockResolvedValue(2);
    prisma.user.findUnique.mockResolvedValue({ email: 'p@x', displayName: 'P' });
    prisma.paymentHasPlaylist.groupBy.mockResolvedValue([
      { playlistId: 1, _count: { playlistId: 1 } },
      { playlistId: 2, _count: { playlistId: 6 } },
    ]);

    const result = await searchFeaturedPlaylists(
      deps,
      '',
      null,
      1,
      20,
      'purchaseCount',
      'desc'
    );

    // Unknown column is not passed to Prisma...
    expect(prisma.playlist.findMany.mock.calls[1][0].orderBy).toEqual({
      id: 'desc',
    });
    // ...but the computed field is sorted in memory.
    expect(result.approved.data.map((p: any) => p.id)).toEqual([2, 1]);
    expect(result.approved.data[0]).toMatchObject({
      purchaseCount: 5, // 6 minus the owner's own purchase
      isPromotional: true,
      userEmail: 'p@x',
      userDisplayName: 'P',
    });
  });

  it('returns the link check fields for the Featured page', async () => {
    const { deps, prisma } = makeDeps();
    const brokenAt = new Date('2026-11-02T01:15:00Z');
    const checkedAt = new Date('2026-11-03T01:16:00Z');
    prisma.playlist.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        approvedRow(1, { linkBroken: true, linkBrokenAt: brokenAt, linkCheckedAt: checkedAt }),
        approvedRow(2, { linkBroken: false, linkBrokenAt: null, linkCheckedAt: null }),
      ]);
    prisma.playlist.count.mockResolvedValue(2);

    const result = await searchFeaturedPlaylists(deps);

    const select = prisma.playlist.findMany.mock.calls[1][0].select;
    expect(select).toMatchObject({ linkBroken: true, linkBrokenAt: true, linkCheckedAt: true });
    expect(result.approved.data[0]).toMatchObject({
      id: 1,
      linkBroken: true,
      linkBrokenAt: brokenAt,
      linkCheckedAt: checkedAt,
    });
    expect(result.approved.data[1]).toMatchObject({ id: 2, linkBroken: false, linkBrokenAt: null });
  });

  it('maps pending playlists with promotional title and user info', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany
      .mockResolvedValueOnce([
        {
          id: 4,
          playlistId: 'pl4',
          name: 'Orig',
          slug: 's4',
          image: 'i4',
          customImage: null,
          promotionalTitle: 'Pending title',
          promotionalDescription: 'Pending desc',
          promotionalLocale: 'nl',
          promotionalUserId: 12,
          // The customer's own card design, which they chose not to show.
          design: { backgroundImage: 'wedding.png' },
          promotionalShareDesign: false,
          featuredDesignHidden: false,
          // They want their own text on the product page, written in German.
          promotionalKeepDescription: true,
          promotionalDescriptionLocale: 'de',
          // The automatic review left it for the admin, with the languages it found.
          featuredLocale: 'de,nl',
          promotionalReviewVerdict: 'review',
          promotionalReviewReason: 'Only 12 songs.',
          promotionalReviewedAt: new Date('2026-11-20T10:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.playlist.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue({ email: 'u@x', displayName: 'U' });

    const result = await searchFeaturedPlaylists(deps);

    expect(result.pending).toEqual([
      {
        id: 4,
        playlistId: 'pl4',
        name: 'Pending title',
        slug: 's4',
        image: 'i4',
        customImage: null,
        description: 'Pending desc',
        locale: 'nl',
        featuredLocale: 'de,nl',
        reviewVerdict: 'review',
        reviewReason: 'Only 12 songs.',
        reviewedAt: new Date('2026-11-20T10:00:00Z'),
        userEmail: 'u@x',
        userDisplayName: 'U',
        // The admin sees the design itself, to judge it before accepting,
        // next to the customer's answer and their own veto.
        hasDesign: true,
        shareDesign: false,
        designHidden: false,
        design: { backgroundImage: 'wedding.png' },
        // and their answer on the description, which approval follows
        keepDescription: true,
        descriptionLocale: 'de',
      },
    ]);
    const select = prisma.playlist.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({
      promotionalKeepDescription: true,
      promotionalDescriptionLocale: true,
      featuredLocale: true,
      promotionalReviewVerdict: true,
      promotionalReviewReason: true,
      promotionalReviewedAt: true,
    });
    expect(prisma.playlist.findMany.mock.calls[1][0].select).toMatchObject({
      promotionalKeepDescription: true,
      promotionalDescriptionLocale: true,
    });
  });

  it('returns the safe default shape on errors', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockRejectedValue(new Error('boom'));

    const result = await searchFeaturedPlaylists(deps, 'x');
    expect(result).toEqual({
      pending: [],
      approved: { data: [], total: 0, page: 1, totalPages: 1 },
    });
  });
});

describe('getPendingPromotionalPlaylists', () => {
  it('returns pending promos with user info', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockResolvedValue([
      {
        id: 1,
        playlistId: 'pl1',
        name: 'Orig',
        slug: 's',
        image: 'i',
        customImage: 'ci',
        promotionalTitle: null,
        promotionalDescription: null,
        promotionalLocale: 'de',
        promotionalUserId: null,
      },
    ]);

    const result = await getPendingPromotionalPlaylists(deps);

    expect(prisma.playlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          promotionalActive: true,
          promotionalAccepted: false,
          promotionalHide: false,
        },
        orderBy: { id: 'desc' },
      })
    );
    expect(result[0]).toMatchObject({
      name: 'Orig', // no promotionalTitle -> original name
      description: '',
      locale: 'de',
      userEmail: null,
      userDisplayName: null,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('looks up the promotional user when set', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockResolvedValue([
      {
        id: 1,
        playlistId: 'pl1',
        name: 'N',
        slug: 's',
        image: 'i',
        customImage: null,
        promotionalTitle: 'T',
        promotionalDescription: 'D',
        promotionalLocale: 'nl',
        promotionalUserId: 9,
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ email: 'u@x', displayName: 'U' });

    const result = await getPendingPromotionalPlaylists(deps);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 9 },
      select: { email: true, displayName: true },
    });
    expect(result[0]).toMatchObject({
      name: 'T',
      userEmail: 'u@x',
      userDisplayName: 'U',
    });
  });

  it('returns [] on errors', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockRejectedValue(new Error('x'));
    expect(await getPendingPromotionalPlaylists(deps)).toEqual([]);
  });
});

describe('updatePlaylistFeatured', () => {
  it('fails when the playlist is unknown', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);

    const res = await updatePlaylistFeatured(deps, 'pl1', true);
    expect(res).toEqual({ success: false, error: 'Playlist not found' });
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('updates the flag, marks for merchant center and busts every related cache', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 1 });

    const res = await updatePlaylistFeatured(deps, 'pl1', true);

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: { featured: true, markedForMerchantCenter: true },
    });
    expect(cache.delPattern.mock.calls.map((c) => c[0])).toEqual([
      'playlist2_pl1*',
      'playlistdb2_pl1*',
      'tracks2_pl1*',
      'trackcount2_pl1*',
      `${CACHE_KEY_FEATURED_PLAYLISTS}*`,
    ]);
  });

  it('returns the error message on failure', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 1 });
    prisma.playlist.update.mockRejectedValue(new Error('db'));

    const res = await updatePlaylistFeatured(deps, 'pl1', false);
    expect(res).toEqual({ success: false, error: 'db' });
  });
});

describe('unfeaturePlaylist / refeaturePlaylist', () => {
  it('unfeature clears featured, stamps unfeaturedAt, flushes the playlist caches by id and slug and rebuilds the sitemap', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 7, slug: 'gone-list' });

    const res = await unfeaturePlaylist(deps, 'pl1');

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: {
        featured: false,
        unfeaturedAt: expect.any(Date),
        markedForMerchantCenter: true,
      },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith(deps, 'pl1', 'gone-list');
    expect(h.createSiteMap).toHaveBeenCalledWith(deps);
  });

  it('refeature restores featured and clears unfeaturedAt', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 7, slug: 'back-again' });

    expect(await refeaturePlaylist(deps, 'pl1')).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: { featured: true, unfeaturedAt: null, markedForMerchantCenter: true },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith(deps, 'pl1', 'back-again');
    expect(h.createSiteMap).toHaveBeenCalledWith(deps);
  });

  it('reports an unknown playlist without touching anything', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);

    expect(await unfeaturePlaylist(deps, 'nope')).toEqual({
      success: false,
      error: 'Playlist not found',
    });
    expect(prisma.playlist.update).not.toHaveBeenCalled();
    expect(h.createSiteMap).not.toHaveBeenCalled();
  });

  it('reports errors instead of throwing', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 7, slug: 'x' });
    prisma.playlist.update.mockRejectedValue(new Error('db'));

    expect(await unfeaturePlaylist(deps, 'pl1')).toEqual({ success: false, error: 'db' });
  });
});

describe('updateFeaturedHidden / updateDesignHidden', () => {
  it('updateFeaturedHidden updates and busts the featured cache', async () => {
    const { deps, prisma, cache } = makeDeps();

    const res = await updateFeaturedHidden(deps, 'pl1', true);

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: { featuredHidden: true, markedForMerchantCenter: true },
    });
    expect(cache.delPattern).toHaveBeenCalledWith(
      `${CACHE_KEY_FEATURED_PLAYLISTS}*`
    );
  });

  it('updateDesignHidden stores the admin veto and drops the cached product page', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.update.mockResolvedValue({ id: 9 });

    const res = await updateDesignHidden(deps, 'pl1', true);

    expect(res).toEqual({ success: true });
    // Its own column: the customer's answer and the design stay as they are,
    // so the design can be switched back on.
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: { featuredDesignHidden: true },
      select: { id: true },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith(deps, 'pl1');
    // the product photo shows the design the page shows
    expect(h.queueProductPhoto).toHaveBeenCalledWith(9);
  });

  it('updateDesignHidden reports errors instead of throwing', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.update.mockRejectedValue(new Error('nope'));

    expect(await updateDesignHidden(deps, 'pl1', false)).toEqual({ success: false, error: 'nope' });
    expect(h.clearPlaylistCache).not.toHaveBeenCalled();
  });

  it('updateFeaturedHidden reports errors instead of throwing', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.update.mockRejectedValue(new Error('nope'));

    expect(await updateFeaturedHidden(deps, 'pl1', true)).toEqual({
      success: false,
      error: 'nope',
    });
  });
});

describe('updatePromotionalPlaylist', () => {
  const payload = {
    name: 'New name',
    description: 'New desc',
    featuredLocale: 'nl',
  };

  it('rejects a slug already used by another playlist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findFirst.mockResolvedValue({
      playlistId: 'other',
      name: 'Other list',
    });

    const res = await updatePromotionalPlaylist(deps, 'pl1', {
      ...payload,
      slug: ' NewSlug ',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('"newslug"');
    expect(res.error).toContain('Other list');
    expect(prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'newslug', playlistId: { not: 'pl1' } },
      select: { playlistId: true, name: true },
    });
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('updates name/description/slug and clears caches with the old slug', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findFirst.mockResolvedValue(null);
    prisma.playlist.findUnique.mockResolvedValue({ slug: 'old-slug' });

    const res = await updatePromotionalPlaylist(deps, 'pl1', {
      ...payload,
      slug: 'New-Slug',
    });

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: {
        name: 'New name',
        promotionalTitle: 'New name',
        description_en: 'New desc',
        promotionalDescription: 'New desc',
        featuredLocale: 'nl',
        markedForMerchantCenter: true,
        slug: 'new-slug',
      },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith(deps, 'pl1', 'old-slug');
    // Both the old and the current slug drop out of the locale gate.
    expect(deps.cache.del).toHaveBeenCalledWith('productPageLocales_old-slug');
    // A new slug is a new URL in the sitemap.
    expect(h.createSiteMap).toHaveBeenCalledWith(deps);
  });

  it('stores several languages as a clean comma list, and none as null', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findFirst.mockResolvedValue(null);
    prisma.playlist.findUnique.mockResolvedValue({ slug: 'old-slug' });

    await updatePromotionalPlaylist(deps, 'pl1', { ...payload, featuredLocale: ' DE, tr ,de' });
    expect(prisma.playlist.update.mock.calls[0][0].data.featuredLocale).toBe('de,tr');

    await updatePromotionalPlaylist(deps, 'pl1', { ...payload, featuredLocale: null });
    expect(prisma.playlist.update.mock.calls[1][0].data.featuredLocale).toBeNull();
  });

  it('rebuilds the sitemap when the locale changes, and not for a name or text edit', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ slug: 'old', featuredLocale: null });

    await updatePromotionalPlaylist(deps, 'pl1', payload);
    expect(h.createSiteMap).toHaveBeenCalledWith(deps);

    h.createSiteMap.mockClear();
    prisma.playlist.findUnique.mockResolvedValue({ slug: 'old', featuredLocale: 'nl' });
    await updatePromotionalPlaylist(deps, 'pl1', { ...payload, slug: 'old' });
    expect(h.createSiteMap).not.toHaveBeenCalled();
  });

  it('leaves the English page copy alone when the description was not changed', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({
      slug: 'old',
      promotionalDescription: 'New desc',
      preserveDescription: false,
    });

    await updatePromotionalPlaylist(deps, 'pl1', payload);

    const data = prisma.playlist.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('description_en');
    expect(data.promotionalDescription).toBe('New desc');
    // Not sent, not touched.
    expect(data).not.toHaveProperty('preserveDescription');
  });

  it('counts a curated list without customer text (null) as unchanged when the form sends ""', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({
      slug: 'old',
      promotionalDescription: null,
      preserveDescription: false,
    });

    await updatePromotionalPlaylist(deps, 'pl1', { ...payload, description: '' });

    expect(prisma.playlist.update.mock.calls[0][0].data).not.toHaveProperty(
      'description_en'
    );
  });

  it('stores the keep switch, and a kept description never goes onto the page untranslated', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({
      slug: 'old',
      promotionalDescription: 'Old desc',
      preserveDescription: false,
    });

    await updatePromotionalPlaylist(deps, 'pl1', {
      ...payload,
      preserveDescription: true,
    });

    const data = prisma.playlist.update.mock.calls[0][0].data;
    expect(data.preserveDescription).toBe(true);
    expect(data.promotionalDescription).toBe('New desc');
    expect(data).not.toHaveProperty('description_en');
  });

  it('an already kept description stays off the page when the form does not send the switch', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({
      slug: 'old',
      promotionalDescription: 'Old desc',
      preserveDescription: true,
    });

    await updatePromotionalPlaylist(deps, 'pl1', payload);

    expect(prisma.playlist.update.mock.calls[0][0].data).not.toHaveProperty(
      'description_en'
    );
  });

  it('a whitespace-only slug is ignored (no duplicate check, no slug update)', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ slug: 'old' });

    const res = await updatePromotionalPlaylist(deps, 'pl1', {
      ...payload,
      slug: '   ',
    });

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.findFirst).not.toHaveBeenCalled();
    expect(prisma.playlist.update.mock.calls[0][0].data).not.toHaveProperty(
      'slug'
    );
  });

  it('returns the error message on failure', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ slug: 'old' });
    prisma.playlist.update.mockRejectedValue(new Error('db gone'));

    const res = await updatePromotionalPlaylist(deps, 'pl1', payload);
    expect(res).toEqual({ success: false, error: 'db gone' });
  });
});

describe('acceptPromotionalPlaylist / declinePromotionalPlaylist', () => {
  it('accept sets promotionalAccepted and busts the featured cache', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 1 });

    const res = await acceptPromotionalPlaylist(deps, 'pl1');

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: { promotionalAccepted: true, markedForMerchantCenter: true },
    });
    expect(cache.delPattern).toHaveBeenCalledWith(
      `${CACHE_KEY_FEATURED_PLAYLISTS}*`
    );
  });

  it('decline hides and marks declined', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 1 });

    const res = await declinePromotionalPlaylist(deps, 'pl1');

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: {
        promotionalHide: true,
        promotionalDeclined: true,
        markedForMerchantCenter: true,
      },
    });
  });

  it('both report update errors', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({ id: 1 });
    prisma.playlist.update.mockRejectedValue(new Error('db'));

    expect(await acceptPromotionalPlaylist(deps, 'pl1')).toEqual({
      success: false,
      error: 'db',
    });
    expect(await declinePromotionalPlaylist(deps, 'pl1')).toEqual({
      success: false,
      error: 'db',
    });
  });

  it('both fail cleanly for unknown playlists', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);

    expect(await acceptPromotionalPlaylist(deps, 'plX')).toEqual({
      success: false,
      error: 'Playlist not found',
    });
    expect(await declinePromotionalPlaylist(deps, 'plX')).toEqual({
      success: false,
      error: 'Playlist not found',
    });
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });
});

describe('related row', () => {
  // A featured list as the related row sees it: `score` is the place in the
  // visitor's market ranking (100 for the first).
  const pl = (
    slug: string,
    over: Record<string, any> = {}
  ): Record<string, any> => ({
    id: slug.length + slug.charCodeAt(0),
    slug,
    genreId: 1,
    featuredLocale: null,
    score: 50,
    decadePercentage1980: 100,
    ...over,
  });
  const slugs = (list: any[]) => list.map((p) => p.slug);

  describe('relatedLocales', () => {
    it('the market\'s own languages, the page\'s, and those of the page\'s playlist', () => {
      expect(relatedLocales('NL', 'nl', null)).toEqual(['nl']);
      expect(relatedLocales('DE', 'tr', 'ru')).toEqual(['de', 'tr', 'ru']);
      expect(relatedLocales('SE', 'en', 'de,TR')).toEqual(['sv', 'no', 'en', 'de', 'tr']);
      expect(relatedLocales(WORLD, 'ru', null)).toEqual(['ru']);
    });
  });

  describe('rankRelated', () => {
    it('leaves out lists in a language the visitor does not see (Russian Hits for a Dutch visitor)', () => {
      const list = [
        pl('source'),
        pl('russian-hits', { featuredLocale: 'ru', score: 100 }),
        pl('dutch', { featuredLocale: 'nl', score: 40 }),
        pl('english-tagged', { featuredLocale: 'en', score: 30 }),
        pl('international', { score: 20 }),
        pl('german-turkish', { featuredLocale: 'de,tr', score: 90 }),
      ];
      expect(slugs(rankRelated(list, 'source', 6, relatedLocales('NL', 'nl', null)))).toEqual([
        'dutch',
        'english-tagged',
        'international',
      ]);
      // A Turkish-speaking visitor in Germany sees the list tagged for both.
      expect(slugs(rankRelated(list, 'source', 6, relatedLocales('DE', 'tr', null)))).toEqual([
        'german-turkish',
        'english-tagged',
        'international',
      ]);
    });

    it('keeps the language of the page\'s own playlist', () => {
      const list = [
        pl('russian-source', { featuredLocale: 'ru' }),
        pl('russian-other', { featuredLocale: 'ru', score: 10 }),
        pl('international', { score: 10 }),
      ];
      const locales = relatedLocales('NL', 'nl', 'ru');
      // Same genre, era and score; the shared language puts the Russian one first.
      expect(slugs(rankRelated(list, 'russian-source', 6, locales))).toEqual([
        'russian-other',
        'international',
      ]);
    });

    it('without a featured source: the best sellers in the visitor\'s country', () => {
      const list = [
        pl('a', { score: 20, genreId: 2 }),
        pl('b', { score: 90, genreId: 3 }),
        pl('c', { score: 60, genreId: 4 }),
      ];
      expect(slugs(rankRelated(list, 'not-featured', 2, ['nl']))).toEqual(['b', 'c']);
    });

    it('a similar list first; among similar ones what sells in the country', () => {
      const list = [
        pl('source', { genreId: 1 }),
        pl('best-seller-other-genre', { genreId: 2, score: 100 }),
        pl('same-genre-slow', { genreId: 1, score: 10 }),
        pl('same-genre-selling', { genreId: 1, score: 80 }),
      ];
      expect(slugs(rankRelated(list, 'source', 3, ['nl']))).toEqual([
        'same-genre-selling',
        'same-genre-slow',
        'best-seller-other-genre',
      ]);
    });

    it('a better seller wins over a slightly closer era, not over a very different one', () => {
      const list = [
        pl('source', { decadePercentage1980: 100 }),
        pl('close-slow', { decadePercentage1980: 90, decadePercentage1990: 10, score: 10 }),
        pl('near-selling', { decadePercentage1980: 75, decadePercentage1990: 25, score: 90 }),
        pl('far-selling', { decadePercentage1980: 0, decadePercentage2020: 100, score: 100 }),
      ];
      expect(slugs(rankRelated(list, 'source', 3, ['nl']))).toEqual([
        'near-selling',
        'close-slow',
        'far-selling',
      ]);
    });
  });

  describe('getRelatedFeaturedPlaylists', () => {
    it('ranks with the stored ranking of the visitor\'s market', async () => {
      const { deps, cache } = makeDeps();
      const list = [
        pl('source', { id: 1, genreId: 9 }),
        pl('x', { id: 2, genreId: 2 }),
        pl('y', { id: 3, genreId: 3 }),
        pl('z', { id: 4, genreId: 4 }),
      ];
      cache.store.set(`${CACHE_KEY_FEATURED_PLAYLISTS}${today()}_nl_all`, JSON.stringify(list));
      cache.store.set(`${CACHE_KEY_MARKET_RANKING}NL`, JSON.stringify([4, 3, 1, 2]));
      cache.store.set(`${CACHE_KEY_MARKET_RANKING}${WORLD}`, JSON.stringify([2, 3, 4, 1]));

      expect(slugs(await getRelatedFeaturedPlaylists(deps, 'nl', 'source', 3, 'NL'))).toEqual([
        'z',
        'y',
        'x',
      ]);
      expect(slugs(await getRelatedFeaturedPlaylists(deps, 'nl', 'source', 3))).toEqual([
        'x',
        'y',
        'z',
      ]);
    });
  });
});
