import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for YouTubeMusicProvider: URL validation, innertube request
 * building (VL browseId prefix, API key), continuation-based pagination,
 * innertube response parsing (titles, artists, durations, thumbnails,
 * UGC "Artist - Title" splitting), search via ytmusic-api (including the
 * 400 re-initialize retry) and radio-playlist error mapping.
 *
 * Mocked: ytmusic-api, axios, Redis cache, logger, utils.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string, _ttl?: number) => {
      store.set(key, value);
    }),
    axiosPost: vi.fn(),
    axiosCreate: vi.fn(),
    ytInitialize: vi.fn(async () => undefined),
    ytSearchSongs: vi.fn(),
    ytConstructed: 0,
  };
});

vi.mock('ytmusic-api', () => ({
  default: class FakeYTMusic {
    constructor() {
      h.ytConstructed++;
    }
    initialize = h.ytInitialize;
    searchSongs = h.ytSearchSongs;
  },
}));

vi.mock('axios', () => {
  h.axiosCreate.mockImplementation(() => ({ post: h.axiosPost }));
  return { default: { create: h.axiosCreate } };
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

import YouTubeMusicProvider from '../../../src/providers/YouTubeMusicProvider';
import { ServiceType } from '../../../src/enums/ServiceType';

const API_URL =
  'https://www.youtube.com/youtubei/v1/browse?key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';

beforeEach(() => {
  h.store.clear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  h.axiosPost.mockReset();
  h.ytInitialize.mockClear();
  h.ytSearchSongs.mockReset();
  delete process.env['YOUTUBE_MUSIC_COOKIES'];
});

function newProvider(): YouTubeMusicProvider {
  return new YouTubeMusicProvider();
}

/** Build a musicResponsiveListItemRenderer item for the innertube response. */
function videoItem(opts: {
  videoId?: string;
  title: string;
  artist?: string;
  videoType?: string | null;
  duration?: string;
  thumbnails?: Array<{ url: string; width: number; height: number }>;
}) {
  const titleRun: any = { text: opts.title };
  if (opts.videoType) {
    titleRun.navigationEndpoint = {
      watchEndpoint: {
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: { musicVideoType: opts.videoType },
        },
      },
    };
  }
  const item: any = {
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [titleRun] } } },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: {
            runs: [{ text: opts.artist ?? 'Some Artist' }, { text: ' • ' }, { text: 'Some Album' }],
          },
        },
      },
    ],
    thumbnail: {
      musicThumbnailRenderer: {
        thumbnail: {
          thumbnails: opts.thumbnails ?? [
            { url: 'https://thumb/small.jpg', width: 60, height: 60 },
            { url: 'https://thumb/large.jpg', width: 544, height: 544 },
          ],
        },
      },
    },
  };
  if (opts.videoId) {
    item.playlistItemData = { videoId: opts.videoId };
  }
  if (opts.duration) {
    item.fixedColumns = [
      {
        musicResponsiveListItemFixedColumnRenderer: {
          text: { runs: [{ text: opts.duration }] },
        },
      },
    ];
  }
  return { musicResponsiveListItemRenderer: item };
}

/** Build an innertube browse response with header metadata + shelf contents. */
function playlistResponse(opts: {
  title?: string;
  songsText?: string;
  items: any[];
  continuationToken?: string;
}) {
  const contents = [...opts.items];
  if (opts.continuationToken) {
    contents.push({
      continuationItemRenderer: {
        continuationEndpoint: {
          continuationCommand: { token: opts.continuationToken },
          clickTrackingParams: 'itct-token',
        },
      },
    });
  }
  return {
    header: {
      musicDetailHeaderRenderer: {
        title: { runs: [{ text: opts.title ?? 'Test Playlist' }] },
        description: { runs: [{ text: 'A description' }] },
        thumbnail: {
          musicThumbnailRenderer: {
            thumbnail: {
              thumbnails: [
                { url: 'https://cover/small.jpg', width: 226, height: 226 },
                { url: 'https://cover/large.jpg', width: 544, height: 544 },
              ],
            },
          },
        },
        secondSubtitle: { runs: [{ text: opts.songsText ?? '' }] },
      },
    },
    contents: { wrapper: { musicPlaylistShelfRenderer: { contents } } },
  };
}

