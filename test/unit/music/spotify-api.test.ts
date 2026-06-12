import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for SpotifyApi (src/spotify_api.ts) — the pre-March-2026
 * Spotify API provider. Everything that does I/O is mocked at the module
 * boundary: axios (HTTP), Settings (token storage, normally Prisma+Redis),
 * Cache (Redis) and Logger.
 */

const h = vi.hoisted(() => {
  const settingsStore = new Map<string, string>();
  const getSetting = vi.fn(async (key: string) => settingsStore.get(key) ?? null);
  const setSetting = vi.fn(async (key: string, value: string) => {
    settingsStore.set(key, value);
  });
  const deleteSetting = vi.fn(async (key: string) => {
    settingsStore.delete(key);
  });

  const cacheStore = new Map<string, string>();
  const cacheGet = vi.fn(async (key: string) => cacheStore.get(key) ?? null);
  const cacheSet = vi.fn(async (key: string, value: string, _ttl?: number) => {
    cacheStore.set(key, value);
  });

  const axiosGet = vi.fn();
  const axiosPost = vi.fn();
  const axiosDelete = vi.fn();
  const axiosRequest = vi.fn(); // bare axios(config) calls

  return {
    settingsStore,
    getSetting,
    setSetting,
    deleteSetting,
    cacheStore,
    cacheGet,
    cacheSet,
    axiosGet,
    axiosPost,
    axiosDelete,
    axiosRequest,
  };
});

vi.mock('axios', () => {
  const axiosFn: any = (...args: any[]) => h.axiosRequest(...args);
  axiosFn.get = h.axiosGet;
  axiosFn.post = h.axiosPost;
  axiosFn.delete = h.axiosDelete;
  axiosFn.isAxiosError = (e: any) => e?.isAxiosError === true;
  return { default: axiosFn };
});

vi.mock('../../../src/logger', () => ({
  default: class {
    init = async () => {};
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/settings', () => ({
  default: {
    getInstance: () => ({
      getSetting: h.getSetting,
      setSetting: h.setSetting,
      deleteSetting: h.deleteSetting,
    }),
  },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: h.cacheGet,
      set: h.cacheSet,
      del: vi.fn(async () => undefined),
      delPattern: vi.fn(async () => undefined),
      acquireLock: vi.fn(async () => true),
      releaseLock: vi.fn(async () => undefined),
      rateLimit: vi.fn(async () => undefined),
    }),
  },
}));

import SpotifyApi from '../../../src/spotify_api';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'http://localhost:3004/spotify_callback';
const BASIC_AUTH = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
const V1_TRACK_FIELDS =
  'items(track(id,name,artists(name),album(name,images,release_date),external_urls,external_ids,preview_url)),next,total';

function makeApi(): InstanceType<typeof SpotifyApi> {
  // Env is read in instance-field initializers, so it must be set before
  // every `new SpotifyApi()`.
  process.env['SPOTIFY_CLIENT_ID'] = CLIENT_ID;
  process.env['SPOTIFY_CLIENT_SECRET'] = CLIENT_SECRET;
  process.env['SPOTIFY_REDIRECT_URI'] = REDIRECT_URI;
  return new SpotifyApi();
}

function seedValidToken(token = 'valid-token') {
  h.settingsStore.set('spotify_access_token', token);
  h.settingsStore.set('spotify_token_expires_at', String(Date.now() + 3600_000));
}

function axiosError(
  status: number,
  opts: { message?: string; data?: any; headers?: Record<string, string> } = {}
) {
  return {
    isAxiosError: true,
    message: opts.message ?? `Request failed with status code ${status}`,
    response: { status, data: opts.data ?? {}, headers: opts.headers ?? {} },
  };
}

function mkItems(count: number, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    track: { id: `t${startIndex + i}`, name: `Track ${startIndex + i}` },
  }));
}

