import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/rate_limit_manager.ts (RateLimitManager).
 *
 * All I/O is mocked:
 *  - src/cache  → in-memory map mock
 *  - src/logger → no-op
 *
 * RateLimitManager has no constructor side effects, just cache reads/writes.
 */

// ── Cache mock ──────────────────────────────────────────────────────────────
const cacheStore = new Map<string, string>();

const cacheMock = {
  get: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string, _ttl?: number) => {
    cacheStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    cacheStore.delete(key);
  }),
};

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import RateLimitManager from '../../src/rate_limit_manager';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSvc(): RateLimitManager {
  (RateLimitManager as any).instance = undefined;
  return RateLimitManager.getInstance();
}

/** Write a future rate-limit entry into the cache (provider is rate-limited) */
function setRateLimited(provider: 'spotifyApi' | 'spotifyScraper', secondsFromNow = 300) {
  cacheStore.set(
    `rate_limit_info_${provider}`,
    JSON.stringify({ provider, retryAfter: Date.now() + secondsFromNow * 1000 })
  );
}

/** Write an expired rate-limit entry (provider no longer limited) */
function setExpiredLimit(provider: 'spotifyApi' | 'spotifyScraper') {
  cacheStore.set(
    `rate_limit_info_${provider}`,
    JSON.stringify({ provider, retryAfter: Date.now() - 1000 })
  );
}

/** Minimal ApiProvider mock */
function makeProvider(returnVal: any = { success: true, data: [] }) {
  return {
    getPlaylist: vi.fn(async () => returnVal),
    getTracks: vi.fn(async () => returnVal),
    getTracksByIds: vi.fn(async () => returnVal),
    searchTracks: vi.fn(async () => returnVal),
  };
}

beforeEach(() => {
  cacheStore.clear();
  vi.clearAllMocks();
  // Re-install default implementations after clearAllMocks wipes them
  cacheMock.get.mockImplementation(async (key: string) => cacheStore.get(key) ?? null);
  cacheMock.set.mockImplementation(async (key: string, value: string, _ttl?: number) => {
    cacheStore.set(key, value);
  });
  cacheMock.del.mockImplementation(async (key: string) => {
    cacheStore.delete(key);
  });
});

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

describe('RateLimitManager singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const svc = makeSvc();
    expect(RateLimitManager.getInstance()).toBe(svc);
  });
});

// ──────────────────────────────────────────────
// getAvailableProvider
// ──────────────────────────────────────────────

describe('RateLimitManager.getAvailableProvider', () => {
  it('returns primary provider when neither is rate-limited', async () => {
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyApi');
    expect(result.provider).toBe(primary);
  });

  it('returns fallback when primary (spotifyApi) is rate-limited', async () => {
    setRateLimited('spotifyApi');
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyScraper');
    expect(result.provider).toBe(fallback);
  });

  it('returns primary when primary is not limited (even if scraper is limited)', async () => {
    setRateLimited('spotifyScraper');
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyApi');
  });

  it('returns primary when both are rate-limited and api expires sooner', async () => {
    setRateLimited('spotifyApi', 60);    // expires in 60s
    setRateLimited('spotifyScraper', 120); // expires in 120s
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyApi');
  });

  it('returns fallback when both are rate-limited and scraper expires sooner', async () => {
    setRateLimited('spotifyApi', 120);
    setRateLimited('spotifyScraper', 60);
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyScraper');
  });

  it('treats expired rate limit as not limited', async () => {
    setExpiredLimit('spotifyApi');
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyApi');
    // Expired entry should have been cleared from cache
    expect(cacheStore.has('rate_limit_info_spotifyApi')).toBe(false);
  });

  it('handles corrupt cache data gracefully (treats as not limited)', async () => {
    cacheStore.set('rate_limit_info_spotifyApi', 'INVALID_JSON{{{');
    const primary = makeProvider();
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.getAvailableProvider(primary, fallback);
    expect(result.name).toBe('spotifyApi');
  });
});

// ──────────────────────────────────────────────
// executeWithFallback – success path
// ──────────────────────────────────────────────

describe('RateLimitManager.executeWithFallback – success', () => {
  it('returns provider result on success', async () => {
    const successResult = { success: true, data: ['track1'] };
    const primary = makeProvider(successResult);
    const fallback = makeProvider();
    const svc = makeSvc();
    const result = await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(result).toEqual(successResult);
    expect(primary.getPlaylist).toHaveBeenCalledWith('pl1');
    expect(fallback.getPlaylist).not.toHaveBeenCalled();
  });

  it('passes all args to the provider method', async () => {
    const primary = makeProvider({ success: true, data: [] });
    const fallback = makeProvider();
    const svc = makeSvc();
    await svc.executeWithFallback('searchTracks', ['hello', 10, 0] as any, primary, fallback);
    expect(primary.searchTracks).toHaveBeenCalledWith('hello', 10, 0);
  });
});

// ──────────────────────────────────────────────
// executeWithFallback – 429 rate limit handling
// ──────────────────────────────────────────────