describe('YouTubeMusicProvider config', () => {
  it('exposes the youtube_music service type and config', () => {
    const p = newProvider();
    expect(p.serviceType).toBe(ServiceType.YOUTUBE_MUSIC);
    expect(p.config).toMatchObject({
      serviceType: ServiceType.YOUTUBE_MUSIC,
      supportsOAuth: false,
      supportsPublicPlaylists: true,
      supportsPlaylistCreation: false,
    });
  });
});

describe('YouTubeMusicProvider.validateUrl', () => {
  const p = newProvider();

  it('accepts music.youtube.com playlist URLs', () => {
    expect(p.validateUrl('https://music.youtube.com/playlist?list=PLabc_DEF-123')).toEqual({
      isValid: true,
      isServiceUrl: true,
      resourceType: 'playlist',
      resourceId: 'PLabc_DEF-123',
    });
  });

  it('accepts music.youtube.com watch URLs containing a list param', () => {
    const r = p.validateUrl('https://music.youtube.com/watch?v=abc123&list=RDCLAK5uy_456');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('RDCLAK5uy_456');
  });

  it('accepts regular youtube.com playlist URLs (with and without www)', () => {
    expect(p.validateUrl('https://www.youtube.com/playlist?list=PLfoo').resourceId).toBe('PLfoo');
    expect(p.validateUrl('https://youtube.com/playlist?list=PLbar').resourceId).toBe('PLbar');
  });

  it('accepts youtube.com watch URLs with a list param', () => {
    const r = p.validateUrl('https://www.youtube.com/watch?v=abc&list=PLwatch1');
    expect(r.isValid).toBe(true);
    expect(r.resourceId).toBe('PLwatch1');
  });

  it('trims surrounding whitespace', () => {
    expect(p.validateUrl('  https://music.youtube.com/playlist?list=PLtrim  ').isValid).toBe(true);
  });

  it('flags YouTube URLs without a playlist as not_playlist', () => {
    expect(p.validateUrl('https://music.youtube.com/channel/UCx')).toEqual({
      isValid: false,
      isServiceUrl: true,
      errorType: 'not_playlist',
    });
    expect(p.validateUrl('https://www.youtube.com/watch?v=abc')).toEqual({
      isValid: false,
      isServiceUrl: true,
      errorType: 'not_playlist',
    });
  });

  it('rejects non-YouTube URLs', () => {
    expect(p.validateUrl('https://tidal.com/browse/playlist/x')).toEqual({
      isValid: false,
      isServiceUrl: false,
    });
  });
});

describe('YouTubeMusicProvider.extractPlaylistId', () => {
  const p = newProvider();
  it('extracts the list ID or returns null', () => {
    expect(p.extractPlaylistId('https://music.youtube.com/playlist?list=PLxyz')).toBe('PLxyz');
    expect(p.extractPlaylistId('https://music.youtube.com/')).toBeNull();
  });
});

