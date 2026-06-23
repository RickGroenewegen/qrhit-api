import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for TidalProvider: UUID-based URL validation, image URL
 * construction, distributed rate limiting, cursor pagination with
 * interleaved metadata batches, placeholder insertion for unavailable
 * tracks, 429 retry/backoff, the two-step search (IDs then details,
 * including ISO 8601 duration parsing) and OAuth delegation.
 *
 * Mocked: the TidalApi wrapper (src/tidal_api), Redis cache, logger, utils.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string, _ttl?: number) => {
      store.set(key, value);
    }),
    distributedRateLimit: vi.fn(async () => undefined),
    tidal: {
      getPlaylist: vi.fn(),
      getPlaylistItems: vi.fn(),
      getTracks: vi.fn(),
      searchTracks: vi.fn(),
      getAuthorizationUrl: vi.fn(() => 'https://login.tidal.com/authorize?client_id=x'),
      exchangeCodeForToken: vi.fn(),
      isConnected: vi.fn(async () => true),
      clearTokens: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../../../src/tidal_api', () => ({
  default: { getInstance: () => h.tidal },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: h.cacheGet,
      set: h.cacheSet,
      distributedRateLimit: h.distributedRateLimit,
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

import TidalProvider from '../../../src/providers/TidalProvider';
import { ServiceType } from '../../../src/enums/ServiceType';

const UUID = 'a1b2c3d4-e5f6-4a3b-8c2d-ef1234567890';

beforeEach(() => {
  h.store.clear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  h.distributedRateLimit.mockClear();
  for (const fn of Object.values(h.tidal)) {
    if (typeof (fn as any).mockClear === 'function') (fn as any).mockReset();
  }
  h.tidal.getAuthorizationUrl.mockReturnValue('https://login.tidal.com/authorize?client_id=x');
});

afterEach(() => {
  vi.useRealTimers();
});

function newProvider(): TidalProvider {
  return new (TidalProvider as any)();
}

describe('TidalProvider config', () => {
  it('exposes the tidal service type and config', () => {
    const p = newProvider();
    expect(p.serviceType).toBe(ServiceType.TIDAL);
    expect(p.config).toMatchObject({
      serviceType: ServiceType.TIDAL,
      supportsOAuth: true,
      supportsPublicPlaylists: false,
      supportsSearch: true,
    });
  });
});

describe('TidalProvider.validateUrl', () => {
  const p = newProvider();

  it('accepts browse playlist URLs', () => {
    expect(p.validateUrl(`https://tidal.com/browse/playlist/${UUID}`)).toEqual({
      isValid: true,
      isServiceUrl: true,
      resourceType: 'playlist',
      resourceId: UUID,
    });
  });

  it('accepts direct, listen and URI-scheme playlist URLs', () => {
    expect(p.validateUrl(`https://tidal.com/playlist/${UUID}`).resourceId).toBe(UUID);
    expect(p.validateUrl(`https://listen.tidal.com/playlist/${UUID}`).resourceId).toBe(UUID);
    expect(p.validateUrl(`tidal://playlist/${UUID}`).resourceId).toBe(UUID);
  });

  it('accepts a bare UUID (case-insensitive) and trims whitespace', () => {
    const upper = UUID.toUpperCase();
    const r = p.validateUrl(`  ${upper}  `);
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe(upper);
  });

  it('rejects playlist URLs whose ID is not a UUID as not_playlist', () => {
    expect(p.validateUrl('https://tidal.com/playlist/12345')).toEqual({
      isValid: false,
      isServiceUrl: true,
      errorType: 'not_playlist',
    });
  });

  it('flags non-playlist Tidal URLs as not_playlist', () => {
    expect(p.validateUrl('https://tidal.com/browse/album/12345')).toEqual({
      isValid: false,
      isServiceUrl: true,
      errorType: 'not_playlist',
    });
  });

  it('rejects non-Tidal URLs', () => {
    expect(p.validateUrl('https://music.apple.com/us/playlist/x/pl.1')).toEqual({
      isValid: false,
      isServiceUrl: false,
    });
  });
});

describe('TidalProvider.extractPlaylistId', () => {
  const p = newProvider();
  it('extracts the UUID or returns null', () => {
    expect(p.extractPlaylistId(`https://tidal.com/browse/playlist/${UUID}`)).toBe(UUID);
    expect(p.extractPlaylistId('https://tidal.com/browse/album/1')).toBeNull();
  });
});

describe('TidalProvider.getPlaylist', () => {
  it('applies rate limiting, maps attributes and builds the image URL', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: {
        data: {
          attributes: {
            name: 'Deep Focus',
            description: 'Concentration',
            squareImage: 'aa11-bb22-cc33',
            numberOfItems: 75,
          },
        },
      },
    });

    const result = await p.getPlaylist(UUID);

    expect(h.distributedRateLimit).toHaveBeenCalledWith('tidal_api', 250);
    expect(h.tidal.getPlaylist).toHaveBeenCalledWith(UUID);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: UUID,
      name: 'Deep Focus',
      description: 'Concentration',
      // dashes in the image ID become path separators
      imageUrl: 'https://resources.tidal.com/images/aa11/bb22/cc33/640x640.jpg',
      trackCount: 75,
      serviceType: ServiceType.TIDAL,
      originalUrl: `https://tidal.com/browse/playlist/${UUID}`,
    });
    expect(h.cacheSet).toHaveBeenCalledWith(`tidal_playlist_${UUID}`, JSON.stringify(result.data));
  });

  it('uses fallbacks for missing attributes and null image', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { data: { attributes: {} } },
    });
    const result = await p.getPlaylist(UUID);
    expect(result.data).toMatchObject({
      name: 'Untitled Playlist',
      description: '',
      imageUrl: null,
      trackCount: 0,
    });
  });

  it('propagates needsReAuth with a connect message', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({ success: false, needsReAuth: true });
    const result = await p.getPlaylist(UUID);
    expect(result).toEqual({
      success: false,
      error: 'Please connect your Tidal account first',
      needsReAuth: true,
    });
  });

  it('propagates generic API errors', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({ success: false, error: 'Tidal API error: 404' });
    const result = await p.getPlaylist(UUID);
    expect(result).toEqual({ success: false, error: 'Tidal API error: 404' });
  });

  it('serves from cache and bypasses with cache=false', async () => {
    const p = newProvider();
    const cached = { id: UUID, name: 'Cached' };
    h.store.set(`tidal_playlist_${UUID}`, JSON.stringify(cached));

    expect(await p.getPlaylist(UUID)).toEqual({ success: true, data: cached });
    expect(h.tidal.getPlaylist).not.toHaveBeenCalled();

    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { data: { attributes: { name: 'Fresh' } } },
    });
    const fresh = await p.getPlaylist(UUID, false);
    expect(fresh.data?.name).toBe('Fresh');
  });
});

