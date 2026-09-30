import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

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
    verifyRecaptcha = async () => ({ isHuman: true });
    getClientIp = () => '203.0.113.7';
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
  h.run.mockClear();
  h.suggest.mockReset().mockResolvedValue([{ id: 1, slug: 'eighties' }]);
  h.spotifySuggest.mockReset().mockResolvedValue([{ id: 'sp1', name: 'Schlager' }]);
});

/** Start a job the way the form does and return its id. */
async function startJob(prompt: string, locale: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/ai-playlist/generate',
    payload: { prompt, trackCount: 75, captchaToken: 'ok', locale },
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
    // Starting a job looks nothing up by itself.
    expect(h.suggest).not.toHaveBeenCalled();
    expect(h.spotifySuggest).not.toHaveBeenCalled();
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