describe('YouTubeMusicProvider.getPlaylist', () => {
  it('posts to the innertube API with a VL-prefixed browseId and maps metadata', async () => {
    const p = newProvider();
    h.axiosPost.mockResolvedValueOnce({
      data: playlistResponse({
        title: 'Road Trip',
        songsText: '1,962 songs',
        items: [videoItem({ videoId: 'v1', title: 'A', videoType: 'MUSIC_VIDEO_TYPE_ATV' })],
      }),
    });

    const result = await p.getPlaylist('PLabc123');

    expect(h.axiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = h.axiosPost.mock.calls[0];
    expect(url).toBe(API_URL);
    expect(body.browseId).toBe('VLPLabc123');
    expect(body.context.client.clientName).toBe('WEB_REMIX');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 'PLabc123',
      name: 'Road Trip',
      description: 'A description',
      imageUrl: 'https://cover/large.jpg', // widest thumbnail wins
      trackCount: 1962, // thousands separator stripped
      serviceType: ServiceType.YOUTUBE_MUSIC,
      originalUrl: 'https://music.youtube.com/playlist?list=PLabc123',
    });
    expect(h.cacheSet).toHaveBeenCalledWith('yt_playlist_PLabc123', JSON.stringify(result.data));
  });

  it('does not double-prefix an already VL-prefixed ID', async () => {
    const p = newProvider();
    h.axiosPost.mockResolvedValueOnce({ data: playlistResponse({ items: [] }) });
    await p.getPlaylist('VLPLalready');
    expect(h.axiosPost.mock.calls[0][1].browseId).toBe('VLPLalready');
  });

  it('falls back to the video count when the header has no track count', async () => {
    const p = newProvider();
    h.axiosPost.mockResolvedValueOnce({
      data: playlistResponse({
        items: [
          videoItem({ videoId: 'v1', title: 'A' }),
          videoItem({ videoId: 'v2', title: 'B' }),
        ],
      }),
    });
    const result = await p.getPlaylist('PLcount');
    expect(result.data?.trackCount).toBe(2);
  });

  it('serves from cache and bypasses with cache=false', async () => {
    const p = newProvider();
    const cached = { id: 'PLc', name: 'Cached' };
    h.store.set('yt_playlist_PLc', JSON.stringify(cached));

    expect(await p.getPlaylist('PLc')).toEqual({ success: true, data: cached });
    expect(h.axiosPost).not.toHaveBeenCalled();

    h.axiosPost.mockResolvedValueOnce({ data: playlistResponse({ title: 'Fresh', items: [] }) });
    const fresh = await p.getPlaylist('PLc', false);
    expect(fresh.data?.name).toBe('Fresh');
  });

  it('maps 400 errors on radio (RD) playlists to a friendly message', async () => {
    const p = newProvider();
    h.axiosPost.mockRejectedValueOnce(new Error('Request failed with status code 400'));
    const result = await p.getPlaylist('RDAMVMxyz');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Radio/auto-generated playlists are not supported');
  });

  it('returns the raw error for non-radio playlists', async () => {
    const p = newProvider();
    h.axiosPost.mockRejectedValueOnce(new Error('Request failed with status code 400'));
    const result = await p.getPlaylist('PLnormal');
    expect(result).toEqual({ success: false, error: 'Request failed with status code 400' });
  });
});

