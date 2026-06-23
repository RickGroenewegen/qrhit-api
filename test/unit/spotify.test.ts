/**
 * Unit tests for src/spotify.ts (Spotify class).
 *
 * Covers the untested branches identified by the coverage report:
 *  - matchCardService (URL pattern detection for MusicMatch/Hitster/Hitify)
 *  - resolveSpotifyUrl (blacklist, cache, card service dispatch, native links)
 *  - formatEnrichedTrack (field selection, null guards)
 *  - searchTracks (short-term error handling)
 *  - getTracksByIds (empty input guard, cache hit)
 *  - getPlaylist (cached error replay, blacklist)
 *
 * All I/O mocked:
 *  - src/cache     → in-memory map
 *  - src/prisma    → in-memory stubs
 *  - src/data      → no-op
 *  - src/analytics → no-op
 *  - src/translation → valid locale check
 *  - src/utils     → cleanTrackName / replaceBrandTerms pass-through
 *  - src/spotify_api / src/spotify_api2 / scrapers → vi.fn stubs
 *  - src/trackEnrichment → no enrichment by default
 *  - src/rate_limit_manager → pass-through
 *  - src/rateLimitManager → pass-through
 *  - axios         → blocked (use cache mocks so no real requests are made)
 *  - cluster       → isPrimary=false
 *
 * No network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Cluster (suppress primary-worker side-effects) ────────────────────────
vi.mock('cluster', () => ({ default: { isPrimary: false }, isPrimary: false }));

// ─── cron (no-op) ──────────────────────────────────────────────────────────
vi.mock('cron', () => ({
  CronJob: class {
    constructor() {}
    start() {}
  },
}));

// ─── Cache (in-memory) ─────────────────────────────────────────────────────
const cacheStore = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => { cacheStore.set(key, value); },
      del: async (key: string) => { cacheStore.delete(key); },
      delPattern: async () => {},
      acquireLock: async () => true,
      releaseLock: async () => {},
    }),
  },
}));

// ─── Prisma (in-memory) ────────────────────────────────────────────────────
const prismaMock = {
  playlist: {
    findFirst: vi.fn(async () => null),
  },
  trackExtraInfo: {
    findMany: vi.fn(async () => []),
  },
};
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

// ─── Data ─────────────────────────────────────────────────────────────────
vi.mock('../../src/data', () => ({
  default: { getInstance: () => ({}) },
}));

// ─── Analytics ────────────────────────────────────────────────────────────
vi.mock('../../src/analytics', () => ({
  default: { getInstance: () => ({ increaseCounter: vi.fn() }) },
}));

// ─── Translation ──────────────────────────────────────────────────────────
vi.mock('../../src/translation', () => ({
  default: class {
    isValidLocale = (l: string) => ['en', 'nl', 'de'].includes(l);
    allLocales = ['en', 'nl', 'de'];
  },
}));

// ─── Utils ────────────────────────────────────────────────────────────────
vi.mock('../../src/utils', () => ({
  default: class {
    isMainServer = vi.fn(async () => false);
    replaceBrandTerms = (s: string) => s || '';
    cleanTrackName = (s: string) => s || '';
  },
}));

// ─── SpotifyApi (stub with configurable results) ──────────────────────────
const spotifyApiGetPlaylistMock = vi.fn();
const spotifyApiGetTracksMock = vi.fn();
const spotifyApiGetTracksByIdsMock = vi.fn();
const spotifyApiSearchTracksMock = vi.fn();
vi.mock('../../src/spotify_api', () => ({
  default: class {
    getPlaylist = spotifyApiGetPlaylistMock;
    getTracks = spotifyApiGetTracksMock;
    getTracksByIds = spotifyApiGetTracksByIdsMock;
    searchTracks = spotifyApiSearchTracksMock;
    createOrUpdatePlaylist = vi.fn();
    deletePlaylist = vi.fn();
    getTokensFromAuthCode = vi.fn();
    getAuthorizationUrl = vi.fn(() => null);
  },
}));

vi.mock('../../src/spotify_api2', () => ({
  default: class {
    getPlaylist = vi.fn();
    getTracks = vi.fn();
    getTracksByIds = vi.fn();
    searchTracks = vi.fn();
  },
}));

vi.mock('../../src/spotify_rapidapi', () => ({
  default: class {
    getPlaylist = vi.fn();
    getTracks = vi.fn();
    searchTracks = vi.fn();
  },
}));

vi.mock('../../src/spotify_scraper', () => ({
  default: class {
    getPlaylist = vi.fn();
    getTracks = vi.fn();
    searchTracks = vi.fn();
  },
}));

vi.mock('../../src/spotify_graphql_scraper', () => ({
  default: class {
    getPlaylist = vi.fn();
    getTracks = vi.fn();
    searchTracks = vi.fn();
  },
}));

vi.mock('../../src/spotify_rapidapi2', () => ({
  default: class {
    getPlaylist = vi.fn();
    getTracks = vi.fn();
    searchTracks = vi.fn();
  },
}));

// ─── RateLimitManager (pass-through) ──────────────────────────────────────
const rateLimitManagerMock = {
  executeWithFallback: vi.fn(async (method: string, args: any[], api: any) => {
    return await api[method](...args);
  }),
  getRateLimitStatus: vi.fn(async () => ({
    spotifyApi: { limited: false },
    spotifyScraper: { limited: false },
  })),
};
vi.mock('../../src/rate_limit_manager', () => ({
  default: { getInstance: () => rateLimitManagerMock },
}));

// ─── TrackEnrichment (no enrichment) ──────────────────────────────────────
vi.mock('../../src/trackEnrichment', () => ({
  default: {
    getInstance: () => ({
      enrichTrack: vi.fn(() => undefined),
    }),
  },
}));

// ─── axios (blocked — no real network in these tests) ─────────────────────
const { axiosGetMock: spotifyAxiosGet } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(async () => { throw new Error('unmocked axios call'); }),
}));
vi.mock('axios', () => {
  const m: any = {
    get: spotifyAxiosGet,
    create: () => ({ get: spotifyAxiosGet }),
  };
  m.default = m;
  return m;
});

import Spotify from '../../src/spotify';

// ─── helpers ─────────────────────────────────────────────────────────────

/** Build a minimal Spotify track item as the API returns it */
function makeTrackItem(overrides: Partial<any> = {}) {
  return {
    track: {
      id: 'trackid123',
      name: 'Test Song',
      artists: [{ name: 'Test Artist' }],
      external_urls: { spotify: 'https://open.spotify.com/track/trackid123' },
      external_ids: { isrc: 'USXX12345678' },
      preview_url: null,
      album: {
        name: 'Test Album',
        release_date: '2000-01-01',
        images: [
          { url: 'https://i.scdn.co/image/small.jpg' },
          { url: 'https://i.scdn.co/image/medium.jpg' },
        ],
      },
      ...overrides.track,
    },
    is_local: false,
    ...overrides,
  };
}

