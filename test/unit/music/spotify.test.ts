import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the Spotify orchestrator (src/spotify.ts).
 *
 * Everything that does I/O at construction time is mocked at module level
 * BEFORE the import of src/spotify (instance-member initializers run in the
 * constructor): cache, prisma, analytics, data, translation, logger, all
 * Spotify API/scraper clients, the rate-limit manager, track enrichment and
 * the (dynamically imported) external card service. axios is mocked too.
 */

const holder = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  const cacheSets: { key: string; ttl?: number }[] = [];
  return {
    cacheStore,
    cacheSets,
    acquireLock: vi.fn(async (_key: string, _ttl?: number) => true),
    releaseLock: vi.fn(async (_key: string) => undefined),
    delPattern: vi.fn(async (_pattern: string) => undefined),

    prisma: {
      playlist: { findFirst: vi.fn() },
      trackExtraInfo: { findMany: vi.fn(async () => [] as any[]) },
      track: { findFirst: vi.fn(async () => null as any) },
    },

    spotifyApi: {
      getPlaylist: vi.fn(),
      getTracks: vi.fn(),
      getTracksByIds: vi.fn(),
      searchTracks: vi.fn(),
      createOrUpdatePlaylist: vi.fn(async () => ({ success: true })),
      deletePlaylist: vi.fn(async () => ({ success: true })),
      getTokensFromAuthCode: vi.fn(async () => 'token-123'),
      getAuthorizationUrl: vi.fn(() => 'https://auth.example'),
    },
    spotifyApi2: {
      getPlaylist: vi.fn(),
      getTracks: vi.fn(),
      getTracksByIds: vi.fn(),
      searchTracks: vi.fn(),
    },
    scraper: {
      getPlaylist: vi.fn(),
      getTracks: vi.fn(),
      searchTracks: vi.fn(),
    },
    graphqlScraper: {
      getPlaylist: vi.fn(),
      getTracks: vi.fn(),
      searchTracks: vi.fn(),
    },

    // Default behavior mirrors the real manager's happy path: call the
    // selected api's method with the given args.
    executeWithFallback: vi.fn(
      async (method: string, args: any[], api: any, _fallback: any) =>
        api[method](...args)
    ),
    getRateLimitStatus: vi.fn(async () => ({
      spotifyApi: { limited: false },
      spotifyScraper: { limited: false },
    })),

    enrichTrack: vi.fn((): any => undefined),

    externalCardService: {
      getCardByJumboKey: vi.fn(async () => null as any),
      getCardByCountryKey: vi.fn(async () => null as any),
      getCardByMusicMatchKey: vi.fn(async () => null as any),
    },

    increaseCounter: vi.fn(),
  };
});

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => holder.cacheStore.get(key) ?? null,
      set: async (key: string, value: string, ttl?: number) => {
        holder.cacheStore.set(key, value);
        holder.cacheSets.push({ key, ttl });
      },
      acquireLock: (key: string, ttl?: number) => holder.acquireLock(key, ttl),
      releaseLock: (key: string) => holder.releaseLock(key),
      delPattern: (pattern: string) => holder.delPattern(pattern),
    }),
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => holder.prisma },
}));

vi.mock('../../../src/data', () => ({
  default: { getInstance: () => ({}) },
}));

vi.mock('../../../src/analytics', () => ({
  default: { getInstance: () => ({ increaseCounter: holder.increaseCounter }) },
}));

vi.mock('../../../src/utils', () => ({
  default: class Utils {
    isMainServer = async () => false;
    replaceBrandTerms = (s: any) => s;
    cleanTrackName = (s: string) => s;
  },
}));