describe('YouTubeMusicProvider.getTracks', () => {
  it('maps catalog tracks: artist kept, duration to ms, best thumbnail, watch link', async () => {
    const p = newProvider();
    h.axiosPost.mockResolvedValueOnce({
      data: playlistResponse({
        songsText: '2 songs',
        items: [
          videoItem({
            videoId: 'vid1',
            title: 'Bohemian Rhapsody',
            artist: 'Queen',
            videoType: 'MUSIC_VIDEO_TYPE_ATV',
            duration: '5:55',
          }),
          videoItem({
            videoId: 'vid2',
            title: 'Long One',
            artist: 'Band',
            videoType: 'MUSIC_VIDEO_TYPE_OMV',
            duration: '1:02:03',
          }),
        ],
      }),
    });

    const result = await p.getTracks('PLtracks');
    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(2);
    expect(result.data?.tracks[0]).toEqual({
      id: 'vid1',
      name: 'Bohemian Rhapsody',
      artist: 'Queen',
      artistsList: ['Queen'],
      album: '',
      albumImageUrl: 'https://thumb/large.jpg',
      releaseDate: null,
      isrc: undefined,
      previewUrl: null,
      duration: 355000, // 5:55 -> ms
      serviceType: ServiceType.YOUTUBE_MUSIC,
      serviceLink: 'https://music.youtube.com/watch?v=vid1',
    });
    // h:mm:ss durations
    expect(result.data?.tracks[1].duration).toBe(3723000);
    expect(result.data?.skipped?.total).toBe(0);
    expect(h.cacheSet).toHaveBeenCalledWith('yt_tracks_PLtracks', JSON.stringify(result.data));
  });

  it('splits "Artist - Title" for non-catalog (UGC) uploads', async () => {
    const p = newProvider();
    h.axiosPost.mockResolvedValueOnce({
      data: playlistResponse({
        items: [
          // UGC upload titled "Artist - Title": channel name must be replaced
          videoItem({
            videoId: 'ugc1',
            title: 'Queen - Bohemian Rhapsody',
            artist: 'RandomChannel',
            videoType: 'MUSIC_VIDEO_TYPE_UGC',
          }),
          // Catalog track with a dash keeps its real artist and full title
          videoItem({
            videoId: 'atv1',
            title: 'Song - Live Version',
            artist: 'Real Artist',
            videoType: 'MUSIC_VIDEO_TYPE_ATV',
          }),
        ],
      }),
    });

    const result = await p.getTracks('PLugc');
    expect(result.data?.tracks[0]).toMatchObject({
      name: 'Bohemian Rhapsody',
      artist: 'Queen',
    });
    expect(result.data?.tracks[1]).toMatchObject({
      name: 'Song - Live Version',
      artist: 'Real Artist',
    });
  });

  it('skips items without a videoId', async () => {
    const p = newProvider();
    h.axiosPost.mockResolvedValueOnce({
      data: playlistResponse({
        items: [
          videoItem({ title: 'No Video Id Here' }), // no videoId
          videoItem({ videoId: 'ok1', title: 'Fine' }),
        ],
      }),
    });
    const result = await p.getTracks('PLskip');
    expect(result.data?.tracks.map((t) => t.id)).toEqual(['ok1']);
  });

  it('follows continuation tokens across pages and reports progress', async () => {
    const p = newProvider();
    h.axiosPost
      .mockResolvedValueOnce({
        data: playlistResponse({
          songsText: '3 songs',
          items: [
            videoItem({ videoId: 'p1a', title: 'One' }),
            videoItem({ videoId: 'p1b', title: 'Two' }),
          ],
          continuationToken: 'CONT_TOKEN_1',
        }),
      })
      .mockResolvedValueOnce({
        data: playlistResponse({
          items: [videoItem({ videoId: 'p2a', title: 'Three' })],
        }),
      });

    const progress: any[] = [];
    const result = await p.getTracks('PLpaged', true, undefined, (pr) => progress.push(pr));

    expect(h.axiosPost).toHaveBeenCalledTimes(2);
    const secondBody = h.axiosPost.mock.calls[1][1];
    expect(secondBody.continuation).toBe('CONT_TOKEN_1');
    expect(secondBody.browseId).toBeUndefined();

    expect(result.data?.tracks.map((t) => t.id)).toEqual(['p1a', 'p1b', 'p2a']);

    expect(progress[0]).toMatchObject({ stage: 'fetching_ids', current: 0, percentage: 1 });
    expect(progress[1]).toMatchObject({ stage: 'fetching_metadata', current: 2, total: 3, percentage: 67 });
    expect(progress[2]).toMatchObject({ stage: 'fetching_metadata', current: 3, total: 3, percentage: 99 });
  });

  it('serves the cached track list without calling the API', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0 };
    h.store.set('yt_tracks_PLc', JSON.stringify(cached));
    const result = await p.getTracks('PLc');
    expect(result).toEqual({ success: true, data: cached });
    expect(h.axiosPost).not.toHaveBeenCalled();
  });

  it('maps 400 errors on radio playlists to a friendly message', async () => {
    const p = newProvider();
    h.axiosPost.mockRejectedValueOnce(new Error('Request failed with status code 400'));
    const result = await p.getTracks('RDradio1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Radio/auto-generated playlists are not supported');
  });
});