function makePlaylistData(overrides: Partial<any> = {}) {
  return {
    id: 'playlist123',
    name: 'Test Playlist',
    description: 'A test playlist',
    images: [{ url: 'https://image.url/cover.jpg' }],
    tracks: { total: 10 },
    ...overrides,
  };
}

describe('Spotify.matchCardService (private)', () => {
  let spotify: Spotify;
  beforeEach(() => {
    (Spotify as any).instance = undefined;
    spotify = Spotify.getInstance();
  });

  it('detects MusicMatch Game URLs', () => {
    const result = (spotify as any).matchCardService(
      'https://api.musicmatchgame.com/1234/5678'
    );
    expect(result).toEqual({
      service: 'musicmatch',
      paymentHasPlaylistId: '1234',
      trackId: '5678',
    });
  });

  it('returns null for MusicMatch with non-numeric IDs', () => {
    const result = (spotify as any).matchCardService(
      'https://api.musicmatchgame.com/abc/def'
    );
    expect(result).toBeNull();
  });

  it('detects Hitster URLs (with locale)', () => {
    const result = (spotify as any).matchCardService(
      'https://hitstergame.com/nl/aaaa0027/00153'
    );
    expect(result).toEqual({
      service: 'hitster',
      setSku: 'aaaa0027',
      cardNumber: '00153',
    });
  });

  it('detects Hitster country-code URLs', () => {
    const result = (spotify as any).matchCardService(
      'https://hitstergame.com/de/00075'
    );
    expect(result).toMatchObject({ service: 'hitster' });
  });

  it('detects Hitify URLs', () => {
    const result = (spotify as any).matchCardService(
      'https://hitify.app/p/abc123'
    );
    expect(result).toEqual({ service: 'hitify', code: 'abc123' });
  });

  it('returns null for unrecognized URLs', () => {
    expect((spotify as any).matchCardService('https://example.com/track/xyz')).toBeNull();
    expect((spotify as any).matchCardService('https://open.spotify.com/playlist/abc')).toBeNull();
  });
});

