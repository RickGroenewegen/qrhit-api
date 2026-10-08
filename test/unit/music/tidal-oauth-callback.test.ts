import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * GET /tidal/callback on a bare Fastify instance: whoever completes the login
 * becomes the API's Tidal account, so only a state an admin login issued is
 * accepted, and its PKCE verifier goes to the token exchange.
 */

const h = vi.hoisted(() => ({
  consume: vi.fn(),
  handleAuthCallback: vi.fn(),
}));

vi.mock('../../../src/oauthState', () => ({
  consumeOAuthState: h.consume,
}));

vi.mock('../../../src/providers', () => ({
  TidalProvider: {
    getInstance: () => ({ handleAuthCallback: h.handleAuthCallback }),
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

vi.mock('../../../src/utils', () => ({ default: class {} }));
vi.mock('../../../src/trackEnrichment', () => ({
  default: { getInstance: () => ({}) },
}));
vi.mock('../../../src/progress-websocket', () => ({
  default: { getInstance: () => null },
}));
vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => ({}) },
}));

import tidalRoutes from '../../../src/routes/tidalRoutes';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await tidalRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.consume.mockReset();
  h.handleAuthCallback.mockReset();
});

describe('GET /tidal/callback', () => {
  it('rejects a code without a valid state and exchanges nothing', async () => {
    h.consume.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/tidal/callback?code=c&state=forged' });
    expect(res.statusCode).toBe(403);
    expect(h.consume).toHaveBeenCalledWith('tidal', 'forged');
    expect(h.handleAuthCallback).not.toHaveBeenCalled();
  });

  it('exchanges the code with the verifier stored under the state', async () => {
    h.consume.mockResolvedValueOnce('the-verifier');
    h.handleAuthCallback.mockResolvedValueOnce({ success: true });
    const res = await app.inject({ method: 'GET', url: '/tidal/callback?code=c&state=s' });
    expect(res.statusCode).toBe(200);
    expect(h.handleAuthCallback).toHaveBeenCalledWith('c', 'the-verifier');
    expect(res.body).toContain('Authorization Complete');
  });

  it('never echoes Tidal error text into the page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tidal/callback?error=x&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    });
    expect(res.body).not.toContain('<script>alert(1)');
    expect(h.handleAuthCallback).not.toHaveBeenCalled();
  });

  it('does not echo a failed exchange error either', async () => {
    h.consume.mockResolvedValueOnce('v');
    h.handleAuthCallback.mockResolvedValueOnce({ success: false, error: '<img src=x onerror=1>' });
    const res = await app.inject({ method: 'GET', url: '/tidal/callback?code=c&state=s' });
    expect(res.body).not.toContain('<img');
  });
});