describe('YouTubeMusicProvider.searchTracks', () => {
  const songs = [
    {
      videoId: 's1',
      name: 'Song One',
      artist: { name: 'Artist One' },
      album: { name: 'Album One' },
      thumbnails: [
        { url: 'https://t/s1-small.jpg', width: 60, height: 60 },
        { url: 'https://t/s1-big.jpg', width: 226, height: 226 },
      ],
      duration: 215,
    },
    {
      videoId: 's2',
      name: 'Song Two',
      artist: { name: 'Artist Two' },
      album: null,
      thumbnails: [],
      duration: null,
    },
    {
      videoId: 's3',
      name: 'Song Three',
      artist: { name: 'Artist Three' },
      album: { name: 'Album Three' },
      thumbnails: [],
      duration: 100,
    },
  ];

  it('initializes the client once, maps songs and paginates with offset/limit', async () => {
    const p = newProvider();
    h.ytSearchSongs.mockResolvedValue(songs);

    const result = await p.searchTracks('queen', 2, 0);

    expect(h.ytInitialize).toHaveBeenCalledTimes(1);
    expect(h.ytSearchSongs).toHaveBeenCalledWith('queen');
    expect(result.success).toBe(true);
    expect(result.data?.tracks).toHaveLength(2);
    expect(result.data?.tracks[0]).toEqual({
      id: 's1',
      name: 'Song One',
      artist: 'Artist One',
      artistsList: ['Artist One'],
      album: 'Album One',
      albumImageUrl: 'https://t/s1-big.jpg',
      releaseDate: null,
      isrc: undefined,
      previewUrl: null,
      duration: 215,
      serviceType: ServiceType.YOUTUBE_MUSIC,
      serviceLink: 'https://music.youtube.com/watch?v=s1',
    });
    // album null -> '', duration null -> undefined
    expect(result.data?.tracks[1].album).toBe('');
    expect(result.data?.tracks[1].duration).toBeUndefined();
    expect(result.data?.total).toBe(3);
    expect(result.data?.hasMore).toBe(true); // offset 0 + limit 2 < 3

    // 30 minute TTL for search results
    expect(h.cacheSet).toHaveBeenCalledWith('yt_search_queen_2_0', JSON.stringify(result.data), 1800);
  });

  it('reports hasMore=false on the last page', async () => {
    const p = newProvider();
    h.ytSearchSongs.mockResolvedValue(songs);
    const result = await p.searchTracks('queen', 2, 2);
    expect(result.data?.tracks.map((t) => t.id)).toEqual(['s3']);
    expect(result.data?.hasMore).toBe(false);
  });

  it('re-initializes a fresh client and retries when search throws a 400', async () => {
    const p = newProvider();
    const constructedBefore = h.ytConstructed;
    h.ytSearchSongs
      .mockRejectedValueOnce(new Error('Request failed with status code 400'))
      .mockResolvedValueOnce(songs);

    const result = await p.searchTracks('retry me');

    expect(result.success).toBe(true);
    expect(h.ytSearchSongs).toHaveBeenCalledTimes(2);
    // reinitialize() replaces the YTMusic instance
    expect(h.ytConstructed).toBe(constructedBefore + 1);
    expect(h.ytInitialize).toHaveBeenCalledTimes(2);
  });

  it('fails on non-400 errors without retrying', async () => {
    const p = newProvider();
    h.ytSearchSongs.mockRejectedValueOnce(new Error('network down'));
    const result = await p.searchTracks('boom');
    expect(result).toEqual({ success: false, error: 'network down' });
    expect(h.ytSearchSongs).toHaveBeenCalledTimes(1);
  });

  it('serves repeated searches from cache', async () => {
    const p = newProvider();
    const cached = { tracks: [], total: 0, hasMore: false };
    h.store.set('yt_search_cached_20_0', JSON.stringify(cached));
    const result = await p.searchTracks('cached');
    expect(result).toEqual({ success: true, data: cached });
    expect(h.ytSearchSongs).not.toHaveBeenCalled();
  });
});

describe('YouTubeMusicProvider OAuth stubs', () => {
  it('does not provide an authorization URL', () => {
    expect(newProvider().getAuthorizationUrl()).toBeNull();
  });

  it('rejects OAuth callbacks', async () => {
    const result = await newProvider().handleAuthCallback('code');
    expect(result.success).toBe(false);
    expect(result.error).toContain('OAuth not supported');
  });
});

describe('YouTubeMusicProvider.getInstance', () => {
  it('returns a singleton', () => {
    expect(YouTubeMusicProvider.getInstance()).toBe(YouTubeMusicProvider.getInstance());
  });
});