describe('Spotify.resolveSpotifyUrl', () => {
  let spotify: Spotify;
  beforeEach(() => {
    cacheStore.clear();
    spotifyAxiosGet.mockReset();
    (Spotify as any).instance = undefined;
    spotify = Spotify.getInstance();
  });

  it('rejects blacklisted domains immediately', async () => {
    const result = await spotify.resolveSpotifyUrl('https://q.me-qr.com/some-qr');
    expect(result.success).toBe(false);
    expect(result.blacklisted).toBe(true);
    expect(spotifyAxiosGet).not.toHaveBeenCalled();
  });

  it('serves cached result on second call (cached=true)', async () => {
    // Prime the cache manually
    const cacheKey = 'qrlink2_unknown_result_' + require('crypto')
      .createHash('md5')
      .update('https://example.com/test')
      .digest('hex');
    cacheStore.set(cacheKey, JSON.stringify({
      success: true,
      spotifyUri: 'spotify:track:abc',
      links: {},
    }));
    const result = await spotify.resolveSpotifyUrl('https://example.com/test');
    expect(result.cached).toBe(true);
    expect(result.spotifyUri).toBe('spotify:track:abc');
    expect(spotifyAxiosGet).not.toHaveBeenCalled();
  });

  it('prepends https:// to URLs without a scheme', async () => {
    // Blacklist check after normalization: q.me-qr.com without https
    const result = await spotify.resolveSpotifyUrl('q.me-qr.com/test');
    expect(result.blacklisted).toBe(true);
  });

  it('detects Apple Music native link', async () => {
    const result = await spotify.resolveSpotifyUrl('https://music.apple.com/album/xyz/123');
    expect(result.success).toBe(true);
    expect(result.links?.appleMusicLink).toBe('https://music.apple.com/album/xyz/123');
    expect(result.links?.spotifyLink).toBeNull();
  });

  it('detects Tidal native link', async () => {
    const result = await spotify.resolveSpotifyUrl('https://tidal.com/browse/track/123456');
    expect(result.success).toBe(true);
    expect(result.links?.tidalLink).toBe('https://tidal.com/browse/track/123456');
  });

  it('detects YouTube Music native link', async () => {
    const result = await spotify.resolveSpotifyUrl('https://music.youtube.com/watch?v=abc123');
    expect(result.success).toBe(true);
    expect(result.links?.youtubeMusicLink).toBeDefined();
  });

  it('detects Deezer native link', async () => {
    const result = await spotify.resolveSpotifyUrl('https://www.deezer.com/track/123456');
    expect(result.success).toBe(true);
    expect(result.links?.deezerLink).toBeDefined();
  });
});

