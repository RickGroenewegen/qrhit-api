import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for SpotifyApi2 (src/spotify_api2.ts) — the post-March-2026
 * Spotify API provider. Focuses on what differs from SpotifyApi:
 *   - playlist tracks live at /playlists/{id}/items (not /tracks)
 *   - playlist field `tracks` is now `items`, track item field `track` is
 *     now `item`, `external_ids` is gone — and every response is
 *     normalized back to the OLD shape for callers
 *   - no 403 → "switch to v2" escape hatch (this IS v2)
 *   - getTracksByIds guards against a missing `tracks` array
 * Shared plumbing (token refresh, error mapping) gets a slimmer pass since
 * the implementation is duplicated from v1.
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

  const axiosGet = vi.fn();
  const axiosPost = vi.fn();
  const axiosDelete = vi.fn();
  const axiosRequest = vi.fn(); // bare axios(config) calls

  return {
    settingsStore,
    getSetting,
    setSetting,
    deleteSetting,
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

import SpotifyApi2 from '../../../src/spotify_api2';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'http://localhost:3004/spotify_callback';
const BASIC_AUTH = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
// New format: `item(...)` instead of `track(...)` and no `external_ids`.
const V2_TRACK_FIELDS =
  'items(item(id,name,artists(name),album(name,images,release_date),external_urls,preview_url)),next,total';

function makeApi(): InstanceType<typeof SpotifyApi2> {
  process.env['SPOTIFY_CLIENT_ID'] = CLIENT_ID;
  process.env['SPOTIFY_CLIENT_SECRET'] = CLIENT_SECRET;
  process.env['SPOTIFY_REDIRECT_URI'] = REDIRECT_URI;
  return new SpotifyApi2();
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

// New-format entries: the track payload sits under `item`.
function mkNewItems(count: number, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    item: { id: `t${startIndex + i}`, name: `Track ${startIndex + i}` },
  }));
}

// What callers must receive after normalization (old shape).
function mkOldItems(count: number, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    track: { id: `t${startIndex + i}`, name: `Track ${startIndex + i}` },
  }));
}

beforeEach(() => {
  h.settingsStore.clear();
  h.getSetting.mockClear();
  h.setSetting.mockClear();
  h.deleteSetting.mockClear();
  h.axiosGet.mockReset();
  h.axiosPost.mockReset();
  h.axiosDelete.mockReset();
  h.axiosRequest.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SpotifyApi2.getAccessToken', () => {
  it('reuses a stored, unexpired token without HTTP', async () => {
    seedValidToken('still-good');
    await expect(makeApi().getAccessToken()).resolves.toBe('still-good');
    expect(h.axiosPost).not.toHaveBeenCalled();
  });

  it('refreshes an expired token through the same accounts endpoint as v1', async () => {
    h.settingsStore.set('spotify_access_token', 'expired');
    h.settingsStore.set('spotify_token_expires_at', '0');
    h.settingsStore.set('spotify_refresh_token', 'refresh-1');
    h.axiosPost.mockResolvedValueOnce({
      data: {
        access_token: 'fresh-token',
        token_type: 'Bearer',
        scope: '',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      },
    });
    const before = Date.now();

    await expect(makeApi().getAccessToken()).resolves.toBe('fresh-token');

    const [url, body, config] = h.axiosPost.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(body).toBe('grant_type=refresh_token&refresh_token=refresh-1');
    expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(config.headers.Authorization).toBe(BASIC_AUTH);

    expect(h.settingsStore.get('spotify_access_token')).toBe('fresh-token');
    expect(h.settingsStore.get('spotify_refresh_token')).toBe('refresh-2');
    const expiresAt = Number(h.settingsStore.get('spotify_token_expires_at'));
    expect(expiresAt).toBeGreaterThanOrEqual(before + (3600 - 60) * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + (3600 - 60) * 1000);
  });

  it('returns null when refresh fails and when nothing is stored', async () => {
    h.settingsStore.set('spotify_refresh_token', 'refresh-1');
    h.axiosPost.mockRejectedValueOnce(axiosError(400));
    await expect(makeApi().getAccessToken()).resolves.toBeNull();

    h.settingsStore.clear();
    await expect(makeApi().getAccessToken()).resolves.toBeNull();
  });
});