function tidalTrack(id: string, opts: { duration?: any; isrc?: string } = {}) {
  return {
    id,
    attributes: {
      title: `Track ${id}`,
      isrc: opts.isrc ?? `ISRC${id}`,
      duration: opts.duration ?? 200,
    },
    relationships: {
      albums: { data: [{ id: `album-${id}` }] },
      artists: { data: [{ id: 'artist-1' }, { id: 'artist-2' }] },
    },
  };
}

function tidalIncluded(trackId: string) {
  return [
    {
      type: 'albums',
      id: `album-${trackId}`,
      attributes: { title: `Album ${trackId}`, cover: 'img-id-1', releaseDate: '1991-09-24' },
    },
    { type: 'artists', id: 'artist-1', attributes: { name: 'Main Artist' } },
    { type: 'artists', id: 'artist-2', attributes: { name: 'Feat Artist' } },
  ];
}

describe('TidalProvider.getTracks', () => {
  it('fetches items, batches metadata, maps tracks and inserts placeholders', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { data: { attributes: { numberOfItems: 3, name: 'List' } } },
    });
    // Page of items: two tracks + one non-track item (filtered out)
    h.tidal.getPlaylistItems.mockResolvedValueOnce({
      success: true,
      data: {
        data: [
          { type: 'tracks', id: 't1' },
          { type: 'videos', id: 'v1' },
          { type: 'tracks', id: 't2' },
        ],
        links: {},
      },
    });
    // Metadata only returns t1 -> t2 becomes a placeholder
    h.tidal.getTracks.mockResolvedValueOnce({
      success: true,
      data: { data: [tidalTrack('t1')], included: tidalIncluded('t1') },
    });

    const progress: any[] = [];
    const result = await p.getTracks(UUID, true, undefined, (pr) => progress.push(pr));

    expect(h.tidal.getPlaylistItems).toHaveBeenCalledWith(UUID, 'US', undefined);
    expect(h.tidal.getTracks).toHaveBeenCalledWith(['t1', 't2']);

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2);
    expect(result.data?.tracks[0]).toEqual({
      id: 't1',
      name: 'Track t1',
      artist: 'Main Artist',
      artistsList: ['Main Artist', 'Feat Artist'],
      album: 'Album t1',
      albumImageUrl: 'https://resources.tidal.com/images/img/id/1/640x640.jpg',
      releaseDate: '1991-09-24',
      isrc: 'ISRCt1',
      previewUrl: null,
      duration: 200000, // seconds -> ms
      serviceType: ServiceType.TIDAL,
      serviceLink: 'https://tidal.com/browse/track/t1',
    });
    // Placeholder for the track that metadata did not return
    expect(result.data?.tracks[1]).toEqual({
      id: 't2',
      name: '',
      artist: '',
      artistsList: [],
      album: '',
      albumImageUrl: null,
      releaseDate: null,
      isrc: undefined,
      previewUrl: null,
      duration: undefined,
      serviceType: ServiceType.TIDAL,
      serviceLink: 'https://tidal.com/browse/track/t2',
    });

    expect(progress[0]).toMatchObject({ stage: 'fetching_ids', current: 0, total: 3, percentage: 1 });
    expect(progress[1]).toMatchObject({ stage: 'fetching_metadata', current: 2, total: 3, percentage: 67 });

    expect(h.cacheSet).toHaveBeenCalledWith(`tidal_tracks_${UUID}`, JSON.stringify(result.data));
  });

  it('paginates with the nextCursor until exhausted', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { data: { attributes: { numberOfItems: 2, name: 'Paged' } } },
    });
    h.tidal.getPlaylistItems
      .mockResolvedValueOnce({
        success: true,
        data: {
          data: [{ type: 'tracks', id: 't1' }],
          links: { meta: { nextCursor: 'cursor-2' } },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { data: [{ type: 'tracks', id: 't2' }], links: {} },
      });
    h.tidal.getTracks
      .mockResolvedValueOnce({
        success: true,
        data: { data: [tidalTrack('t1')], included: tidalIncluded('t1') },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { data: [tidalTrack('t2')], included: tidalIncluded('t2') },
      });

    const result = await p.getTracks(UUID);

    expect(h.tidal.getPlaylistItems).toHaveBeenNthCalledWith(1, UUID, 'US', undefined);
    expect(h.tidal.getPlaylistItems).toHaveBeenNthCalledWith(2, UUID, 'US', 'cursor-2');
    expect(result.data?.tracks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('truncates to maxTracks and stops paginating', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { data: { attributes: { numberOfItems: 3 } } },
    });
    h.tidal.getPlaylistItems.mockResolvedValueOnce({
      success: true,
      data: {
        data: [
          { type: 'tracks', id: 't1' },
          { type: 'tracks', id: 't2' },
          { type: 'tracks', id: 't3' },
        ],
        links: { meta: { nextCursor: 'more' } },
      },
    });
    h.tidal.getTracks.mockResolvedValueOnce({
      success: true,
      data: {
        data: [tidalTrack('t1'), tidalTrack('t2'), tidalTrack('t3')],
        included: tidalIncluded('t1'),
      },
    });

    const result = await p.getTracks(UUID, true, 2);
    expect(result.data?.tracks).toHaveLength(2);
    expect(h.tidal.getPlaylistItems).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on a non-429 error for the first page', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({ success: true, data: { data: { attributes: {} } } });
    h.tidal.getPlaylistItems.mockResolvedValueOnce({ success: false, error: 'Tidal API error: 500' });

    const result = await p.getTracks(UUID);
    expect(result).toEqual({ success: false, error: 'Tidal API error: 500' });
    expect(h.tidal.getPlaylistItems).toHaveBeenCalledTimes(1); // no retry
  });

  it('propagates needsReAuth when fetching items requires login', async () => {
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({ success: false });
    h.tidal.getPlaylistItems.mockResolvedValueOnce({ success: false, needsReAuth: true });

    const result = await p.getTracks(UUID);
    expect(result).toEqual({
      success: false,
      error: 'Please connect your Tidal account first',
      needsReAuth: true,
    });
  });

  it('retries with backoff after a 429 and succeeds', async () => {
    vi.useFakeTimers();
    const p = newProvider();
    h.tidal.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { data: { attributes: { numberOfItems: 1 } } },
    });
    h.tidal.getPlaylistItems
      .mockResolvedValueOnce({ success: false, error: 'Tidal API error: 429 Too Many Requests' })
      .mockResolvedValueOnce({
        success: true,
        data: { data: [{ type: 'tracks', id: 't1' }], links: {} },
      });
    h.tidal.getTracks.mockResolvedValueOnce({
      success: true,
      data: { data: [tidalTrack('t1')], included: tidalIncluded('t1') },
    });

    const promise = p.getTracks(UUID);
    // First retry backoff is 2000ms
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(h.tidal.getPlaylistItems).toHaveBeenCalledTimes(2);
    expect(result.data?.tracks.map((t) => t.id)).toEqual(['t1']);
  });

  it('serves the cached track list', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0 };
    h.store.set(`tidal_tracks_${UUID}`, JSON.stringify(cached));
    const result = await p.getTracks(UUID);
    expect(result).toEqual({ success: true, data: cached });
    expect(h.tidal.getPlaylist).not.toHaveBeenCalled();
  });
});