beforeEach(() => {
  h.settingsStore.clear();
  h.cacheStore.clear();
  h.getSetting.mockClear();
  h.setSetting.mockClear();
  h.deleteSetting.mockClear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  h.axiosGet.mockReset();
  h.axiosPost.mockReset();
  h.axiosDelete.mockReset();
  h.axiosRequest.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SpotifyApi.getAccessToken', () => {
  it('returns the stored token when it has not expired, without any HTTP call', async () => {
    seedValidToken('still-good');
    const api = makeApi();

    await expect(api.getAccessToken()).resolves.toBe('still-good');
    expect(h.axiosPost).not.toHaveBeenCalled();
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('returns null when there is no token and no refresh token', async () => {
    const api = makeApi();
    await expect(api.getAccessToken()).resolves.toBeNull();
    expect(h.axiosPost).not.toHaveBeenCalled();
  });

  it('returns null without touching settings when credentials are missing', async () => {
    const savedId = process.env['SPOTIFY_CLIENT_ID'];
    try {
      delete process.env['SPOTIFY_CLIENT_ID'];
      const api = new SpotifyApi();
      await expect(api.getAccessToken()).resolves.toBeNull();
      expect(h.getSetting).not.toHaveBeenCalled();
      expect(h.axiosPost).not.toHaveBeenCalled();
    } finally {
      process.env['SPOTIFY_CLIENT_ID'] = savedId;
    }
  });

  it('refreshes an expired token via the token endpoint with Basic auth and form encoding', async () => {
    h.settingsStore.set('spotify_access_token', 'expired-token');
    h.settingsStore.set('spotify_token_expires_at', String(Date.now() - 1000));
    h.settingsStore.set('spotify_refresh_token', 'refresh-1');
    h.axiosPost.mockResolvedValueOnce({
      data: {
        access_token: 'fresh-token',
        token_type: 'Bearer',
        scope: 'playlist-modify-public',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      },
    });
    const before = Date.now();

    const api = makeApi();
    await expect(api.getAccessToken()).resolves.toBe('fresh-token');

    expect(h.axiosPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = h.axiosPost.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(body).toBe('grant_type=refresh_token&refresh_token=refresh-1');
    expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(config.headers.Authorization).toBe(BASIC_AUTH);

    // New tokens are persisted with a 60-second expiry buffer.
    expect(h.settingsStore.get('spotify_access_token')).toBe('fresh-token');
    expect(h.settingsStore.get('spotify_refresh_token')).toBe('refresh-2');
    const expiresAt = Number(h.settingsStore.get('spotify_token_expires_at'));
    expect(expiresAt).toBeGreaterThanOrEqual(before + (3600 - 60) * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + (3600 - 60) * 1000);
  });

  it('keeps the old refresh token when the refresh response omits one', async () => {
    h.settingsStore.set('spotify_access_token', 'expired-token');
    h.settingsStore.set('spotify_token_expires_at', '0');
    h.settingsStore.set('spotify_refresh_token', 'refresh-1');
    h.axiosPost.mockResolvedValueOnce({
      data: { access_token: 'fresh', token_type: 'Bearer', scope: '', expires_in: 3600 },
    });

    await makeApi().getAccessToken();
    expect(h.settingsStore.get('spotify_refresh_token')).toBe('refresh-1');
  });

  it('returns null when the refresh request fails', async () => {
    h.settingsStore.set('spotify_refresh_token', 'refresh-1');
    h.axiosPost.mockRejectedValueOnce(axiosError(400, { data: { error: 'invalid_grant' } }));

    await expect(makeApi().getAccessToken()).resolves.toBeNull();
    expect(h.axiosPost).toHaveBeenCalledTimes(1);
  });
});

describe('SpotifyApi.getTokensFromAuthCode', () => {
  it('exchanges the auth code with grant_type=authorization_code and stores both tokens', async () => {
    h.axiosPost.mockResolvedValueOnce({
      data: {
        access_token: 'auth-access',
        token_type: 'Bearer',
        scope: 'playlist-modify-public',
        expires_in: 3600,
        refresh_token: 'auth-refresh',
      },
    });

    const api = makeApi();
    await expect(api.getTokensFromAuthCode('the-code')).resolves.toBe('auth-access');

    const [url, body, config] = h.axiosPost.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(body).toBe(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: REDIRECT_URI,
      }).toString()
    );
    expect(config.headers.Authorization).toBe(BASIC_AUTH);
    expect(h.settingsStore.get('spotify_access_token')).toBe('auth-access');
    expect(h.settingsStore.get('spotify_refresh_token')).toBe('auth-refresh');
  });

  it('returns null when the exchange fails', async () => {
    h.axiosPost.mockRejectedValueOnce(axiosError(400));
    await expect(makeApi().getTokensFromAuthCode('bad')).resolves.toBeNull();
    expect(h.settingsStore.has('spotify_access_token')).toBe(false);
  });
});

describe('SpotifyApi.getAuthorizationUrl', () => {
  it('builds the authorize URL with client id, encoded redirect uri and scope', () => {
    const api = makeApi();
    expect(api.getAuthorizationUrl()).toBe(
      `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}` +
        `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent('playlist-modify-public')}`
    );
  });

  it('returns null when the client id is missing', () => {
    const savedId = process.env['SPOTIFY_CLIENT_ID'];
    try {
      delete process.env['SPOTIFY_CLIENT_ID'];
      expect(new SpotifyApi().getAuthorizationUrl()).toBeNull();
    } finally {
      process.env['SPOTIFY_CLIENT_ID'] = savedId;
    }
  });
});

describe('SpotifyApi.isSpotifyOwnedPlaylist', () => {
  it('classifies Spotify-owned playlist id prefixes', () => {
    const api = makeApi();
    expect(api.isSpotifyOwnedPlaylist('37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      isOwned: true,
      type: 'editorial',
    });
    expect(api.isSpotifyOwnedPlaylist('37i9dQZF1DZ06evO1ru5fF')).toEqual({
      isOwned: true,
      type: 'this_is',
    });
    expect(api.isSpotifyOwnedPlaylist('37i9dQZF1E37jO8SiMT0yN')).toEqual({
      isOwned: true,
      type: 'daily_mix',
    });
    expect(api.isSpotifyOwnedPlaylist('37i9dQZEVXbMDoHDwVN2tF')).toEqual({
      isOwned: true,
      type: 'personalized',
    });
    expect(api.isSpotifyOwnedPlaylist('3cEYpjA9oz9GiPac4AsH4n')).toEqual({ isOwned: false });
  });
});

describe('SpotifyApi.getPlaylist', () => {
  it('requests the playlist with the trimmed v1 fields and Bearer token', async () => {
    seedValidToken();
    const playlist = { id: 'pl1', name: 'List', tracks: { total: 5 } };
    h.axiosGet.mockResolvedValueOnce({ data: playlist });

    const res = await makeApi().getPlaylist('pl1');

    expect(res).toEqual({ success: true, data: playlist });
    expect(h.axiosGet).toHaveBeenCalledWith('https://api.spotify.com/v1/playlists/pl1', {
      params: { fields: 'id,name,description,images(url),tracks(total)' },
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(h.cacheSet).not.toHaveBeenCalled();
  });

  it('flags the v2 provider in cache when the response uses the new items format', async () => {
    seedValidToken();
    h.axiosGet.mockResolvedValueOnce({ data: { id: 'pl1', items: { total: 5 } } });

    const res = await makeApi().getPlaylist('pl1');

    expect(res.success).toBe(true);
    expect(h.cacheSet).toHaveBeenCalledWith('spotify_tracks_provider', 'v2');
  });

  it('asks for re-auth (with auth URL) when no access token can be obtained', async () => {
    const res = await makeApi().getPlaylist('pl1');
    expect(res).toMatchObject({
      success: false,
      error: 'Spotify authentication required',
      needsReAuth: true,
    });
    expect(res.authUrl).toContain('https://accounts.spotify.com/authorize?client_id=');
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('maps 404 on a Spotify-owned playlist to spotifyOwnedPlaylist with its type', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(axiosError(404));

    const res = await makeApi().getPlaylist('37i9dQZF1DXcBWIGoYBM5M');
    expect(res).toEqual({
      success: false,
      error: 'spotifyOwnedPlaylist',
      playlistType: 'editorial',
    });
  });

  it('maps 404 on a normal playlist to "Spotify resource not found"', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(axiosError(404));

    const res = await makeApi().getPlaylist('3cEYpjA9oz9GiPac4AsH4n');
    expect(res).toEqual({
      success: false,
      error: 'Spotify resource not found',
      needsReAuth: false,
    });
  });

  it('maps 401 to needsReAuth and clears the cached token', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(axiosError(401));

    const res = await makeApi().getPlaylist('pl1');
    expect(res).toMatchObject({
      success: false,
      error: 'Spotify authorization error (token likely expired/invalid)',
      needsReAuth: true,
    });
    expect(h.deleteSetting).toHaveBeenCalledWith('spotify_access_token');
    expect(h.deleteSetting).toHaveBeenCalledWith('spotify_token_expires_at');
  });

  it('maps 400 with an auth-flavored message to needsReAuth', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(
      axiosError(400, { data: { error: { status: 400, message: 'invalid_grant: revoked' } } })
    );

    const res = await makeApi().getPlaylist('pl1');
    expect(res).toMatchObject({ success: false, needsReAuth: true });
  });

  it('maps a plain 400 to a non-reauth bad request error', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(
      axiosError(400, { data: { error: { status: 400, message: 'malformed fields' } } })
    );

    const res = await makeApi().getPlaylist('pl1');
    expect(res).toEqual({
      success: false,
      error: 'Spotify API error: 400 Bad Request',
      needsReAuth: false,
    });
  });

  it('maps 429 to a rate-limit error carrying the parsed Retry-After', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(axiosError(429, { headers: { 'retry-after': '7' } }));

    const res = await makeApi().getPlaylist('pl1');
    expect(res).toEqual({
      success: false,
      error: 'Spotify API error: 429 Too Many Requests. Retry after: 7 seconds.',
      needsReAuth: false,
      retryAfter: 7,
    });
  });

  it('maps other statuses generically and non-axios errors to an internal error', async () => {
    seedValidToken();
    h.axiosGet.mockRejectedValueOnce(axiosError(503));
    expect(await makeApi().getPlaylist('pl1')).toEqual({
      success: false,
      error: 'Spotify API error: 503',
      needsReAuth: false,
    });

    h.axiosGet.mockRejectedValueOnce(new Error('boom'));
    expect(await makeApi().getPlaylist('pl1')).toEqual({
      success: false,
      error: 'Internal error fetching playlist pl1',
      needsReAuth: false,
    });
  });
});

