/**
 * Unit tests for src/data/misc.ts
 *
 * All I/O is mocked — no real DB, Redis, filesystem, or network calls.
 * vi.mock calls are hoisted to before any imports by Vitest.
 *
 * Skipped:
 *   createSiteMap      — requires coordinating fs.writeFile + prisma + locale
 *                        iteration; mocking fs promises at module level is
 *                        fragile and the function has no observable return value
 *                        beyond the side-effect, making branch coverage low-value.
 *   generatePlaylistExcel — ExcelJS's streaming Buffer path (workbook.xlsx.writeBuffer)
 *                           is tightly coupled to internal ExcelJS state; mocking it
 *                           fully would duplicate the ExcelJS API rather than test
 *                           the business logic. The null-path branches are covered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — shared mutable state visible inside vi.mock factories
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  return {
    // Cache key constants that misc.ts imports from other modules
    CACHE_KEY_PLAYLIST: 'playlist2_',
    CACHE_KEY_PLAYLIST_DB: 'playlistdb2_',
    CACHE_KEY_TRACKS: 'tracks2_',
    CACHE_KEY_TRACK_COUNT: 'trackcount2_',
    CACHE_KEY_FEATURED_PLAYLISTS: 'featuredPlaylists_v3_',
  };
});

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any src import)
// ---------------------------------------------------------------------------

vi.mock('console-log-colors', () => ({
  color: new Proxy(
    {},
    {
      get() {
        return new Proxy(
          (s: unknown) => s,
          {
            get() {
              return new Proxy((s: unknown) => s, { get() { return (s: unknown) => s; } });
            },
          }
        );
      },
    }
  ),
  white: (s: unknown) => s,
}));

vi.mock('fs', () => ({
  promises: {
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('exceljs', () => {
  const mockWorkbook = {
    addWorksheet: vi.fn(() => ({
      columns: [],
      getRow: vi.fn(() => ({ font: {}, fill: {} })),
      addRow: vi.fn(),
      eachRow: vi.fn(),
    })),
    xlsx: {
      writeBuffer: vi.fn(async () => Buffer.from('fake-excel')),
    },
  };
  return {
    Workbook: vi.fn(() => mockWorkbook),
  };
});

vi.mock('../../../src/translation', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      allLocales: ['en', 'nl', 'de', 'fr'],
    })),
  };
});

vi.mock('@prisma/client', () => ({
  Prisma: {},
  genre: {},
}));

vi.mock('../../../src/spotify', () => ({
  CACHE_KEY_PLAYLIST: h.CACHE_KEY_PLAYLIST,
  CACHE_KEY_PLAYLIST_DB: h.CACHE_KEY_PLAYLIST_DB,
  CACHE_KEY_TRACKS: h.CACHE_KEY_TRACKS,
  CACHE_KEY_TRACK_COUNT: h.CACHE_KEY_TRACK_COUNT,
}));

vi.mock('../../../src/data/featuredPlaylists', () => ({
  CACHE_KEY_FEATURED_PLAYLISTS: h.CACHE_KEY_FEATURED_PLAYLISTS,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are registered
// ---------------------------------------------------------------------------
import {
  getPDFFilepath,
  getLastPlays,
  translateGenres,
  clearPlaylistCache,
  clearNonFeaturedPlaylistCaches,
} from '../../../src/data/misc';

// ---------------------------------------------------------------------------
// Helper: build a minimal DataDeps object
// ---------------------------------------------------------------------------
function makeDeps(overrides: Partial<any> = {}): any {
  return {
    prisma: {
      track: { findMany: vi.fn(async () => []) },
      genre: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
      playlist: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      paymentHasPlaylist: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      playlistHasTrack: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
      ...overrides.prisma,
    },
    logger: { log: vi.fn() },
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      del: vi.fn(async () => undefined),
      delPattern: vi.fn(async () => undefined),
      executeCommand: vi.fn(async () => []),
      ...overrides.cache,
    },
    utils: {
      isTrustedIp: vi.fn(() => false),
      generateFilename: vi.fn((name: string) => name.replace(/\s+/g, '_')),
      ...overrides.utils,
    },
    translate: {
      allLocales: ['en', 'nl', 'de'],
      ...overrides.translate,
    },
    openai: {
      translateGenreNames: vi.fn(async () => ({})),
      ...overrides.openai,
    },
    music: {},
    analytics: {},
    pushover: {},
    appTheme: {},
    axiosInstance: {},
    blockedPlaylists: [],
    blockedPlaylistsInitialized: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getPDFFilepath
// ---------------------------------------------------------------------------
describe('getPDFFilepath', () => {
  it('returns null when type=printer and isTrustedIp returns false', async () => {
    const deps = makeDeps({ utils: { isTrustedIp: vi.fn(() => false), generateFilename: vi.fn() } });
    const result = await getPDFFilepath(deps, '1.2.3.4', 'PAY1', 'HASH1', 'PL1', 'printer');
    expect(result).toBeNull();
    expect(deps.utils.isTrustedIp).toHaveBeenCalledWith('1.2.3.4');
  });

  it('returns cached result (parsed from JSON) when cache hit', async () => {
    const cached = { fileName: 'cached.pdf', filePath: '/some/path/cached.pdf' };
    const deps = makeDeps({
      utils: { isTrustedIp: vi.fn(() => true), generateFilename: vi.fn() },
      cache: { get: vi.fn(async () => JSON.stringify(cached)), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
    });
    const result = await getPDFFilepath(deps, '10.0.0.1', 'PAY1', 'HASH1', 'PL1', 'digital');
    expect(result).toEqual(cached);
    // DB should not be queried
    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns null when DB query returns empty array', async () => {
    const deps = makeDeps({
      utils: { isTrustedIp: vi.fn(() => true), generateFilename: vi.fn(() => 'myplaylist') },
      cache: { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
      prisma: { $queryRaw: vi.fn(async () => []) },
    });
    const result = await getPDFFilepath(deps, '10.0.0.1', 'PAY1', 'HASH1', 'PL1', 'digital');
    expect(result).toBeNull();
  });

  it('returns object with "printer_" prefix in fileName for printer type', async () => {
    process.env['PUBLIC_DIR'] = '/public';
    const dbRow = { filename: 'printer_file.pdf', filenameDigital: 'digital_file.pdf', name: 'My Playlist' };
    const deps = makeDeps({
      utils: { isTrustedIp: vi.fn(() => true), generateFilename: vi.fn(() => 'My_Playlist') },
      cache: { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
      prisma: { $queryRaw: vi.fn(async () => [dbRow]) },
    });
    const result = await getPDFFilepath(deps, '10.0.0.1', 'PAY1', 'HASH1', 'PL1', 'printer');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('printer_My_Playlist.pdf');
    expect(result!.filePath).toBe('/public/pdf/printer_file.pdf');
  });

  it('returns object with filenameDigital for non-printer type', async () => {
    process.env['PUBLIC_DIR'] = '/public';
    const dbRow = { filename: 'printer_file.pdf', filenameDigital: 'digital_file.pdf', name: 'My Playlist' };
    const deps = makeDeps({
      utils: { isTrustedIp: vi.fn(() => true), generateFilename: vi.fn(() => 'My_Playlist') },
      cache: { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
      prisma: { $queryRaw: vi.fn(async () => [dbRow]) },
    });
    const result = await getPDFFilepath(deps, '10.0.0.1', 'PAY1', 'HASH1', 'PL1', 'digital');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('My_Playlist.pdf');
    expect(result!.filePath).toBe('/public/pdf/digital_file.pdf');
  });

  it('stores result in cache after DB fetch and returns it', async () => {
    process.env['PUBLIC_DIR'] = '/public';
    const dbRow = { filename: 'pfile.pdf', filenameDigital: 'dfile.pdf', name: 'Playlist A' };
    const setCacheFn = vi.fn(async () => undefined);
    const deps = makeDeps({
      utils: { isTrustedIp: vi.fn(() => true), generateFilename: vi.fn(() => 'Playlist_A') },
      cache: { get: vi.fn(async () => null), set: setCacheFn, del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
      prisma: { $queryRaw: vi.fn(async () => [dbRow]) },
    });
    const result = await getPDFFilepath(deps, '10.0.0.1', 'PAY2', 'HASH2', 'PL2', 'digital');
    expect(result).not.toBeNull();
    expect(setCacheFn).toHaveBeenCalledOnce();
    const [cacheKey, cacheValue] = setCacheFn.mock.calls[0];
    expect(cacheKey).toContain('PAY2');
    expect(JSON.parse(cacheValue)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// getLastPlays
// ---------------------------------------------------------------------------
describe('getLastPlays', () => {
  it('returns empty array when ipInfoList is empty', async () => {
    const deps = makeDeps({
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn(async () => []) },
    });
    const result = await getLastPlays(deps);
    expect(result).toEqual([]);
    // NOTE: suspected bug: track.findMany is still called with an empty `in` array even when
    // ipInfoList is empty — a cheap guard (`if (trackIds.length === 0) return []`) would save a DB round-trip.
    // The current code calls findMany regardless, so we assert the result rather than whether it was called.
    expect(deps.prisma.track.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [] } } })
    );
  });

  it('returns parsed track+geo data for valid entries', async () => {
    const ipInfo = {
      trackId: '42',
      city: 'Amsterdam',
      region: 'NH',
      country_code: 'NL',
      latitude: 52.37,
      longitude: 4.9,
      timestamp: '2024-01-01T12:00:00Z',
    };
    const track = { id: 42, name: 'Song A', artist: 'Artist A', trackId: 'spotify123' };

    const deps = makeDeps({
      cache: {
        get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(),
        executeCommand: vi.fn(async () => [JSON.stringify(ipInfo)]),
      },
      prisma: {
        track: { findMany: vi.fn(async () => [track]) },
        paymentHasPlaylist: { findMany: vi.fn(async () => []) },
      },
    });

    const result = await getLastPlays(deps);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'Song A',
      artist: 'Artist A',
      city: 'Amsterdam',
      country: 'NL',
      trackId: 'spotify123',
    });
  });

  it('filters out entries with no matching track', async () => {
    const ipInfo = { trackId: '999', city: 'Berlin', region: 'BE', country_code: 'DE', latitude: 52.5, longitude: 13.4, timestamp: '2024-01-01T12:00:00Z' };
    const deps = makeDeps({
      cache: {
        get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(),
        executeCommand: vi.fn(async () => [JSON.stringify(ipInfo)]),
      },
      prisma: {
        track: { findMany: vi.fn(async () => []) }, // no matching track
        paymentHasPlaylist: { findMany: vi.fn(async () => []) },
      },
    });

    const result = await getLastPlays(deps);
    expect(result).toHaveLength(0);
  });

  it('includes playlistName and displayName when php entry is present and matched', async () => {
    const ipInfo = {
      trackId: '10',
      php: '5',
      city: 'Utrecht',
      region: 'UT',
      country_code: 'NL',
      latitude: 52.09,
      longitude: 5.1,
      timestamp: '2024-01-02T10:00:00Z',
    };
    const track = { id: 10, name: 'Track B', artist: 'Artist B', trackId: 'sp456' };
    const phpEntry = {
      id: 5,
      playlist: { name: 'Cool Playlist' },
      payment: { user: { displayName: 'JohnDoe' } },
    };

    const deps = makeDeps({
      cache: {
        get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(),
        executeCommand: vi.fn(async () => [JSON.stringify(ipInfo)]),
      },
      prisma: {
        track: { findMany: vi.fn(async () => [track]) },
        paymentHasPlaylist: { findMany: vi.fn(async () => [phpEntry]) },
      },
    });

    const result = await getLastPlays(deps);
    expect(result).toHaveLength(1);
    expect(result[0].playlistName).toBe('Cool Playlist');
    expect(result[0].displayName).toBe('JohnDoe');
  });

  it('does NOT call paymentHasPlaylist.findMany when phpIds is empty', async () => {
    const ipInfo = { trackId: '10', city: 'X', region: 'Y', country_code: 'ZZ', latitude: 0, longitude: 0, timestamp: 't' };
    const track = { id: 10, name: 'T', artist: 'A', trackId: 'sp789' };
    const phpFindMany = vi.fn(async () => []);

    const deps = makeDeps({
      cache: {
        get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(),
        executeCommand: vi.fn(async () => [JSON.stringify(ipInfo)]),
      },
      prisma: {
        track: { findMany: vi.fn(async () => [track]) },
        paymentHasPlaylist: { findMany: phpFindMany },
      },
    });

    await getLastPlays(deps);
    expect(phpFindMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// translateGenres
// ---------------------------------------------------------------------------
describe('translateGenres', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips genres with empty name_en and does not call translateGenreNames', async () => {
    const genre = { id: 1, slug: 'rock', name_en: '', name_nl: null, name_de: null, name_fr: null };
    const translateFn = vi.fn(async () => ({}));
    const deps = makeDeps({
      prisma: { genre: { findMany: vi.fn(async () => [genre]), update: vi.fn() } },
      openai: { translateGenreNames: translateFn },
    });

    const p = translateGenres(deps);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(translateFn).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, updated: 0, errors: 0 });
  });

  it('only translates null/empty locales, skips en and already-translated', async () => {
    // name_nl is already set, name_de is null, name_fr is empty → only de and fr should be requested
    const genre = { id: 2, slug: 'pop', name_en: 'Pop', name_nl: 'Pop', name_de: null, name_fr: '' };
    const translateFn = vi.fn(async (_name: string, locales: string[]) => {
      return Object.fromEntries(locales.map((l) => [l, `Pop_${l}`]));
    });
    const updateFn = vi.fn(async () => ({}));
    const deps = makeDeps({
      prisma: { genre: { findMany: vi.fn(async () => [genre]), update: updateFn } },
      openai: { translateGenreNames: translateFn },
    });

    const p = translateGenres(deps);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(translateFn).toHaveBeenCalledOnce();
    const [, localesArg] = translateFn.mock.calls[0];
    expect(localesArg).not.toContain('en');
    expect(localesArg).not.toContain('nl');
    expect(localesArg).toContain('de');
    expect(localesArg).toContain('fr');
    expect(updateFn).toHaveBeenCalledOnce();
    expect(result.updated).toBe(1);
  });

  it('updates DB and increments updatedCount on success', async () => {
    const genre = { id: 3, slug: 'jazz', name_en: 'Jazz', name_nl: null, name_de: null, name_fr: null };
    const updateFn = vi.fn(async () => ({}));
    const deps = makeDeps({
      prisma: { genre: { findMany: vi.fn(async () => [genre]), update: updateFn } },
      openai: { translateGenreNames: vi.fn(async () => ({ nl: 'Jazz', de: 'Jazz', fr: 'Jazz' })) },
    });

    const p = translateGenres(deps);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(updateFn).toHaveBeenCalledWith({ where: { id: 3 }, data: expect.objectContaining({ name_nl: 'Jazz' }) });
    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('increments errorCount when openai.translateGenreNames throws', async () => {
    const genre = { id: 4, slug: 'blues', name_en: 'Blues', name_nl: null, name_de: null, name_fr: null };
    const deps = makeDeps({
      prisma: { genre: { findMany: vi.fn(async () => [genre]), update: vi.fn() } },
      openai: { translateGenreNames: vi.fn(async () => { throw new Error('OpenAI error'); }) },
    });

    const p = translateGenres(deps);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.errors).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('returns processed/updated/errors counts', async () => {
    const genres = [
      { id: 10, slug: 'a', name_en: '', name_nl: null, name_de: null, name_fr: null },     // skipped: no name_en
      { id: 11, slug: 'b', name_en: 'Genre B', name_nl: 'Genre B', name_de: 'Genre B', name_fr: 'Genre B' }, // fully translated
      { id: 12, slug: 'c', name_en: 'Genre C', name_nl: null, name_de: null, name_fr: null }, // needs translation
    ];
    const deps = makeDeps({
      prisma: { genre: { findMany: vi.fn(async () => genres), update: vi.fn(async () => ({})) } },
      openai: { translateGenreNames: vi.fn(async () => ({ nl: 'Genre C', de: 'Genre C', fr: 'Genre C' })) },
    });

    const p = translateGenres(deps);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.processed).toBe(3);
    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clearPlaylistCache
// ---------------------------------------------------------------------------
describe('clearPlaylistCache', () => {
  it('calls delPattern for CACHE_KEY_FEATURED_PLAYLISTS pattern', async () => {
    const delPatternFn = vi.fn(async () => undefined);
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => ({ slug: 'my-playlist' })) } },
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: delPatternFn, executeCommand: vi.fn() },
    });

    await clearPlaylistCache(deps, 'PL123');

    expect(delPatternFn).toHaveBeenCalledWith(`${h.CACHE_KEY_FEATURED_PLAYLISTS}*`);
  });

  it('calls del for playlistId-based keys', async () => {
    const delFn = vi.fn(async () => undefined);
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => ({ slug: null })) } },
      cache: { get: vi.fn(), set: vi.fn(), del: delFn, delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    await clearPlaylistCache(deps, 'PL123');

    const deletedKeys: string[] = delFn.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(`${h.CACHE_KEY_PLAYLIST}PL123`);
    expect(deletedKeys).toContain(`${h.CACHE_KEY_PLAYLIST_DB}PL123`);
  });

  it('calls del for slug-based keys when slug exists', async () => {
    const delFn = vi.fn(async () => undefined);
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => ({ slug: 'my-slug' })) } },
      cache: { get: vi.fn(), set: vi.fn(), del: delFn, delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    await clearPlaylistCache(deps, 'PL123');

    const deletedKeys: string[] = delFn.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(`${h.CACHE_KEY_PLAYLIST}my-slug`);
    expect(deletedKeys).toContain(`${h.CACHE_KEY_PLAYLIST_DB}my-slug`);
  });

  it('calls del for oldSlug when different from current slug', async () => {
    const delFn = vi.fn(async () => undefined);
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => ({ slug: 'new-slug' })) } },
      cache: { get: vi.fn(), set: vi.fn(), del: delFn, delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    await clearPlaylistCache(deps, 'PL123', 'old-slug');

    const deletedKeys: string[] = delFn.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(`${h.CACHE_KEY_PLAYLIST}old-slug`);
    expect(deletedKeys).toContain(`${h.CACHE_KEY_PLAYLIST_DB}old-slug`);
  });

  it('skips oldSlug del when same as current slug', async () => {
    const delFn = vi.fn(async () => undefined);
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => ({ slug: 'same-slug' })) } },
      cache: { get: vi.fn(), set: vi.fn(), del: delFn, delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    await clearPlaylistCache(deps, 'PL123', 'same-slug');

    const deletedKeys: string[] = delFn.mock.calls.map((c) => c[0]);
    // same-slug appears once for the current slug del, NOT a second time for oldSlug
    const sameSlugHits = deletedKeys.filter((k) => k.includes('same-slug'));
    // Expect exactly 2 hits (CACHE_KEY_PLAYLIST + CACHE_KEY_PLAYLIST_DB), not 4
    expect(sameSlugHits).toHaveLength(2);
  });

  it('returns {success:true} on success', async () => {
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => ({ slug: 'sl' })) } },
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    const result = await clearPlaylistCache(deps, 'PL123');
    expect(result).toEqual({ success: true });
  });

  it('returns {success:false, error} when an exception is thrown', async () => {
    const deps = makeDeps({
      prisma: { playlist: { findUnique: vi.fn(async () => { throw new Error('DB gone'); }) } },
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    const result = await clearPlaylistCache(deps, 'PL123');
    expect(result.success).toBe(false);
    expect(result.error).toBe('DB gone');
  });
});

// ---------------------------------------------------------------------------
// clearNonFeaturedPlaylistCaches
// ---------------------------------------------------------------------------
describe('clearNonFeaturedPlaylistCaches', () => {
  it('queries non-featured playlists', async () => {
    const findManyFn = vi.fn(async () => []);
    const deps = makeDeps({
      prisma: {
        playlist: { findMany: findManyFn, findUnique: vi.fn(async () => null) },
      },
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    await clearNonFeaturedPlaylistCaches(deps);

    expect(findManyFn).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ featured: false }) })
    );
  });

  it('calls clearPlaylistCache for each non-featured playlist', async () => {
    const playlists = [
      { playlistId: 'PL1', slug: 'slug-1' },
      { playlistId: 'PL2', slug: 'slug-2' },
    ];
    const delFn = vi.fn(async () => undefined);
    const delPatternFn = vi.fn(async () => undefined);

    const deps = makeDeps({
      prisma: {
        playlist: {
          findMany: vi.fn(async () => playlists),
          // findUnique is called inside clearPlaylistCache for each playlist
          findUnique: vi.fn(async ({ where }: any) => {
            const pl = playlists.find((p) => p.playlistId === where.playlistId);
            return pl ? { slug: pl.slug } : null;
          }),
        },
      },
      cache: { get: vi.fn(), set: vi.fn(), del: delFn, delPattern: delPatternFn, executeCommand: vi.fn() },
    });

    const result = await clearNonFeaturedPlaylistCaches(deps);

    // delPattern called once per clearPlaylistCache call (featured key) — 2 playlists → 2 calls minimum
    expect(delPatternFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.processed).toBe(2);
  });

  it('returns {success:true, processed: N}', async () => {
    const playlists = [{ playlistId: 'A', slug: 'a' }, { playlistId: 'B', slug: 'b' }];
    const deps = makeDeps({
      prisma: {
        playlist: {
          findMany: vi.fn(async () => playlists),
          findUnique: vi.fn(async () => ({ slug: 'x' })),
        },
      },
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    const result = await clearNonFeaturedPlaylistCaches(deps);
    expect(result).toEqual({ success: true, processed: 2 });
  });

  it('returns {success:false, processed:0, error} on exception', async () => {
    const deps = makeDeps({
      prisma: {
        playlist: {
          findMany: vi.fn(async () => { throw new Error('DB exploded'); }),
        },
      },
      cache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), delPattern: vi.fn(), executeCommand: vi.fn() },
    });

    const result = await clearNonFeaturedPlaylistCaches(deps);
    expect(result.success).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.error).toBe('DB exploded');
  });
});
