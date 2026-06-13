import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/data/musicLinks.ts
 * All I/O is mocked — no real DB, Redis, or network calls are made.
 */

// ─── Hoisted mock state ────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  return {
    // Provider factory mocks
    spotifyGetInstance: vi.fn(),
    fakeProvider: {
      config: { supportsSearch: true, displayName: 'Deezer' },
      searchTracks: vi.fn(),
    },
    fakeFactoryInstance: {
      getProvider: vi.fn(),
    },
    fakeFactoryClass: {
      getInstance: vi.fn(),
    },
  };
});

// ─── Module-level vi.mock calls (hoisted before any import) ───────────────

vi.mock('console-log-colors', () => ({
  color: new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          (s: any) => s,
          {
            get: () => (s: any) => s,
          }
        ),
    }
  ),
}));

vi.mock('../../src/providers/MusicProviderFactory', () => ({
  serviceColumnMap: {
    spotify: 'spotifyLink',
    youtube: 'youtubeMusicLink',
    deezer: 'deezerLink',
    apple: 'appleMusicLink',
    tidal: 'tidalLink',
    amazon: 'amazonMusicLink',
  },
  serviceCheckedColumnMap: {
    spotify: 'spotifyCheckedBySearch',
    youtube: 'youtubeCheckedBySearch',
    deezer: 'deezerCheckedBySearch',
    apple: 'appleCheckedBySearch',
    tidal: 'tidalCheckedBySearch',
    amazon: 'amazonCheckedBySearch',
  },
  serviceTypeMap: {
    spotify: 'spotify',
    youtube: 'youtube_music',
    deezer: 'deezer',
    apple: 'apple_music',
    tidal: 'tidal',
  },
  default: h.fakeFactoryClass,
}));

// ─── Subject under test ────────────────────────────────────────────────────

import {
  TRACK_LINKS_CACHE_PREFIX,
  getYouTubeLink,
  addSpotifyLinks,
  prefillLinkCache,
  logLink,
  getLink,
  getPlaylistLinkCoverage,
  getTracksWithoutMusicLinks,
  updateTrackMusicLinks,
  findMissingServiceLinks,
} from '../../src/data/musicLinks';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a minimal DataDeps-shaped fake that only exposes what the tests need.
 * Each test can override individual properties as required.
 */