describe('TidalProvider.searchTracks', () => {
  it('searches for IDs, fetches details, parses ISO durations and sharing links', async () => {
    const p = newProvider();
    h.tidal.searchTracks.mockResolvedValueOnce({
      success: true,
      data: {
        included: [
          { type: 'tracks', id: 's1' },
          { type: 'artists', id: 'noise' },
          { type: 'tracks', id: 's2' },
        ],
      },
    });
    h.tidal.getTracks.mockResolvedValueOnce({
      success: true,
      data: {
        data: [
          {
            id: 's1',
            attributes: {
              title: 'ISO Song',
              isrc: 'ISRCS1',
              duration: 'PT2M55S',
              externalLinks: [
                { href: 'https://tidal.com/share/other', meta: { type: 'OTHER' } },
                { href: 'https://tidal.com/share/s1', meta: { type: 'TIDAL_SHARING' } },
              ],
            },
            relationships: {
              albums: { data: [{ id: 'album-s1' }] },
              artists: { data: [{ id: 'artist-1' }] },
            },
          },
          {
            id: 's2',
            attributes: { title: 'Numeric Song', duration: 90 },
            relationships: {},
          },
        ],
        included: [
          {
            type: 'albums',
            id: 'album-s1',
            attributes: { title: 'Album S1', cover: 'cv-1', releaseDate: '2001-01-01' },
          },
          { type: 'artists', id: 'artist-1', attributes: { name: 'Searcher' } },
        ],
      },
    });

    const result = await p.searchTracks('iso song', 10);

    expect(h.tidal.searchTracks).toHaveBeenCalledWith('iso song', 'US', 10);
    expect(h.tidal.getTracks).toHaveBeenCalledWith(['s1', 's2']);

    expect(result.success).toBe(true);
    expect(result.data?.tracks[0]).toMatchObject({
      id: 's1',
      name: 'ISO Song',
      artist: 'Searcher',
      album: 'Album S1',
      releaseDate: '2001-01-01',
      isrc: 'ISRCS1',
      duration: 175000, // PT2M55S
      serviceLink: 'https://tidal.com/share/s1', // TIDAL_SHARING link preferred
    });
    expect(result.data?.tracks[1]).toMatchObject({
      id: 's2',
      artist: 'Unknown Artist',
      duration: 90000, // numeric seconds
      serviceLink: 'https://tidal.com/browse/track/s2', // fallback link
    });
    expect(result.data?.hasMore).toBe(false);

    expect(h.cacheSet).toHaveBeenCalledWith(
      'tidal_search_iso song_10_0',
      JSON.stringify(result.data),
      3600
    );
  });

  it('returns an empty result when the search has no track IDs', async () => {
    const p = newProvider();
    h.tidal.searchTracks.mockResolvedValueOnce({ success: true, data: { included: [] } });
    const result = await p.searchTracks('nothing');
    expect(result).toEqual({ success: true, data: { tracks: [], total: 0, hasMore: false } });
    expect(h.tidal.getTracks).not.toHaveBeenCalled();
  });

  it('propagates needsReAuth from search', async () => {
    const p = newProvider();
    h.tidal.searchTracks.mockResolvedValueOnce({ success: false, needsReAuth: true });
    const result = await p.searchTracks('q');
    expect(result).toEqual({
      success: false,
      error: 'Please connect your Tidal account first',
      needsReAuth: true,
    });
  });

  it('fails when the details fetch fails', async () => {
    const p = newProvider();
    h.tidal.searchTracks.mockResolvedValueOnce({
      success: true,
      data: { included: [{ type: 'tracks', id: 's1' }] },
    });
    h.tidal.getTracks.mockResolvedValueOnce({ success: false, error: 'details broke' });
    const result = await p.searchTracks('q');
    expect(result).toEqual({ success: false, error: 'details broke' });
  });

  it('serves repeated searches from cache', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0, hasMore: false };
    h.store.set('tidal_search_cached_10_0', JSON.stringify(cached));
    const result = await p.searchTracks('cached');
    expect(result).toEqual({ success: true, data: cached });
    expect(h.tidal.searchTracks).not.toHaveBeenCalled();
  });
});

