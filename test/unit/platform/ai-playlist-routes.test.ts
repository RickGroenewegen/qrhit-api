import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';

/**
 * The AI playlist routes on a bare Fastify instance, with the generator, both
 * suggestion matchers, reCAPTCHA and Redis mocked. No database.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    store,
    counters,
    ip: '203.0.113.7',
    verifyRecaptcha: vi.fn(async () => ({ isHuman: true })),
    run: vi.fn(async () => {}),
    getSnapshot: vi.fn(),
    suggest: vi.fn(),
    spotifySuggest: vi.fn(),
  };
});

vi.mock('../../../src/aiPlaylist', () => ({
  default: { getInstance: () => ({ run: h.run, getSnapshot: h.getSnapshot }) },
  aiPlaylistJobKey: (jobId: string) => `aiPlaylistJob:${jobId}`,
}));

vi.mock('../../../src/aiPlaylistSuggestions', () => ({
  default: { getInstance: () => ({ suggest: h.suggest }) },
}));

vi.mock('../../../src/aiPlaylistSpotifySuggestions', () => ({
  default: { getInstance: () => ({ suggest: h.spotifySuggest }) },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    verifyRecaptcha = h.verifyRecaptcha;
    getClientIp = () => h.ip;
    isTrustedIp = () => false;
  },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => h.store.get(key) ?? null,
      set: async (key: string, value: string) => {
        h.store.set(key, value);
      },
      executeCommand: async (command: string, key: string) => {
        if (command === 'incr') {
          const next = (h.counters.get(key) || 0) + 1;
          h.counters.set(key, next);
          return next;
        }
        if (command === 'decr') {
          h.counters.set(key, (h.counters.get(key) || 0) - 1);
          return h.counters.get(key);
        }
        if (command === 'get') return h.counters.get(key)?.toString() ?? null;
        return 1;
      },
    }),
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import aiPlaylistRoutes from '../../../src/routes/aiPlaylistRoutes';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await aiPlaylistRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.store.clear();
  h.counters.clear();
  h.ip = '203.0.113.7';
  h.run.mockClear();
  h.suggest.mockReset().mockResolvedValue([{ id: 1, slug: 'eighties' }]);
  h.spotifySuggest.mockReset().mockResolvedValue([{ id: 'sp1', name: 'Schlager' }]);
});

/** Start a job the way the form does and return its id. */
async function startJob(prompt: string, locale: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/ai-playlist/generate',
    payload: { prompt, trackCount: 75, captchaToken: 'ok', locale, clientId: randomUUID() },
  });
  return res.json().data.jobId;
}

describe('POST /ai-playlist/generate', () => {
  it('keeps what the job was asked, for the suggestions of the progress page', async () => {
    const jobId = await startJob('Deutsche Schlager', 'de');

    expect(jobId).toMatch(/^ai-\d+-[0-9a-f]{12}$/);
    expect(JSON.parse(h.store.get(`aiPlaylistJob:${jobId}`)!)).toEqual({
      prompt: 'Deutsche Schlager',
      locale: 'de',
      trackCount: 75,
    });
    expect(h.run).toHaveBeenCalledWith({
      jobId,
      prompt: 'Deutsche Schlager',
      trackCount: 75,
      locale: 'de',
    });
    // With a token the form asked for this action.
    expect(h.verifyRecaptcha).toHaveBeenCalledWith('ok', 0.5, 'aiPlaylistGenerate');
    // Starting a job looks nothing up by itself.
    expect(h.suggest).not.toHaveBeenCalled();
    expect(h.spotifySuggest).not.toHaveBeenCalled();
  });
});

