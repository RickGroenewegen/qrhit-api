import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * One-time OAuth states for the API's own Spotify/Tidal logins: issued with
 * a TTL, accepted once, and nothing that merely looks like one.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ttl?: number) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({ get: h.get, set: h.set, del: h.del }),
  },
}));

import { consumeOAuthState, issueOAuthState } from '../../src/oauthState';

beforeEach(() => {
  h.store.clear();
  vi.clearAllMocks();
});

describe('oauthState', () => {
  it('issues a random state per login and stores its value with a TTL', async () => {
    const a = await issueOAuthState('tidal', 'verifier-1');
    const b = await issueOAuthState('tidal', 'verifier-2');
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
    expect(h.set).toHaveBeenCalledWith(`oauth_state:tidal:${a}`, 'verifier-1', expect.any(Number));
    expect(h.set.mock.calls[0][2]).toBeGreaterThan(0);
  });

  it('returns the value once, then never again', async () => {
    const state = await issueOAuthState('tidal', 'verifier-1');
    expect(await consumeOAuthState('tidal', state)).toBe('verifier-1');
    expect(await consumeOAuthState('tidal', state)).toBeNull();
  });

  it('defaults the value to a marker for a provider without one', async () => {
    const state = await issueOAuthState('spotify');
    expect(await consumeOAuthState('spotify', state)).toBe('1');
  });

  it('does not accept a state issued for the other provider', async () => {
    const state = await issueOAuthState('spotify');
    expect(await consumeOAuthState('tidal', state)).toBeNull();
    expect(await consumeOAuthState('spotify', state)).toBe('1');
  });

  it('rejects missing and malformed states without reading the cache', async () => {
    for (const state of [undefined, null, '', 'short', ['a'], 'x'.repeat(31) + '!']) {
      expect(await consumeOAuthState('spotify', state)).toBeNull();
    }
    expect(h.get).not.toHaveBeenCalled();
  });
});