describe('SpotifyApi2.getAuthorizationUrl', () => {
  it('builds the same authorize URL as v1', () => {
    expect(makeApi().getAuthorizationUrl()).toBe(
      `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}` +
        `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent('playlist-modify-public')}`
    );
  });

  it('returns null without a client id', () => {
    const saved = process.env['SPOTIFY_CLIENT_ID'];
    try {
      delete process.env['SPOTIFY_CLIENT_ID'];
      expect(new SpotifyApi2().getAuthorizationUrl()).toBeNull();
    } finally {
      process.env['SPOTIFY_CLIENT_ID'] = saved;
    }
  });
});

describe('SpotifyApi2.getPlaylist', () => {
  beforeEach(() => seedValidToken());

  it('requests items(total) instead of tracks(total) and normalizes items → tracks', async () => {
    h.axiosGet.mockResolvedValueOnce({
      data: { id: 'pl1', name: 'List', items: { total: 9 } },
    });

    const res = await makeApi().getPlaylist('pl1');

    expect(h.axiosGet).toHaveBeenCalledWith('https://api.spotify.com/v1/playlists/pl1', {
      params: { fields: 'id,name,description,images(url),items(total)' },
      headers: { Authorization: 'Bearer valid-token' },
    });
    // Callers keep consuming the OLD shape.
    expect(res.success).toBe(true);
    expect(res.data.tracks).toEqual({ total: 9 });
    expect(res.data).not.toHaveProperty('items');
  });

  it('leaves a response untouched when it already uses the old tracks shape', async () => {
    const data = { id: 'pl1', tracks: { total: 3 } };
    h.axiosGet.mockResolvedValueOnce({ data });
    const res = await makeApi().getPlaylist('pl1');
    expect(res.data).toEqual({ id: 'pl1', tracks: { total: 3 } });
  });

  it('maps 404 on a Spotify-owned playlist id to spotifyOwnedPlaylist', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(404));
    const res = await makeApi().getPlaylist('37i9dQZF1DZ06evO1ru5fF');
    expect(res).toEqual({
      success: false,
      error: 'spotifyOwnedPlaylist',
      playlistType: 'this_is',
    });
  });

  it('maps 401 to needsReAuth and clears the cached token', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(401));
    const res = await makeApi().getPlaylist('pl1');
    expect(res).toMatchObject({
      success: false,
      error: 'Spotify authorization error (token likely expired/invalid)',
      needsReAuth: true,
    });
    expect(res.authUrl).toContain('https://accounts.spotify.com/authorize?client_id=');
    expect(h.deleteSetting).toHaveBeenCalledWith('spotify_access_token');
    expect(h.deleteSetting).toHaveBeenCalledWith('spotify_token_expires_at');
  });
});

