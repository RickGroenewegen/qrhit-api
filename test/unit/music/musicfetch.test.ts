import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

/**
 * Unit tests for src/musicfetch.ts with every I/O collaborator mocked:
 * axios (MusicFetch API), Bottleneck (rate limiter -> pass-through),
 * prisma, cache (Map-backed), logger (no-op) and ExternalCardService.
 *
 * MusicFetch instantiates all collaborators as instance-member
 * initializers, so all mocks are registered before the module import.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    axiosGet: vi.fn(),
    cacheStore,
    cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string) => {
      cacheStore.set(key, value);
    }),
    cacheDel: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    updateCardsWithSpotifyIdInCache: vi.fn(async () => undefined),
    prisma: {
      track: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      playlistHasTrack: {
        findMany: vi.fn(),
      },
      externalCard: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

vi.mock('axios', () => {
  const axios = {
    create: () => ({ get: h.axiosGet }),
    isAxiosError: (e: any) => e?.isAxiosError === true,
  };
  return { default: axios };
});

// Real Bottleneck would space calls 12s apart (5/min); pass straight through.
vi.mock('bottleneck', () => ({
  default: class {
    schedule(fn: () => any) {
      return fn();
    }
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: h.cacheGet,
      set: h.cacheSet,
      del: h.cacheDel,
    }),
  },
}));

vi.mock('../../../src/externalCardService', () => ({
  default: {
    getInstance: () => ({
      updateCardsWithSpotifyIdInCache: h.updateCardsWithSpotifyIdInCache,
    }),
  },
}));

process.env['MUSICFETCH_API_KEY'] = 'test-key';

import MusicFetch from '../../../src/musicfetch';

const mf = MusicFetch.getInstance();

const SPOTIFY_URL = 'https://open.spotify.com/track/abc123';

function fullServicesResponse() {
  return {
    data: {
      result: {
        services: {
          spotify: { link: 'https://open.spotify.com/track/abc123' },
          deezer: { link: 'https://www.deezer.com/track/1' },
          youtubeMusic: { link: 'https://music.youtube.com/watch?v=x' },
          appleMusic: { link: 'https://music.apple.com/nl/song/1' },
          amazonMusic: { link: 'https://music.amazon.com/tracks/1' },
          tidal: { link: 'https://tidal.com/browse/track/1' },
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cacheStore.clear();
});

describe('fetchLinksForTrack', () => {
  it('fails fast without an API key and never calls the API', async () => {
    const saved = process.env['MUSICFETCH_API_KEY'];
    delete process.env['MUSICFETCH_API_KEY'];
    try {
      const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
      expect(res).toEqual({ success: false, error: 'API key not configured' });
      expect(h.axiosGet).not.toHaveBeenCalled();
    } finally {
      process.env['MUSICFETCH_API_KEY'] = saved;
    }
  });

  it('requests /url with the source url, all six services and country NL', async () => {
    h.axiosGet.mockResolvedValueOnce(fullServicesResponse());
    await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(h.axiosGet).toHaveBeenCalledWith('/url', {
      params: {
        url: SPOTIFY_URL,
        services: 'spotify,deezer,youtubeMusic,appleMusic,amazonMusic,tidal',
        country: 'NL',
      },
    });
  });

  it('maps every service link from the response', async () => {
    h.axiosGet.mockResolvedValueOnce(fullServicesResponse());
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res.success).toBe(true);
    expect(res.links).toEqual({
      spotifyLink: 'https://open.spotify.com/track/abc123',
      deezerLink: 'https://www.deezer.com/track/1',
      youtubeMusicLink: 'https://music.youtube.com/watch?v=x',
      appleMusicLink: 'https://music.apple.com/nl/song/1',
      amazonMusicLink: 'https://music.amazon.com/tracks/1',
      tidalLink: 'https://tidal.com/browse/track/1',
    });
  });

  it('returns null for services missing from the response', async () => {
    h.axiosGet.mockResolvedValueOnce({
      data: {
        result: {
          services: { deezer: { link: 'https://www.deezer.com/track/9' } },
        },
      },
    });
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res.links).toEqual({
      spotifyLink: null,
      deezerLink: 'https://www.deezer.com/track/9',
      youtubeMusicLink: null,
      appleMusicLink: null,
      amazonMusicLink: null,
      tidalLink: null,
    });
  });

  it('strips the source field from the returned links', async () => {
    h.axiosGet.mockResolvedValueOnce(fullServicesResponse());
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL, 'spotifyLink');
    expect(res.links).not.toHaveProperty('spotifyLink');
    expect(res.links?.deezerLink).toBe('https://www.deezer.com/track/1');
  });

  it('ignores a sourceField that is not a known link field', async () => {
    h.axiosGet.mockResolvedValueOnce(fullServicesResponse());
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL, 'bogusField');
    expect(Object.keys(res.links!)).toHaveLength(6);
  });

  it('fails with "No services in response" when result.services is absent', async () => {
    h.axiosGet.mockResolvedValueOnce({ data: { result: {} } });
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res).toEqual({ success: false, error: 'No services in response' });
  });

  it('treats a 404 as success with notFound and empty links', async () => {
    h.axiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
    });
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res).toEqual({ success: true, notFound: true, links: {} });
  });

  it('flags 429 responses as rateLimited', async () => {
    h.axiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 429 },
    });
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res).toEqual({
      success: false,
      error: 'Rate limit exceeded',
      rateLimited: true,
    });
  });

  it('returns the axios error message for other HTTP failures', async () => {
    h.axiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'Request failed with status code 500',
      response: { status: 500 },
    });
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res).toEqual({
      success: false,
      error: 'Request failed with status code 500',
    });
    expect(res).not.toHaveProperty('rateLimited');
  });

  it('returns the plain error message for non-axios errors', async () => {
    h.axiosGet.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await mf.fetchLinksForTrack(SPOTIFY_URL);
    expect(res).toEqual({ success: false, error: 'socket hang up' });
  });
});

describe('findAvailableLink / getMissingLinkFields (private helpers)', () => {
  const find = (track: Record<string, any>) =>
    (mf as any).findAvailableLink(track);
  const missing = (track: Record<string, any>) =>
    (mf as any).getMissingLinkFields(track);

  it('prefers spotify over every other link', () => {
    expect(
      find({ spotifyLink: 's-url', youtubeMusicLink: 'y-url', tidalLink: 't' })
    ).toEqual({ url: 's-url', field: 'spotifyLink' });
  });

  it('falls back in order spotify > youtubeMusic > deezer > apple > amazon > tidal', () => {
    expect(find({ deezerLink: 'd', tidalLink: 't' })).toEqual({
      url: 'd',
      field: 'deezerLink',
    });
    expect(find({ amazonMusicLink: 'a', tidalLink: 't' })).toEqual({
      url: 'a',
      field: 'amazonMusicLink',
    });
    expect(find({ tidalLink: 't' })).toEqual({ url: 't', field: 'tidalLink' });
  });

  it('returns null when no link is set (null/empty values do not count)', () => {
    expect(find({})).toBeNull();
    expect(find({ spotifyLink: null, deezerLink: '' })).toBeNull();
  });

  it('lists missing fields in canonical order', () => {
    expect(missing({ spotifyLink: 's', appleMusicLink: 'a' })).toEqual([
      'youtubeMusicLink',
      'deezerLink',
      'amazonMusicLink',
      'tidalLink',
    ]);
    expect(
      missing({
        spotifyLink: 's',
        youtubeMusicLink: 'y',
        deezerLink: 'd',
        appleMusicLink: 'a',
        amazonMusicLink: 'am',
        tidalLink: 't',
      })
    ).toEqual([]);
  });
});

describe('updateTrackWithLinks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(mf, 'fetchLinksForTrack');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const baseTrack = {
    name: 'Song',
    artist: 'Artist',
    musicFetchAttempts: 0,
    spotifyLink: SPOTIFY_URL,
    youtubeMusicLink: null,
    deezerLink: null,
    appleMusicLink: null,
    amazonMusicLink: null,
    tidalLink: null,
  };

  it('returns false when the track does not exist', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce(null);
    expect(await mf.updateTrackWithLinks(1)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.prisma.track.update).not.toHaveBeenCalled();
  });

  it('returns false at 3 attempts unless forceUpdate is set', async () => {
    h.prisma.track.findUnique.mockResolvedValue({
      ...baseTrack,
      musicFetchAttempts: 3,
    });
    expect(await mf.updateTrackWithLinks(1)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockResolvedValueOnce({ success: true, links: {} });
    h.prisma.track.update.mockResolvedValueOnce({});
    expect(await mf.updateTrackWithLinks(1, true)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    h.prisma.track.findUnique.mockReset();
  });

  it('returns false when the track has no source link at all', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce({
      ...baseTrack,
      spotifyLink: null,
    });
    expect(await mf.updateTrackWithLinks(1)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the first available link by preference as the fetch source', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce({
      ...baseTrack,
      spotifyLink: null,
      youtubeMusicLink: 'yt-url',
      deezerLink: 'dz-url',
    });
    fetchSpy.mockResolvedValueOnce({ success: true, links: {} });
    h.prisma.track.update.mockResolvedValueOnce({});
    await mf.updateTrackWithLinks(1);
    expect(fetchSpy).toHaveBeenCalledWith('yt-url', 'youtubeMusicLink');
  });

  it('does not touch the DB (no attempt increment) when rate limited', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce(baseTrack);
    fetchSpy.mockResolvedValueOnce({
      success: false,
      error: 'Rate limit exceeded',
      rateLimited: true,
    });
    expect(await mf.updateTrackWithLinks(1)).toBe(false);
    expect(h.prisma.track.update).not.toHaveBeenCalled();
  });

  it('only fills in missing fields and always increments attempts', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce({
      ...baseTrack,
      deezerLink: 'existing-deezer',
    });
    fetchSpy.mockResolvedValueOnce({
      success: true,
      links: {
        deezerLink: 'new-deezer', // already present -> must not overwrite
        tidalLink: 'new-tidal',
        amazonMusicLink: 'new-amazon',
        youtubeMusicLink: null,
        appleMusicLink: null,
      },
    });
    h.prisma.track.update.mockResolvedValueOnce({});

    expect(await mf.updateTrackWithLinks(42)).toBe(true);

    expect(h.prisma.track.update).toHaveBeenCalledTimes(1);
    const call = h.prisma.track.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 42 });
    expect(call.data.tidalLink).toBe('new-tidal');
    expect(call.data.amazonMusicLink).toBe('new-amazon');
    expect(call.data.musicFetchAttempts).toEqual({ increment: 1 });
    expect(call.data.musicFetchLastAttempt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty('deezerLink');
    expect(call.data).not.toHaveProperty('spotifyLink');
    expect(call.data).not.toHaveProperty('youtubeMusicLink');
    expect(call.data).not.toHaveProperty('appleMusicLink');
  });

  it('still increments attempts and returns true on a 404 (notFound) result', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce(baseTrack);
    fetchSpy.mockResolvedValueOnce({ success: true, notFound: true, links: {} });
    h.prisma.track.update.mockResolvedValueOnce({});

    expect(await mf.updateTrackWithLinks(7)).toBe(true);
    const call = h.prisma.track.update.mock.calls[0][0];
    expect(Object.keys(call.data).sort()).toEqual([
      'musicFetchAttempts',
      'musicFetchLastAttempt',
    ]);
  });

  it('swallows DB errors and returns false', async () => {
    h.prisma.track.findUnique.mockResolvedValueOnce(baseTrack);
    fetchSpy.mockResolvedValueOnce({ success: true, links: {} });
    h.prisma.track.update.mockRejectedValueOnce(new Error('db down'));
    expect(await mf.updateTrackWithLinks(1)).toBe(false);
  });
});

describe('processPlaylistTracks', () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateSpy = vi
      .spyOn(mf, 'updateTrackWithLinks')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    updateSpy.mockRestore();
  });

  const track = (id: number, overrides: Record<string, any> = {}) => ({
    track: {
      id,
      name: `t${id}`,
      artist: 'a',
      spotifyLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      appleMusicLink: null,
      amazonMusicLink: null,
      tidalLink: null,
      musicFetchAttempts: 0,
      ...overrides,
    },
  });

  it('only processes tracks with a source link, a missing link and attempts < 3', async () => {
    h.prisma.playlistHasTrack.findMany.mockResolvedValueOnce([
      // complete track: nothing missing -> skip
      track(1, {
        spotifyLink: 's',
        youtubeMusicLink: 'y',
        deezerLink: 'd',
        appleMusicLink: 'ap',
        amazonMusicLink: 'am',
        tidalLink: 't',
      }),
      // no source link at all -> skip
      track(2),
      // maxed-out attempts -> skip
      track(3, { spotifyLink: 's', musicFetchAttempts: 3 }),
      // eligible
      track(4, { spotifyLink: 's' }),
    ]);

    await mf.processPlaylistTracks(99);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(4);
  });

  it('does nothing when no track qualifies', async () => {
    h.prisma.playlistHasTrack.findMany.mockResolvedValueOnce([track(1)]);
    await mf.processPlaylistTracks(99);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('never throws when the playlist query fails', async () => {
    h.prisma.playlistHasTrack.findMany.mockRejectedValueOnce(
      new Error('boom')
    );
    await expect(mf.processPlaylistTracks(99)).resolves.toBeUndefined();
  });
});

describe('processBulkTracks (specific trackIds batch)', () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateSpy = vi.spyOn(mf, 'updateTrackWithLinks');
  });

  afterEach(() => {
    updateSpy.mockRestore();
  });

  const row = (id: number, overrides: Record<string, any> = {}) => ({
    id,
    spotifyLink: null,
    youtubeMusicLink: null,
    deezerLink: null,
    appleMusicLink: null,
    amazonMusicLink: null,
    tidalLink: null,
    musicFetchAttempts: 0,
    name: `t${id}`,
    artist: 'a',
    ...overrides,
  });

  it('counts successes, failures and skips correctly', async () => {
    h.prisma.track.findMany.mockResolvedValueOnce([
      row(1, { spotifyLink: 's' }), // success
      row(2), // no source link -> skipped
      row(3, { spotifyLink: 's', musicFetchAttempts: 3 }), // maxed -> skipped
      row(4, { tidalLink: 't' }), // failure
    ]);
    updateSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await mf.processBulkTracks([1, 2, 3, 4]);

    expect(updateSpy.mock.calls.map((c) => c[0])).toEqual([1, 4]);
    expect(res).toEqual({
      totalProcessed: 4,
      successful: 1,
      failed: 1,
      skipped: 2,
      errors: [{ trackId: 4, error: 'Failed to fetch or update links' }],
    });
  });

  it('returns an all-zero result when nothing matches', async () => {
    h.prisma.track.findMany.mockResolvedValueOnce([]);
    const res = await mf.processBulkTracks([123]);
    expect(res).toEqual({
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('returns the partial result instead of throwing when the query fails', async () => {
    h.prisma.track.findMany.mockRejectedValueOnce(new Error('db down'));
    const res = await mf.processBulkTracks([1]);
    expect(res.totalProcessed).toBe(0);
    expect(res.errors).toEqual([]);
  });
});

describe('processSingleExternalCard', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(mf, 'fetchLinksForTrack');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const card = (overrides: Record<string, any> = {}) => ({
    id: 10,
    spotifyId: 'abc123',
    spotifyLink: null,
    appleMusicLink: null,
    tidalLink: null,
    youtubeMusicLink: null,
    deezerLink: null,
    amazonMusicLink: null,
    ...overrides,
  });

  const allLinks = {
    deezerLink: 'dz',
    youtubeMusicLink: 'yt',
    appleMusicLink: 'ap',
    amazonMusicLink: 'am',
    tidalLink: 'td',
  };

  it('fails without any spotify source', async () => {
    const res = await mf.processSingleExternalCard(card({ spotifyId: null }));
    expect(res).toEqual({
      success: false,
      linksAdded: [],
      cardsUpdated: 0,
      error: 'No Spotify source available',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds the spotify URL from spotifyId when no spotifyLink is stored', async () => {
    fetchSpy.mockResolvedValueOnce({ success: false, error: 'x' });
    await mf.processSingleExternalCard(card());
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://open.spotify.com/track/abc123',
      'spotifyLink'
    );
  });

  it('prefers the stored spotifyLink over the constructed URL', async () => {
    fetchSpy.mockResolvedValueOnce({ success: false, error: 'x' });
    await mf.processSingleExternalCard(card({ spotifyLink: 'stored-link' }));
    expect(fetchSpy).toHaveBeenCalledWith('stored-link', 'spotifyLink');
  });

  it('reports rate limiting distinctly', async () => {
    fetchSpy.mockResolvedValueOnce({
      success: false,
      error: 'Rate limit exceeded',
      rateLimited: true,
    });
    const res = await mf.processSingleExternalCard(card());
    expect(res.error).toBe('Rate limited, please try again later');
    expect(res.success).toBe(false);
  });

  it('fails with "No links found" when the fetch fails', async () => {
    fetchSpy.mockResolvedValueOnce({ success: false, error: 'nope' });
    const res = await mf.processSingleExternalCard(card());
    expect(res.error).toBe('No links found');
  });

  it('fails when the API returned no usable service links', async () => {
    fetchSpy.mockResolvedValueOnce({ success: true, links: {} });
    const res = await mf.processSingleExternalCard(card());
    expect(res.error).toBe('No links found from MusicFetch');
    expect(h.prisma.externalCard.findMany).not.toHaveBeenCalled();
  });

  it('fills only null fields across all cards sharing the spotifyId and clears caches', async () => {
    fetchSpy.mockResolvedValueOnce({ success: true, links: { ...allLinks } });
    h.prisma.externalCard.findMany
      // cards to update
      .mockResolvedValueOnce([
        {
          id: 1,
          deezerLink: null,
          youtubeMusicLink: 'already-yt',
          appleMusicLink: null,
          amazonMusicLink: null,
          tidalLink: null,
        },
        {
          id: 2,
          deezerLink: 'dz-old',
          youtubeMusicLink: 'yt-old',
          appleMusicLink: 'ap-old',
          amazonMusicLink: 'am-old',
          tidalLink: 'td-old',
        },
      ])
      // cards for cache clearing (clearExternalCardCaches)
      .mockResolvedValueOnce([
        {
          cardType: 'jumbo',
          sku: 'aaaa0007',
          countryCode: null,
          playlistId: null,
          cardNumber: '12',
        },
      ]);
    h.prisma.externalCard.update.mockResolvedValue({});

    const res = await mf.processSingleExternalCard(card());

    // Card 2 is fully populated -> not updated; only card 1 counts.
    expect(res.success).toBe(true);
    expect(res.cardsUpdated).toBe(1);
    expect(res.error).toBeUndefined();
    expect(res.linksAdded).toEqual([
      'Deezer',
      'YouTube Music',
      'Apple Music',
      'Amazon Music',
      'Tidal',
    ]);

    expect(h.prisma.externalCard.update).toHaveBeenCalledTimes(1);
    const update = h.prisma.externalCard.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 1 });
    expect(update.data.deezerLink).toBe('dz');
    expect(update.data).not.toHaveProperty('youtubeMusicLink'); // already set
    expect(update.data.musicFetchAttempts).toEqual({ increment: 1 });

    // Cache invalidation: jumbo cards get one key per locale (8 locales).
    expect(h.cacheDel).toHaveBeenCalledTimes(8);
    const nlKey = `qrlink2_unknown_result_${crypto
      .createHash('md5')
      .update('https://hitstergame.com/nl/aaaa0007/12')
      .digest('hex')}`;
    expect(h.cacheDel).toHaveBeenCalledWith(nlKey);

    expect(h.updateCardsWithSpotifyIdInCache).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ deezerLink: 'dz', tidalLink: 'td' })
    );
  });

  it('reports failure when every card already has all links', async () => {
    fetchSpy.mockResolvedValueOnce({
      success: true,
      links: { deezerLink: 'dz' },
    });
    h.prisma.externalCard.findMany.mockResolvedValueOnce([
      {
        id: 1,
        deezerLink: 'dz-old',
        youtubeMusicLink: 'yt-old',
        appleMusicLink: 'ap-old',
        amazonMusicLink: 'am-old',
        tidalLink: 'td-old',
      },
    ]);

    const res = await mf.processSingleExternalCard(card());
    expect(res.success).toBe(false);
    expect(res.cardsUpdated).toBe(0);
    expect(res.error).toBe(
      'No new links found (all services already linked or unavailable)'
    );
    expect(h.prisma.externalCard.update).not.toHaveBeenCalled();
    expect(h.cacheDel).not.toHaveBeenCalled();
  });

  it('uses a musicmatch cache key for musicmatch cards', async () => {
    fetchSpy.mockResolvedValueOnce({
      success: true,
      links: { deezerLink: 'dz' },
    });
    h.prisma.externalCard.findMany
      .mockResolvedValueOnce([
        {
          id: 1,
          deezerLink: null,
          youtubeMusicLink: null,
          appleMusicLink: null,
          amazonMusicLink: null,
          tidalLink: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          cardType: 'musicmatch',
          sku: null,
          countryCode: null,
          playlistId: 'pl-1',
          cardNumber: '3',
        },
      ]);
    h.prisma.externalCard.update.mockResolvedValue({});

    await mf.processSingleExternalCard(card());

    const expectedKey = `qrlink2_unknown_result_${crypto
      .createHash('md5')
      .update('https://api.musicmatchgame.com/pl-1/3')
      .digest('hex')}`;
    expect(h.cacheDel).toHaveBeenCalledTimes(1);
    expect(h.cacheDel).toHaveBeenCalledWith(expectedKey);
  });

  it('catches unexpected errors into the error field', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('kaboom'));
    const res = await mf.processSingleExternalCard(card());
    expect(res).toEqual({
      success: false,
      linksAdded: [],
      cardsUpdated: 0,
      error: 'kaboom',
    });
  });
});

describe('updateExternalCardWithLinks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(mf, 'fetchLinksForTrack');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const dbCard = (overrides: Record<string, any> = {}) => ({
    spotifyLink: SPOTIFY_URL,
    spotifyId: 'abc123',
    musicFetchAttempts: 0,
    ...overrides,
  });

  it('returns the empty result when the card does not exist', async () => {
    h.prisma.externalCard.findUnique.mockResolvedValueOnce(null);
    expect(await mf.updateExternalCardWithLinks(5)).toEqual({
      success: false,
      cardsUpdated: 0,
      servicesAdded: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects the 3-attempt cap unless forced', async () => {
    h.prisma.externalCard.findUnique.mockResolvedValueOnce(
      dbCard({ musicFetchAttempts: 3 })
    );
    expect(await mf.updateExternalCardWithLinks(5)).toEqual({
      success: false,
      cardsUpdated: 0,
      servicesAdded: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a spotifyId even when a spotifyLink exists', async () => {
    h.prisma.externalCard.findUnique.mockResolvedValueOnce(
      dbCard({ spotifyId: null })
    );
    expect(await mf.updateExternalCardWithLinks(5)).toEqual({
      success: false,
      cardsUpdated: 0,
      servicesAdded: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('aborts without DB writes when rate limited', async () => {
    h.prisma.externalCard.findUnique.mockResolvedValueOnce(dbCard());
    fetchSpy.mockResolvedValueOnce({
      success: false,
      error: 'Rate limit exceeded',
      rateLimited: true,
    });
    expect(await mf.updateExternalCardWithLinks(5)).toEqual({
      success: false,
      cardsUpdated: 0,
      servicesAdded: [],
    });
    expect(h.prisma.externalCard.findMany).not.toHaveBeenCalled();
    expect(h.prisma.externalCard.update).not.toHaveBeenCalled();
  });

  it('fills null fields, sets processedByBatch on changed cards and updates timestamps on all', async () => {
    h.prisma.externalCard.findUnique.mockResolvedValueOnce(dbCard());
    fetchSpy.mockResolvedValueOnce({
      success: true,
      links: { deezerLink: 'dz', tidalLink: 'td' },
    });
    h.prisma.externalCard.findMany
      // cards sharing the spotifyId
      .mockResolvedValueOnce([
        {
          id: 1,
          deezerLink: null,
          youtubeMusicLink: null,
          appleMusicLink: null,
          amazonMusicLink: null,
          tidalLink: null,
        },
        {
          id: 2,
          deezerLink: 'dz-old',
          youtubeMusicLink: null,
          appleMusicLink: null,
          amazonMusicLink: null,
          tidalLink: 'td-old',
        },
      ])
      // clearExternalCardCaches lookup
      .mockResolvedValueOnce([]);
    h.prisma.externalCard.update.mockResolvedValue({});

    const res = await mf.updateExternalCardWithLinks(5);

    expect(res.success).toBe(true);
    expect(res.servicesAdded.sort()).toEqual(['deezer', 'tidal']);
    // Quirk (documented): cardsUpdated counts ALL cards sharing the
    // spotifyId once any card got a new link — card 2 got nothing new
    // but is still counted.
    expect(res.cardsUpdated).toBe(2);

    // Both cards receive an update (attempt bookkeeping), but only card 1
    // gets the links + processedByBatch flag.
    expect(h.prisma.externalCard.update).toHaveBeenCalledTimes(2);
    const byId = Object.fromEntries(
      h.prisma.externalCard.update.mock.calls.map((c) => [c[0].where.id, c[0].data])
    );
    expect(byId[1].deezerLink).toBe('dz');
    expect(byId[1].tidalLink).toBe('td');
    expect(byId[1].processedByBatch).toBe(true);
    expect(byId[2]).not.toHaveProperty('deezerLink');
    expect(byId[2]).not.toHaveProperty('processedByBatch');
    expect(byId[2].musicFetchAttempts).toEqual({ increment: 1 });

    expect(h.updateCardsWithSpotifyIdInCache).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ deezerLink: 'dz', tidalLink: 'td' })
    );
  });

  it('skips cache clearing when nothing new was added', async () => {
    h.prisma.externalCard.findUnique.mockResolvedValueOnce(dbCard());
    fetchSpy.mockResolvedValueOnce({ success: true, links: {} });
    h.prisma.externalCard.findMany.mockResolvedValueOnce([
      {
        id: 1,
        deezerLink: 'dz-old',
        youtubeMusicLink: null,
        appleMusicLink: null,
        amazonMusicLink: null,
        tidalLink: null,
      },
    ]);
    h.prisma.externalCard.update.mockResolvedValue({});

    const res = await mf.updateExternalCardWithLinks(5);
    expect(res).toEqual({ success: true, cardsUpdated: 0, servicesAdded: [] });
    // Attempt bookkeeping still happens for the card.
    expect(h.prisma.externalCard.update).toHaveBeenCalledTimes(1);
    expect(h.updateCardsWithSpotifyIdInCache).not.toHaveBeenCalled();
    expect(h.cacheDel).not.toHaveBeenCalled();
  });

  it('returns the empty result when something throws', async () => {
    h.prisma.externalCard.findUnique.mockRejectedValueOnce(
      new Error('db down')
    );
    expect(await mf.updateExternalCardWithLinks(5)).toEqual({
      success: false,
      cardsUpdated: 0,
      servicesAdded: [],
    });
  });
});

describe('processExternalCards (specific cardIds batch)', () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateSpy = vi.spyOn(mf, 'updateExternalCardWithLinks');
    h.prisma.track.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    updateSpy.mockRestore();
  });

  const row = (id: number, spotifyId: string) => ({
    id,
    spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
    spotifyId,
    deezerLink: null,
    youtubeMusicLink: null,
    appleMusicLink: null,
    amazonMusicLink: null,
    tidalLink: null,
    musicFetchAttempts: 0,
  });

  it('deduplicates cards by spotifyId within a chunk and counts results', async () => {
    h.prisma.externalCard.findMany.mockResolvedValueOnce([
      row(1, 'X'),
      row(2, 'X'), // duplicate spotifyId -> skipped, no API call
      row(3, 'Y'),
    ]);
    updateSpy
      .mockResolvedValueOnce({
        success: true,
        cardsUpdated: 2,
        servicesAdded: ['deezer'],
      })
      .mockResolvedValueOnce({
        success: false,
        cardsUpdated: 0,
        servicesAdded: [],
      });

    const res = await mf.processExternalCards([1, 2, 3]);

    expect(updateSpy.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(res).toEqual({
      totalProcessed: 3,
      successful: 1,
      failed: 1,
      skipped: 1,
      errors: [{ trackId: 3, error: 'Failed to fetch or update links' }],
    });
  });

  it('counts success-but-zero-cards-updated as neither success nor failure', async () => {
    // Documented quirk: success=true with cardsUpdated=0 falls through
    // both counters.
    h.prisma.externalCard.findMany.mockResolvedValueOnce([row(1, 'X')]);
    updateSpy.mockResolvedValueOnce({
      success: true,
      cardsUpdated: 0,
      servicesAdded: [],
    });
    const res = await mf.processExternalCards([1]);
    expect(res.successful).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.totalProcessed).toBe(1);
  });

  it('returns zeros when nothing needs processing', async () => {
    h.prisma.externalCard.findMany.mockResolvedValueOnce([]);
    const res = await mf.processExternalCards([9]);
    expect(res).toEqual({
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