describe('the daily limit', () => {
  const CLIENT = '0f8b6a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b';

  // Each call a new browser unless one is given; null sends none.
  function generate(ip: string, clientId: string | null = randomUUID()) {
    h.ip = ip;
    return app.inject({
      method: 'POST',
      url: '/ai-playlist/generate',
      payload: { prompt: 'Kpop', trackCount: 75, captchaToken: 'ok', locale: 'en', clientId },
    });
  }

  async function status(ip: string, clientId?: string) {
    h.ip = ip;
    const query = clientId ? `?clientId=${clientId}` : '';
    const res = await app.inject({ method: 'GET', url: `/ai-playlist/rate-limit-status${query}` });
    return res.json().data;
  }

  it('counts an IPv6 connection by its /64, however the address is written', async () => {
    const sameConnection = [
      '2a01:112f:811:eb00:54e8:f268:7436:4ac7',
      '2a01:112f:811:eb00:28ee:346a:19c0:dd18',
      '2a01:112f:0811:EB00::1',
      '2a01:112f:811:eb00::',
      '2a01:112f:811:eb00:5d8e:c985:e5bf:daeb',
    ];
    for (const ip of sameConnection) {
      expect((await generate(ip)).statusCode).toBe(200);
    }

    const refused = await generate('2a01:112f:811:eb00:ffff:1:2:3');
    expect(refused.statusCode).toBe(429);
    expect(refused.json().data).toEqual({ used: 5, limit: 5, remaining: 0 });

    // Another connection has its own five, and so does IPv4.
    expect((await generate('2a01:112f:811:eb01::1')).statusCode).toBe(200);
    expect((await generate('::ffff:198.51.100.4')).statusCode).toBe(200);
    expect((await status('198.51.100.4')).used).toBe(1);
  });

  it('counts the browser across addresses that keep changing', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await generate(`198.51.100.${i}`, CLIENT);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.rateLimit.remaining).toBe(5 - i);
    }
    expect(await status('198.51.100.99', CLIENT)).toMatchObject({ used: 5, remaining: 0 });

    // A new address with the same browser is refused, and the refusal does
    // not use up the new address.
    expect((await generate('198.51.100.6', CLIENT)).statusCode).toBe(429);
    expect((await status('198.51.100.6')).used).toBe(0);

  });

  it('refuses a request without a browser id as a failed captcha, and counts nothing', async () => {
    h.run.mockClear();
    for (const clientId of [null, '', 'x'.repeat(65), 'not an id!']) {
      const res = await generate('198.51.100.7', clientId);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ success: false, error: 'reCAPTCHA verification failed' });
    }
    expect(h.run).not.toHaveBeenCalled();
    expect((await status('198.51.100.7')).used).toBe(0);
  });

  it('counts an address by itself, whatever browser ids it sends', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await generate('203.0.113.9', `${CLIENT.slice(0, -1)}${i}`)).statusCode).toBe(200);
    }
    expect((await generate('203.0.113.9', `${CLIENT.slice(0, -1)}6`)).statusCode).toBe(429);
  });
});

describe('suggestions for a job', () => {
  it('GET /ai-playlist/suggestions/:jobId matches featured playlists to the job', async () => {
    const jobId = await startJob('Deutsche Schlager', 'de');

    const res = await app.inject({ method: 'GET', url: `/ai-playlist/suggestions/${jobId}` });

    expect(res.json()).toEqual({ success: true, data: [{ id: 1, slug: 'eighties' }] });
    // With the number of tracks the customer asked for, as the minimum size.
    expect(h.suggest).toHaveBeenCalledWith('Deutsche Schlager', 'de', 75);
    expect(h.spotifySuggest).not.toHaveBeenCalled();
  });

  it('GET /ai-playlist/spotify-suggestions/:jobId searches Spotify for the job', async () => {
    const jobId = await startJob('Deutsche Schlager', 'de');

    const res = await app.inject({
      method: 'GET',
      url: `/ai-playlist/spotify-suggestions/${jobId}`,
    });

    expect(res.json()).toEqual({ success: true, data: [{ id: 'sp1', name: 'Schlager' }] });
    expect(h.spotifySuggest).toHaveBeenCalledWith('Deutsche Schlager', 'de', 75);
    expect(h.suggest).not.toHaveBeenCalled();
  });

  it('answers with nothing, and looks nothing up, for a job it does not know', async () => {
    for (const url of ['/ai-playlist/suggestions/ai-unknown', '/ai-playlist/spotify-suggestions/ai-unknown']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, data: [] });
    }
    expect(h.suggest).not.toHaveBeenCalled();
    expect(h.spotifySuggest).not.toHaveBeenCalled();
  });

  it('has no endpoint that looks things up for free text', async () => {
    for (const url of ['/ai-playlist/suggestions', '/ai-playlist/spotify-suggestions']) {
      const res = await app.inject({ method: 'POST', url, payload: { prompt: '80s hits' } });
      expect(res.statusCode).toBe(404);
    }
    expect(h.suggest).not.toHaveBeenCalled();
    expect(h.spotifySuggest).not.toHaveBeenCalled();
  });
});