describe('SpotifyApi.getTracks', () => {
  beforeEach(() => seedValidToken());

  it('fetches a small playlist in a single request to /tracks with limit=100', async () => {
    h.axiosGet.mockResolvedValueOnce({
      data: { items: [...mkItems(2), null, { track: null }], total: 2 },
    });

    const res = await makeApi().getTracks('pl1');

    expect(h.axiosGet).toHaveBeenCalledTimes(1);
    expect(h.axiosGet).toHaveBeenCalledWith(
      `https://api.spotify.com/v1/playlists/pl1/tracks?limit=100&offset=0&fields=${V1_TRACK_FIELDS}`,
      { headers: { Authorization: 'Bearer valid-token' } }
    );
    // null entries and items without a track are filtered out
    expect(res).toEqual({ success: true, data: { items: mkItems(2) } });
  });

  it('returns an empty list (single request) for an empty playlist without reporting progress', async () => {
    h.axiosGet.mockResolvedValueOnce({ data: { items: [], total: 0 } });
    const onProgress = vi.fn();

    const res = await makeApi().getTracks('pl1', onProgress);
    expect(res).toEqual({ success: true, data: { items: [] } });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('pages the remainder in parallel with limit/offset and reports progress', async () => {
    h.axiosGet.mockImplementation(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset === 0) return { data: { items: mkItems(100, 0), total: 250 } };
      if (offset === 100) return { data: { items: mkItems(100, 100) } };
      if (offset === 200) return { data: { items: mkItems(50, 200) } };
      throw new Error(`unexpected GET ${url}`);
    });
    const onProgress = vi.fn();

    const res = await makeApi().getTracks('pl1', onProgress);

    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(250);
    expect(res.data.items[0].track.id).toBe('t0');
    expect(res.data.items[249].track.id).toBe('t249');

    const urls = h.axiosGet.mock.calls.map((c) => c[0]);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/tracks?limit=100&offset=100&fields=${V1_TRACK_FIELDS}`
    );
    expect(urls[2]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/tracks?limit=100&offset=200&fields=${V1_TRACK_FIELDS}`
    );

    // Initial page → 40%, after the (single) parallel batch → capped at 99%.
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      {
        stage: 'fetching_metadata',
        current: 100,
        total: 250,
        percentage: 40,
        message: 'progress.loaded',
      },
      {
        stage: 'fetching_metadata',
        current: 250,
        total: 250,
        percentage: 99,
        message: 'progress.loaded',
      },
    ]);
  });

  it('switches the provider to v2 when /tracks returns 403', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(403));

    const res = await makeApi().getTracks('pl1');

    expect(res).toEqual({ success: false, error: 'spotify_api2_switch', needsReAuth: false });
    expect(h.cacheSet).toHaveBeenCalledWith('spotify_tracks_provider', 'v2');
    expect(h.axiosGet).toHaveBeenCalledTimes(1);
  });

  it('retries the initial request with limit=50 when limit=100 is rejected with 400', async () => {
    h.axiosGet
      .mockRejectedValueOnce(axiosError(400))
      .mockResolvedValueOnce({ data: { items: mkItems(30), total: 30 } });

    const res = await makeApi().getTracks('pl1');

    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(30);
    const urls = h.axiosGet.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain('/tracks?limit=100&offset=0');
    expect(urls[1]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/tracks?limit=50&offset=0&fields=${V1_TRACK_FIELDS}`
    );
  });

  it('falls back to sequential fetching (limit=50, next-link paging) when a parallel page is rate limited', async () => {
    const seqStart = `https://api.spotify.com/v1/playlists/pl1/tracks?limit=50&fields=items(track(id,name,artists(name),album(name,images,release_date),external_urls,external_ids,preview_url)),next`;
    const seqNext = 'https://api.spotify.com/v1/playlists/pl1/tracks?seqpage=2';
    h.axiosGet.mockImplementation(async (url: string) => {
      if (url.includes('offset=0')) return { data: { items: mkItems(100, 0), total: 150 } };
      if (url.includes('offset=100'))
        throw axiosError(429, { headers: { 'retry-after': '1' } });
      if (url === seqStart) return { data: { items: mkItems(50, 0), next: seqNext } };
      if (url === seqNext) return { data: { items: mkItems(50, 50), next: null } };
      throw new Error(`unexpected GET ${url}`);
    });

    const res = await makeApi().getTracks('pl1');

    // The sequential fallback re-fetches from scratch and its result is
    // returned as-is (only the items the sequential pass produced).
    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(100);
    const urls = h.axiosGet.mock.calls.map((c) => c[0]);
    expect(urls).toContain(seqStart);
    expect(urls[urls.length - 1]).toBe(seqNext);
  });

  it('reports an internal error when both parallel and sequential paths fail with non-API errors', async () => {
    h.axiosGet.mockRejectedValue(new Error('socket hangup'));

    const res = await makeApi().getTracks('pl1');
    expect(res).toEqual({
      success: false,
      error: 'Internal error fetching tracks for playlist pl1 (sequential fallback)',
      needsReAuth: false,
    });
  });

  it('asks for re-auth before any request when no token is available', async () => {
    h.settingsStore.clear();
    const res = await makeApi().getTracks('pl1');
    expect(res).toMatchObject({ success: false, needsReAuth: true });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });
});

