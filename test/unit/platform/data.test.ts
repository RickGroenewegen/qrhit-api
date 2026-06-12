import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Data is a facade: nearly every public method delegates to a src/data/*
// submodule with `this` cast as DataDeps. These tests cover the logic that
// lives in data.ts itself:
//
//   - constructor cron/cluster wiring (main server, non-main server, worker)
//   - the cron-invoked maintenance bodies (prefillLinkCache, translateGenres,
//     updateFeaturedPlaylistStats, loadBlockedFromCache)
//   - getInstance singleton, getPaymentHasPlaylistById (direct prisma call),
//     resolveTaxContext (dynamic import), euCountryCodes re-export
//   - delegation wrappers with default-argument logic
//
// All collaborators are mocked: no DB, no Redis, no network, no real timers.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const fns = <const T extends readonly string[]>(names: T) =>
    Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
      T[number],
      ReturnType<typeof vi.fn>
    >;

  return {
    isPrimary: true,
    isMainServer: vi.fn(),
    cronJobs: [] as Array<{
      schedule: string;
      callback: () => Promise<void>;
      started: boolean;
    }>,
    axiosCreate: vi.fn(),
    axiosInstance: { get: vi.fn(), post: vi.fn() },
    prisma: {
      paymentHasPlaylist: { findUnique: vi.fn() },
    },
    cacheStore: new Map<string, string>(),
    resolveTaxContext: vi.fn(),
    euCountryCodes: ['NL', 'DE', 'BE', 'FR'],
    misc: fns([
      'getPDFFilepath',
      'getLastPlays',
      'translateGenres',
      'createSiteMap',
      'generatePlaylistExcel',
      'clearPlaylistCache',
      'clearNonFeaturedPlaylistCaches',
    ] as const),
    users: fns([
      'areAllTracksManuallyChecked',
      'storeUser',
      'getUser',
      'getUserByUserId',
      'getPayment',
      'verifyPayment',
      'checkUnfinalizedPayments',
      'getTaxRate',
      'updatePaymentPrinterHold',
      'updatePaymentExpress',
    ] as const),
    scoring: fns([
      'calculatePlaylistScores',
      'calculateSinglePlaylistDecadePercentages',
      'calculateDecadePercentages',
      'updateFeaturedPlaylistStats',
    ] as const),
    playlists: fns([
      'storePlaylists',
      'getPlaylist',
      'getPlaylistsByPaymentId',
      'getPlaylistBySlug',
      'updatePaymentHasPlaylist',
      'updatePlaylistDetails',
      'deletePlaylistFromOrder',
      'updatePlaylistAmount',
      'changePlaylistType',
      'updateGamesEnabled',
      'updateAddHowToCard',
      'updateHowToCardImage',
      'resetJudgedStatus',
      'updatePlaylistBlocked',
      'buildMusicMatchExport',
      'loadBlocked',
      'loadBlockedFromCache',
    ] as const),
    tracks: fns([
      'getTracks',
      'getTrackById',
      'updateTrack',
      'storeTracks',
      'searchTracks',
      'getTracksMissingSpotifyLink',
      'getTracksMissingSpotifyLinkCount',
      'toggleSpotifyLinkIgnored',
    ] as const),
    trackYears: fns([
      'updateTrackYear',
      'getFirstUncheckedTrack',
      'getYearCheckQueue',
      'updateTrackCheck',
    ] as const),
    musicLinks: fns([
      'getYouTubeLink',
      'addSpotifyLinks',
      'prefillLinkCache',
      'logLink',
      'getLink',
      'getPlaylistLinkCoverage',
      'getTracksWithoutMusicLinks',
      'updateTrackMusicLinks',
      'findMissingServiceLinks',
    ] as const),
    featuredPlaylists: fns([
      'getFeaturedPlaylists',
      'getAllFeaturedPlaylists',
      'searchFeaturedPlaylists',
      'getPendingPromotionalPlaylists',
      'getAcceptedPromotionalPlaylists',
      'updatePlaylistFeatured',
      'updateFeaturedHidden',
      'updateFeaturedLocale',
      'updatePromotionalPlaylist',
      'acceptPromotionalPlaylist',
      'declinePromotionalPlaylist',
    ] as const),
  };
});

// --- cron: capture schedule + callback, never run real timers ---------------
vi.mock('cron', () => ({
  CronJob: class {
    started = false;
    constructor(
      public schedule: string,
      public callback: () => Promise<void>
    ) {
      h.cronJobs.push(this as any);
    }
    start() {
      this.started = true;
    }
  },
}));

// --- cluster: controllable isPrimary ----------------------------------------
vi.mock('cluster', () => ({
  default: {
    get isPrimary() {
      return h.isPrimary;
    },
  },
}));
vi.mock('node:cluster', () => ({
  default: {
    get isPrimary() {
      return h.isPrimary;
    },
  },
}));

// --- infrastructure collaborators -------------------------------------------
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: vi.fn(async (key: string) => h.cacheStore.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        h.cacheStore.set(key, String(value));
      }),
      del: vi.fn(async (key: string) => {
        h.cacheStore.delete(key);
      }),
    }),
  },
}));

vi.mock('axios', () => ({
  default: { create: h.axiosCreate },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = h.isMainServer;
  },
}));

vi.mock('../../../src/translation', () => ({
  default: class {
    allLocales = ['en', 'nl'];
  },
}));

vi.mock('../../../src/music', () => ({ Music: class {} }));
vi.mock('../../../src/chatgpt', () => ({ ChatGPT: class {} }));
vi.mock('../../../src/analytics', () => ({
  default: { getInstance: () => ({}) },
}));
vi.mock('../../../src/apptheme', () => ({
  default: { getInstance: () => ({}) },
}));

vi.mock('../../../src/services/vat', () => ({
  resolveTaxContext: h.resolveTaxContext,
}));

// --- src/data/* submodules (tested elsewhere; mocked to isolate the facade) -
vi.mock('../../../src/data/misc', () => ({ ...h.misc }));
vi.mock('../../../src/data/users', () => ({
  ...h.users,
  euCountryCodes: h.euCountryCodes,
}));
vi.mock('../../../src/data/scoring', () => ({ ...h.scoring }));
vi.mock('../../../src/data/playlists', () => ({ ...h.playlists }));
vi.mock('../../../src/data/tracks', () => ({ ...h.tracks }));
vi.mock('../../../src/data/trackYears', () => ({ ...h.trackYears }));
vi.mock('../../../src/data/musicLinks', () => ({ ...h.musicLinks }));
vi.mock('../../../src/data/featuredPlaylists', () => ({
  ...h.featuredPlaylists,
}));

/** Drains the constructor's async `.then(...)` wiring (mocks resolve sync). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Fresh Data singleton per test (the class caches its instance per module
 * copy, so each scenario needs a clean module registry).
 */