describe('Spotify.searchTracks', () => {
  let spotify: Spotify;
  beforeEach(() => {
    cacheStore.clear();
    spotifyApiSearchTracksMock.mockReset();
    (Spotify as any).instance = undefined;
    spotify = Spotify.getInstance();
  });

  it('returns error when search term is too short', async () => {
    const result = await spotify.searchTracks('a');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Search term too short');
    expect(spotifyApiSearchTracksMock).not.toHaveBeenCalled();
  });

  it('returns error when search term is empty', async () => {
    const result = await spotify.searchTracks('');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Search term too short');
  });

  it('returns cached result on cache hit', async () => {
    const cacheKey = 'search_hello_5_0';
    cacheStore.set(cacheKey, JSON.stringify({ success: true, data: { tracks: [] } }));
    const result = await spotify.searchTracks('hello', 5, 0);
    expect(result.success).toBe(true);
    expect(spotifyApiSearchTracksMock).not.toHaveBeenCalled();
  });

  it('propagates API error', async () => {
    spotifyApiSearchTracksMock.mockResolvedValue({
      success: false,
      error: 'Unauthorized',
      needsReAuth: true,
    });
    const result = await spotify.searchTracks('hello world');
    expect(result.success).toBe(false);
    expect(result.needsReAuth).toBe(true);
  });

  it('formats tracks from a successful API response', async () => {
    spotifyApiSearchTracksMock.mockResolvedValue({
      success: true,
      data: {
        tracks: {
          total: 1,
          items: [
            {
              id: 'abc',
              name: 'My Song',
              artists: [{ name: 'Some Artist' }],
              album: {
                name: 'My Album',
                images: [{ url: 'https://img.url/cover.jpg' }],
                release_date: '2010-03-15',
              },
              external_urls: { spotify: 'https://open.spotify.com/track/abc' },
              preview_url: 'https://preview.url/abc.mp3',
            },
          ],
        },
      },
    });
    const result = await spotify.searchTracks('my song');
    expect(result.success).toBe(true);
    // searchTracks returns data.tracks as a flat array of formatted items
    expect(Array.isArray(result.data?.tracks)).toBe(true);
    expect(result.data?.tracks).toHaveLength(1);
    expect(result.data?.tracks[0].name).toBe('My Song');
  });
});

describe('Spotify.getTracksByIds', () => {
  let spotify: Spotify;
  beforeEach(() => {
    cacheStore.clear();
    spotifyApiGetTracksByIdsMock.mockReset();
    (Spotify as any).instance = undefined;
    spotify = Spotify.getInstance();
  });

  it('returns error immediately for empty array', async () => {
    const result = await spotify.getTracksByIds([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No track IDs');
  });

  it('returns cached result on cache hit', async () => {
    const key = 'tracksbyids_abc_def'; // sorted join
    cacheStore.set(key, JSON.stringify({ success: true, data: [{ id: 'abc' }] }));
    const result = await spotify.getTracksByIds(['def', 'abc']);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(spotifyApiGetTracksByIdsMock).not.toHaveBeenCalled();
  });

  it('formats tracks from a successful API response', async () => {
    spotifyApiGetTracksByIdsMock.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          {
            id: 'track1',
            name: 'Test Track',
            artists: [{ name: 'Artist One' }],
            album: { name: 'Album One', images: [{ url: 'https://img.url/t.jpg' }], release_date: '2020' },
            external_urls: { spotify: 'https://open.spotify.com/track/track1' },
            external_ids: { isrc: 'USXX01234567' },
            preview_url: null,
          },
        ],
      },
    });
    const result = await spotify.getTracksByIds(['track1']);
    expect(result.success).toBe(true);
    const track = result.data[0];
    expect(track.id).toBe('track1');
    expect(track.name).toBe('Test Track');
    expect(track.artist).toBe('Artist One');
  });

  it('filters out tracks with empty name or artist', async () => {
    spotifyApiGetTracksByIdsMock.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          {
            id: 't1',
            name: '', // empty name → filtered
            artists: [{ name: 'Artist' }],
            album: { name: '', images: [], release_date: '' },
            external_urls: { spotify: '' },
            preview_url: null,
          },
        ],
      },
    });
    const result = await spotify.getTracksByIds(['t1']);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('handles needsReAuth error from API', async () => {
    spotifyApiGetTracksByIdsMock.mockResolvedValue({
      success: false,
      error: 'Spotify token expired',
      needsReAuth: true,
    });
    const result = await spotify.getTracksByIds(['t1']);
    expect(result.success).toBe(false);
    expect(result.needsReAuth).toBe(true);
  });
});

