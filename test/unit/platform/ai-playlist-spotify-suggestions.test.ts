import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AIPlaylistSpotifySuggestions with OpenAI, Redis and the Spotify gateway
 * mocked. The featured matcher's module is loaded for its text helpers, so
 * its collaborators are stubbed too.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  const cacheTtls = new Map<string, number | undefined>();
  return {
    cacheStore,
    cacheTtls,
    createMock: vi.fn(),
    searchPlaylists: vi.fn(),
  };
});

vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: h.createMock } };
  },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => h.cacheStore.get(key) ?? null,
      set: async (key: string, value: string, ttl?: number) => {
        h.cacheStore.set(key, value);
        h.cacheTtls.set(key, ttl);
      },
    }),
  },
}));

vi.mock('../../../src/spotify', () => ({
  default: { getInstance: () => ({ searchPlaylists: h.searchPlaylists }) },
}));

vi.mock('../../../src/prisma', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/data', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/translation', () => ({ default: { ALL_LOCALES: ['en'] } }));
vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import AIPlaylistSpotifySuggestions, {
  candidateLine,
  isUsable,
} from '../../../src/aiPlaylistSpotifySuggestions';

const suggestions = AIPlaylistSpotifySuggestions.getInstance();

const hit = (overrides: Partial<any> = {}) => ({
  id: 'pl1',
  name: 'Deutsche Schlager 60er 70er',
  description: '',
  owner: 'Susi',
  trackCount: 120,
  image: 'https://i.scdn.co/cover.jpg',
  ...overrides,
});