describe('SpotifyApi.getTracksByIds', () => {
  beforeEach(() => seedValidToken());

  it('rejects an empty id list without doing any I/O', async () => {
    expect(await makeApi().getTracksByIds([])).toEqual({
      success: false,
      error: 'No track IDs provided',
    });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('chunks ids into batches of 50 and concatenates non-null tracks', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    h.axiosGet.mockImplementation(async (_url: string, config: any) => {
      const chunk = config.params.ids.split(',');
      // Sprinkle a null into every chunk: unavailable tracks must be dropped.
      return { data: { tracks: [...chunk.map((id: string) => ({ id })), null] } };
    });

    const res = await makeApi().getTracksByIds(ids);

    expect(h.axiosGet).toHaveBeenCalledTimes(3);
    for (const call of h.axiosGet.mock.calls) {
      expect(call[0]).toBe('https://api.spotify.com/v1/tracks');
      expect(call[1].headers).toEqual({ Authorization: 'Bearer valid-token' });
    }
    expect(h.axiosGet.mock.calls[0][1].params.ids).toBe(ids.slice(0, 50).join(','));
    expect(h.axiosGet.mock.calls[1][1].params.ids).toBe(ids.slice(50, 100).join(','));
    expect(h.axiosGet.mock.calls[2][1].params.ids).toBe(ids.slice(100).join(','));

    expect(res.success).toBe(true);
    expect(res.data.tracks).toHaveLength(120);
    expect(res.data.tracks[0]).toEqual({ id: 'id0' });
    expect(res.data.tracks[119]).toEqual({ id: 'id119' });
  });

  it('propagates a 401 from any chunk as needsReAuth', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(401));
    const res = await makeApi().getTracksByIds(['a', 'b']);
    expect(res).toMatchObject({ success: false, needsReAuth: true });
  });

  it('turns a response without a tracks array into an internal error (no guard in v1)', async () => {
    // v1 does `result.tracks.filter(...)` without a fallback — a malformed
    // response throws a TypeError which surfaces as a non-API internal error.
    h.axiosGet.mockResolvedValueOnce({ data: {} });
    const res = await makeApi().getTracksByIds(['a']);
    expect(res).toEqual({
      success: false,
      error: 'Internal error fetching tracks by IDs',
      needsReAuth: false,
    });
  });
});

