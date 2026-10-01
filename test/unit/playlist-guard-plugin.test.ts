import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// The reload budget is a Redis counter; only `increment` is used.
const cacheMock = vi.hoisted(() => ({
  increment: vi.fn(),
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

import playlistGuardPlugin, {
  forbiddenPlaylistAgent,
  isPlaylistPath,
} from '../../src/plugins/playlistGuardPlugin';

describe('forbiddenPlaylistAgent', () => {
  it('matches every okhttp version, case-insensitively', () => {
    expect(forbiddenPlaylistAgent('okhttp/4.12.0')).toBe('okhttp');
    expect(forbiddenPlaylistAgent('okhttp/3.14.9')).toBe('okhttp');
    expect(forbiddenPlaylistAgent('OkHttp/5.0.0-alpha.2')).toBe('okhttp');
  });

  it('lets browsers, the app WebView and our own SSR server through', () => {
    expect(
      forbiddenPlaylistAgent(
        'Mozilla/5.0 (Linux; Android 12; 220333QAG Build/SKQ1.211103.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.36 Mobile Safari/537.36'
      )
    ).toBeNull();
    expect(forbiddenPlaylistAgent('node')).toBeNull();
    expect(forbiddenPlaylistAgent('')).toBeNull();
  });
});

describe('isPlaylistPath', () => {
  it('covers playlists and playlist tracks for every service', () => {
    for (const service of [
      'spotify',
      'music',
      'apple-music',
      'deezer',
      'tidal',
      'youtube-music',
    ]) {
      expect(isPlaylistPath(`/${service}/playlists`)).toBe(true);
      expect(isPlaylistPath(`/${service}/playlists/tracks?x=1`)).toBe(true);
    }
  });

  it('leaves other routes alone', () => {
    expect(isPlaylistPath('/qrlink/123')).toBe(false);
    expect(isPlaylistPath('/qrlink_unknown')).toBe(false);
    expect(isPlaylistPath('/playlist/abc/link-coverage')).toBe(false);
    expect(isPlaylistPath('/featured/en')).toBe(false);
  });
});

describe('playlistGuardPlugin', () => {
  // Echoes the cache flag the route handler ends up with.
  async function build() {
    const app = Fastify();
    app.decorateRequest('clientIp', '');
    app.addHook('onRequest', (request, _reply, done) => {
      request.clientIp = '203.0.113.7';
      done();
    });
    await app.register(playlistGuardPlugin);
    app.post('/spotify/playlists/tracks', async (request: any) => ({
      cache: request.body.cache,
    }));
    app.post('/qrlink_unknown', async (request: any) => ({
      cache: request.body.cache ?? null,
    }));
    return app;
  }

  function post(
    app: Awaited<ReturnType<typeof build>>,
    url: string,
    payload: Record<string, unknown>,
    userAgent = 'Mozilla/5.0 (iPhone)'
  ) {
    return app.inject({
      method: 'POST',
      url,
      headers: { 'user-agent': userAgent },
      payload,
    });
  }

  beforeEach(() => {
    cacheMock.increment.mockReset();
    cacheMock.increment.mockResolvedValue(1);
  });

  it('refuses a forbidden agent on a playlist route', async () => {
    const app = await build();
    const res = await post(
      app,
      '/spotify/playlists/tracks',
      { playlistId: 'x', cache: 1 },
      'okhttp/4.12.0'
    );
    expect(res.statusCode).toBe(403);
  });

  it('serves the same agent on other routes', async () => {
    const app = await build();
    const res = await post(app, '/qrlink_unknown', {}, 'okhttp/4.12.0');
    expect(res.statusCode).toBe(200);
  });

  it('reads a missing cache flag as "use the cache"', async () => {
    const app = await build();
    const res = await post(app, '/spotify/playlists/tracks', { playlistId: 'x' });
    expect(res.json().cache).toBe(1);
    expect(cacheMock.increment).not.toHaveBeenCalled();
  });

  it('leaves cache: 1 alone without counting it', async () => {
    const app = await build();
    const res = await post(app, '/spotify/playlists/tracks', {
      playlistId: 'x',
      cache: 1,
    });
    expect(res.json().cache).toBe(1);
    expect(cacheMock.increment).not.toHaveBeenCalled();
  });

  it('honours a reload within the budget', async () => {
    cacheMock.increment.mockResolvedValue(20);
    const app = await build();
    const res = await post(app, '/spotify/playlists/tracks', {
      playlistId: 'x',
      cache: 0,
    });
    expect(res.json().cache).toBe(0);
    expect(cacheMock.increment).toHaveBeenCalledWith(
      'playlist_reload:203.0.113.7',
      3600
    );
  });

  it('serves a reload over the budget from the cache', async () => {
    cacheMock.increment.mockResolvedValue(21);
    const app = await build();
    const res = await post(app, '/spotify/playlists/tracks', {
      playlistId: 'x',
      cache: 'false',
    });
    expect(res.json().cache).toBe(1);
  });

  it('honours the reload when Redis is down', async () => {
    cacheMock.increment.mockRejectedValue(new Error('redis down'));
    const app = await build();
    const res = await post(app, '/spotify/playlists/tracks', {
      playlistId: 'x',
      cache: 0,
    });
    expect(res.json().cache).toBe(0);
  });

  it('does not touch the cache flag on other routes', async () => {
    const app = await build();
    const res = await post(app, '/qrlink_unknown', {});
    expect(res.json().cache).toBeNull();
  });
});