describe('RateLimitManager.executeWithFallback – 429 handling', () => {
  it('sets rate limit and falls back to scraper on 429 from api', async () => {
    const rateLimitResult = { success: false, error: 'Rate limit 429: Retry after: 60 seconds' };
    const successResult = { success: true, data: [] };
    const primary = makeProvider(rateLimitResult);
    const fallback = makeProvider(successResult);
    const svc = makeSvc();

    const result = await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(result).toEqual(successResult);
    expect(fallback.getPlaylist).toHaveBeenCalled();
    // spotifyApi should now be rate-limited in cache
    expect(cacheStore.has('rate_limit_info_spotifyApi')).toBe(true);
  });

  it('returns both-limited error when fallback also returns 429', async () => {
    const rateLimitResult = { success: false, error: 'Rate limit 429: Retry after: 60 seconds' };
    const primary = makeProvider(rateLimitResult);
    const fallback = makeProvider({ success: false, error: 'Rate limit 429' });
    const svc = makeSvc();

    const result = await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Both Spotify API and Scraper are rate limited');
    // Both should now be rate-limited
    expect(cacheStore.has('rate_limit_info_spotifyApi')).toBe(true);
    expect(cacheStore.has('rate_limit_info_spotifyScraper')).toBe(true);
  });

  it('sets rate limit without retryAfter when not specified in error', async () => {
    const rateLimitResult = { success: false, error: 'Rate limit 429' };
    const primary = makeProvider(rateLimitResult);
    const fallback = makeProvider({ success: true, data: [] });
    const svc = makeSvc();

    await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(cacheStore.has('rate_limit_info_spotifyApi')).toBe(true);
    const cached = JSON.parse(cacheStore.get('rate_limit_info_spotifyApi')!);
    // Default 5 min fallback (300s) + some margin
    expect(cached.retryAfter).toBeGreaterThan(Date.now() + 290_000);
  });

  it('does not try fallback when primary returns 429 but scraper is already limited', async () => {
    setRateLimited('spotifyScraper');
    const rateLimitResult = { success: false, error: 'Rate limit 429' };
    const primary = makeProvider(rateLimitResult);
    const fallback = makeProvider({ success: true, data: [] });
    const svc = makeSvc();

    const result = await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(result).toEqual(rateLimitResult);
    expect(fallback.getPlaylist).not.toHaveBeenCalled();
  });

  it('returns non-429 error from primary without fallback', async () => {
    const errorResult = { success: false, error: 'Playlist not found' };
    const primary = makeProvider(errorResult);
    const fallback = makeProvider();
    const svc = makeSvc();

    const result = await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(result).toEqual(errorResult);
    expect(fallback.getPlaylist).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// executeWithFallback – exception handling
// ──────────────────────────────────────────────

describe('RateLimitManager.executeWithFallback – exception', () => {
  it('catches thrown errors and returns error result', async () => {
    const primary = makeProvider();
    primary.getPlaylist.mockRejectedValueOnce(new Error('Network timeout'));
    const fallback = makeProvider();
    const svc = makeSvc();

    const result = await svc.executeWithFallback('getPlaylist', ['pl1'] as any, primary, fallback);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Internal error');
    expect(result.error).toContain('Network timeout');
  });
});

// ──────────────────────────────────────────────
// clearAllRateLimits
// ──────────────────────────────────────────────

describe('RateLimitManager.clearAllRateLimits', () => {
  it('removes rate limit entries for both providers', async () => {
    setRateLimited('spotifyApi');
    setRateLimited('spotifyScraper');
    const svc = makeSvc();
    await svc.clearAllRateLimits();
    expect(cacheStore.has('rate_limit_info_spotifyApi')).toBe(false);
    expect(cacheStore.has('rate_limit_info_spotifyScraper')).toBe(false);
  });
});

// ──────────────────────────────────────────────
// getRateLimitStatus
// ──────────────────────────────────────────────

describe('RateLimitManager.getRateLimitStatus', () => {
  it('returns not limited when cache is empty', async () => {
    const svc = makeSvc();
    const status = await svc.getRateLimitStatus();
    expect(status.spotifyApi.limited).toBe(false);
    expect(status.spotifyScraper.limited).toBe(false);
  });

  it('reports limited status with approximate retryAfter', async () => {
    setRateLimited('spotifyApi', 120);
    const svc = makeSvc();
    const status = await svc.getRateLimitStatus();
    expect(status.spotifyApi.limited).toBe(true);
    expect(status.spotifyApi.retryAfter).toBeGreaterThan(100);
    expect(status.spotifyApi.retryAfter).toBeLessThanOrEqual(120);
  });

  it('reports not limited when rate limit has expired', async () => {
    setExpiredLimit('spotifyApi');
    const svc = makeSvc();
    const status = await svc.getRateLimitStatus();
    expect(status.spotifyApi.limited).toBe(false);
  });

  it('handles corrupt JSON gracefully', async () => {
    cacheStore.set('rate_limit_info_spotifyScraper', 'BAD_JSON');
    const svc = makeSvc();
    const status = await svc.getRateLimitStatus();
    expect(status.spotifyScraper.limited).toBe(false);
  });

  it('reports status for both providers independently', async () => {
    setRateLimited('spotifyApi', 60);
    const svc = makeSvc();
    const status = await svc.getRateLimitStatus();
    expect(status.spotifyApi.limited).toBe(true);
    expect(status.spotifyScraper.limited).toBe(false);
  });
});