vi.mock('../../../src/translation', () => ({
  default: class Translation {
    allLocales = ['en', 'nl'];
    isValidLocale = (l: string) => ['en', 'nl'].includes(l);
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class Logger {
    log() {}
  },
}));

vi.mock('../../../src/spotify_api', () => ({
  default: function () {
    return holder.spotifyApi;
  },
}));
vi.mock('../../../src/spotify_api2', () => ({
  default: function () {
    return holder.spotifyApi2;
  },
}));
vi.mock('../../../src/spotify_rapidapi', () => ({
  default: class {},
}));
vi.mock('../../../src/spotify_rapidapi2', () => ({
  default: class {},
}));
vi.mock('../../../src/spotify_scraper', () => ({
  default: function () {
    return holder.scraper;
  },
}));
vi.mock('../../../src/spotify_graphql_scraper', () => ({
  default: function () {
    return holder.graphqlScraper;
  },
}));

vi.mock('../../../src/rate_limit_manager', () => ({
  default: {
    getInstance: () => ({
      executeWithFallback: holder.executeWithFallback,
      getRateLimitStatus: holder.getRateLimitStatus,
    }),
  },
}));

vi.mock('../../../src/trackEnrichment', () => ({
  default: { getInstance: () => ({ enrichTrack: holder.enrichTrack }) },
}));

vi.mock('../../../src/externalCardService', () => ({
  default: { getInstance: () => holder.externalCardService },
}));

vi.mock('axios');
import axios from 'axios';
import Spotify, {
  CACHE_KEY_PLAYLIST,
  CACHE_KEY_TRACKS,
} from '../../../src/spotify';

const axiosGet = vi.mocked(axios.get);
const spotify = Spotify.getInstance();

function resetAll() {
  holder.cacheStore.clear();
  holder.cacheSets.length = 0;
  holder.acquireLock.mockClear();
  holder.acquireLock.mockImplementation(async () => true);
  holder.releaseLock.mockClear();
  holder.delPattern.mockClear();
  holder.prisma.playlist.findFirst.mockReset();
  holder.prisma.trackExtraInfo.findMany.mockReset();
  holder.prisma.trackExtraInfo.findMany.mockResolvedValue([]);
  holder.prisma.track.findFirst.mockReset();
  holder.prisma.track.findFirst.mockResolvedValue(null);
  for (const api of [
    holder.spotifyApi,
    holder.spotifyApi2,
    holder.scraper,
    holder.graphqlScraper,
  ]) {
    for (const fn of Object.values(api)) (fn as any).mockClear?.();
  }
  holder.spotifyApi.getPlaylist.mockReset();
  holder.spotifyApi.getTracks.mockReset();
  holder.spotifyApi.getTracksByIds.mockReset();
  holder.spotifyApi.searchTracks.mockReset();
  holder.executeWithFallback.mockClear();
  holder.executeWithFallback.mockImplementation(
    async (method: string, args: any[], api: any) => api[method](...args)
  );
  holder.enrichTrack.mockReset();
  holder.enrichTrack.mockReturnValue(undefined);
  holder.externalCardService.getCardByJumboKey.mockReset();
  holder.externalCardService.getCardByJumboKey.mockResolvedValue(null);
  holder.externalCardService.getCardByCountryKey.mockReset();
  holder.externalCardService.getCardByCountryKey.mockResolvedValue(null);
  holder.externalCardService.getCardByMusicMatchKey.mockReset();
  holder.externalCardService.getCardByMusicMatchKey.mockResolvedValue(null);
  axiosGet.mockReset();
}

beforeEach(resetAll);

// ---------------------------------------------------------------------------
// getPlaylist
// ---------------------------------------------------------------------------

describe('Spotify.getPlaylist', () => {
  const apiPlaylist = {
    success: true,
    data: {
      name: 'Road Trip (AIID: a34n234n)',
      description: 'A spotify description',
      images: [{ url: 'https://img/cover.jpg' }],
      tracks: { total: 42 },
    },
  };

  it('fetches via the v1 api by default, strips the AIID suffix and caches for 24h', async () => {
    holder.spotifyApi.getPlaylist.mockResolvedValueOnce(apiPlaylist);

    const res = await spotify.getPlaylist('pl1', true, '', false);

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      id: 'pl1',
      playlistId: 'pl1',
      name: 'Road Trip',
      description: 'A spotify description',
      numberOfTracks: 42,
      image: 'https://img/cover.jpg',
    });
    expect(holder.executeWithFallback).toHaveBeenCalledWith(
      'getPlaylist',
      ['pl1'],
      holder.spotifyApi,
      holder.graphqlScraper
    );
    // non-featured playlists are cached for 24 hours
    const set = holder.cacheSets.find(
      (s) => s.key === `${CACHE_KEY_PLAYLIST}pl1`
    );
    expect(set?.ttl).toBe(86400);
    expect(holder.releaseLock).toHaveBeenCalled();
  });

  it('serves a cached playlist without touching any provider', async () => {
    holder.cacheStore.set(
      `${CACHE_KEY_PLAYLIST}plCached`,
      JSON.stringify({
        id: 'plCached',
        playlistId: 'plCached',
        name: 'Cached',
        description: 'def',
        descriptions: { nl: 'NL desc' },
        numberOfTracks: 7,
        image: 'img',
      })
    );

    const res = await spotify.getPlaylist(
      'plCached',
      true,
      '',
      false,
      false,
      false,
      'nl'
    );

    expect(res.success).toBe(true);
    expect(res.data.name).toBe('Cached');
    // locale-specific description wins over the default one
    expect(res.data.description).toBe('NL desc');
    expect(holder.executeWithFallback).not.toHaveBeenCalled();
    expect(holder.acquireLock).not.toHaveBeenCalled();
  });

  it('falls back to the default description for an unknown locale', async () => {
    holder.cacheStore.set(
      `${CACHE_KEY_PLAYLIST}plCached`,
      JSON.stringify({
        id: 'plCached',
        playlistId: 'plCached',
        name: 'Cached',
        description: 'default desc',
        descriptions: { nl: 'NL desc' },
        numberOfTracks: 7,
        image: 'img',
      })
    );
    // 'xx' is not a valid locale → coerced to 'en' → no en description → default
    const res = await spotify.getPlaylist(
      'plCached', true, '', false, false, false, 'xx'
    );
    expect(res.data.description).toBe('default desc');
  });

  it('returns a cached error immediately', async () => {
    holder.cacheStore.set(
      `${CACHE_KEY_PLAYLIST}plBad`,
      JSON.stringify({ error: 'playlistNotFound' })
    );
    const res = await spotify.getPlaylist('plBad', true, '', false);
    expect(res).toEqual({ success: false, error: 'playlistNotFound' });
  });

  it('uses the v2 api when the redis toggle says v2', async () => {
    holder.cacheStore.set('spotify_playlist_provider', 'v2');
    holder.spotifyApi2.getPlaylist.mockResolvedValueOnce(apiPlaylist);

    const res = await spotify.getPlaylist('plV2', true, '', false);

    expect(res.success).toBe(true);
    expect(holder.executeWithFallback).toHaveBeenCalledWith(
      'getPlaylist',
      ['plV2'],
      holder.spotifyApi2,
      holder.graphqlScraper
    );
    expect(holder.spotifyApi.getPlaylist).not.toHaveBeenCalled();
  });

  it('calls the graphql scraper directly (no rate-limit manager) when toggled', async () => {
    holder.cacheStore.set('spotify_playlist_provider', 'graphql');
    holder.graphqlScraper.getPlaylist.mockResolvedValueOnce(apiPlaylist);

    const res = await spotify.getPlaylist('plG', true, '', false);

    expect(res.success).toBe(true);
    expect(holder.graphqlScraper.getPlaylist).toHaveBeenCalledWith('plG');
    expect(holder.executeWithFallback).not.toHaveBeenCalled();
  });

  it('maps "Spotify resource not found" to playlistNotFound and does not cache it for non-featured playlists', async () => {
    holder.spotifyApi.getPlaylist.mockResolvedValueOnce({
      success: false,
      error: 'Spotify resource not found',
    });

    const res = await spotify.getPlaylist('plMissing', true, '', false);

    expect(res).toEqual({ success: false, error: 'playlistNotFound' });
    // 404s for non-featured playlists are deliberately not cached (the
    // playlist may become public later)
    expect(holder.cacheStore.has(`${CACHE_KEY_PLAYLIST}plMissing`)).toBe(false);
    expect(holder.releaseLock).toHaveBeenCalled();
  });

  it('propagates needsReAuth without caching the failure', async () => {
    holder.spotifyApi.getPlaylist.mockResolvedValueOnce({
      success: false,
      error: 'token expired',
      needsReAuth: true,
    });

    const res = await spotify.getPlaylist('plAuth', true, '', false);

    expect(res).toEqual({
      success: false,
      error: 'token expired',
      needsReAuth: true,
    });
    expect(holder.cacheStore.has(`${CACHE_KEY_PLAYLIST}plAuth`)).toBe(false);
  });

  it('caches generic provider failures for 60 seconds', async () => {
    holder.spotifyApi.getPlaylist.mockResolvedValueOnce({
      success: false,
      error: 'boom',
    });

    const res = await spotify.getPlaylist('plErr', true, '', false);

    expect(res).toEqual({ success: false, error: 'boom' });
    const set = holder.cacheSets.find(
      (s) => s.key === `${CACHE_KEY_PLAYLIST}plErr`
    );
    expect(set?.ttl).toBe(60);
    expect(JSON.parse(holder.cacheStore.get(`${CACHE_KEY_PLAYLIST}plErr`)!)).toMatchObject(
      { error: 'boom' }
    );
  });

  it('resolves featured slugs via the database and caches under both keys forever', async () => {
    holder.prisma.playlist.findFirst.mockImplementation(async (args: any) => {
      if (args.select) {
        return {
          name: 'DB Name',
          design: { layout: 'x' },
          customImage: 'custom.png',
          description_en: 'EN desc',
          description_nl: 'NL desc',
          decadePercentage1980: 25,
        };
      }
      return { playlistId: 'REAL1' };
    });
    holder.spotifyApi.getPlaylist.mockResolvedValueOnce(apiPlaylist);

    const res = await spotify.getPlaylist(
      'my-slug',
      true,
      '',
      false,
      true, // featured
      true, // isSlug
      'nl'
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      id: 'my-slug',
      playlistId: 'REAL1',
      name: 'DB Name',
      description: 'NL desc',
      customImage: 'custom.png',
      decadePercentage1980: 25,
    });
    // provider was asked for the real playlist id, not the slug
    expect(holder.executeWithFallback).toHaveBeenCalledWith(
      'getPlaylist',
      ['REAL1'],
      holder.spotifyApi,
      holder.graphqlScraper
    );
    // cached under slug AND real id, both without TTL (featured = forever)
    const slugSet = holder.cacheSets.find(
      (s) => s.key === `${CACHE_KEY_PLAYLIST}my-slug`
    );
    const realSet = holder.cacheSets.find(
      (s) => s.key === `${CACHE_KEY_PLAYLIST}REAL1`
    );
    expect(slugSet?.ttl).toBeUndefined();
    expect(realSet?.ttl).toBeUndefined();
  });

  it('returns playlistNotFound for an unknown featured slug and caches the failure briefly', async () => {
    holder.prisma.playlist.findFirst.mockResolvedValue(null);

    const res = await spotify.getPlaylist(
      'nope-slug', true, '', false, true, true
    );

    expect(res).toEqual({ success: false, error: 'playlistNotFound' });
    const set = holder.cacheSets.find(
      (s) => s.key === `${CACHE_KEY_PLAYLIST}nope-slug`
    );
    expect(set?.ttl).toBe(60);
    expect(holder.spotifyApi.getPlaylist).not.toHaveBeenCalled();
  });

  it('waits for a concurrent fetch when the lock is taken and serves the cache filled by the lock holder', async () => {
    holder.acquireLock.mockImplementation(async () => {
      // Simulate the concurrent worker finishing while we poll
      holder.cacheStore.set(
        `${CACHE_KEY_PLAYLIST}plLocked`,
        JSON.stringify({
          id: 'plLocked',
          playlistId: 'plLocked',
          name: 'From other worker',
          description: 'd',
          numberOfTracks: 3,
          image: 'i',
        })
      );
      return false;
    });

    const res = await spotify.getPlaylist('plLocked', true, '', false);

    expect(res.success).toBe(true);
    expect(res.data.name).toBe('From other worker');
    expect(holder.spotifyApi.getPlaylist).not.toHaveBeenCalled();
    expect(holder.releaseLock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getTracks
// ---------------------------------------------------------------------------

function seedPlaylistCache(id: string, total: number) {
  holder.cacheStore.set(
    `${CACHE_KEY_PLAYLIST}${id}`,
    JSON.stringify({
      id,
      playlistId: id,
      name: 'Seeded',
      description: 'd',
      numberOfTracks: total,
      image: 'img',
    })
  );
}

function makeItem(
  id: string,
  name: string,
  artist: string,
  extra: Record<string, any> = {}
) {
  return {
    track: {
      id,
      name,
      artists: [{ name: artist }],
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
      external_ids: { isrc: `ISRC-${id}` },
      preview_url: `https://p.scdn.co/${id}`,
      album: {
        name: 'The Album',
        images: [{ url: 'big.jpg' }, { url: 'mid.jpg' }],
        release_date: '1999-05-01',
      },
      ...extra,
    },
  };
}

describe('Spotify.getTracks', () => {
  it('formats tracks, classifies skipped items and caches the result', async () => {
    seedPlaylistCache('PL1', 6);
    holder.prisma.playlist.findFirst.mockResolvedValue({ id: 11 });
    holder.spotifyApi.getTracks.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          makeItem('t1', 'Song A', 'Artist A'),
          null, // unavailable
          { track: null, is_local: true }, // local file
          {
            track: {
              id: 'pod1',
              name: 'Podcast Ep',
              artists: [{ name: 'Host' }],
              external_urls: { spotify: 'https://open.spotify.com/episode/x' },
              album: { images: [{ url: 'i.jpg' }] },
            },
          },
          {
            track: {
              id: 'noimg',
              name: 'No Image',
              artists: [{ name: 'X' }],
              external_urls: { spotify: 'https://open.spotify.com/track/noimg' },
              album: { images: [] },
            },
          },
          makeItem('t6', 'song a ', ' ARTIST A'), // artist+title duplicate of #1
        ],
      },
    });

    const res = await spotify.getTracks('PL1', true, '', false);

    expect(res.success).toBe(true);
    expect(res.data.totalTracks).toBe(1);
    expect(res.data.tracks).toHaveLength(1);
    expect(res.data.tracks[0]).toMatchObject({
      id: 't1',
      name: 'Song A',
      artist: 'Artist A',
      album: 'The Album',
      isrc: 'ISRC-t1',
      image: 'mid.jpg', // second image is preferred when available
      releaseDate: '1999-05-01',
      link: 'https://open.spotify.com/track/t1',
    });
    expect(res.data.supportsYearData).toBe(true);
    expect(res.data.maxReached).toBe(false);
    expect(res.data.maxReachedPhysical).toBe(false);

    expect(res.data.skippedTracks.total).toBe(5);
    expect(res.data.skippedTracks.summary).toEqual({
      unavailable: 2,
      localFiles: 1,
      podcasts: 1,
      duplicates: 1,
    });
    const dup = res.data.skippedTracks.details.find(
      (d: any) => d.reason === 'duplicate'
    );
    expect(dup).toMatchObject({ position: 6, duplicateOf: 1 });

    // old cache entries are purged and the new result cached for 24h
    expect(holder.delPattern).toHaveBeenCalledWith(`${CACHE_KEY_TRACKS}PL1*`);
    const set = holder.cacheSets.find(
      (s) => s.key === `${CACHE_KEY_TRACKS}PL1_6`
    );
    expect(set?.ttl).toBe(86400);
  });

  it('applies enrichment data and playlist-specific overrides', async () => {
    seedPlaylistCache('PL2', 1);
    holder.prisma.playlist.findFirst.mockResolvedValue({ id: 22 });
    holder.enrichTrack.mockReturnValue({
      year: 1988,
      name: 'Enriched Name',
      artist: 'Enriched Artist',
    });
    holder.prisma.trackExtraInfo.findMany.mockResolvedValue([
      {
        track: { trackId: 't1' },
        name: null,
        artist: null,
        year: 2001, // override wins over enrichment year
        extraNameAttribute: 'live',
        extraArtistAttribute: null,
      },
    ]);
    holder.spotifyApi.getTracks.mockResolvedValueOnce({
      success: true,
      data: { items: [makeItem('t1', 'Spotify Name', 'Spotify Artist')] },
    });

    const res = await spotify.getTracks('PL2', true, '', false);

    expect(holder.enrichTrack).toHaveBeenCalledWith({
      id: 't1',
      isrc: 'ISRC-t1',
      name: 'Spotify Name',
      artist: 'Spotify Artist',
    });
    expect(res.data.tracks[0]).toMatchObject({
      name: 'Enriched Name',
      artist: 'Enriched Artist',
      trueYear: 2001,
      extraNameAttribute: 'live',
    });
  });

  it('joins up to three artists with commas and an ampersand', async () => {
    seedPlaylistCache('PL3', 1);
    holder.prisma.playlist.findFirst.mockResolvedValue(null);
    holder.spotifyApi.getTracks.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          makeItem('t1', 'Collab', 'ignored', {
            artists: [
              { name: 'One' },
              { name: 'Two' },
              { name: 'Three' },
              { name: 'Four' },
            ],
          }),
        ],
      },
    });

    const res = await spotify.getTracks('PL3', true, '', false);
    expect(res.data.tracks[0].artist).toBe('One, Two & Three');
  });

  it('returns the cached result without calling any provider', async () => {
    seedPlaylistCache('PL4', 2);
    holder.cacheStore.set(
      `${CACHE_KEY_TRACKS}PL4_2`,
      JSON.stringify({ success: true, data: { totalTracks: 2, tracks: [] } })
    );

    const res = await spotify.getTracks('PL4', true, '', false);

    expect(res).toEqual({ success: true, data: { totalTracks: 2, tracks: [] } });
    expect(holder.spotifyApi.getTracks).not.toHaveBeenCalled();
  });

  it('retries with spotify_api2 when v1 signals spotify_api2_switch', async () => {
    seedPlaylistCache('PL5', 1);
    holder.prisma.playlist.findFirst.mockResolvedValue(null);
    holder.spotifyApi.getTracks.mockResolvedValueOnce({
      success: false,
      error: 'spotify_api2_switch',
    });
    holder.spotifyApi2.getTracks.mockResolvedValueOnce({
      success: true,
      data: { items: [makeItem('t9', 'Nine', 'Niner')] },
    });

    const res = await spotify.getTracks('PL5', true, '', false);

    expect(holder.spotifyApi2.getTracks).toHaveBeenCalledWith(
      'PL5',
      undefined
    );
    expect(res.success).toBe(true);
    expect(res.data.tracks[0].id).toBe('t9');
  });

  it('propagates needsReAuth from the tracks provider', async () => {
    seedPlaylistCache('PL6', 1);
    holder.spotifyApi.getTracks.mockResolvedValueOnce({
      success: false,
      error: 'expired',
      needsReAuth: true,
    });

    const res = await spotify.getTracks('PL6', true, '', false);
    expect(res).toEqual({
      success: false,
      error: 'expired',
      needsReAuth: true,
    });
  });

  it('uses the scraper when toggled and flags that year data is unsupported', async () => {
    seedPlaylistCache('PL7', 1);
    holder.cacheStore.set('spotify_tracks_provider', 'scraper');
    holder.prisma.playlist.findFirst.mockResolvedValue(null);
    holder.scraper.getTracks.mockResolvedValueOnce({
      success: true,
      data: { items: [makeItem('t1', 'A', 'B')] },
    });

    const res = await spotify.getTracks('PL7', true, '', false);

    expect(holder.scraper.getTracks).toHaveBeenCalledWith('PL7', undefined);
    expect(holder.executeWithFallback).not.toHaveBeenCalled();
    expect(res.data.supportsYearData).toBe(false);
  });

  it('fails when the underlying playlist lookup fails', async () => {
    holder.spotifyApi.getPlaylist.mockResolvedValueOnce({
      success: false,
      error: 'Spotify resource not found',
    });
    const res = await spotify.getTracks('PLmissing', true, '', false);
    expect(res).toEqual({ success: false, error: 'playlistNotFound' });
    expect(holder.spotifyApi.getTracks).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getTracksByIds
// ---------------------------------------------------------------------------

describe('Spotify.getTracksByIds', () => {
  it('rejects an empty id list', async () => {
    const res = await spotify.getTracksByIds([]);
    expect(res).toEqual({ success: false, error: 'No track IDs provided' });
  });

  it('formats tracks and filters out null/incomplete entries', async () => {
    holder.spotifyApi.getTracksByIds.mockResolvedValueOnce({
      success: true,
      data: {
        tracks: [
          {
            id: 'a1',
            name: 'Alpha',
            artists: [{ name: 'Artist' }],
            album: {
              name: 'Alb',
              images: [{ url: 'img1' }],
              release_date: '2001-01-01',
            },
            preview_url: 'pv',
            external_urls: { spotify: 'link' },
            external_ids: { isrc: 'QQ123' },
          },
          null, // dropped
          { id: 'a2', name: '', artists: [{ name: 'X' }] }, // empty name dropped
        ],
      },
    });

    const res = await spotify.getTracksByIds(['a1', 'a2']);

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({
      id: 'a1',
      trackId: 'a1',
      name: 'Alpha',
      artist: 'Artist',
      album: 'Alb',
      image: 'img1',
      isrc: 'QQ123',
      releaseDate: '2001-01-01',
    });
  });

  it('serves repeat lookups from cache regardless of id order', async () => {
    holder.spotifyApi.getTracksByIds.mockResolvedValue({
      success: true,
      data: { tracks: [] },
    });

    await spotify.getTracksByIds(['b2', 'a1']);
    const res = await spotify.getTracksByIds(['a1', 'b2']);

    expect(res.success).toBe(true);
    expect(holder.executeWithFallback).toHaveBeenCalledTimes(1);
  });

  it('propagates provider failure', async () => {
    holder.spotifyApi.getTracksByIds.mockResolvedValueOnce({
      success: false,
      error: 'nope',
      needsReAuth: true,
    });
    const res = await spotify.getTracksByIds(['z1']);
    expect(res).toEqual({ success: false, error: 'nope', needsReAuth: true });
  });
});

// ---------------------------------------------------------------------------
// searchTracks
// ---------------------------------------------------------------------------

describe('Spotify.searchTracks', () => {
  it('rejects search terms shorter than two characters', async () => {
    expect(await spotify.searchTracks('a')).toEqual({
      success: false,
      error: 'Search term too short',
    });
    expect(await spotify.searchTracks('')).toEqual({
      success: false,
      error: 'Search term too short',
    });
  });

  it('maps results, computes hasMore and caches for an hour', async () => {
    holder.spotifyApi.searchTracks.mockResolvedValueOnce({
      success: true,
      data: {
        tracks: {
          total: 25,
          items: [
            {
              id: 's1',
              name: 'Hit',
              artists: [{ name: 'Star' }],
              album: { images: [{ url: 'cover' }] },
            },
            { id: null, name: 'dropped' },
            { id: 's3', name: '', artists: [{ name: 'NoName' }] },
          ],
        },
      },
    });

    const res = await spotify.searchTracks('hit', 10, 0);

    expect(holder.executeWithFallback).toHaveBeenCalledWith(
      'searchTracks',
      ['hit', 10, 0],
      holder.spotifyApi,
      holder.graphqlScraper
    );
    expect(res.success).toBe(true);
    expect(res.data.tracks).toEqual([
      { id: 's1', trackId: 's1', name: 'Hit', artist: 'Star', image: 'cover' },
    ]);
    expect(res.data).toMatchObject({
      totalCount: 25,
      offset: 0,
      limit: 10,
      hasMore: true,
    });
    const set = holder.cacheSets.find((s) => s.key === 'search_hit_10_0');
    expect(set?.ttl).toBe(3600);

    // second identical search hits the cache
    const again = await spotify.searchTracks('hit', 10, 0);
    expect(again.data.totalCount).toBe(25);
    expect(holder.executeWithFallback).toHaveBeenCalledTimes(1);
  });

  it('reports hasMore=false on the last page', async () => {
    holder.spotifyApi.searchTracks.mockResolvedValueOnce({
      success: true,
      data: { tracks: { total: 12, items: [] } },
    });
    const res = await spotify.searchTracks('end', 10, 5);
    expect(res.data.hasMore).toBe(false); // 5 + 10 >= 12
  });

  it('passes through provider failures with retryAfter', async () => {
    holder.spotifyApi.searchTracks.mockResolvedValueOnce({
      success: false,
      error: 'rate limited',
      retryAfter: 30,
    });
    const res = await spotify.searchTracks('busy', 10, 0);
    expect(res).toMatchObject({
      success: false,
      error: 'rate limited',
      retryAfter: 30,
    });
  });

  it('uses the graphql scraper when toggled', async () => {
    holder.cacheStore.set('spotify_search_provider', 'graphql');
    holder.graphqlScraper.searchTracks.mockResolvedValueOnce({
      success: true,
      data: { tracks: { total: 0, items: [] } },
    });
    const res = await spotify.searchTracks('gq', 5, 0);
    expect(holder.graphqlScraper.searchTracks).toHaveBeenCalledWith('gq', 5, 0);
    expect(res.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPlaylistTrackCount + delegation methods
// ---------------------------------------------------------------------------

describe('Spotify.getPlaylistTrackCount', () => {
  it('returns the cached count as an integer', async () => {
    holder.cacheStore.set('trackcount_PLC', '42');
    expect(await spotify.getPlaylistTrackCount('PLC')).toBe(42);
  });

  it('throws when tracks cannot be fetched', async () => {
    holder.spotifyApi.getPlaylist.mockResolvedValue({
      success: false,
      error: 'down',
    });
    await expect(spotify.getPlaylistTrackCount('PLX')).rejects.toThrow(
      'Error getting playlist track count'
    );
  });
});

describe('Spotify delegation methods', () => {
  it('delegates createOrUpdatePlaylist/deletePlaylist/auth to the v1 api', async () => {
    await spotify.createOrUpdatePlaylist('My list', ['t1', 't2']);
    expect(holder.spotifyApi.createOrUpdatePlaylist).toHaveBeenCalledWith(
      'My list',
      ['t1', 't2']
    );

    await spotify.deletePlaylist('pl-del');
    expect(holder.spotifyApi.deletePlaylist).toHaveBeenCalledWith('pl-del');

    expect(await spotify.getTokensFromAuthCode('code1')).toBe('token-123');
    expect(holder.spotifyApi.getTokensFromAuthCode).toHaveBeenCalledWith(
      'code1'
    );

    expect(spotify.getAuthorizationUrl()).toBe('https://auth.example');
  });
});

// ---------------------------------------------------------------------------
// resolveSpotifyUrl
// ---------------------------------------------------------------------------

describe('Spotify.resolveSpotifyUrl', () => {
  const savedHitifyKey = process.env['HITIFY_API_KEY'];

  afterEach(() => {
    if (savedHitifyKey === undefined) delete process.env['HITIFY_API_KEY'];
    else process.env['HITIFY_API_KEY'] = savedHitifyKey;
  });

  it('refuses blacklisted domains without any network call', async () => {
    const res = await spotify.resolveSpotifyUrl('https://qrto.org/abc');
    expect(res).toMatchObject({ success: false, blacklisted: true });
    const sub = await spotify.resolveSpotifyUrl('https://sub.q.me-qr.com/x');
    expect(sub.blacklisted).toBe(true);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('extracts the URI from a direct Spotify track URL (protocol added when missing)', async () => {
    axiosGet.mockResolvedValue({ status: 200, headers: {}, data: '' });
    const res = await spotify.resolveSpotifyUrl(
      'open.spotify.com/intl-de/track/abc123?si=xyz'
    );
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:abc123',
      cached: false,
    });
  });

  it('serves the second resolution of the same URL from cache', async () => {
    axiosGet.mockResolvedValue({ status: 200, headers: {}, data: '' });
    await spotify.resolveSpotifyUrl('https://open.spotify.com/track/cacheme');
    axiosGet.mockClear();
    const res = await spotify.resolveSpotifyUrl(
      'https://open.spotify.com/track/cacheme'
    );
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:cacheme',
      cached: true,
    });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('follows HTTP redirects to a Spotify track', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://open.spotify.com/track/redir1' },
      data: '',
    });
    const res = await spotify.resolveSpotifyUrl('https://sho.rt/x1');
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:redir1',
    });
  });

  it('finds a Spotify URI in a meta-refresh tag', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '<html><meta http-equiv="refresh" content="0; url=https://open.spotify.com/track/meta1"></html>',
    });
    const res = await spotify.resolveSpotifyUrl('https://meta.example/p');
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:meta1',
    });
  });

  it('finds a Spotify URI in a JS location.href redirect', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '<script>location.href = "https://open.spotify.com/track/js1"</script>',
    });
    const res = await spotify.resolveSpotifyUrl('https://js.example/p');
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:js1',
    });
  });

  it('fails cleanly when nothing resolves and caches the failure', async () => {
    axiosGet.mockResolvedValue({
      status: 200,
      headers: {},
      data: '<html>nothing here</html>',
    });
    const res = await spotify.resolveSpotifyUrl('https://nothing.example/x');
    expect(res).toMatchObject({
      success: false,
      error: 'No Spotify URI found via redirects or page content.',
      cached: false,
    });
    const again = await spotify.resolveSpotifyUrl('https://nothing.example/x');
    expect(again.cached).toBe(true);
  });

  it('recognizes native music service links without resolving them', async () => {
    const res = await spotify.resolveSpotifyUrl(
      'https://www.deezer.com/track/12345'
    );
    expect(res).toMatchObject({
      success: true,
      links: { deezerLink: 'https://www.deezer.com/track/12345' },
    });
    expect((res as any).nativeLink).toEqual({
      service: 'deezer',
      trackId: '12345',
    });
    expect(axiosGet).not.toHaveBeenCalled();

    const yt = await spotify.resolveSpotifyUrl(
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ'
    );
    expect((yt as any).nativeLink).toEqual({
      service: 'youtube-music',
      trackId: 'dQw4w9WgXcQ',
    });

    const apple = await spotify.resolveSpotifyUrl(
      'https://music.apple.com/nl/song/never/1440857781'
    );
    expect((apple as any).nativeLink).toEqual({
      service: 'apple-music',
      trackId: '1440857781',
    });

    const tidal = await spotify.resolveSpotifyUrl(
      'https://tidal.com/browse/track/77777'
    );
    expect((tidal as any).nativeLink).toEqual({
      service: 'tidal',
      trackId: '77777',
    });
  });

  it('resolves a Hitster country-code card via the country lookup', async () => {
    holder.externalCardService.getCardByCountryKey.mockResolvedValueOnce({
      spotifyId: 'hitDE',
      spotifyLink: 'sl',
      appleMusicLink: 'am',
      tidalLink: 'tl',
      youtubeMusicLink: 'yl',
      deezerLink: 'dl',
      amazonMusicLink: 'azl',
    });

    const res = await spotify.resolveSpotifyUrl(
      'https://hitstergame.com/de/00075'
    );

    expect(holder.externalCardService.getCardByCountryKey).toHaveBeenCalledWith(
      'de',
      '00075'
    );
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:hitDE',
      links: { appleMusicLink: 'am', deezerLink: 'dl' },
    });
  });

  it('resolves a Hitster Jumbo SKU card via the jumbo lookup', async () => {
    holder.externalCardService.getCardByJumboKey.mockResolvedValueOnce({
      spotifyId: 'jumbo1',
    });
    const res = await spotify.resolveSpotifyUrl(
      'https://hitstergame.com/nl/aaaa0027/00153'
    );
    expect(holder.externalCardService.getCardByJumboKey).toHaveBeenCalledWith(
      'aaaa0027',
      '00153'
    );
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:jumbo1',
    });
  });

  it('reports a missing Hitster mapping as a failure', async () => {
    const res = await spotify.resolveSpotifyUrl(
      'https://hitstergame.com/de/99999'
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('No mapping found for country de');
  });

  it('resolves MusicMatch cards via the payment/track key', async () => {
    holder.externalCardService.getCardByMusicMatchKey.mockResolvedValueOnce({
      spotifyId: 'mm1',
      spotifyLink: 'https://open.spotify.com/track/mm1',
    });
    const res = await spotify.resolveSpotifyUrl(
      'https://api.musicmatchgame.com/123/456'
    );
    expect(
      holder.externalCardService.getCardByMusicMatchKey
    ).toHaveBeenCalledWith('123', '456');
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:mm1',
    });
  });

  it('fails Hitify resolution when no API key is configured', async () => {
    delete process.env['HITIFY_API_KEY'];
    const res = await spotify.resolveSpotifyUrl('https://hitify.app/p/CODE1');
    expect(res).toMatchObject({
      success: false,
      error: 'Hitify API key not configured',
    });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('resolves a Hitify card through the DB by ISRC, building the partner request correctly', async () => {
    process.env['HITIFY_API_KEY'] = 'secret-key';
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: { isrc: 'NLZ001', spotify_track_id: 'spX' },
    });
    holder.prisma.track.findFirst.mockResolvedValueOnce({
      trackId: 'dbTrack',
      spotifyLink: null,
      appleMusicLink: 'am',
      tidalLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      amazonMusicLink: null,
    });

    const res = await spotify.resolveSpotifyUrl('https://hitify.app/p/HX1');

    expect(axiosGet).toHaveBeenCalledWith(
      'https://hitify.app/api/partner/resolve/HX1',
      expect.objectContaining({
        headers: { 'X-API-Key': 'secret-key' },
      })
    );
    expect(holder.prisma.track.findFirst).toHaveBeenCalledWith({
      where: { isrc: 'NLZ001' },
    });
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:dbTrack',
      // spotifyLink falls back to a constructed open.spotify.com URL
      links: {
        spotifyLink: 'https://open.spotify.com/track/dbTrack',
        appleMusicLink: 'am',
      },
    });
  });

  it('falls back to the Hitify-provided Spotify id when the DB has no match', async () => {
    process.env['HITIFY_API_KEY'] = 'secret-key';
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: { isrc: 'NOPE1', spotify_track_id: 'directSp' },
    });
    holder.prisma.track.findFirst.mockResolvedValue(null);

    const res = await spotify.resolveSpotifyUrl('https://hitify.app/p/HX2');

    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:directSp',
      links: {
        spotifyLink: 'https://open.spotify.com/track/directSp',
        appleMusicLink: null,
      },
    });
  });

  it('falls back to an official Spotify ISRC search as a last resort', async () => {
    process.env['HITIFY_API_KEY'] = 'secret-key';
    axiosGet.mockResolvedValueOnce({
      status: 200,
      data: { isrc: 'LAST1' },
    });
    holder.prisma.track.findFirst.mockResolvedValue(null);
    holder.spotifyApi.searchTracks.mockResolvedValueOnce({
      success: true,
      data: { tracks: { items: [{ id: 'isrcHit' }] } },
    });

    const res = await spotify.resolveSpotifyUrl('https://hitify.app/p/HX3');

    // ISRC lookups deliberately go to the official v1 api, not the toggle
    expect(holder.spotifyApi.searchTracks).toHaveBeenCalledWith(
      'isrc:LAST1',
      1
    );
    expect(res).toMatchObject({
      success: true,
      spotifyUri: 'spotify:track:isrcHit',
    });
  });

  it('reports unknown Hitify cards (404) as failures', async () => {
    process.env['HITIFY_API_KEY'] = 'secret-key';
    axiosGet.mockResolvedValueOnce({ status: 404, data: {} });
    const res = await spotify.resolveSpotifyUrl('https://hitify.app/p/GONE');
    expect(res).toMatchObject({
      success: false,
      error: 'Unknown Hitify card: GONE',
    });
  });

  it('maps a 401 from the Hitify partner API to an invalid-key error', async () => {
    process.env['HITIFY_API_KEY'] = 'wrong';
    axiosGet.mockResolvedValueOnce({ status: 401, data: {} });
    const res = await spotify.resolveSpotifyUrl('https://hitify.app/p/AUTH');
    expect(res).toMatchObject({
      success: false,
      error: 'Invalid or missing Hitify API key',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveShortlink
// ---------------------------------------------------------------------------

describe('Spotify.resolveShortlink', () => {
  it('follows redirects until it reaches a Spotify playlist URL', async () => {
    axiosGet
      .mockResolvedValueOnce({
        status: 301,
        headers: { location: 'https://open.spotify.com/playlist/PL99' },
        data: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: '',
        request: {
          res: { responseUrl: 'https://open.spotify.com/playlist/PL99' },
        },
      });

    const res = await spotify.resolveShortlink('https://spotify.link/abc');
    expect(res).toEqual({
      success: true,
      url: 'https://open.spotify.com/playlist/PL99',
    });
    expect(axiosGet).toHaveBeenCalledTimes(2);
    // redirects are followed manually
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0 });
    expect(axiosGet.mock.calls[1][0]).toBe(
      'https://open.spotify.com/playlist/PL99'
    );
  });

  it('extracts the most frequent playlist URL from HTML when no redirect lands on one', async () => {
    const html = `
      <a href="https://open.spotify.com/playlist/AAA?si=1">one</a>
      <a href="https://open.spotify.com/playlist/AAA?si=2">two</a>
      <a href="https://open.spotify.com/playlist/BBB">other</a>
    `;
    axiosGet.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: html,
      request: { res: {} },
    });

    const res = await spotify.resolveShortlink('https://spotify.link/html');
    expect(res).toEqual({
      success: true,
      url: 'https://open.spotify.com/playlist/AAA',
    });
  });

  it('fails when no playlist URL can be found', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '<html>no links</html>',
      request: { res: {} },
    });
    const res = await spotify.resolveShortlink('https://spotify.link/none');
    expect(res).toEqual({
      success: false,
      error: 'URL did not resolve to a Spotify playlist',
    });
  });

  it('surfaces network errors as a failure result', async () => {
    axiosGet.mockRejectedValueOnce(new Error('ECONNRESET'));
    const res = await spotify.resolveShortlink('https://spotify.link/err');
    expect(res).toEqual({ success: false, error: 'ECONNRESET' });
  });
});
