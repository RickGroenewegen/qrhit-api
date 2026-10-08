import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Module-level mocks — must come before any src/ import
// ---------------------------------------------------------------------------

const settingsStore = new Map<string, string>();

vi.mock('../../src/settings', () => ({
  default: {
    getInstance: () => ({
      getSetting: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
      setSetting: vi.fn(async (key: string, value: string) => {
        settingsStore.set(key, value);
      }),
    }),
  },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({}) },
}));

vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      del: vi.fn(async () => undefined),
      acquireLock: vi.fn(async () => true),
      releaseLock: vi.fn(async () => undefined),
    }),
  },
}));

// Pushover is fired when a refresh token is discarded; stub it (no real I/O).
vi.mock('../../src/pushover', () => ({
  default: class {
    async sendMessage() {}
  },
}));

// The one-time login state (carrying the PKCE verifier) is stored in Redis;
// record what is issued instead.
const issuedStates = vi.hoisted(() => [] as { provider: string; value: string }[]);
vi.mock('../../src/oauthState', () => ({
  issueOAuthState: vi.fn(async (provider: string, value: string) => {
    issuedStates.push({ provider, value });
    return 'test-state';
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import TidalApi from '../../src/tidal_api';

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

process.env.TIDAL_CLIENT_ID = 'test-client-id';
process.env.TIDAL_CLIENT_SECRET = 'test-secret';
// Redirect URI is now derived from API_URI (+ /tidal/callback).
process.env.API_URI = 'https://example.com';
const TIDAL_REDIRECT_URI = 'https://example.com/tidal/callback';

// ---------------------------------------------------------------------------
// fetch mock infrastructure
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as any;
  settingsStore.clear();
  issuedStates.length = 0;
  (TidalApi as any).instance = undefined;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(body: unknown, status = 200) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function getInstance() {
  return TidalApi.getInstance();
}

/** Put a non-expired access token in the settings store */
function seedValidToken(token = 'valid-access-token') {
  settingsStore.set('tidal_access_token', token);
  settingsStore.set('tidal_token_expires_at', String(Date.now() + 3_600_000)); // 1 h from now
}

/** Put an expired access token in the store */
function seedExpiredToken(token = 'expired-token') {
  settingsStore.set('tidal_access_token', token);
  settingsStore.set('tidal_token_expires_at', String(Date.now() - 10_000)); // expired 10 s ago
}

// ---------------------------------------------------------------------------
// 1. createAuthorizationUrl
// ---------------------------------------------------------------------------

describe('createAuthorizationUrl', () => {
  it('returns a URL that starts with the Tidal login authorize endpoint', async () => {
    const api = getInstance();
    const url = await api.createAuthorizationUrl();
    expect(url).toMatch(/^https:\/\/login\.tidal\.com\/authorize\?/);
  });

  it('includes required query params: client_id, redirect_uri, scope, code_challenge_method, state', async () => {
    const api = getInstance();
    const url = await api.createAuthorizationUrl();
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe(TIDAL_REDIRECT_URI);
    expect(parsed.searchParams.get('scope')).toBe('playlists.read');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe('test-state');
  });

  it('stores the code verifier with the one-time state', async () => {
    const api = getInstance();
    await api.createAuthorizationUrl();
    expect(issuedStates).toHaveLength(1);
    expect(issuedStates[0].provider).toBe('tidal');
    expect(issuedStates[0].value).toBeTruthy();
  });

  it('code_challenge is the SHA-256 base64url of the stored verifier', async () => {
    const api = getInstance();
    const url = await api.createAuthorizationUrl();
    const parsed = new URL(url);
    const challenge = parsed.searchParams.get('code_challenge')!;
    const storedVerifier = issuedStates[0].value;

    const expected = crypto
      .createHash('sha256')
      .update(storedVerifier)
      .digest('base64url');

    expect(challenge).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. exchangeCodeForToken
// ---------------------------------------------------------------------------

describe('exchangeCodeForToken', () => {
  it('sends the code with the verifier of its login', async () => {
    const api = getInstance();

    mockFetch.mockResolvedValueOnce(
      makeResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
      })
    );

    const result = await api.exchangeCodeForToken('code-abc', 'verifier-abc');
    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://auth.tidal.com/v1/oauth2/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-abc');
    expect(body.get('code_verifier')).toBe('verifier-abc');
    expect(body.get('client_id')).toBe('test-client-id');
    expect(body.get('client_secret')).toBe('test-secret');
  });

  it('stores tokens on success', async () => {
    const api = getInstance();

    mockFetch.mockResolvedValueOnce(
      makeResponse({
        access_token: 'at-stored',
        refresh_token: 'rt-stored',
        expires_in: 7200,
      })
    );

    await api.exchangeCodeForToken('code-store', 'verifier');

    expect(settingsStore.get('tidal_access_token')).toBe('at-stored');
    expect(settingsStore.get('tidal_refresh_token')).toBe('rt-stored');
    expect(settingsStore.get('tidal_token_expires_at')).toBeTruthy();
  });

  it('returns {success:false, error} using error_description on non-ok response', async () => {
    const api = getInstance();

    mockFetch.mockResolvedValueOnce(
      makeResponse(
        { error: 'invalid_grant', error_description: 'Code expired or already used' },
        400
      )
    );

    const result = await api.exchangeCodeForToken('bad-code', 'verifier');
    expect(result).toEqual({ success: false, error: 'Code expired or already used' });
  });

  it('falls back to "Token exchange failed" when error_description is missing', async () => {
    const api = getInstance();

    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'server_error' }, 500));

    const result = await api.exchangeCodeForToken('bad-code-2', 'verifier');
    expect(result).toEqual({ success: false, error: 'Token exchange failed' });
  });

  it('returns {success:false, error} on fetch exception', async () => {
    const api = getInstance();

    mockFetch.mockRejectedValueOnce(new Error('network failure'));

    const result = await api.exchangeCodeForToken('code-net', 'verifier');
    expect(result).toEqual({ success: false, error: 'network failure' });
  });
});

// ---------------------------------------------------------------------------
// 3. refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  it('returns null when no refresh token is stored', async () => {
    const api = getInstance();
    const result = await api.refreshAccessToken();
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the new access token and stores it on success', async () => {
    settingsStore.set('tidal_refresh_token', 'rt-old');

    mockFetch.mockResolvedValueOnce(
      makeResponse({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
      })
    );

    const api = getInstance();
    const result = await api.refreshAccessToken();
    expect(result).toBe('at-new');
    expect(settingsStore.get('tidal_access_token')).toBe('at-new');
    expect(settingsStore.get('tidal_refresh_token')).toBe('rt-new');
    // A rotated refresh token restarts the expiry-tracking clock.
    expect(settingsStore.get('tidal_refresh_token_obtained_at')).toBeTruthy();
  });

  it('discards tokens and returns null on an auth-error (401) response', async () => {
    settingsStore.set('tidal_refresh_token', 'rt-bad');
    settingsStore.set('tidal_access_token', 'at-old');

    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'invalid_token' }, 401));

    const api = getInstance();
    const result = await api.refreshAccessToken();
    expect(result).toBeNull();
    // clearTokens blanks every token key.
    expect(settingsStore.get('tidal_access_token')).toBe('');
    expect(settingsStore.get('tidal_refresh_token')).toBe('');
  });

  it('keeps the refresh token on a transient (5xx) refresh failure', async () => {
    settingsStore.set('tidal_refresh_token', 'rt-keep');
    settingsStore.set('tidal_access_token', 'at-old');

    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'server_error' }, 503));

    const api = getInstance();
    const result = await api.refreshAccessToken();
    expect(result).toBeNull();
    // A brief Tidal outage must not force a manual re-login.
    expect(settingsStore.get('tidal_refresh_token')).toBe('rt-keep');
  });

  it('returns null on fetch exception', async () => {
    settingsStore.set('tidal_refresh_token', 'rt-err');
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const api = getInstance();
    const result = await api.refreshAccessToken();
    expect(result).toBeNull();
  });

  it('sends client_secret in body when set', async () => {
    settingsStore.set('tidal_refresh_token', 'rt-sec');

    mockFetch.mockResolvedValueOnce(
      makeResponse({ access_token: 'at-sec', expires_in: 3600 })
    );

    const api = getInstance();
    await api.refreshAccessToken();

    const [, init] = mockFetch.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_secret')).toBe('test-secret');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-sec');
  });
});