async function makeData() {
  vi.resetModules();
  const Data = (await import('../../../src/data')).default;
  const data = Data.getInstance();
  await flush();
  return { Data, data };
}

beforeEach(() => {
  h.cronJobs.length = 0;
  h.cacheStore.clear();
  for (const mod of [
    h.misc,
    h.users,
    h.scoring,
    h.playlists,
    h.tracks,
    h.trackYears,
    h.musicLinks,
    h.featuredPlaylists,
  ]) {
    for (const fn of Object.values(mod)) fn.mockReset();
  }
  h.prisma.paymentHasPlaylist.findUnique.mockReset();
  h.resolveTaxContext.mockReset();
  h.axiosCreate.mockReset().mockReturnValue(h.axiosInstance);
  h.isPrimary = true;
  // Default: primary process but NOT the main server → minimal wiring
  h.isMainServer.mockReset().mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// Constructor wiring — primary process on the main server
// ---------------------------------------------------------------------------

describe('constructor (primary process, main server)', () => {
  beforeEach(() => {
    h.isMainServer.mockResolvedValue(true);
  });

  it('creates the sitemap, prefills the link cache, loads blocked playlists and schedules 3 cron jobs', async () => {
    const { data } = await makeData();

    expect(h.axiosCreate).toHaveBeenCalledTimes(1);
    expect(h.misc.createSiteMap).toHaveBeenCalledTimes(1);
    expect(h.misc.createSiteMap).toHaveBeenCalledWith(data);
    expect(h.musicLinks.prefillLinkCache).toHaveBeenCalledTimes(1);
    expect(h.musicLinks.prefillLinkCache).toHaveBeenCalledWith(data);
    expect(h.playlists.loadBlocked).toHaveBeenCalledTimes(1);
    expect(h.playlists.loadBlocked).toHaveBeenCalledWith(data);
    // loadBlocked() marks the blocked list as initialized
    expect((data as any).blockedPlaylistsInitialized).toBe(true);
    // Main server never syncs blocked playlists FROM the cache
    expect(h.playlists.loadBlockedFromCache).not.toHaveBeenCalled();

    expect(h.cronJobs.map((j) => j.schedule)).toEqual([
      '0 * * * *', // hourly link-cache refresh
      '30 1 * * *', // nightly genre translation
      '0 3 * * *', // daily featured playlist stats
    ]);
    expect(h.cronJobs.every((j) => j.started)).toBe(true);
  });

  it('hourly cron tick re-runs prefillLinkCache', async () => {
    const { data } = await makeData();
    h.musicLinks.prefillLinkCache.mockClear();

    await h.cronJobs[0].callback();

    expect(h.musicLinks.prefillLinkCache).toHaveBeenCalledTimes(1);
    expect(h.musicLinks.prefillLinkCache).toHaveBeenCalledWith(data);
  });

  it('01:30 cron tick runs translateGenres', async () => {
    const { data } = await makeData();

    expect(h.misc.translateGenres).not.toHaveBeenCalled();
    await h.cronJobs[1].callback();

    expect(h.misc.translateGenres).toHaveBeenCalledTimes(1);
    expect(h.misc.translateGenres).toHaveBeenCalledWith(data);
  });

  it('03:00 cron tick runs updateFeaturedPlaylistStats', async () => {
    const { data } = await makeData();

    expect(h.scoring.updateFeaturedPlaylistStats).not.toHaveBeenCalled();
    await h.cronJobs[2].callback();

    expect(h.scoring.updateFeaturedPlaylistStats).toHaveBeenCalledTimes(1);
    expect(h.scoring.updateFeaturedPlaylistStats).toHaveBeenCalledWith(data);
  });

  it('treats ENVIRONMENT=development as a main server even when isMainServer() is false', async () => {
    const saved = process.env['ENVIRONMENT'];
    process.env['ENVIRONMENT'] = 'development';
    h.isMainServer.mockResolvedValue(false);
    try {
      await makeData();

      expect(h.misc.createSiteMap).toHaveBeenCalledTimes(1);
      expect(h.playlists.loadBlocked).toHaveBeenCalledTimes(1);
      expect(h.playlists.loadBlockedFromCache).not.toHaveBeenCalled();
      expect(h.cronJobs.map((j) => j.schedule)).toEqual([
        '0 * * * *',
        '30 1 * * *',
        '0 3 * * *',
      ]);
    } finally {
      process.env['ENVIRONMENT'] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Constructor wiring — primary process on a secondary server
// ---------------------------------------------------------------------------

describe('constructor (primary process, non-main server)', () => {
  it('only loads the blocked list from cache and schedules the hourly sync', async () => {
    const { data } = await makeData();

    expect(h.misc.createSiteMap).not.toHaveBeenCalled();
    expect(h.musicLinks.prefillLinkCache).not.toHaveBeenCalled();
    expect(h.playlists.loadBlocked).not.toHaveBeenCalled();

    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledTimes(1);
    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledWith(data);
    expect((data as any).blockedPlaylistsInitialized).toBe(true);

    expect(h.cronJobs.map((j) => j.schedule)).toEqual(['5 * * * *']);
    expect(h.cronJobs[0].started).toBe(true);
  });

  it('hourly sync tick reloads the blocked list from cache', async () => {
    const { data } = await makeData();
    h.playlists.loadBlockedFromCache.mockClear();

    await h.cronJobs[0].callback();

    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledTimes(1);
    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledWith(data);
  });
});

// ---------------------------------------------------------------------------
// Constructor wiring — worker process
// ---------------------------------------------------------------------------

describe('constructor (worker process)', () => {
  beforeEach(() => {
    h.isPrimary = false;
  });

  it('loads blocked playlists from cache and schedules the hourly sync without probing the server role', async () => {
    const { data } = await makeData();

    expect(h.isMainServer).not.toHaveBeenCalled();
    expect(h.misc.createSiteMap).not.toHaveBeenCalled();
    expect(h.playlists.loadBlocked).not.toHaveBeenCalled();

    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledTimes(1);
    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledWith(data);
    expect((data as any).blockedPlaylistsInitialized).toBe(true);

    expect(h.cronJobs.map((j) => j.schedule)).toEqual(['5 * * * *']);
    expect(h.cronJobs[0].started).toBe(true);

    h.playlists.loadBlockedFromCache.mockClear();
    await h.cronJobs[0].callback();
    expect(h.playlists.loadBlockedFromCache).toHaveBeenCalledWith(data);
  });
});

// ---------------------------------------------------------------------------
// getInstance / direct members
// ---------------------------------------------------------------------------

describe('Data.getInstance', () => {
  it('returns the same singleton on every call', async () => {
    const { Data, data } = await makeData();
    expect(Data.getInstance()).toBe(data);
    // Constructor side effects ran exactly once
    expect(h.axiosCreate).toHaveBeenCalledTimes(1);
  });

  it('re-exports euCountryCodes from the users submodule', async () => {
    const { data } = await makeData();
    expect(data.euCountryCodes).toBe(h.euCountryCodes);
  });
});

describe('Data.getPaymentHasPlaylistById', () => {
  it('queries prisma by primary key and returns the row', async () => {
    const { data } = await makeData();
    const row = { id: 42, eco: true, doubleSided: false };
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValueOnce(row);

    await expect(data.getPaymentHasPlaylistById(42)).resolves.toBe(row);

    expect(h.prisma.paymentHasPlaylist.findUnique).toHaveBeenCalledTimes(1);
    expect(h.prisma.paymentHasPlaylist.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
    });
  });

  it('returns null when the row does not exist', async () => {
    const { data } = await makeData();
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValueOnce(null);
    await expect(data.getPaymentHasPlaylistById(999)).resolves.toBeNull();
  });
});

describe('Data.resolveTaxContext', () => {
  it('lazily imports the vat service and forwards itself plus the params', async () => {
    const { data } = await makeData();
    const params = { countryCode: 'NL', vatNumber: 'NL123' } as any;
    const result = { rate: 21, vatShifted: false };
    h.resolveTaxContext.mockResolvedValueOnce(result);

    await expect(data.resolveTaxContext(params)).resolves.toBe(result);

    expect(h.resolveTaxContext).toHaveBeenCalledTimes(1);
    expect(h.resolveTaxContext).toHaveBeenCalledWith(data, params);
  });
});

// ---------------------------------------------------------------------------
// Delegation wrappers — default arguments and exact pass-through
// ---------------------------------------------------------------------------

describe('delegation wrappers', () => {
  it('getLink applies defaults (useCache=true, no userAgent/php) and passes the ApiResult through', async () => {
    const { data } = await makeData();
    const apiResult = { success: true, data: { link: 'https://yt' } };
    h.musicLinks.getLink.mockResolvedValueOnce(apiResult);

    await expect(data.getLink(5, '1.2.3.4')).resolves.toBe(apiResult);
    expect(h.musicLinks.getLink).toHaveBeenCalledWith(
      data,
      5,
      '1.2.3.4',
      true,
      undefined,
      undefined
    );
  });

  it('getLink forwards explicit cache/userAgent/php arguments', async () => {
    const { data } = await makeData();
    h.musicLinks.getLink.mockResolvedValueOnce({ success: false });

    await data.getLink(7, '5.6.7.8', false, 'UA/1.0', 99);
    expect(h.musicLinks.getLink).toHaveBeenCalledWith(
      data,
      7,
      '5.6.7.8',
      false,
      'UA/1.0',
      99
    );
  });

  it('getTracks defaults userId to 0', async () => {
    const { data } = await makeData();
    h.tracks.getTracks.mockResolvedValueOnce(['t']);

    await expect(data.getTracks(3)).resolves.toEqual(['t']);
    expect(h.tracks.getTracks).toHaveBeenCalledWith(data, 3, 0);
  });

  it('storeTracks defaults serviceType to spotify and locale to en', async () => {
    const { data } = await makeData();
    const tracks = [{ id: 'abc' }];
    h.tracks.storeTracks.mockResolvedValueOnce({ stored: 1 });

    await expect(data.storeTracks(11, 'pl-id', tracks)).resolves.toEqual({
      stored: 1,
    });
    expect(h.tracks.storeTracks).toHaveBeenCalledWith(
      data,
      11,
      'pl-id',
      tracks,
      undefined,
      'spotify',
      'en'
    );
  });

  it('searchTracks defaults to page 1 with limit 50', async () => {
    const { data } = await makeData();
    h.tracks.searchTracks.mockResolvedValueOnce({ items: [] });

    await data.searchTracks('queen');
    expect(h.tracks.searchTracks).toHaveBeenCalledWith(
      data,
      'queen',
      undefined,
      undefined,
      1,
      50
    );
  });

  it('updateTrack forwards all link fields in order and defaults locale to en', async () => {
    const { data } = await makeData();
    h.tracks.updateTrack.mockResolvedValueOnce({ success: true });

    const result = await data.updateTrack(
      1,
      'Artist',
      'Name',
      1999,
      'sp',
      'yt',
      'ap',
      'ti',
      'de',
      'am',
      '9.9.9.9'
    );
    expect(result).toEqual({ success: true });
    expect(h.tracks.updateTrack).toHaveBeenCalledWith(
      data,
      1,
      'Artist',
      'Name',
      1999,
      'sp',
      'yt',
      'ap',
      'ti',
      'de',
      'am',
      '9.9.9.9',
      'en'
    );
  });

  it('storePlaylists defaults resetCache to false', async () => {
    const { data } = await makeData();
    const cart = [{ playlistId: 'p1' }] as any[];
    h.playlists.storePlaylists.mockResolvedValueOnce([10]);

    await expect(data.storePlaylists(2, cart)).resolves.toEqual([10]);
    expect(h.playlists.storePlaylists).toHaveBeenCalledWith(
      data,
      2,
      cart,
      false
    );
  });

  it('getPlaylistsByPaymentId defaults playlistId to null', async () => {
    const { data } = await makeData();
    h.playlists.getPlaylistsByPaymentId.mockResolvedValueOnce([]);

    await data.getPlaylistsByPaymentId('pay_1');
    expect(h.playlists.getPlaylistsByPaymentId).toHaveBeenCalledWith(
      data,
      'pay_1',
      null
    );
  });

  it('getFeaturedPlaylists defaults skipLocaleFilter to false', async () => {
    const { data } = await makeData();
    h.featuredPlaylists.getFeaturedPlaylists.mockResolvedValueOnce(['f']);

    await expect(data.getFeaturedPlaylists('nl')).resolves.toEqual(['f']);
    expect(h.featuredPlaylists.getFeaturedPlaylists).toHaveBeenCalledWith(
      data,
      'nl',
      false
    );
  });

  it('searchFeaturedPlaylists applies its full default search window', async () => {
    const { data } = await makeData();
    h.featuredPlaylists.searchFeaturedPlaylists.mockResolvedValueOnce({
      items: [],
    });

    await data.searchFeaturedPlaylists();
    expect(h.featuredPlaylists.searchFeaturedPlaylists).toHaveBeenCalledWith(
      data,
      '',
      null,
      1,
      20,
      'id',
      'desc'
    );
  });

  it('getTracksWithoutMusicLinks defaults the limit to 100', async () => {
    const { data } = await makeData();
    h.musicLinks.getTracksWithoutMusicLinks.mockResolvedValueOnce([]);

    await data.getTracksWithoutMusicLinks();
    expect(h.musicLinks.getTracksWithoutMusicLinks).toHaveBeenCalledWith(
      data,
      100
    );
  });

  it('getTaxRate defaults the reference date to now', async () => {
    const { data } = await makeData();
    h.users.getTaxRate.mockResolvedValueOnce(21);
    const before = Date.now();

    await expect(data.getTaxRate('NL')).resolves.toBe(21);

    const [deps, country, date] = h.users.getTaxRate.mock.calls[0];
    expect(deps).toBe(data);
    expect(country).toBe('NL');
    expect(date).toBeInstanceOf(Date);
    expect((date as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((date as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('public translateGenres delegates to the misc submodule', async () => {
    const { data } = await makeData();
    h.misc.translateGenres.mockResolvedValueOnce(undefined);

    await data.translateGenres();
    expect(h.misc.translateGenres).toHaveBeenCalledWith(data);
  });

  it('public updateFeaturedPlaylistStats delegates to the scoring submodule', async () => {
    const { data } = await makeData();
    h.scoring.updateFeaturedPlaylistStats.mockResolvedValueOnce(undefined);

    await data.updateFeaturedPlaylistStats();
    expect(h.scoring.updateFeaturedPlaylistStats).toHaveBeenCalledWith(data);
  });

  it('clearPlaylistCache forwards the optional old slug', async () => {
    const { data } = await makeData();
    h.misc.clearPlaylistCache.mockResolvedValueOnce(undefined);

    await data.clearPlaylistCache('pl_1', 'old-slug');
    expect(h.misc.clearPlaylistCache).toHaveBeenCalledWith(
      data,
      'pl_1',
      'old-slug'
    );
  });

  it('areAllTracksManuallyChecked delegates to the users submodule', async () => {
    const { data } = await makeData();
    h.users.areAllTracksManuallyChecked.mockResolvedValueOnce(true);

    await expect(data.areAllTracksManuallyChecked('pay_9')).resolves.toBe(
      true
    );
    expect(h.users.areAllTracksManuallyChecked).toHaveBeenCalledWith(
      data,
      'pay_9'
    );
  });
});
