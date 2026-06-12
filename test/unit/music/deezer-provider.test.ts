import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/**
 * Unit tests for DeezerProvider: URL validation/ID extraction, Deezer API
 * request building, pagination (next-URL rewriting + country param),
 * response -> track mapping, shortlink resolution and error handling.
 *
 * All I/O is mocked: Redis cache, logger, utils and global fetch.
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

// Pass-through cleanTrackName so mapping assertions stay literal.
vi.mock('../../../src/utils', () => ({
  default: class {
    cleanTrackName(name: string) {
      return name;
    }
  },
}));

import DeezerProvider from '../../../src/providers/DeezerProvider';
import { ServiceType } from '../../../src/enums/ServiceType';

const fetchMock = vi.fn();

function jsonResponse(data: any, opts: { ok?: boolean; status?: number; statusText?: string; url?: string } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    url: opts.url ?? '',
    json: async () => data,
  };
}

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.store.clear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  fetchMock.mockReset();
});

function newProvider(): DeezerProvider {
  return new (DeezerProvider as any)();
}

describe('DeezerProvider config', () => {
  it('exposes the deezer service type and config', () => {
    const p = newProvider();
    expect(p.serviceType).toBe(ServiceType.DEEZER);
    expect(p.config).toMatchObject({
      serviceType: ServiceType.DEEZER,
      supportsOAuth: false,
      supportsPublicPlaylists: true,
      supportsSearch: true,
      supportsPlaylistCreation: false,
    });
  });
});

describe('DeezerProvider.validateUrl', () => {
  const p = newProvider();

  it('accepts standard playlist URLs', () => {
    expect(p.validateUrl('https://www.deezer.com/playlist/908622995')).toEqual({
      isValid: true,
      isServiceUrl: true,
      resourceType: 'playlist',
      resourceId: '908622995',
    });
  });

  it('accepts playlist URLs without www and with http', () => {
    expect(p.validateUrl('http://deezer.com/playlist/42').resourceId).toBe('42');
  });

  it('accepts locale-prefixed playlist URLs', () => {
    const r = p.validateUrl('https://www.deezer.com/en/playlist/908622995');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('908622995');
  });

  it('accepts the deezer:// URI scheme', () => {
    const r = p.validateUrl('deezer://playlist/12345');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('12345');
  });

  it('accepts a bare numeric ID and trims whitespace', () => {
    const r = p.validateUrl('  908622995  ');
    expect(r).toEqual({
      isValid: true,
      isServiceUrl: true,
      resourceType: 'playlist',
      resourceId: '908622995',
    });
  });

  it('accepts shortlinks as valid but without a resourceId', () => {
    for (const url of ['https://link.deezer.com/s/abc123', 'https://deezer.page.link/xyz']) {
      const r = p.validateUrl(url);
      expect(r.isValid).toBe(true);
      expect(r.isServiceUrl).toBe(true);
      expect(r.resourceId).toBeUndefined();
    }
  });

  it('flags non-playlist Deezer URLs as not_playlist', () => {
    const r = p.validateUrl('https://www.deezer.com/album/1234');
    expect(r).toEqual({ isValid: false, isServiceUrl: true, errorType: 'not_playlist' });
  });

  it('rejects non-Deezer URLs entirely', () => {
    expect(p.validateUrl('https://open.spotify.com/playlist/abc')).toEqual({
      isValid: false,
      isServiceUrl: false,
    });
  });
});

describe('DeezerProvider.extractPlaylistId', () => {
  const p = newProvider();

  it('extracts the numeric ID from a valid URL', () => {
    expect(p.extractPlaylistId('https://www.deezer.com/playlist/908622995')).toBe('908622995');
  });

  it('returns null for a shortlink (valid but unresolved, no resourceId)', () => {
    expect(p.extractPlaylistId('https://link.deezer.com/s/abc123')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(p.extractPlaylistId('https://www.deezer.com/album/1')).toBeNull();
  });
});

describe('DeezerProvider.getPlaylist', () => {
  it('fetches from the API with country=NL and maps the response', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        title: 'Best of 80s',
        description: 'Hits',
        picture_xl: 'https://img/xl.jpg',
        picture_big: 'https://img/big.jpg',
        nb_tracks: 99,
      })
    );

    const result = await p.getPlaylist('908622995');

    expect(fetchMock).toHaveBeenCalledWith('https://api.deezer.com/playlist/908622995?country=NL');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: '908622995',
      name: 'Best of 80s',
      description: 'Hits',
      imageUrl: 'https://img/xl.jpg',
      trackCount: 99,
      serviceType: ServiceType.DEEZER,
      originalUrl: 'https://www.deezer.com/playlist/908622995',
    });
    // Cached without TTL (no expiry for playlists)
    expect(h.cacheSet).toHaveBeenCalledWith('deezer_playlist_908622995', JSON.stringify(result.data));
  });

  it('falls back through the picture size chain', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ title: 'X', nb_tracks: 1, picture_medium: 'https://img/med.jpg' })
    );
    const result = await p.getPlaylist('1');
    expect(result.data?.imageUrl).toBe('https://img/med.jpg');
  });

  it('returns the cached playlist without hitting the API', async () => {
    const p = newProvider();
    const cachedData = { id: '5', name: 'Cached', serviceType: ServiceType.DEEZER };
    h.store.set('deezer_playlist_5', JSON.stringify(cachedData));

    const result = await p.getPlaylist('5');
    expect(result).toEqual({ success: true, data: cachedData });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bypasses the cache when cache=false', async () => {
    const p = newProvider();
    h.store.set('deezer_playlist_5', JSON.stringify({ name: 'Stale' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'Fresh', nb_tracks: 2 }));

    const result = await p.getPlaylist('5', false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data?.name).toBe('Fresh');
  });

  it('maps Deezer body-level error objects to a failed ApiResult', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { type: 'DataException', message: 'no data' } })
    );
    const result = await p.getPlaylist('404404');
    expect(result).toEqual({ success: false, error: 'no data' });
  });

  it('maps non-2xx HTTP responses to a failed ApiResult', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500, statusText: 'Server Error' }));
    const result = await p.getPlaylist('1');
    expect(result).toEqual({ success: false, error: 'Deezer API error: 500 Server Error' });
  });

  it('maps network errors to a failed ApiResult', async () => {
    const p = newProvider();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await p.getPlaylist('1');
    expect(result).toEqual({ success: false, error: 'ECONNRESET' });
  });
});

function deezerTrack(id: number, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `Track ${id} - Remastered`,
    title_short: `Track ${id}`,
    artist: { name: `Artist ${id}` },
    album: { title: `Album ${id}`, cover_xl: `https://img/${id}_xl.jpg` },
    duration: 200,
    isrc: `ISRC${id}`,
    preview: `https://preview/${id}.mp3`,
    link: `https://www.deezer.com/track/${id}`,
    ...overrides,
  };
}

describe('DeezerProvider.getTracks', () => {
  it('fetches all pages, rewrites next URLs with country=NL and maps tracks', async () => {
    const p = newProvider();
    // 1: playlist metadata, 2: page 1, 3: page 2
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ title: 'My List', nb_tracks: 3 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [deezerTrack(1), deezerTrack(2)],
          next: 'https://api.deezer.com/playlist/777/tracks?index=100',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [deezerTrack(3)] }));

    const progress: any[] = [];
    const result = await p.getTracks('777', true, undefined, (pr) => progress.push(pr));

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.deezer.com/playlist/777',
      'https://api.deezer.com/playlist/777/tracks?limit=100&country=NL',
      // next URL from the API lacked country -> it must be re-added
      'https://api.deezer.com/playlist/777/tracks?index=100&country=NL',
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(3);
    expect(result.data?.tracks).toHaveLength(3);
    expect(result.data?.tracks[0]).toEqual({
      id: '1',
      name: 'Track 1', // title_short preferred over title
      artist: 'Artist 1',
      artistsList: ['Artist 1'],
      album: 'Album 1',
      albumImageUrl: 'https://img/1_xl.jpg',
      releaseDate: null,
      isrc: 'ISRC1',
      previewUrl: 'https://preview/1.mp3',
      duration: 200000, // seconds -> ms
      serviceType: ServiceType.DEEZER,
      serviceLink: 'https://www.deezer.com/track/1',
    });
    expect(result.data?.skipped?.total).toBe(0);

    // Progress: initial fetching_ids, then fetching_metadata per page
    expect(progress[0]).toMatchObject({ stage: 'fetching_ids', current: 0, total: 3, percentage: 1 });
    expect(progress[1]).toMatchObject({ stage: 'fetching_metadata', current: 2, total: 3, percentage: 67 });
    expect(progress[2]).toMatchObject({ stage: 'fetching_metadata', current: 3, total: 3, percentage: 99 });

    expect(h.cacheSet).toHaveBeenCalledWith('deezer_tracks_777', JSON.stringify(result.data));
  });

  it('handles missing artist/album/link fields with fallbacks', async () => {
    const p = newProvider();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ title: 'L', nb_tracks: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 9,
              title: 'Only Title',
              // no title_short, artist, album, link, isrc, preview, duration
            },
          ],
        })
      );

    const result = await p.getTracks('9');
    const track = result.data!.tracks[0];
    expect(track.name).toBe('Only Title'); // falls back to title
    expect(track.artist).toBe('Unknown Artist');
    expect(track.album).toBe('');
    expect(track.isrc).toBeUndefined();
    expect(track.previewUrl).toBeNull();
    expect(track.duration).toBeUndefined();
    expect(track.serviceLink).toBe('https://www.deezer.com/track/9');
  });

  it('truncates to maxTracks and stops paginating', async () => {
    const p = newProvider();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ title: 'L', nb_tracks: 10 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [deezerTrack(1), deezerTrack(2), deezerTrack(3)],
          next: 'https://api.deezer.com/playlist/8/tracks?index=100',
        })
      );

    const result = await p.getTracks('8', true, 2);
    expect(result.data?.tracks.map((t) => t.id)).toEqual(['1', '2']);
    // metadata + first page only — no second page fetched
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when the first tracks page fails', async () => {
    const p = newProvider();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ title: 'L', nb_tracks: 1 }))
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 403, statusText: 'Forbidden' }));

    const result = await p.getTracks('13');
    expect(result).toEqual({ success: false, error: 'Deezer API error: 403 Forbidden' });
  });

  it('returns partial results when a later page fails', async () => {
    const p = newProvider();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ title: 'L', nb_tracks: 2 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [deezerTrack(1)],
          next: 'https://api.deezer.com/playlist/14/tracks?index=100',
        })
      )
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500, statusText: 'Server Error' }));

    const result = await p.getTracks('14');
    expect(result.success).toBe(true);
    expect(result.data?.tracks).toHaveLength(1);
  });

  it('returns the cached track list without fetching', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0 };
    h.store.set('deezer_tracks_55', JSON.stringify(cached));
    const result = await p.getTracks('55');
    expect(result).toEqual({ success: true, data: cached });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DeezerProvider.searchTracks', () => {
  it('builds the search endpoint with encoded query, limit and index', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [deezerTrack(7)], total: 120, next: 'https://api.deezer.com/search?index=5' })
    );

    const result = await p.searchTracks('hello & goodbye', 5, 10);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deezer.com/search/track?q=hello%20%26%20goodbye&limit=5&index=10'
    );
    expect(result.success).toBe(true);
    expect(result.data?.tracks[0].id).toBe('7');
    expect(result.data?.total).toBe(120);
    expect(result.data?.hasMore).toBe(true);
    // Search results are cached with a 30 min TTL
    expect(h.cacheSet).toHaveBeenCalledWith(
      'deezer_search_hello & goodbye_5_10',
      JSON.stringify(result.data),
      1800
    );
  });

  it('reports hasMore=false when there is no next page', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [], total: 0 }));
    const result = await p.searchTracks('nothing');
    expect(result.data).toEqual({ tracks: [], total: 0, hasMore: false });
  });

  it('serves repeated searches from cache', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0, hasMore: false };
    h.store.set('deezer_search_q_20_0', JSON.stringify(cached));
    const result = await p.searchTracks('q');
    expect(result).toEqual({ success: true, data: cached });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates API errors', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Quota limit exceeded' } }));
    const result = await p.searchTracks('q2');
    expect(result).toEqual({ success: false, error: 'Quota limit exceeded' });
  });
});

describe('DeezerProvider.resolveShortlink', () => {
  it('resolves a shortlink to a playlist URL', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce({ url: 'https://www.deezer.com/en/playlist/908622995' });

    const result = await p.resolveShortlink('https://link.deezer.com/s/abc');
    expect(fetchMock).toHaveBeenCalledWith('https://link.deezer.com/s/abc', {
      method: 'HEAD',
      redirect: 'follow',
    });
    expect(result).toEqual({
      success: true,
      data: { resolvedUrl: 'https://www.deezer.com/en/playlist/908622995' },
    });
  });

  it('fails when the shortlink resolves to a non-playlist Deezer URL', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce({ url: 'https://www.deezer.com/album/123' });
    const result = await p.resolveShortlink('https://link.deezer.com/s/abc');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Shortlink resolved to a Deezer URL but not a playlist');
  });

  it('fails when the shortlink resolves outside Deezer', async () => {
    const p = newProvider();
    fetchMock.mockResolvedValueOnce({ url: 'https://example.com/' });
    const result = await p.resolveShortlink('https://deezer.page.link/x');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Shortlink did not resolve to a valid Deezer playlist URL');
  });

  it('maps fetch errors to a failed result', async () => {
    const p = newProvider();
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const result = await p.resolveShortlink('https://link.deezer.com/s/abc');
    expect(result).toEqual({ success: false, error: 'timeout' });
  });
});

describe('DeezerProvider OAuth stubs', () => {
  it('does not provide an authorization URL', () => {
    expect(newProvider().getAuthorizationUrl()).toBeNull();
  });

  it('rejects OAuth callbacks', async () => {
    const result = await newProvider().handleAuthCallback('code');
    expect(result.success).toBe(false);
    expect(result.error).toContain('OAuth not supported');
  });
});

describe('DeezerProvider.getInstance', () => {
  it('returns a singleton', () => {
    expect(DeezerProvider.getInstance()).toBe(DeezerProvider.getInstance());
  });
});