describe('TidalProvider OAuth + connection', () => {
  it('delegates getAuthorizationUrl to the Tidal API', () => {
    expect(newProvider().getAuthorizationUrl()).toBe(
      'https://login.tidal.com/authorize?client_id=x'
    );
  });

  it('returns a stored marker on successful auth callback', async () => {
    h.tidal.exchangeCodeForToken.mockResolvedValueOnce({ success: true });
    const result = await newProvider().handleAuthCallback('the-code');
    expect(h.tidal.exchangeCodeForToken).toHaveBeenCalledWith('the-code');
    expect(result).toEqual({ success: true, data: { accessToken: 'stored' } });
  });

  it('propagates auth callback failures', async () => {
    h.tidal.exchangeCodeForToken.mockResolvedValueOnce({ success: false, error: 'bad code' });
    const result = await newProvider().handleAuthCallback('x');
    expect(result).toEqual({ success: false, error: 'bad code' });
  });

  it('delegates isConnected and disconnect', async () => {
    h.tidal.isConnected.mockResolvedValueOnce(true);
    const p = newProvider();
    expect(await p.isConnected()).toBe(true);
    await p.disconnect();
    expect(h.tidal.clearTokens).toHaveBeenCalledTimes(1);
  });
});

describe('TidalProvider.getInstance', () => {
  it('returns a singleton', () => {
    expect(TidalProvider.getInstance()).toBe(TidalProvider.getInstance());
  });
});