const answer = (body: unknown) => ({
  choices: [{ message: { content: JSON.stringify(body) } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});

/** Six usable playlists: enough for one search to do. */
const SIX = Array.from({ length: 6 }, (_, i) => hit({ id: `pl${i}`, name: `Schlager ${i}` }));

/** The only key this module writes: the picks for a description. */
const resultTtl = () => Array.from(h.cacheTtls.values())[0];

beforeEach(() => {
  h.cacheStore.clear();
  h.cacheTtls.clear();
  h.createMock.mockReset();
  h.searchPlaylists.mockReset();
});

describe('candidateLine', () => {
  it('lists id, name, size, owner and a plain-text description', () => {
    expect(
      candidateLine(
        hit({ description: 'Raw &amp; extra raw <a href="x">hardstyle</a>,\n daily updated!' })
      )
    ).toBe(
      'pl1 | Deutsche Schlager 60er 70er | 120 tracks | by Susi | Raw & extra raw hardstyle , daily updated!'
    );
  });

  it('leaves out an empty owner and description', () => {
    expect(candidateLine(hit({ owner: '' }))).toBe(
      'pl1 | Deutsche Schlager 60er 70er | 120 tracks'
    );
  });
});

describe('isUsable', () => {
  it('takes playlists of the sizes the form offers, with a cover', () => {
    expect(isUsable(hit({ trackCount: 25 }))).toBe(true);
    expect(isUsable(hit({ trackCount: 500 }))).toBe(true);
    expect(isUsable(hit({ trackCount: 24 }))).toBe(false);
    expect(isUsable(hit({ trackCount: 501 }))).toBe(false);
    expect(isUsable(hit({ image: null }))).toBe(false);
  });

  it('takes nothing smaller than the customer asked for, and up to twice that', () => {
    expect(isUsable(hit({ trackCount: 99 }), 100)).toBe(false);
    expect(isUsable(hit({ trackCount: 100 }), 100)).toBe(true);
    expect(isUsable(hit({ trackCount: 500 }), 100)).toBe(true);
    expect(isUsable(hit({ trackCount: 501 }), 100)).toBe(false);
    // Asked for 400: larger than the form's maximum is fine, up to 800.
    expect(isUsable(hit({ trackCount: 800 }), 400)).toBe(true);
    expect(isUsable(hit({ trackCount: 801 }), 400)).toBe(false);
    // The form's minimum still holds for a smaller number.
    expect(isUsable(hit({ trackCount: 20 }), 10)).toBe(false);
  });

  it('skips the temporary playlists of our own generator', () => {
    expect(isUsable(hit({ name: 'qrsong! AI — Best of Disney Songs (AIID: mato49sh)' }))).toBe(false);
  });
});

describe('suggest', () => {
  it('asks the model for a query, Spotify once, and the model to pick', async () => {
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['deutsche schlager 60er 70er', 'schlager oldies'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['pl3', 'pl0'] }));
    h.searchPlaylists.mockResolvedValue({ success: true, hits: SIX });

    const out = await suggestions.suggest('  Deutsche Schlager\n1960 - 1980 ', 'de');

    expect(out).toEqual([
      { id: 'pl3', name: 'Schlager 3', owner: 'Susi', trackCount: 120, image: 'https://i.scdn.co/cover.jpg' },
      { id: 'pl0', name: 'Schlager 0', owner: 'Susi', trackCount: 120, image: 'https://i.scdn.co/cover.jpg' },
    ]);

    // One search: the first query found enough.
    expect(h.searchPlaylists).toHaveBeenCalledTimes(1);
    expect(h.searchPlaylists).toHaveBeenCalledWith('deutsche schlager 60er 70er', 30);

    const [queryCall, pickCall] = h.createMock.mock.calls.map((c) => c[0]);
    expect(queryCall.model).toBe('gpt-5.6-luna');
    expect(queryCall.reasoning_effort).toBe('none');
    expect(queryCall.response_format.json_schema.name).toBe('returnQueries');
    expect(queryCall.messages[1].content).toBe(
      "Customer's language: de\nWhat the customer wants:\nDeutsche Schlager 1960 - 1980"
    );
    expect(pickCall.response_format.json_schema.name).toBe('returnPlaylists');
    expect(pickCall.messages[1].content).toContain('What the customer wants:\nDeutsche Schlager 1960 - 1980');
    expect(pickCall.messages[1].content).toContain('pl0 | Schlager 0 | 120 tracks | by Susi');
  });

  it('tries the second query only when the first found next to nothing', async () => {
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['rare thing', 'other words', 'a third'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['b'] }));
    h.searchPlaylists
      .mockResolvedValueOnce({ success: true, hits: [hit({ id: 'a' })] })
      .mockResolvedValueOnce({ success: true, hits: [hit({ id: 'a' }), hit({ id: 'b', name: 'B' })] });

    const out = await suggestions.suggest('something rare', 'en');

    // Two at most, whatever the model returns.
    expect(h.searchPlaylists.mock.calls.map((c) => c[0])).toEqual(['rare thing', 'other words']);
    expect(out.map((p) => p.id)).toEqual(['b']);
    // The same playlist from both searches is offered to the model once.
    const list = h.createMock.mock.calls[1][0].messages[1].content;
    expect(list.match(/^a \| /gm)).toHaveLength(1);
  });

  it('only offers the model playlists a customer could order', async () => {
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['hardstyle'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['ok'] }));
    h.searchPlaylists.mockResolvedValue({
      success: true,
      hits: [
        hit({ id: 'huge', trackCount: 5305 }),
        hit({ id: 'tiny', trackCount: 19 }),
        hit({ id: 'ours', name: 'qrsong! AI — Hardstyle (AIID: a1b2c3d4)' }),
        hit({ id: 'ok', name: 'Raw Hardstyle 2017-2018' }),
      ],
    });

    await suggestions.suggest('hardstyle 2018', 'en');

    const list = h.createMock.mock.calls[1][0].messages[1].content;
    expect(list).toContain('ok | Raw Hardstyle 2017-2018');
    expect(list).not.toContain('huge |');
    expect(list).not.toContain('tiny |');
    expect(list).not.toContain('ours |');
  });

  it('only offers playlists with at least as many tracks as the customer asked for', async () => {
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['schlager'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['big', 'small'] }))
      .mockResolvedValueOnce(answer({ queries: ['schlager'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['small'] }));
    h.searchPlaylists.mockResolvedValue({
      success: true,
      hits: [
        hit({ id: 'small', trackCount: 42 }),
        hit({ id: 'big', trackCount: 213 }),
        hit({ id: 'b2', trackCount: 120 }),
        hit({ id: 'b3', trackCount: 150 }),
        hit({ id: 'b4', trackCount: 300 }),
      ],
    });

    const out = await suggestions.suggest('schlager', 'de', 100);

    // The 42-song playlist is not even offered to the model, which is told
    // the size to aim for.
    const list = h.createMock.mock.calls[1][0].messages[1].content;
    expect(list).not.toContain('small |');
    expect(list).toContain('The customer asked for 100 tracks.');
    expect(out.map((p) => p.id)).toEqual(['big']);

    // The same description for fewer tracks is worked out on its own.
    const smaller = await suggestions.suggest('schlager', 'de', 40);
    expect(smaller.map((p) => p.id)).toEqual(['small']);
    expect(h.createMock).toHaveBeenCalledTimes(4);
  });

  it('shows three at most and ignores ids the model made up or repeats', async () => {
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['schlager'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['nope', 'pl1', 'pl1', 7, 'pl2', 'pl3', 'pl4'] }));
    h.searchPlaylists.mockResolvedValue({ success: true, hits: SIX });

    const out = await suggestions.suggest('schlager', 'de');
    expect(out.map((p) => p.id)).toEqual(['pl1', 'pl2', 'pl3']);
  });

  it('answers the same description from the cache for a day, per locale', async () => {
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['schlager'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['pl1'] }));
    h.searchPlaylists.mockResolvedValue({ success: true, hits: SIX });

    const first = await suggestions.suggest('Schlager', 'de');
    expect(resultTtl()).toBe(24 * 3600);

    // Same description, other spacing and case: nobody is asked again.
    expect(await suggestions.suggest(' schlager ', 'de')).toEqual(first);
    expect(h.createMock).toHaveBeenCalledTimes(2);
    expect(h.searchPlaylists).toHaveBeenCalledTimes(1);

    // Another locale is worked out on its own (the query may differ).
    h.createMock
      .mockResolvedValueOnce(answer({ queries: ['schlager'] }))
      .mockResolvedValueOnce(answer({ playlistIds: ['pl2'] }));
    await suggestions.suggest('Schlager', 'nl');
    expect(h.createMock).toHaveBeenCalledTimes(4);
  });

  it('does not ask Spotify when the model sees nothing to search for, and remembers that', async () => {
    h.createMock.mockResolvedValueOnce(answer({ queries: [] }));

    expect(await suggestions.suggest('a mix for my aunt', 'en')).toEqual([]);

    expect(h.searchPlaylists).not.toHaveBeenCalled();
    expect(h.createMock).toHaveBeenCalledTimes(1);
    expect(resultTtl()).toBe(24 * 3600);
  });

  it('does not ask the model to pick when Spotify found nothing usable', async () => {
    h.createMock.mockResolvedValueOnce(answer({ queries: ['obscure'] }));
    h.searchPlaylists.mockResolvedValue({ success: true, hits: [hit({ trackCount: 3 })] });

    expect(await suggestions.suggest('obscure thing', 'en')).toEqual([]);
    expect(h.createMock).toHaveBeenCalledTimes(1);
    expect(resultTtl()).toBe(24 * 3600);
  });

  it('remembers "nothing" only briefly when Spotify could not be asked', async () => {
    h.createMock.mockResolvedValueOnce(answer({ queries: ['schlager', 'schlager hits'] }));
    h.searchPlaylists.mockResolvedValue({ success: false, hits: [], error: 'Playlist search is paused' });

    expect(await suggestions.suggest('schlager', 'de')).toEqual([]);
    expect(resultTtl()).toBe(5 * 60);
  });

  it('does not ask anyone for a prompt that is too short', async () => {
    expect(await suggestions.suggest(' a ', 'en')).toEqual([]);
    expect(h.createMock).not.toHaveBeenCalled();
  });

  it('returns nothing, and caches nothing, when a model call fails', async () => {
    h.createMock.mockRejectedValueOnce(new Error('openai down'));
    expect(await suggestions.suggest('schlager', 'de')).toEqual([]);
    expect(h.cacheStore.size).toBe(0);
    expect(h.searchPlaylists).not.toHaveBeenCalled();
  });
});