function makeDeps(overrides: Record<string, any> = {}): any {
  const prisma = {
    track: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  };

  const cache = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    executeCommand: vi.fn(),
    delPatternNonBlocking: vi.fn(),
  };

  const logger = { log: vi.fn() };

  const utils = { lookupIp: vi.fn() };

  const analytics = { increaseCounter: vi.fn() };

  const appTheme = { getTheme: vi.fn() };

  return {
    prisma,
    cache,
    logger,
    utils,
    analytics,
    appTheme,
    axiosInstance: { request: vi.fn() },
    blockedPlaylists: new Set<number>(),
    blockedPlaylistsInitialized: true,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('TRACK_LINKS_CACHE_PREFIX', () => {
  it('equals "track_links_v6"', () => {
    expect(TRACK_LINKS_CACHE_PREFIX).toBe('track_links_v6');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getYouTubeLink
// ══════════════════════════════════════════════════════════════════════════

describe('getYouTubeLink', () => {
  it('always returns null — the function body is dead code after the early return', async () => {
    const deps = makeDeps();
    const result = await getYouTubeLink(deps, 'ABBA', 'Waterloo');
    expect(result).toBeNull();
    // The axios instance should never be called because of the early return
    expect(deps.axiosInstance.request).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// addSpotifyLinks
// ══════════════════════════════════════════════════════════════════════════

describe('addSpotifyLinks', () => {
  it('returns 0 when the tracks list is empty', async () => {
    const deps = makeDeps();
    deps.prisma.track.findMany.mockResolvedValue([]);
    const result = await addSpotifyLinks(deps);
    expect(result).toBe(0);
  });

  it('returns 0 when getYouTubeLink returns null (which it always does)', async () => {
    const deps = makeDeps();
    deps.prisma.track.findMany.mockResolvedValue([
      { id: 1, artist: 'ABBA', name: 'Waterloo', spotifyLink: 'https://open.spotify.com/track/abc123' },
    ]);
    // NOTE: suspected bug: addSpotifyLinks iterates tracks and calls
    // getYouTubeLink, but getYouTubeLink always returns null (dead code).
    // Therefore processed will always be 0. This function does nothing useful.
    const result = await addSpotifyLinks(deps);
    expect(result).toBe(0);
    // DB update must never be called because youtubeId is always null
    expect(deps.prisma.track.update).not.toHaveBeenCalled();
  });

  it('queries tracks that have spotifyLink but no youtubeLink', async () => {
    const deps = makeDeps();
    deps.prisma.track.findMany.mockResolvedValue([]);
    await addSpotifyLinks(deps);
    expect(deps.prisma.track.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          youtubeLink: null,
          spotifyLink: { not: null },
        }),
      })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// prefillLinkCache
// ══════════════════════════════════════════════════════════════════════════

describe('prefillLinkCache', () => {
  it('calls delPatternNonBlocking with "track_links_v*"', async () => {
    const deps = makeDeps();
    deps.cache.delPatternNonBlocking.mockResolvedValue(5);
    deps.prisma.track.findMany.mockResolvedValue([]);
    await prefillLinkCache(deps);
    expect(deps.cache.delPatternNonBlocking).toHaveBeenCalledWith('track_links_v*');
  });

  it('sets a cache entry for each track that has a spotifyLink', async () => {
    const deps = makeDeps();
    deps.cache.delPatternNonBlocking.mockResolvedValue(0);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.track.findMany.mockResolvedValue([
      {
        id: 10,
        spotifyLink: 'https://open.spotify.com/track/x',
        youtubeLink: null,
        youtubeMusicLink: 'https://music.youtube.com/watch?v=y',
        appleMusicLink: null,
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
      {
        id: 11,
        spotifyLink: 'https://open.spotify.com/track/z',
        youtubeLink: null,
        youtubeMusicLink: null,
        appleMusicLink: 'https://music.apple.com/track/1',
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
    ]);

    await prefillLinkCache(deps);

    expect(deps.cache.set).toHaveBeenCalledTimes(2);
    expect(deps.cache.set).toHaveBeenCalledWith(
      'track_links_v6:10',
      expect.stringContaining('"link":"https://open.spotify.com/track/x"')
    );
    expect(deps.cache.set).toHaveBeenCalledWith(
      'track_links_v6:11',
      expect.stringContaining('"link":"https://open.spotify.com/track/z"')
    );
  });

  it('skips tracks with a null spotifyLink', async () => {
    const deps = makeDeps();
    deps.cache.delPatternNonBlocking.mockResolvedValue(0);
    deps.cache.set.mockResolvedValue(undefined);
    // The DB query uses `where: { spotifyLink: { not: '' } }` so even tracks
    // with null spotifyLink can be returned by a mock.
    deps.prisma.track.findMany.mockResolvedValue([
      {
        id: 20,
        spotifyLink: null,
        youtubeLink: null,
        youtubeMusicLink: null,
        appleMusicLink: null,
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
    ]);

    await prefillLinkCache(deps);

    // The if (track.spotifyLink) guard skips null values
    expect(deps.cache.set).not.toHaveBeenCalled();
  });

  it('includes all link fields in the cached JSON value', async () => {
    const deps = makeDeps();
    deps.cache.delPatternNonBlocking.mockResolvedValue(0);
    deps.cache.set.mockResolvedValue(undefined);
    const track = {
      id: 30,
      spotifyLink: 'sp-link',
      youtubeLink: 'yt-link',
      youtubeMusicLink: 'ytm-link',
      appleMusicLink: 'apple-link',
      amazonMusicLink: 'amazon-link',
      deezerLink: 'deezer-link',
      tidalLink: 'tidal-link',
    };
    deps.prisma.track.findMany.mockResolvedValue([track]);

    await prefillLinkCache(deps);

    const [, cachedJson] = deps.cache.set.mock.calls[0];
    const parsed = JSON.parse(cachedJson);
    expect(parsed).toEqual({
      link: 'sp-link',
      youtubeLink: 'yt-link',
      youtubeMusicLink: 'ytm-link',
      appleMusicLink: 'apple-link',
      amazonMusicLink: 'amazon-link',
      deezerLink: 'deezer-link',
      tidalLink: 'tidal-link',
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// logLink
// ══════════════════════════════════════════════════════════════════════════

describe('logLink', () => {
  it('calls utils.lookupIp with the provided clientIp', async () => {
    const deps = makeDeps();
    deps.utils.lookupIp.mockResolvedValue({ country: 'NL', city: 'Amsterdam' });
    deps.cache.executeCommand.mockResolvedValue(undefined);

    await logLink(deps, 42, '1.2.3.4', 99);

    expect(deps.utils.lookupIp).toHaveBeenCalledWith('1.2.3.4');
  });

  it('calls cache.executeCommand("lpush", ...) with a JSON payload including trackId, timestamp and php', async () => {
    const deps = makeDeps();
    const ipInfo = { country: 'DE', city: 'Berlin' };
    deps.utils.lookupIp.mockResolvedValue(ipInfo);
    deps.cache.executeCommand.mockResolvedValue(undefined);

    await logLink(deps, 7, '9.9.9.9', 55);

    const lpushCall = deps.cache.executeCommand.mock.calls.find(
      (c: any[]) => c[0] === 'lpush'
    );
    expect(lpushCall).toBeDefined();
    expect(lpushCall[1]).toBe('ipInfoList');
    const payload = JSON.parse(lpushCall[2]);
    expect(payload.trackId).toBe(7);
    expect(payload.php).toBe(55);
    expect(payload.country).toBe('DE');
    expect(typeof payload.timestamp).toBe('string'); // ISO date string
  });

  it('calls cache.executeCommand("ltrim", ...) to keep only the last 1000 entries', async () => {
    const deps = makeDeps();
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);

    await logLink(deps, 1, '127.0.0.1');

    const ltrimCall = deps.cache.executeCommand.mock.calls.find(
      (c: any[]) => c[0] === 'ltrim'
    );
    expect(ltrimCall).toBeDefined();
    expect(ltrimCall[1]).toBe('ipInfoList');
    expect(ltrimCall[2]).toBe(0);
    expect(ltrimCall[3]).toBe(999);
    // NOTE: suspected bug: the code comment says "last 100 entries" but the
    // ltrim keeps indices 0–999 (1000 entries). Comment is wrong.
  });

  it('works without a php argument (php is optional)', async () => {
    const deps = makeDeps();
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);

    await expect(logLink(deps, 5, '1.1.1.1')).resolves.toBeUndefined();

    const lpushCall = deps.cache.executeCommand.mock.calls.find(
      (c: any[]) => c[0] === 'lpush'
    );
    const payload = JSON.parse(lpushCall[2]);
    expect(payload.php).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getLink
// ══════════════════════════════════════════════════════════════════════════

describe('getLink', () => {
  beforeEach(() => {
    // Reset hoisted factory mock state before each test in this suite
    h.fakeFactoryClass.getInstance.mockReturnValue(h.fakeFactoryInstance);
    h.fakeFactoryInstance.getProvider.mockReturnValue(h.fakeProvider);
  });

  it('calls analytics.increaseCounter("songs", "played") on every call', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.prisma.$queryRaw.mockResolvedValue([]);

    await getLink(deps, 1, '1.2.3.4');

    expect(deps.analytics.increaseCounter).toHaveBeenCalledWith('songs', 'played');
  });

  it('returns blocked error when php is in blockedPlaylists and blockedPlaylistsInitialized is true', async () => {
    const deps = makeDeps({
      blockedPlaylists: new Set([999]),
      blockedPlaylistsInitialized: true,
    });
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);

    const result = await getLink(deps, 1, '1.2.3.4', true, undefined, 999);

    expect(result).toEqual({ success: false, error: 'This playlist has been blocked' });
  });

  it('does not block when php is not in the blockedPlaylists set', async () => {
    const deps = makeDeps({
      blockedPlaylists: new Set([100]),
      blockedPlaylistsInitialized: true,
    });
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([]);

    const result = await getLink(deps, 1, '1.2.3.4', true, undefined, 200);

    expect(result.success).toBe(false);
    expect(result.error).not.toBe('This playlist has been blocked');
  });

  it('returns cache result when useCache=true and there is a cache hit', async () => {
    const deps = makeDeps();
    const cachedData = {
      link: 'https://open.spotify.com/track/cached',
      youtubeLink: null,
      youtubeMusicLink: null,
      appleMusicLink: null,
      amazonMusicLink: null,
      deezerLink: null,
      tidalLink: null,
    };
    deps.cache.get.mockResolvedValue(JSON.stringify(cachedData));
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);

    const result = await getLink(deps, 5, '1.2.3.4', true);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(cachedData);
    // DB should NOT be queried when cache hit
    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns {success:false} when no cached data and DB returns empty array', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([]);

    const result = await getLink(deps, 99, '1.2.3.4', true);

    expect(result).toEqual({ success: false });
  });

  it('returns {success:true, data} with links from DB when cache misses', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.cache.set.mockResolvedValue(undefined);
    const dbRow = {
      spotifyLink: 'https://open.spotify.com/track/db',
      youtubeLink: null,
      youtubeMusicLink: null,
      appleMusicLink: null,
      amazonMusicLink: null,
      deezerLink: null,
      tidalLink: null,
    };
    deps.prisma.$queryRaw.mockResolvedValue([dbRow]);

    const result = await getLink(deps, 3, '1.2.3.4', false);

    expect(result.success).toBe(true);
    expect(result.data?.link).toBe('https://open.spotify.com/track/db');
  });

  it('applies themeData.s and themeData.st when php is provided and getTheme returns data', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        spotifyLink: 'sp-link',
        youtubeLink: null,
        youtubeMusicLink: null,
        appleMusicLink: null,
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
    ]);
    deps.appTheme.getTheme.mockReturnValue({
      s: '#ff0000',
      n: 'My Theme',
      st: 'dark',
    });

    const result = await getLink(deps, 1, '1.2.3.4', true, undefined, 77);

    expect(result.success).toBe(true);
    expect(result.data?.t).toEqual({ s: '#ff0000', n: 'My Theme' });
    expect(result.data?.st).toBe('dark');
    expect(deps.appTheme.getTheme).toHaveBeenCalledWith(77);
  });

  it('does NOT apply theme when php is not provided', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        spotifyLink: 'sp-link',
        youtubeLink: null,
        youtubeMusicLink: null,
        appleMusicLink: null,
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
    ]);

    const result = await getLink(deps, 1, '1.2.3.4'); // no php

    expect(result.success).toBe(true);
    expect(result.data?.t).toBeUndefined();
    expect(result.data?.st).toBeUndefined();
    expect(deps.appTheme.getTheme).not.toHaveBeenCalled();
  });

  it('does not add t property when themeData has no s field', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        spotifyLink: 'sp-link',
        youtubeLink: null,
        youtubeMusicLink: null,
        appleMusicLink: null,
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
    ]);
    // getTheme returns data but without an 's' field
    deps.appTheme.getTheme.mockReturnValue({ st: 'dark' });

    const result = await getLink(deps, 1, '1.2.3.4', true, undefined, 50);

    expect(result.success).toBe(true);
    expect(result.data?.t).toBeUndefined(); // s was falsy, so t is not set
    expect(result.data?.st).toBe('dark');   // st is still applied
  });

  it('caches the DB result when spotifyLink is present', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.utils.lookupIp.mockResolvedValue({});
    deps.cache.executeCommand.mockResolvedValue(undefined);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        spotifyLink: 'sp-link',
        youtubeLink: null,
        youtubeMusicLink: null,
        appleMusicLink: null,
        amazonMusicLink: null,
        deezerLink: null,
        tidalLink: null,
      },
    ]);

    await getLink(deps, 42, '1.2.3.4', false);

    expect(deps.cache.set).toHaveBeenCalledWith(
      'track_links_v6:42',
      expect.any(String)
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getPlaylistLinkCoverage
// ══════════════════════════════════════════════════════════════════════════

describe('getPlaylistLinkCoverage', () => {
  it('returns parsed cached data when there is a cache hit', async () => {
    const deps = makeDeps();
    const cached = { spotify: 80, appleMusic: 60, youtubeMusic: 50, tidal: 30, deezer: 70, totalTracks: 10 };
    deps.cache.get.mockResolvedValue(JSON.stringify(cached));

    const result = await getPlaylistLinkCoverage(deps, 5);

    expect(result).toEqual(cached);
    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns all zeros when DB result is empty', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.prisma.$queryRaw.mockResolvedValue([]);
    deps.cache.set.mockResolvedValue(undefined);

    const result = await getPlaylistLinkCoverage(deps, 1);

    expect(result).toEqual({
      spotify: 0,
      appleMusic: 0,
      youtubeMusic: 0,
      tidal: 0,
      deezer: 0,
      totalTracks: 0,
    });
  });

  it('calculates correct percentages from bigint DB result', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        totalTracks: BigInt(10),
        spotifyCount: BigInt(8),
        appleMusicCount: BigInt(5),
        youtubeMusicCount: BigInt(3),
        tidalCount: BigInt(2),
        deezerCount: BigInt(7),
      },
    ]);

    const result = await getPlaylistLinkCoverage(deps, 2);

    expect(result.totalTracks).toBe(10);
    expect(result.spotify).toBe(80);      // 8/10 = 80%
    expect(result.appleMusic).toBe(50);   // 5/10 = 50%
    expect(result.youtubeMusic).toBe(30); // 3/10 = 30%
    expect(result.tidal).toBe(20);        // 2/10 = 20%
    expect(result.deezer).toBe(70);       // 7/10 = 70%
  });

  it('caches the result with TTL 3600', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        totalTracks: BigInt(4),
        spotifyCount: BigInt(4),
        appleMusicCount: BigInt(0),
        youtubeMusicCount: BigInt(0),
        tidalCount: BigInt(0),
        deezerCount: BigInt(0),
      },
    ]);

    await getPlaylistLinkCoverage(deps, 7);

    expect(deps.cache.set).toHaveBeenCalledWith(
      'playlist_link_coverage_v1:7',
      expect.any(String),
      3600
    );
  });

  it('handles zero totalTracks without division errors (returns 0 for all percentages)', async () => {
    const deps = makeDeps();
    deps.cache.get.mockResolvedValue(null);
    deps.cache.set.mockResolvedValue(undefined);
    deps.prisma.$queryRaw.mockResolvedValue([
      {
        totalTracks: BigInt(0),
        spotifyCount: BigInt(0),
        appleMusicCount: BigInt(0),
        youtubeMusicCount: BigInt(0),
        tidalCount: BigInt(0),
        deezerCount: BigInt(0),
      },
    ]);

    const result = await getPlaylistLinkCoverage(deps, 9);

    expect(result.spotify).toBe(0);
    expect(result.totalTracks).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getTracksWithoutMusicLinks
// ══════════════════════════════════════════════════════════════════════════

describe('getTracksWithoutMusicLinks', () => {
  it('returns tracks from the DB', async () => {
    const deps = makeDeps();
    const tracks = [
      { id: 1, name: 'Song A', artist: 'Artist A', spotifyLink: 'sp-link', musicFetchAttempts: 0 },
      { id: 2, name: 'Song B', artist: 'Artist B', spotifyLink: 'sp-link-2', musicFetchAttempts: 1 },
    ];
    deps.prisma.track.findMany.mockResolvedValue(tracks);

    const result = await getTracksWithoutMusicLinks(deps, 50);

    expect(result).toEqual(tracks);
    expect(deps.prisma.track.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );
  });

  it('uses default limit of 100 when limit is not specified', async () => {
    const deps = makeDeps();
    deps.prisma.track.findMany.mockResolvedValue([]);

    await getTracksWithoutMusicLinks(deps);

    expect(deps.prisma.track.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 })
    );
  });

  it('returns [] when the DB throws', async () => {
    const deps = makeDeps();
    deps.prisma.track.findMany.mockRejectedValue(new Error('db connection failed'));

    const result = await getTracksWithoutMusicLinks(deps);

    expect(result).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// updateTrackMusicLinks
// ══════════════════════════════════════════════════════════════════════════

describe('updateTrackMusicLinks', () => {
  it('calls prisma.track.update with the correct data including musicFetchLastAttempt and increment', async () => {
    const deps = makeDeps();
    deps.prisma.track.update.mockResolvedValue({});

    const links = {
      deezerLink: 'https://deezer.com/track/1',
      youtubeMusicLink: null,
      appleMusicLink: 'https://music.apple.com/song/1',
      amazonMusicLink: null,
      tidalLink: null,
    };

    await updateTrackMusicLinks(deps, 42, links);

    expect(deps.prisma.track.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        deezerLink: 'https://deezer.com/track/1',
        youtubeMusicLink: null,
        appleMusicLink: 'https://music.apple.com/song/1',
        amazonMusicLink: null,
        tidalLink: null,
        musicFetchLastAttempt: expect.any(Date),
        musicFetchAttempts: { increment: 1 },
      },
    });
  });

  it('returns {success:true} on successful update', async () => {
    const deps = makeDeps();
    deps.prisma.track.update.mockResolvedValue({});

    const result = await updateTrackMusicLinks(deps, 1, {});

    expect(result).toEqual({ success: true });
  });

  it('returns {success:false, error} on exception', async () => {
    const deps = makeDeps();
    deps.prisma.track.update.mockRejectedValue(new Error('constraint violation'));

    const result = await updateTrackMusicLinks(deps, 1, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe('constraint violation');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// findMissingServiceLinks
// ══════════════════════════════════════════════════════════════════════════

describe('findMissingServiceLinks', () => {
  beforeEach(() => {
    h.fakeFactoryClass.getInstance.mockReturnValue(h.fakeFactoryInstance);
    h.fakeFactoryInstance.getProvider.mockReturnValue(h.fakeProvider);
    h.fakeProvider.config = { supportsSearch: true, displayName: 'Deezer' };
    h.fakeProvider.searchTracks = vi.fn();
  });

  it('returns error for an invalid service name', async () => {
    const deps = makeDeps();

    const result = await findMissingServiceLinks(deps, 'invalid_service');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid service/);
    expect(result.total).toBe(0);
    expect(result.found).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns {total:0, found:0, results:[]} when no tracks are found', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([]);

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result).toEqual({ success: true, total: 0, found: 0, results: [] });
  });

  it('returns error when provider does not support search', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 1, artist: 'ABBA', name: 'Waterloo' },
    ]);
    h.fakeProvider.config = { supportsSearch: false, displayName: 'Tidal' };

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support search');
  });

  it('returns error when provider has no searchTracks method', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 1, artist: 'ABBA', name: 'Waterloo' },
    ]);
    h.fakeProvider.config = { supportsSearch: true, displayName: 'Tidal' };
    // Remove searchTracks to simulate provider not having the method
    const providerWithoutSearch = {
      config: { supportsSearch: true, displayName: 'Tidal' },
      // no searchTracks property
    };
    h.fakeFactoryInstance.getProvider.mockReturnValue(providerWithoutSearch);

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support search');
  });

  it('found match: updates DB with link and returns found=true in results', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 10, artist: 'ABBA', name: 'Waterloo' },
    ]);
    deps.prisma.track.update.mockResolvedValue({});
    h.fakeProvider.searchTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          {
            name: 'Waterloo',
            artist: 'ABBA',
            serviceLink: 'https://deezer.com/track/waterloo',
          },
        ],
      },
    });

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result.success).toBe(true);
    expect(result.found).toBe(1);
    expect(result.total).toBe(1);
    expect(result.results[0]).toEqual({
      trackId: 10,
      artist: 'ABBA',
      title: 'Waterloo',
      found: true,
      link: 'https://deezer.com/track/waterloo',
    });
    // DB update should include the link column and the checked column
    expect(deps.prisma.track.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: {
        deezerLink: 'https://deezer.com/track/waterloo',
        deezerCheckedBySearch: true,
      },
    });
  });

  it('no match: marks checked=true and returns found=false', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 20, artist: 'ABBA', name: 'Waterloo' },
    ]);
    deps.prisma.track.update.mockResolvedValue({});
    // Return tracks but none match exactly
    h.fakeProvider.searchTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          { name: 'Different Song', artist: 'Other Artist', serviceLink: 'https://deezer.com/track/other' },
        ],
      },
    });

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result.found).toBe(0);
    expect(result.results[0]).toEqual({
      trackId: 20,
      artist: 'ABBA',
      title: 'Waterloo',
      found: false,
    });
    expect(deps.prisma.track.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: { deezerCheckedBySearch: true },
    });
  });

  it('search API failure: marks checked=true and returns found=false', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 30, artist: 'ABBA', name: 'Waterloo' },
    ]);
    deps.prisma.track.update.mockResolvedValue({});
    // searchTracks returns success:false
    h.fakeProvider.searchTracks.mockResolvedValue({
      success: false,
      data: null,
    });

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result.found).toBe(0);
    expect(result.results[0].found).toBe(false);
    // Checked should be set to true even on search failure
    expect(deps.prisma.track.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: { deezerCheckedBySearch: true },
    });
  });

  it('search throws: catches error, marks checked and returns found=false', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 40, artist: 'ABBA', name: 'Waterloo' },
    ]);
    deps.prisma.track.update.mockResolvedValue({});
    h.fakeProvider.searchTracks.mockRejectedValue(new Error('Network timeout'));

    const result = await findMissingServiceLinks(deps, 'deezer');

    expect(result.found).toBe(0);
    expect(result.results[0].found).toBe(false);
    // The catch block calls track.update with catch(() => {}) so it may or may not succeed
    // but must not throw
    expect(result.success).toBe(true);
  });

  it('correctly uses the column names for a different service (apple)', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRawUnsafe.mockResolvedValue([
      { id: 50, artist: 'ABBA', name: 'Waterloo' },
    ]);
    deps.prisma.track.update.mockResolvedValue({});
    h.fakeProvider.searchTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          { name: 'Waterloo', artist: 'ABBA', serviceLink: 'https://music.apple.com/song/waterloo' },
        ],
      },
    });

    const result = await findMissingServiceLinks(deps, 'apple');

    expect(result.success).toBe(true);
    expect(result.found).toBe(1);
    expect(deps.prisma.track.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: {
        appleMusicLink: 'https://music.apple.com/song/waterloo',
        appleCheckedBySearch: true,
      },
    });
    // The $queryRawUnsafe should use the correct column names
    const rawCall = deps.prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(rawCall).toContain('appleMusicLink');
    expect(rawCall).toContain('appleCheckedBySearch');
  });
});