describe('Spotify.formatEnrichedTrack (private)', () => {
  let spotify: Spotify;
  beforeEach(() => {
    (Spotify as any).instance = undefined;
    spotify = Spotify.getInstance();
  });

  const baseTrack = {
    id: 'track1',
    name: 'My Song',
    external_urls: { spotify: 'https://open.spotify.com/track/track1' },
    external_ids: { isrc: 'USXX01234567' },
    preview_url: 'https://preview.mp3',
    album: {
      name: 'My Album',
      release_date: '1999-06-01',
      images: [
        { url: 'https://img.url/large.jpg' },
        { url: 'https://img.url/medium.jpg' },
      ],
    },
  };

  const baseArtists = [{ name: 'Primary Artist' }];

  it('returns a formatted track when all fields are present', () => {
    const result = (spotify as any).formatEnrichedTrack(baseTrack, null, baseArtists);
    expect(result).not.toBeNull();
    expect(result.id).toBe('track1');
    expect(result.name).toBe('My Song');
    expect(result.artist).toBe('Primary Artist');
    expect(result.image).toBe('https://img.url/medium.jpg'); // second image (index 1)
  });

  it('returns null when track has no name', () => {
    const t = { ...baseTrack, name: '' };
    expect((spotify as any).formatEnrichedTrack(t, null, baseArtists)).toBeNull();
  });

  it('returns null when artists array is empty', () => {
    expect((spotify as any).formatEnrichedTrack(baseTrack, null, [])).toBeNull();
  });

  it('returns null when album has no images', () => {
    const t = { ...baseTrack, album: { ...baseTrack.album, images: [] } };
    expect((spotify as any).formatEnrichedTrack(t, null, baseArtists)).toBeNull();
  });

  it('returns null for podcast episode URLs (/episode/)', () => {
    const t = {
      ...baseTrack,
      external_urls: { spotify: 'https://open.spotify.com/episode/abc123' },
    };
    expect((spotify as any).formatEnrichedTrack(t, null, baseArtists)).toBeNull();
  });

  it('applies enrichment data when provided', () => {
    const enrichment = { year: 1985, name: 'Better Name', artist: 'True Artist' };
    const result = (spotify as any).formatEnrichedTrack(baseTrack, enrichment, baseArtists);
    expect(result.trueYear).toBe(1985);
    expect(result.name).toBe('Better Name');
    expect(result.artist).toBe('True Artist');
  });

  it('falls back to Spotify artist when enrichment artist is null', () => {
    const enrichment = { year: 1985, name: null, artist: null };
    const result = (spotify as any).formatEnrichedTrack(baseTrack, enrichment, baseArtists);
    expect(result.artist).toBe('Primary Artist');
  });

  it('joins multiple artists with & for the last one', () => {
    const artists = [
      { name: 'Artist One' },
      { name: 'Artist Two' },
      { name: 'Artist Three' },
    ];
    const result = (spotify as any).formatEnrichedTrack(baseTrack, null, artists);
    expect(result.artist).toBe('Artist One, Artist Two & Artist Three');
  });

  it('uses first image when album has only one image', () => {
    const t = {
      ...baseTrack,
      album: { ...baseTrack.album, images: [{ url: 'https://img.url/only.jpg' }] },
    };
    const result = (spotify as any).formatEnrichedTrack(t, null, baseArtists);
    expect(result.image).toBe('https://img.url/only.jpg');
  });
});