describe('SpotifyApi2.getTracks', () => {
  beforeEach(() => seedValidToken());

  it('fetches from /playlists/{id}/items with new-format fields and normalizes item → track', async () => {
    h.axiosGet.mockResolvedValueOnce({
      data: { items: [...mkNewItems(2), null, { item: null }], total: 2 },
    });

    const res = await makeApi().getTracks('pl1');

    expect(h.axiosGet).toHaveBeenCalledTimes(1);
    expect(h.axiosGet).toHaveBeenCalledWith(
      `https://api.spotify.com/v1/playlists/pl1/items?limit=100&offset=0&fields=${V2_TRACK_FIELDS}`,
      { headers: { Authorization: 'Bearer valid-token' } }
    );
    // Entries are renamed item → track and null/empty entries dropped.
    expect(res).toEqual({ success: true, data: { items: mkOldItems(2) } });
    expect(res.data.items[0]).not.toHaveProperty('item');
  });

  it('does not rename entries that already carry a track property', async () => {
    h.axiosGet.mockResolvedValueOnce({
      data: { items: [{ track: { id: 'old' }, item: { id: 'new' } }], total: 1 },
    });
    const res = await makeApi().getTracks('pl1');
    // normalizeTrackItems only renames when `item` exists AND `track` does not.
    expect(res.data.items[0].track).toEqual({ id: 'old' });
    expect(res.data.items[0].item).toEqual({ id: 'new' });
  });

  it('pages the remainder in parallel against /items, normalizing every page', async () => {
    h.axiosGet.mockImplementation(async (url: string) => {
      expect(url).toContain('/v1/playlists/pl1/items?');
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset === 0) return { data: { items: mkNewItems(100, 0), total: 250 } };
      if (offset === 100) return { data: { items: mkNewItems(100, 100) } };
      if (offset === 200) return { data: { items: mkNewItems(50, 200) } };
      throw new Error(`unexpected GET ${url}`);
    });
    const onProgress = vi.fn();

    const res = await makeApi().getTracks('pl1', onProgress);

    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(250);
    expect(res.data.items[0].track.id).toBe('t0');
    expect(res.data.items[249].track.id).toBe('t249');
    expect(res.data.items.every((i: any) => i.track && !i.item)).toBe(true);

    const urls = h.axiosGet.mock.calls.map((c) => c[0]);
    expect(urls[1]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/items?limit=100&offset=100&fields=${V2_TRACK_FIELDS}`
    );
    expect(urls[2]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/items?limit=100&offset=200&fields=${V2_TRACK_FIELDS}`
    );
    expect(onProgress.mock.calls.map((c) => c[0].percentage)).toEqual([40, 99]);
  });

  it('retries the initial request with limit=50 on a 400', async () => {
    h.axiosGet
      .mockRejectedValueOnce(axiosError(400))
      .mockResolvedValueOnce({ data: { items: mkNewItems(30), total: 30 } });

    const res = await makeApi().getTracks('pl1');

    expect(res.success).toBe(true);
    expect(res.data.items).toHaveLength(30);
    expect(h.axiosGet.mock.calls[1][0]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/items?limit=50&offset=0&fields=${V2_TRACK_FIELDS}`
    );
  });

  it('has no v2-switch on 403: it falls back to sequential and maps the error', async () => {
    h.axiosGet.mockRejectedValue(axiosError(403));

    const res = await makeApi().getTracks('pl1');

    // Unlike v1 there is no `spotify_api2_switch` result — the 403 falls
    // through to the sequential fallback, which fails the same way.
    expect(res).toEqual({ success: false, error: 'Spotify API error: 403', needsReAuth: false });
    expect(h.axiosGet).toHaveBeenCalledTimes(2);
    expect(h.axiosGet.mock.calls[1][0]).toBe(
      `https://api.spotify.com/v1/playlists/pl1/items?limit=50&fields=items(item(id,name,artists(name),album(name,images,release_date),external_urls,preview_url)),next`
    );
  });

  it('falls back to sequential /items paging (next links) when a parallel page is rate limited', async () => {
    const seqStart = `https://api.spotify.com/v1/playlists/pl1/items?limit=50&fields=items(item(id,name,artists(name),album(name,images,release_date),external_urls,preview_url)),next`;
    const seqNext = 'https://api.spotify.com/v1/playlists/pl1/items?seqpage=2';
    h.axiosGet.mockImplementation(async (url: string) => {
      if (url.includes('offset=0')) return { data: { items: mkNewItems(100, 0), total: 150 } };
      if (url.includes('offset=100'))
        throw axiosError(429, { headers: { 'retry-after': '1' } });
      if (url === seqStart) return { data: { items: mkNewItems(50, 0), next: seqNext } };
      if (url === seqNext) return { data: { items: mkNewItems(50, 50), next: null } };
      throw new Error(`unexpected GET ${url}`);
    });

    const res = await makeApi().getTracks('pl1');

    expect(res.success).toBe(true);
    // Sequential refetches from scratch; its items are normalized too.
    expect(res.data.items).toHaveLength(100);
    expect(res.data.items.every((i: any) => i.track && !i.item)).toBe(true);
    const urls = h.axiosGet.mock.calls.map((c) => c[0]);
    expect(urls).toContain(seqStart);
    expect(urls[urls.length - 1]).toBe(seqNext);
  });

  it('asks for re-auth before any request when no token is available', async () => {
    h.settingsStore.clear();
    const res = await makeApi().getTracks('pl1');
    expect(res).toMatchObject({
      success: false,
      error: 'Spotify authentication required',
      needsReAuth: true,
    });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });
});