describe('SpotifyApi.searchTracks', () => {
  beforeEach(() => seedValidToken());

  it('rejects an empty search term', async () => {
    expect(await makeApi().searchTracks('')).toEqual({
      success: false,
      error: 'Search term is required',
    });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('queries /v1/search with type=track and clamps the limit to 50', async () => {
    const payload = { tracks: { items: [{ id: 't1' }], total: 1 } };
    h.axiosGet.mockResolvedValueOnce({ data: payload });

    const res = await makeApi().searchTracks('abba', 100, 10);

    expect(res).toEqual({ success: true, data: payload });
    expect(h.axiosGet).toHaveBeenCalledWith('https://api.spotify.com/v1/search', {
      params: {
        q: 'abba',
        type: 'track',
        limit: 50,
        offset: 10,
        fields: 'tracks(items(id,name,artists(name),album(images(url))),total)',
      },
      headers: { Authorization: 'Bearer valid-token' },
    });
  });

  it('maps a 429 without Retry-After header to an error with no retryAfter value', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(429));
    const res = await makeApi().searchTracks('abba');
    expect(res.error).toBe('Spotify API error: 429 Too Many Requests. No Retry-After header.');
    expect(res.retryAfter).toBeUndefined();
  });
});

describe('SpotifyApi.createOrUpdatePlaylist', () => {
  beforeEach(() => seedValidToken());

  const trackIds = Array.from({ length: 150 }, (_, i) => `id${i}`);

  it('replaces tracks on an existing owned playlist (PUT first chunk, POST the rest)', async () => {
    h.axiosGet.mockImplementation(async (url: string) => {
      if (url === 'https://api.spotify.com/v1/me') return { data: { id: 'user1' } };
      if (url === 'https://api.spotify.com/v1/me/playlists') {
        return {
          data: {
            items: [
              {
                id: 'pl-exist',
                name: 'My List',
                owner: { id: 'user1' },
                external_urls: { spotify: 'https://open.spotify.com/playlist/pl-exist' },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    h.axiosRequest.mockResolvedValue({});

    const res = await makeApi().createOrUpdatePlaylist('My List', trackIds);

    expect(res).toEqual({
      success: true,
      data: {
        playlistId: 'pl-exist',
        playlistUrl: 'https://open.spotify.com/playlist/pl-exist',
        playlistName: 'My List',
      },
    });

    // Duplicate check asked only for the fields it needs, at the 50 limit.
    const playlistsCall = h.axiosGet.mock.calls.find(
      (c) => c[0] === 'https://api.spotify.com/v1/me/playlists'
    )!;
    expect(playlistsCall[1].params).toEqual({
      limit: 50,
      fields: 'items(id,name,owner(id),external_urls)',
    });

    // 150 URIs → chunk 1 (100) replaces via PUT, chunk 2 (50) appends via POST.
    expect(h.axiosRequest).toHaveBeenCalledTimes(2);
    const [first, second] = h.axiosRequest.mock.calls.map((c) => c[0]);
    expect(first.method).toBe('put');
    expect(first.url).toBe('https://api.spotify.com/v1/playlists/pl-exist/tracks');
    expect(JSON.parse(first.data).uris).toHaveLength(100);
    expect(JSON.parse(first.data).uris[0]).toBe('spotify:track:id0');
    expect(second.method).toBe('post');
    expect(second.url).toBe('https://api.spotify.com/v1/playlists/pl-exist/tracks');
    expect(JSON.parse(second.data).uris).toHaveLength(50);
    expect(JSON.parse(second.data).uris[49]).toBe('spotify:track:id149');

    // No new playlist was created.
    expect(h.axiosPost).not.toHaveBeenCalled();
  });

  it('creates a new playlist when the same name belongs to a different owner', async () => {
    h.axiosGet.mockImplementation(async (url: string) => {
      if (url === 'https://api.spotify.com/v1/me') return { data: { id: 'user1' } };
      if (url === 'https://api.spotify.com/v1/me/playlists') {
        return {
          data: {
            items: [
              {
                id: 'pl-other',
                name: 'My List',
                owner: { id: 'someone-else' },
                external_urls: { spotify: 'x' },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    h.axiosPost.mockImplementation(async (url: string) => {
      if (url === 'https://api.spotify.com/v1/me/playlists') {
        return {
          data: {
            id: 'pl-new',
            external_urls: { spotify: 'https://open.spotify.com/playlist/pl-new' },
          },
        };
      }
      return { data: {} };
    });

    const res = await makeApi().createOrUpdatePlaylist('My List', trackIds);

    expect(res).toEqual({
      success: true,
      data: {
        playlistId: 'pl-new',
        playlistUrl: 'https://open.spotify.com/playlist/pl-new',
        playlistName: 'My List',
      },
    });

    expect(h.axiosPost).toHaveBeenCalledTimes(3);
    const [createCall, add1, add2] = h.axiosPost.mock.calls;
    expect(createCall[0]).toBe('https://api.spotify.com/v1/me/playlists');
    expect(JSON.parse(createCall[1])).toEqual({
      name: 'My List',
      description: 'Created automatically.',
      public: true,
    });
    expect(add1[0]).toBe('https://api.spotify.com/v1/playlists/pl-new/tracks');
    expect(JSON.parse(add1[1]).uris).toHaveLength(100);
    expect(add2[0]).toBe('https://api.spotify.com/v1/playlists/pl-new/tracks');
    expect(JSON.parse(add2[1]).uris).toHaveLength(50);
    expect(h.axiosRequest).not.toHaveBeenCalled();
  });

  it('asks for re-auth when no token is available', async () => {
    h.settingsStore.clear();
    const res = await makeApi().createOrUpdatePlaylist('My List', ['a']);
    expect(res).toMatchObject({ success: false, needsReAuth: true });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });
});

describe('SpotifyApi.getUserPlaylists', () => {
  it('fetches /v1/me/playlists with a clamped limit and given offset', async () => {
    const data = { items: [{ id: 'p1' }], total: 1 };
    h.axiosGet.mockResolvedValueOnce({ data });

    const res = await makeApi().getUserPlaylists('tok-1', 100, 5);

    expect(res).toEqual({ success: true, data });
    expect(h.axiosGet).toHaveBeenCalledWith('https://api.spotify.com/v1/me/playlists', {
      params: { limit: 50, offset: 5 },
      headers: { Authorization: 'Bearer tok-1' },
    });
  });

  it('retries after a 429 (honoring Retry-After + 500ms) and succeeds', async () => {
    vi.useFakeTimers();
    h.axiosGet
      .mockRejectedValueOnce(axiosError(429, { headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce({ data: { items: [] } });

    const promise = makeApi().getUserPlaylists('tok-1');
    await vi.advanceTimersByTimeAsync(1500); // 1s Retry-After + 500ms buffer
    const res = await promise;

    expect(res).toEqual({ success: true, data: { items: [] } });
    expect(h.axiosGet).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 rate-limited attempts and surfaces the 429 ApiResult', async () => {
    vi.useFakeTimers();
    h.axiosGet.mockRejectedValue(axiosError(429, { headers: { 'retry-after': '1' } }));

    const promise = makeApi().getUserPlaylists('tok-1');
    await vi.advanceTimersByTimeAsync(5000); // two 1.5s waits, third attempt throws
    const res = await promise;

    expect(h.axiosGet).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({
      success: false,
      error: 'Spotify API error: 429 Too Many Requests. Retry after: 1 seconds.',
      retryAfter: 1,
    });
  });

  it('does not retry non-429 errors', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(500));
    const res = await makeApi().getUserPlaylists('tok-1');
    expect(res).toEqual({ success: false, error: 'Spotify API error: 500', needsReAuth: false });
    expect(h.axiosGet).toHaveBeenCalledTimes(1);
  });
});

describe('SpotifyApi.deletePlaylist', () => {
  beforeEach(() => seedValidToken());

  it('unfollows the playlist via DELETE /followers', async () => {
    h.axiosDelete.mockResolvedValueOnce({});

    const res = await makeApi().deletePlaylist('pl1');

    expect(res).toEqual({ success: true });
    expect(h.axiosDelete).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/playlists/pl1/followers',
      { headers: { Authorization: 'Bearer valid-token' } }
    );
  });

  it('maps a 404 to "Spotify resource not found"', async () => {
    h.axiosDelete.mockRejectedValueOnce(axiosError(404));
    const res = await makeApi().deletePlaylist('pl1');
    expect(res).toEqual({
      success: false,
      error: 'Spotify resource not found',
      needsReAuth: false,
    });
  });
});
