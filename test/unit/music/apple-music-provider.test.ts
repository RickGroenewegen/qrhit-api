import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/**
 * Unit tests for AppleMusicProvider: URL validation, storefront mapping,
 * Developer Token auth header, pagination of playlist tracks, skipping of
 * unavailable tracks, artwork URL templating, search, shortlink resolution
 * and the storefront song-link resolver (direct + ISRC fallback).
 *
 * All I/O is mocked: Redis cache, logger, utils, translation and global fetch.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string, _ttl?: number) => {
      store.set(key, value);
    }),
  };
});

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: h.cacheGet,
      set: h.cacheSet,
    }),
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    cleanTrackName(name: string) {
      return name;
    }
  },
}));

// AppleMusicProvider reads Translation.LOCALE_STOREFRONTS at module load.
vi.mock('../../../src/translation', () => ({
  default: class Translation {
    static LOCALE_STOREFRONTS: Record<string, string> = {
      en: 'us',
      nl: 'nl',
      de: 'de',
      sv: 'se',
    };
  },
}));

import AppleMusicProvider from '../../../src/providers/AppleMusicProvider';
import { ServiceType } from '../../../src/enums/ServiceType';

const fetchMock = vi.fn();

function jsonResponse(data: any, opts: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    json: async () => data,
  };
}

const ORIGINAL_TOKEN = process.env['APPLE_MUSIC_DEVELOPER_TOKEN'];

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
  process.env['APPLE_MUSIC_DEVELOPER_TOKEN'] = 'test-dev-token';
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env['APPLE_MUSIC_DEVELOPER_TOKEN'];
  } else {
    process.env['APPLE_MUSIC_DEVELOPER_TOKEN'] = ORIGINAL_TOKEN;
  }
});

beforeEach(() => {
  h.store.clear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  fetchMock.mockReset();
  process.env['APPLE_MUSIC_DEVELOPER_TOKEN'] = 'test-dev-token';
});

function newProvider(): AppleMusicProvider {
  return new (AppleMusicProvider as any)();
}

describe('AppleMusicProvider config', () => {
  it('exposes the apple_music service type and config', () => {
    const p = newProvider();
    expect(p.serviceType).toBe(ServiceType.APPLE_MUSIC);
    expect(p.config).toMatchObject({
      serviceType: ServiceType.APPLE_MUSIC,
      supportsOAuth: false,
      supportsPublicPlaylists: true,
      supportsSearch: true,
    });
  });
});

describe('AppleMusicProvider.getStorefrontForLocale', () => {
  const p = newProvider();

  it('maps known locales (case-insensitive)', () => {
    expect(p.getStorefrontForLocale('en')).toBe('us');
    expect(p.getStorefrontForLocale('EN')).toBe('us');
    expect(p.getStorefrontForLocale('sv')).toBe('se');
  });

  it('falls back to nl for unknown or missing locales', () => {
    expect(p.getStorefrontForLocale('xx')).toBe('nl');
    expect(p.getStorefrontForLocale(undefined)).toBe('nl');
  });
});

describe('AppleMusicProvider.validateUrl', () => {
  const p = newProvider();

  it('accepts a playlist URL with a name segment', () => {
    const r = p.validateUrl('https://music.apple.com/us/playlist/top-100/pl.u-abc123');
    expect(r).toEqual({
      isValid: true,
      isServiceUrl: true,
      resourceType: 'playlist',
      resourceId: 'pl.u-abc123',
    });
  });

  it('accepts a playlist URL without a name segment (pl.-prefixed)', () => {
    const r = p.validateUrl('https://music.apple.com/nl/playlist/pl.u-xyz789');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('pl.u-xyz789');
  });

  it('accepts the itms:// URI scheme', () => {
    const r = p.validateUrl('itms://music.apple.com/us/playlist/some-name/pl.abc');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('pl.abc');
  });

  it('accepts a bare pl.-prefixed playlist ID', () => {
    const r = p.validateUrl('pl.u-AkAmPYLF8jvbqo');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('pl.u-AkAmPYLF8jvbqo');
  });

  it('accepts ANY trailing segment as a playlist ID when a name is present (current behavior)', () => {
    // The named-playlist regex does not require a pl. prefix, so the trailing
    // segment is taken as the ID even when it is not a real playlist ID.
    const r = p.validateUrl('https://music.apple.com/us/playlist/some-name/whatever-id');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('whatever-id');
  });

  it('classifies album, song and artist URLs as not_playlist with the right resourceType', () => {
    expect(p.validateUrl('https://music.apple.com/us/album/thriller/123')).toMatchObject({
      isValid: false,
      isServiceUrl: true,
      resourceType: 'album',
      errorType: 'not_playlist',
    });
    expect(p.validateUrl('https://music.apple.com/us/song/billie-jean/456')).toMatchObject({
      isValid: false,
      resourceType: 'track',
    });
    expect(p.validateUrl('https://music.apple.com/us/artist/queen/789')).toMatchObject({
      isValid: false,
      resourceType: 'artist',
    });
  });

  it('flags other Apple Music URLs as not_playlist without a resourceType', () => {
    const r = p.validateUrl('https://music.apple.com/us/browse');
    expect(r).toEqual({ isValid: false, isServiceUrl: true, errorType: 'not_playlist' });
  });

  it('rejects non-Apple URLs', () => {
    expect(p.validateUrl('https://www.deezer.com/playlist/1')).toEqual({
      isValid: false,
      isServiceUrl: false,
    });
  });
});

describe('AppleMusicProvider.extractPlaylistId', () => {
  const p = newProvider();
  it('extracts the ID from a valid URL and returns null otherwise', () => {
    expect(p.extractPlaylistId('https://music.apple.com/us/playlist/x/pl.123')).toBe('pl.123');
    expect(p.extractPlaylistId('https://music.apple.com/us/album/x/1')).toBeNull();
  });
});

describe('AppleMusicProvider.getPlaylist', () => {
  it('requests the storefront catalog endpoint with the Bearer token', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            attributes: {
              name: 'Hot Hits',
              description: { standard: 'The hottest' },
              artwork: { url: 'https://art/{w}x{h}bb.jpg' },
              trackCount: 50,
              url: 'https://music.apple.com/us/playlist/hot-hits/pl.hot',
            },
          },
        ],
      })
    );

    const result = await p.getPlaylist('pl.hot', 'us');

    expect(fetchMock).toHaveBeenCalledWith('https://api.music.apple.com/v1/catalog/us/playlists/pl.hot', {
      headers: { Authorization: 'Bearer test-dev-token' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 'pl.hot',
      name: 'Hot Hits',
      description: 'The hottest',
      imageUrl: 'https://art/640x640bb.jpg', // {w}/{h} templated to 640
      trackCount: 50,
      serviceType: ServiceType.APPLE_MUSIC,
      originalUrl: 'https://music.apple.com/us/playlist/hot-hits/pl.hot',
    });
    expect(h.cacheSet).toHaveBeenCalledWith('apple_music_playlist_pl.hot', JSON.stringify(result.data));
  });

  it('defaults to the nl storefront', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ attributes: { name: 'X' } }] }));
    await p.getPlaylist('pl.x');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.music.apple.com/v1/catalog/nl/playlists/pl.x');
  });

  it('fails without a Developer Token configured', async () => {
    delete process.env['APPLE_MUSIC_DEVELOPER_TOKEN'];
    const p = newProvider(); // fresh instance so no token is memoized
    const result = await p.getPlaylist('pl.x');
    expect(result).toEqual({ success: false, error: 'Apple Music Developer Token not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "Playlist not found" for an empty data array', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await p.getPlaylist('pl.missing');
    expect(result).toEqual({ success: false, error: 'Playlist not found' });
  });

  it('maps HTTP errors with status code and text', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 401, statusText: 'Unauthorized' }));
    const result = await p.getPlaylist('pl.x');
    expect(result).toEqual({ success: false, error: 'Apple Music API error: 401 Unauthorized' });
  });

  it('serves from cache and bypasses it with cache=false (third argument)', async () => {
    const p = newProvider();
    const cached = { id: 'pl.c', name: 'Cached' };
    h.store.set('apple_music_playlist_pl.c', JSON.stringify(cached));

    expect(await p.getPlaylist('pl.c')).toEqual({ success: true, data: cached });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ attributes: { name: 'Fresh' } }] }));
    const fresh = await p.getPlaylist('pl.c', 'nl', false);
    expect(fresh.data?.name).toBe('Fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function appleTrack(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    attributes: {
      name: `Song ${id}`,
      artistName: `Artist ${id}`,
      albumName: `Album ${id}`,
      artwork: { url: `https://art/${id}/{w}x{h}.jpg` },
      releaseDate: '1985-07-13',
      isrc: `USISRC${id}`,
      previews: [{ url: `https://preview/${id}.m4a` }],
      durationInMillis: 180000,
      url: `https://music.apple.com/nl/song/song-${id}/${id}`,
      playParams: { id },
      ...overrides,
    },
  };
}

describe('AppleMusicProvider.getTracks', () => {
  it('paginates via the next URL, skips unavailable tracks and maps fields', async () => {
    const p = newProvider();
    fetchMock
      // playlist metadata (track count + name)
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ attributes: { trackCount: 3, name: 'Mix' } }] })
      )
      // page 1: one good track + one without playParams (unavailable)
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appleTrack('100'), appleTrack('101', { playParams: undefined })],
          next: '/v1/catalog/nl/playlists/pl.mix/tracks?offset=100',
        })
      )
      // page 2
      .mockResolvedValueOnce(jsonResponse({ data: [appleTrack('102')] }));

    const progress: any[] = [];
    const result = await p.getTracks('pl.mix', true, undefined, (pr) => progress.push(pr));

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.music.apple.com/v1/catalog/nl/playlists/pl.mix',
      'https://api.music.apple.com/v1/catalog/nl/playlists/pl.mix/tracks?limit=100',
      // catalog prefix is stripped from the next URL before re-requesting
      'https://api.music.apple.com/v1/catalog/nl/playlists/pl.mix/tracks?offset=100',
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.tracks.map((t) => t.id)).toEqual(['100', '102']);
    expect(result.data?.total).toBe(2);
    expect(result.data?.skipped).toMatchObject({
      total: 1,
      summary: { unavailable: 1, localFiles: 0, podcasts: 0, duplicates: 0 },
    });

    expect(result.data?.tracks[0]).toEqual({
      id: '100',
      name: 'Song 100',
      artist: 'Artist 100',
      artistsList: ['Artist 100'],
      album: 'Album 100',
      albumImageUrl: 'https://art/100/640x640.jpg',
      releaseDate: '1985-07-13',
      isrc: 'USISRC100',
      previewUrl: 'https://preview/100.m4a',
      duration: 180000,
      serviceType: ServiceType.APPLE_MUSIC,
      serviceLink: 'https://music.apple.com/nl/song/song-100/100',
    });

    expect(progress[0]).toMatchObject({ stage: 'fetching_ids', current: 0, total: 3, percentage: 1 });
    expect(progress.at(-1)).toMatchObject({ stage: 'fetching_metadata', current: 2, total: 3 });

    // Cache key includes the storefront
    expect(h.cacheSet).toHaveBeenCalledWith('apple_music_tracks_nl_pl.mix', JSON.stringify(result.data));
  });

  it('uses the storefront argument (5th param) for requests and cache key', async () => {
    const p = newProvider();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ attributes: { trackCount: 1 } }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [appleTrack('1')] }));

    await p.getTracks('pl.us', true, undefined, undefined, 'us');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.music.apple.com/v1/catalog/us/playlists/pl.us');
    expect(h.cacheSet.mock.calls[0][0]).toBe('apple_music_tracks_us_pl.us');
  });

  it('fails when the first page fails', async () => {
    const p = newProvider();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404, statusText: 'Not Found' }))
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404, statusText: 'Not Found' }));
    const result = await p.getTracks('pl.gone');
    expect(result).toEqual({ success: false, error: 'Apple Music API error: 404 Not Found' });
  });

  it('serves the cached track list', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0 };
    h.store.set('apple_music_tracks_nl_pl.c', JSON.stringify(cached));
    const result = await p.getTracks('pl.c');
    expect(result).toEqual({ success: true, data: cached });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AppleMusicProvider.searchTracks', () => {
  it('builds the search endpoint and maps songs (300px artwork)', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: {
          songs: {
            data: [appleTrack('7')],
            total: 42,
            next: '/v1/catalog/us/search?offset=20',
          },
        },
      })
    );

    const result = await p.searchTracks('bohemian rhapsody', 20, 0, 'us');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.music.apple.com/v1/catalog/us/search?term=bohemian%20rhapsody&types=songs&limit=20&offset=0',
      { headers: { Authorization: 'Bearer test-dev-token' } }
    );
    expect(result.success).toBe(true);
    expect(result.data?.tracks[0].albumImageUrl).toBe('https://art/7/300x300.jpg');
    expect(result.data?.total).toBe(42);
    expect(result.data?.hasMore).toBe(true);
    expect(h.cacheSet).toHaveBeenCalledWith(
      'apple_music_search_us_bohemian rhapsody_20_0',
      JSON.stringify(result.data),
      3600
    );
  });

  it('reports hasMore=false and empty tracks when there are no results', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: {} }));
    const result = await p.searchTracks('zzzz');
    expect(result.data).toEqual({ tracks: [], total: 0, hasMore: false });
  });

  it('propagates API failures', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500, statusText: 'Server Error' }));
    const result = await p.searchTracks('q');
    expect(result).toEqual({ success: false, error: 'Apple Music API error: 500 Server Error' });
  });
});

describe('AppleMusicProvider.resolveShortlink', () => {
  it('resolves to a playlist URL', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce({ url: 'https://music.apple.com/us/playlist/top/pl.top' });
    const result = await p.resolveShortlink('https://apple.co/xyz');
    expect(fetchMock).toHaveBeenCalledWith('https://apple.co/xyz', { method: 'HEAD', redirect: 'follow' });
    expect(result).toEqual({
      success: true,
      data: { resolvedUrl: 'https://music.apple.com/us/playlist/top/pl.top' },
    });
  });

  it('fails when resolved to an Apple Music non-playlist URL', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce({ url: 'https://music.apple.com/us/album/x/1' });
    const result = await p.resolveShortlink('https://apple.co/xyz');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Shortlink resolved to an Apple Music URL but not a playlist');
  });

  it('fails when resolved outside Apple Music', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce({ url: 'https://example.org/' });
    const result = await p.resolveShortlink('https://apple.co/xyz');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Shortlink did not resolve to a valid Apple Music playlist URL');
  });
});

describe('AppleMusicProvider.resolveSongToStorefront', () => {
  it('returns the link unchanged when it does not parse', async () => {
    const p = newProvider();
    const link = 'https://example.com/not-apple';
    expect(await p.resolveSongToStorefront(link, 'de')).toBe(link);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the link unchanged when the storefront already matches', async () => {
    const p = newProvider();
    const link = 'https://music.apple.com/de/song/track/12345';
    expect(await p.resolveSongToStorefront(link, 'de')).toBe(link);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves via direct catalog ID lookup and caches for a day', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ attributes: { url: 'https://music.apple.com/de/song/track/999' } }] })
    );

    const resolved = await p.resolveSongToStorefront('https://music.apple.com/us/song/track/12345', 'de');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.music.apple.com/v1/catalog/de/songs/12345');
    expect(resolved).toBe('https://music.apple.com/de/song/track/999');
    expect(h.cacheSet).toHaveBeenCalledWith('am_sf:12345:de', resolved, 86400);
  });

  it('uses the ?i= album query parameter as the song ID', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ attributes: { url: 'https://music.apple.com/de/song/track/1' } }] })
    );
    await p.resolveSongToStorefront('https://music.apple.com/us/album/great-album/555?i=999', 'de');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.music.apple.com/v1/catalog/de/songs/999');
  });

  it('returns the cached resolution without fetching', async () => {
    const p = newProvider();
    h.store.set('am_sf:12345:de', 'https://music.apple.com/de/song/cached/1');
    const resolved = await p.resolveSongToStorefront('https://music.apple.com/us/song/track/12345', 'de');
    expect(resolved).toBe('https://music.apple.com/de/song/cached/1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to ISRC lookup via the original storefront', async () => {
    const p = newProvider();
    fetchMock
      // 1. direct lookup in target storefront fails
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404, statusText: 'Not Found' }))
      // 2. original storefront lookup yields the ISRC
      .mockResolvedValueOnce(jsonResponse({ data: [{ attributes: { isrc: 'GBUM71029604' } }] }))
      // 3. ISRC filter search in target storefront yields the URL
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ attributes: { url: 'https://music.apple.com/de/song/via-isrc/2' } }] })
      );

    const resolved = await p.resolveSongToStorefront('https://music.apple.com/us/song/track/12345', 'de');

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.music.apple.com/v1/catalog/de/songs/12345',
      'https://api.music.apple.com/v1/catalog/us/songs/12345',
      'https://api.music.apple.com/v1/catalog/de/songs?filter[isrc]=GBUM71029604',
    ]);
    expect(resolved).toBe('https://music.apple.com/de/song/via-isrc/2');
  });

  it('returns the original link when nothing resolves anywhere', async () => {
    const p = newProvider();
    // direct, original storefront, fallback (nl) storefront all fail
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 404, statusText: 'Not Found' }));
    const link = 'https://music.apple.com/us/song/track/12345';
    expect(await p.resolveSongToStorefront(link, 'de')).toBe(link);
  });
});

describe('AppleMusicProvider OAuth stubs', () => {
  it('does not provide an authorization URL', () => {
    expect(newProvider().getAuthorizationUrl()).toBeNull();
  });

  it('rejects OAuth callbacks', async () => {
    const result = await newProvider().handleAuthCallback('code');
    expect(result.success).toBe(false);
    expect(result.error).toContain('OAuth not applicable');
  });
});

describe('AppleMusicProvider.getInstance', () => {
  it('returns a singleton', () => {
    expect(AppleMusicProvider.getInstance()).toBe(AppleMusicProvider.getInstance());
  });
});