describe('SpotifyApi2.getTracksByIds', () => {
  beforeEach(() => seedValidToken());

  it('rejects an empty id list', async () => {
    expect(await makeApi().getTracksByIds([])).toEqual({
      success: false,
      error: 'No track IDs provided',
    });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('chunks ids into batches of 50 against the unchanged /v1/tracks endpoint', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
    h.axiosGet.mockImplementation(async (_url: string, config: any) => ({
      data: {
        tracks: [...config.params.ids.split(',').map((id: string) => ({ id })), null],
      },
    }));

    const res = await makeApi().getTracksByIds(ids);

    expect(h.axiosGet).toHaveBeenCalledTimes(2);
    expect(h.axiosGet.mock.calls[0][0]).toBe('https://api.spotify.com/v1/tracks');
    expect(h.axiosGet.mock.calls[0][1].params.ids).toBe(ids.slice(0, 50).join(','));
    expect(h.axiosGet.mock.calls[1][1].params.ids).toBe(ids.slice(50).join(','));
    expect(res.success).toBe(true);
    expect(res.data.tracks).toHaveLength(60); // nulls filtered out
  });

  it('tolerates a chunk response without a tracks array (guard absent in v1)', async () => {
    // v2 uses `response.data?.tracks || []`, so a malformed chunk yields an
    // empty contribution instead of v1's internal TypeError.
    h.axiosGet
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { tracks: [{ id: 'id50' }] } });

    const ids = Array.from({ length: 51 }, (_, i) => `id${i}`);
    const res = await makeApi().getTracksByIds(ids);

    expect(res).toEqual({ success: true, data: { tracks: [{ id: 'id50' }] } });
  });

  it('maps a 401 from a chunk to needsReAuth', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(401));
    const res = await makeApi().getTracksByIds(['a']);
    expect(res).toMatchObject({ success: false, needsReAuth: true });
  });
});

describe('SpotifyApi2.searchTracks', () => {
  beforeEach(() => seedValidToken());

  it('rejects an empty search term', async () => {
    expect(await makeApi().searchTracks('')).toEqual({
      success: false,
      error: 'Search term is required',
    });
  });

  it('queries /v1/search exactly like v1 (unchanged endpoint), clamping limit to 50', async () => {
    const payload = { tracks: { items: [{ id: 't1' }], total: 1 } };
    h.axiosGet.mockResolvedValueOnce({ data: payload });

    const res = await makeApi().searchTracks('queen', 99, 20);

    expect(res).toEqual({ success: true, data: payload });
    expect(h.axiosGet).toHaveBeenCalledWith('https://api.spotify.com/v1/search', {
      params: {
        q: 'queen',
        type: 'track',
        limit: 50,
        offset: 20,
        fields: 'tracks(items(id,name,artists(name),album(images(url))),total)',
      },
      headers: { Authorization: 'Bearer valid-token' },
    });
  });

  it('maps 400 with an auth-flavored message to needsReAuth and clears tokens', async () => {
    h.axiosGet.mockRejectedValueOnce(
      axiosError(400, { data: { error: { status: 400, message: 'Token expired' } } })
    );
    const res = await makeApi().searchTracks('queen');
    expect(res).toMatchObject({ success: false, needsReAuth: true });
    expect(h.deleteSetting).toHaveBeenCalledWith('spotify_access_token');
  });

  it('maps a 429 with Retry-After into retryAfter seconds', async () => {
    h.axiosGet.mockRejectedValueOnce(axiosError(429, { headers: { 'retry-after': '12' } }));
    const res = await makeApi().searchTracks('queen');
    expect(res).toEqual({
      success: false,
      error: 'Spotify API error: 429 Too Many Requests. Retry after: 12 seconds.',
      needsReAuth: false,
      retryAfter: 12,
    });
  });
});