// ---------------------------------------------------------------------------
// 4. getAccessToken
// ---------------------------------------------------------------------------

describe('getAccessToken', () => {
  it('returns stored token when it exists and has not expired', async () => {
    seedValidToken('my-token');

    const api = getInstance();
    const token = await api.getAccessToken();
    expect(token).toBe('my-token');
    // should NOT hit the network
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls refreshAccessToken when the token has expired', async () => {
    seedExpiredToken('stale-token');
    settingsStore.set('tidal_refresh_token', 'rt-refresh');

    mockFetch.mockResolvedValueOnce(
      makeResponse({ access_token: 'refreshed-token', expires_in: 3600 })
    );

    const api = getInstance();
    const token = await api.getAccessToken();
    expect(token).toBe('refreshed-token');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('calls refreshAccessToken when no token is stored', async () => {
    // store has nothing — no access token, but has a refresh token
    settingsStore.set('tidal_refresh_token', 'rt-cold');

    mockFetch.mockResolvedValueOnce(
      makeResponse({ access_token: 'cold-token', expires_in: 3600 })
    );

    const api = getInstance();
    const token = await api.getAccessToken();
    expect(token).toBe('cold-token');
  });

  it('returns null when token is expired within the 60 s buffer', async () => {
    // expires 30 s from now — within the 60 s buffer, so should refresh
    settingsStore.set('tidal_access_token', 'nearly-expired');
    settingsStore.set('tidal_token_expires_at', String(Date.now() + 30_000));
    // no refresh token → refreshAccessToken returns null

    const api = getInstance();
    const token = await api.getAccessToken();
    expect(token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. isConnected
// ---------------------------------------------------------------------------

describe('isConnected', () => {
  it('returns true when getAccessToken returns a token', async () => {
    seedValidToken('live-token');

    const api = getInstance();
    expect(await api.isConnected()).toBe(true);
  });

  it('returns false when getAccessToken returns null', async () => {
    // no token, no refresh token → null
    const api = getInstance();
    expect(await api.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. clearTokens
// ---------------------------------------------------------------------------

describe('clearTokens', () => {
  it('sets all four token settings to empty string', async () => {
    settingsStore.set('tidal_access_token', 'at');
    settingsStore.set('tidal_refresh_token', 'rt');
    settingsStore.set('tidal_token_expires_at', '12345');

    const api = getInstance();
    await api.clearTokens();

    expect(settingsStore.get('tidal_access_token')).toBe('');
    expect(settingsStore.get('tidal_refresh_token')).toBe('');
    expect(settingsStore.get('tidal_token_expires_at')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 7. apiRequest
// ---------------------------------------------------------------------------

describe('apiRequest', () => {
  it('returns {success:false, needsReAuth:true} when no access token is available', async () => {
    const api = getInstance();
    const result = await api.apiRequest('/some/endpoint');
    expect(result).toEqual({
      success: false,
      error: 'Not authenticated with Tidal',
      needsReAuth: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('prepends TIDAL_API_BASE_URL when endpoint does not start with http', async () => {
    seedValidToken();

    mockFetch.mockResolvedValueOnce(makeResponse({ items: [] }));

    const api = getInstance();
    await api.apiRequest('/playlists/123');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://openapi.tidal.com/v2/playlists/123');
  });

  it('uses endpoint as-is when it starts with http', async () => {
    seedValidToken();

    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }));

    const api = getInstance();
    await api.apiRequest('https://custom.example.com/api/data');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://custom.example.com/api/data');
  });

  it('returns {success:true, data} on ok response', async () => {
    seedValidToken();

    const payload = { data: [{ id: '1' }] };
    mockFetch.mockResolvedValueOnce(makeResponse(payload));

    const api = getInstance();
    const result = await api.apiRequest('/tracks');
    expect(result).toEqual({ success: true, data: payload });
  });

  it('returns {success:false, error} using errors[0].detail on non-ok response', async () => {
    seedValidToken();

    mockFetch.mockResolvedValueOnce(
      makeResponse({ errors: [{ detail: 'Resource not found' }] }, 404)
    );

    const api = getInstance();
    const result = await api.apiRequest('/tracks/missing');
    expect(result).toEqual({ success: false, error: 'Resource not found' });
  });

  it('falls back to generic error message when errors array is absent', async () => {
    seedValidToken();

    mockFetch.mockResolvedValueOnce(makeResponse({}, 500));

    const api = getInstance();
    const result = await api.apiRequest('/tracks/bad');
    expect(result).toEqual({ success: false, error: 'API request failed: 500' });
  });

  it('on 401: retries with refreshed token and returns success', async () => {
    seedValidToken('initial-token');
    settingsStore.set('tidal_refresh_token', 'rt-401');

    // First call returns 401
    mockFetch.mockResolvedValueOnce(makeResponse({}, 401));
    // refreshAccessToken call
    mockFetch.mockResolvedValueOnce(
      makeResponse({ access_token: 'refreshed-token', expires_in: 3600 })
    );
    // Retry call returns 200
    mockFetch.mockResolvedValueOnce(makeResponse({ data: 'retried' }));

    const api = getInstance();
    const result = await api.apiRequest('/playlists/abc');
    expect(result).toEqual({ success: true, data: { data: 'retried' } });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('on 401 when refresh fails: returns {success:false, needsReAuth:true}', async () => {
    seedValidToken('initial-token');
    // no refresh token → refreshAccessToken returns null immediately

    mockFetch.mockResolvedValueOnce(makeResponse({}, 401));

    const api = getInstance();
    const result = await api.apiRequest('/playlists/abc');
    expect(result).toEqual({
      success: false,
      error: 'Authentication failed',
      needsReAuth: true,
    });
  });

  it('returns {success:false, error} on fetch exception', async () => {
    seedValidToken();

    mockFetch.mockRejectedValueOnce(new Error('DNS resolution failed'));

    const api = getInstance();
    const result = await api.apiRequest('/tracks');
    expect(result).toEqual({ success: false, error: 'DNS resolution failed' });
  });

  it('sets correct Authorization and content-type headers', async () => {
    seedValidToken('my-bearer-token');

    mockFetch.mockResolvedValueOnce(makeResponse({}));

    const api = getInstance();
    await api.apiRequest('/tracks');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer my-bearer-token');
    expect(init.headers['Content-Type']).toBe('application/vnd.api+json');
    expect(init.headers['Accept']).toBe('application/vnd.api+json');
  });
});

// ---------------------------------------------------------------------------
// 8. Delegation: getPlaylist, searchTracks, getTracks
// ---------------------------------------------------------------------------

describe('getPlaylist', () => {
  it('calls apiRequest with the correct URL including countryCode', async () => {
    seedValidToken();
    mockFetch.mockResolvedValueOnce(makeResponse({ data: {} }));

    const api = getInstance();
    await api.getPlaylist('playlist-001', 'NL');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/playlists/playlist-001');
    expect(url).toContain('countryCode=NL');
  });

  it('uses default countryCode US when not specified', async () => {
    seedValidToken();
    mockFetch.mockResolvedValueOnce(makeResponse({ data: {} }));

    const api = getInstance();
    await api.getPlaylist('playlist-002');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('countryCode=US');
  });
});

describe('searchTracks', () => {
  it('URL-encodes the query string', async () => {
    seedValidToken();
    mockFetch.mockResolvedValueOnce(makeResponse({ data: [] }));

    const api = getInstance();
    await api.searchTracks('hello world & more', 'US');

    const [url] = mockFetch.mock.calls[0];
    // encodeURIComponent('hello world & more') === 'hello%20world%20%26%20more'
    expect(url).toContain('hello%20world%20%26%20more');
  });

  it('includes countryCode and include=tracks in URL', async () => {
    seedValidToken();
    mockFetch.mockResolvedValueOnce(makeResponse({ data: [] }));

    const api = getInstance();
    await api.searchTracks('Radiohead', 'DE');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('countryCode=DE');
    expect(url).toContain('include=tracks');
  });
});

describe('getTracks', () => {
  it('joins track IDs with comma in the filter[id] parameter', async () => {
    seedValidToken();
    mockFetch.mockResolvedValueOnce(makeResponse({ data: [] }));

    const api = getInstance();
    await api.getTracks(['111', '222', '333'], 'US');

    const rawUrl = mockFetch.mock.calls[0][0] as string;
    // The source builds the URL via template literal (not URLSearchParams) so
    // brackets and commas are passed raw, not percent-encoded.
    // NOTE: suspected bug: passing unencoded square brackets in a URL is
    // technically invalid (RFC 3986). Whether the Tidal API accepts it should
    // be verified against their docs.
    expect(rawUrl).toContain('filter[id]=111,222,333');
  });

  it('includes include=albums,artists and countryCode in URL', async () => {
    seedValidToken();
    mockFetch.mockResolvedValueOnce(makeResponse({ data: [] }));

    const api = getInstance();
    await api.getTracks(['1', '2'], 'NL');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('countryCode=NL');
    expect(url).toContain('include=albums,artists');
  });
});
