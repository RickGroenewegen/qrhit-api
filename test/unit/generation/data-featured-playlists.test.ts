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
}));

vi.mock('../../../src/spotify', () => ({
  CACHE_KEY_PLAYLIST: 'playlist2_',
  CACHE_KEY_PLAYLIST_DB: 'playlistdb2_',
  CACHE_KEY_TRACKS: 'tracks2_',
  CACHE_KEY_TRACK_COUNT: 'trackcount2_',
}));

vi.mock('../../../src/data/misc', () => ({
  clearPlaylistCache: h.clearPlaylistCache,
}));

import {
  getFeaturedPlaylists,
  getAllFeaturedPlaylists,
  searchFeaturedPlaylists,
  getPendingPromotionalPlaylists,
  getAcceptedPromotionalPlaylists,
  updatePlaylistFeatured,
  updateFeaturedHidden,
  updateFeaturedLocale,
  updatePromotionalPlaylist,
  acceptPromotionalPlaylist,
  declinePromotionalPlaylist,
  CACHE_KEY_FEATURED_PLAYLISTS,
} from '../../../src/data/featuredPlaylists';

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
    user: { findUnique: vi.fn(async () => null) },
    $queryRawUnsafe: vi.fn(async () => []),
  };
  const cache = {
    store: cacheStore,
    get: vi.fn(async (k: string) => cacheStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      cacheStore.set(k, v);
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
        description_en: 'fallback EN',
        isPromotional: 0,
        genreId: null,
      },
    ]);

    const result = await getFeaturedPlaylists(deps, 'de');
    expect(result[0].description).toBe('B:fallback EN');
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

describe('getAllFeaturedPlaylists', () => {
  const p1 = {
    id: 1,
    playlistId: 'pl1',
    name: 'N1',
    slug: 's1',
    image: 'i1',
    customImage: null,
    featuredHidden: false,
    featuredLocale: null,
    promotionalActive: false,
    promotionalAccepted: false,
    promotionalTitle: null,
    promotionalDescription: null,
    promotionalUserId: null,
  };
  const p2 = {
    ...p1,
    id: 2,
    playlistId: 'pl2',
    name: 'N2',
    promotionalActive: true,
    promotionalAccepted: true,
    promotionalTitle: 'T2',
    promotionalDescription: 'D2',
    promotionalUserId: 9,
  };

  it('joins purchase counts and user info, subtracting the owner purchase for promos', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockResolvedValue([p1, p2]);
    prisma.paymentHasPlaylist.groupBy.mockResolvedValue([
      { playlistId: 2, _count: { playlistId: 3 } },
    ]);
    prisma.user.findUnique.mockResolvedValue({
      email: 'e@x.com',
      displayName: 'Rick',
    });

    const result = await getAllFeaturedPlaylists(deps);

    expect(prisma.playlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          featured: true,
          NOT: { promotionalActive: true, promotionalAccepted: false },
        },
        orderBy: [{ id: 'desc' }],
      })
    );
    expect(prisma.paymentHasPlaylist.groupBy).toHaveBeenCalledWith({
      by: ['playlistId'],
      where: { playlistId: { in: [1, 2] }, payment: { status: 'paid' } },
      _count: { playlistId: true },
    });

    expect(result[0]).toEqual({
      id: 1,
      playlistId: 'pl1',
      name: 'N1',
      slug: 's1',
      image: 'i1',
      customImage: null,
      description: '',
      featuredHidden: false,
      featuredLocale: null,
      isPromotional: false,
      userEmail: null,
      userDisplayName: null,
      purchaseCount: 0,
    });
    // Promotional: title/description override, count 3 minus owner = 2.
    expect(result[1]).toMatchObject({
      id: 2,
      name: 'T2',
      description: 'D2',
      isPromotional: true,
      userEmail: 'e@x.com',
      userDisplayName: 'Rick',
      purchaseCount: 2,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 9 },
      select: { email: true, displayName: true },
    });
  });

  it('returns [] on errors', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockRejectedValue(new Error('boom'));
    expect(await getAllFeaturedPlaylists(deps)).toEqual([]);
    expect(deps.logger.log).toHaveBeenCalled();
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
      featuredLocale: 'de',
    });

    const approvedArgs = prisma.playlist.findMany.mock.calls[1][0];
    expect(approvedArgs.where).toEqual({
      featured: true,
      NOT: { promotionalActive: true, promotionalAccepted: false },
      OR: [
        { name: { contains: 'abc' } },
        { promotionalTitle: { contains: 'abc' } },
      ],
      featuredLocale: 'de',
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
        userEmail: 'u@x',
        userDisplayName: 'U',
      },
    ]);
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

describe('getAcceptedPromotionalPlaylists', () => {
  it('returns accepted promos including featuredLocale', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockResolvedValue([
      {
        id: 2,
        playlistId: 'pl2',
        name: 'Orig',
        slug: 's',
        image: 'i',
        customImage: null,
        promotionalTitle: 'T',
        promotionalDescription: 'D',
        promotionalLocale: 'nl',
        promotionalUserId: 9,
        featuredLocale: 'nl,de',
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ email: 'a@x', displayName: 'A' });

    const result = await getAcceptedPromotionalPlaylists(deps);

    expect(prisma.playlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { promotionalActive: true, promotionalAccepted: true },
      })
    );
    expect(result[0]).toMatchObject({
      name: 'T',
      description: 'D',
      featuredLocale: 'nl,de',
      userEmail: 'a@x',
      userDisplayName: 'A',
    });
  });

  it('returns [] on errors', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockRejectedValue(new Error('x'));
    expect(await getAcceptedPromotionalPlaylists(deps)).toEqual([]);
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

describe('updateFeaturedHidden / updateFeaturedLocale', () => {
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

  it('updateFeaturedLocale updates (null allowed) and busts the featured cache', async () => {
    const { deps, prisma, cache } = makeDeps();

    const res = await updateFeaturedLocale(deps, 'pl1', null);

    expect(res).toEqual({ success: true });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl1' },
      data: { featuredLocale: null, markedForMerchantCenter: true },
    });
    expect(cache.delPattern).toHaveBeenCalledWith(
      `${CACHE_KEY_FEATURED_PLAYLISTS}*`
    );
  });

  it('both report errors instead of throwing', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.update.mockRejectedValue(new Error('nope'));

    expect(await updateFeaturedHidden(deps, 'pl1', true)).toEqual({
      success: false,
      error: 'nope',
    });
    expect(await updateFeaturedLocale(deps, 'pl1', 'nl')).toEqual({
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