describe('SpotifyApi2.createOrUpdatePlaylist', () => {
  beforeEach(() => seedValidToken());

  const trackIds = Array.from({ length: 150 }, (_, i) => `id${i}`);

  it('creates via POST /v1/me/playlists and adds tracks to /playlists/{id}/items', async () => {
    h.axiosGet.mockImplementation(async (url: string) => {
      if (url === 'https://api.spotify.com/v1/me') return { data: { id: 'user1' } };
      if (url === 'https://api.spotify.com/v1/me/playlists') return { data: { items: [] } };
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
    // New API: track additions go to .../items (v1 used .../tracks).
    expect(add1[0]).toBe('https://api.spotify.com/v1/playlists/pl-new/items');
    expect(JSON.parse(add1[1]).uris).toHaveLength(100);
    expect(JSON.parse(add1[1]).uris[0]).toBe('spotify:track:id0');
    expect(add2[0]).toBe('https://api.spotify.com/v1/playlists/pl-new/items');
    expect(JSON.parse(add2[1]).uris).toHaveLength(50);
  });

  it('updates an existing owned playlist through PUT/POST on the /items endpoint', async () => {
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
    expect(h.axiosRequest).toHaveBeenCalledTimes(2);
    const [first, second] = h.axiosRequest.mock.calls.map((c) => c[0]);
    expect(first.method).toBe('put');
    expect(first.url).toBe('https://api.spotify.com/v1/playlists/pl-exist/items');
    expect(JSON.parse(first.data).uris).toHaveLength(100);
    expect(second.method).toBe('post');
    expect(second.url).toBe('https://api.spotify.com/v1/playlists/pl-exist/items');
    expect(JSON.parse(second.data).uris).toHaveLength(50);
    expect(h.axiosPost).not.toHaveBeenCalled();
  });

  it('asks for re-auth when no token is available', async () => {
    h.settingsStore.clear();
    const res = await makeApi().createOrUpdatePlaylist('My List', ['a']);
    expect(res).toMatchObject({ success: false, needsReAuth: true });
    expect(h.axiosGet).not.toHaveBeenCalled();
  });
});

describe('SpotifyApi2.deletePlaylist', () => {
  beforeEach(() => seedValidToken());

  it('unfollows via DELETE /followers (direct, no retry wrapper)', async () => {
    h.axiosDelete.mockResolvedValueOnce({});

    const res = await makeApi().deletePlaylist('pl1');

    expect(res).toEqual({ success: true });
    expect(h.axiosDelete).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/playlists/pl1/followers',
      { headers: { Authorization: 'Bearer valid-token' } }
    );
  });

  it('does not retry a 429 (no executeWithRetry on this path) and maps it', async () => {
    h.axiosDelete.mockRejectedValueOnce(axiosError(429, { headers: { 'retry-after': '3' } }));
    const res = await makeApi().deletePlaylist('pl1');
    expect(res).toMatchObject({ success: false, retryAfter: 3 });
    expect(h.axiosDelete).toHaveBeenCalledTimes(1);
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

describe('SpotifyApi2.isSpotifyOwnedPlaylist', () => {
  it('classifies the same Spotify-owned prefixes as v1', () => {
    const api = makeApi();
    expect(api.isSpotifyOwnedPlaylist('37i9dQZF1DXcBWIGoYBM5M').type).toBe('editorial');
    expect(api.isSpotifyOwnedPlaylist('37i9dQZF1E37jO8SiMT0yN').type).toBe('daily_mix');
    expect(api.isSpotifyOwnedPlaylist('37i9dQZEVXbMDoHDwVN2tF').type).toBe('personalized');
    expect(api.isSpotifyOwnedPlaylist('3cEYpjA9oz9GiPac4AsH4n')).toEqual({ isOwned: false });
  });
});
