import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AIPlaylistSuggestions with OpenAI, Prisma (the catalogue query), Redis and
 * Data (the featured list the cards are taken from) mocked.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    cacheStore,
    createMock: vi.fn(),
    queryRaw: vi.fn(),
    getFeatured: vi.fn(),
  };
});

vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: h.createMock } };
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => ({ $queryRaw: h.queryRaw }) },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => h.cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => {
        h.cacheStore.set(key, value);
      },
    }),
  },
}));

vi.mock('../../../src/data', () => ({
  default: { getInstance: () => ({ getFeaturedPlaylists: h.getFeatured }) },
}));

vi.mock('../../../src/translation', () => ({
  default: { ALL_LOCALES: ['en', 'nl', 'de', 'fr'] },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import AIPlaylistSuggestions, {
  CataloguePlaylist,
  catalogueLine,
  fitsMarket,
  playlistMarkets,
} from '../../../src/aiPlaylistSuggestions';

const suggestions = AIPlaylistSuggestions.getInstance();

const playlist = (overrides: Partial<CataloguePlaylist>): CataloguePlaylist => ({
  id: 1,
  name: 'Playlist',
  numberOfTracks: 100,
  featuredLocale: null,
  genreName: null,
  description: null,
  promotionalTitle: null,
  promotionalDescription: null,
  decadePercentage1950: 0,
  decadePercentage1960: 0,
  decadePercentage1970: 0,
  decadePercentage1980: 0,
  decadePercentage1990: 0,
  decadePercentage2000: 0,
  decadePercentage2010: 0,
  decadePercentage2020: 0,
  ...overrides,
});

const CATALOGUE = [
  playlist({ id: 10, name: '80s Hits', decadePercentage1980: 90 }),
  playlist({ id: 11, name: 'Best of 80`s', featuredLocale: 'de', decadePercentage1980: 80 }),
  playlist({ id: 12, name: 'Schlagerparty', featuredLocale: 'de' }),
  playlist({ id: 13, name: 'Hollandse hits', featuredLocale: 'nl,fr' }),
  playlist({ id: 14, name: 'Rock Classics' }),
  playlist({ id: 15, name: 'Pop Classics' }),
  playlist({ id: 16, name: 'More Pop' }),
];

/** What /featured serves: the cards, in the visitor's language. */
const card = (id: number) => ({ id, name: `Card ${id}`, slug: `card-${id}` });

const answer = (
  playlistIds: unknown,
  promptLanguage = 'en',
  musicMarket: string | null = null
) => ({
  choices: [
    { message: { content: JSON.stringify({ promptLanguage, musicMarket, playlistIds }) } },
  ],
  usage: { prompt_tokens: 1000, completion_tokens: 10 },
});

beforeEach(() => {
  h.cacheStore.clear();
  h.createMock.mockReset();
  h.queryRaw.mockReset().mockResolvedValue(CATALOGUE);
  h.getFeatured.mockReset().mockResolvedValue(CATALOGUE.map((p) => card(p.id)));
});

describe('catalogueLine', () => {
  it('lists id, name, size, main decades, genre, market and description', () => {
    expect(
      catalogueLine(
        playlist({
          id: 7,
          name: 'Eighties Mix',
          numberOfTracks: 150,
          genreName: 'Pop',
          featuredLocale: 'de',
          decadePercentage1970: 19,
          decadePercentage1980: 60,
          decadePercentage1990: 20,
          description: 'Eighties Mix QR music cards bring together synth-pop and new wave.',
        })
      )
    ).toBe(
      '7 | Eighties Mix | 150 tracks | 80s/90s | Pop | market de | QR music cards bring together synth-pop and new wave.'
    );
  });

  it('uses the promotional title and falls back to the customer text', () => {
    expect(
      catalogueLine(
        playlist({
          id: 8,
          name: 'spotify name',
          promotionalTitle: ' Hit The Song ',
          promotionalDescription: 'Alte Songs,\nneue Songs',
        })
      )
    ).toBe('8 | Hit The Song | 100 tracks | international | Alte Songs, neue Songs');
  });

  it('cuts a long description without splitting an emoji', () => {
    const line = catalogueLine(playlist({ description: '🇮🇹'.repeat(200) }));
    expect((line as any).isWellFormed()).toBe(true);
    expect(Array.from(line.split(' | ').pop()!)).toHaveLength(240);
  });
});

describe('market helpers', () => {
  it('reads the markets of a playlist', () => {
    expect(playlistMarkets(null)).toEqual([]);
    expect(playlistMarkets('de')).toEqual(['de']);
    expect(playlistMarkets('de, nl')).toEqual(['de', 'nl']);
  });

  it('offers a market playlist only to that market', () => {
    expect(fitsMarket(null, new Set(['en']))).toBe(true);
    expect(fitsMarket('de', new Set(['en']))).toBe(false);
    expect(fitsMarket('nl,fr', new Set(['fr']))).toBe(true);
  });
});

describe('suggest', () => {
  it('sends the catalogue and the theme, and returns the matching cards in order', async () => {
    h.createMock.mockResolvedValueOnce(answer([14, 10]));

    const out = await suggestions.suggest('  80s   rock ', 'en');

    expect(out).toEqual([card(14), card(10)]);
    expect(h.getFeatured).toHaveBeenCalledWith('en', true);

    const payload = h.createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.6-luna');
    expect(payload.reasoning_effort).toBe('none');
    expect(payload.messages[0].content).toContain('10 | 80s Hits | 100 tracks | 80s | international');
    expect(payload.messages[0].content).toContain('11 | Best of 80`s | 100 tracks | 80s | market de');
    expect(payload.messages[1].content).toBe('What the customer wants:\n80s rock');
    const schema = payload.response_format.json_schema.schema;
    expect(schema.required).toEqual(['promptLanguage', 'musicMarket', 'playlistIds']);
    expect(schema.properties.promptLanguage.enum).toEqual(['en', 'nl', 'de', 'fr', 'other']);
  });

  it('drops playlists made for another market', async () => {
    h.createMock.mockResolvedValueOnce(answer([11, 10, 12, 14]));
    expect(await suggestions.suggest('80s hits', 'en')).toEqual([card(10), card(14)]);
  });

  it('keeps a market playlist for a visitor on that locale', async () => {
    h.createMock.mockResolvedValueOnce(answer([11, 10]));
    expect(await suggestions.suggest('80er Hits', 'de')).toEqual([card(11), card(10)]);
  });

  it('keeps a market playlist when the customer asks for that country or writes in its language', async () => {
    h.createMock.mockResolvedValueOnce(answer([12], 'nl', 'de'));
    expect(await suggestions.suggest('Duitse schlagers', 'nl')).toEqual([card(12)]);

    h.createMock.mockResolvedValueOnce(answer([13], 'fr', null));
    expect(await suggestions.suggest('tubes néerlandais', 'en')).toEqual([card(13)]);
  });

  it('shows three at most and ignores made-up, repeated and malformed ids', async () => {
    h.createMock.mockResolvedValueOnce(answer([999, 14, '15', 14, null, 16, 10]));
    expect(await suggestions.suggest('classics', 'en')).toEqual([card(14), card(15), card(16)]);
  });

  it('only offers playlists with at least as many tracks as the customer asked for', async () => {
    const sized = (id: number, numberOfTracks: number) => ({ ...card(id), numberOfTracks });
    h.getFeatured.mockResolvedValue([sized(10, 60), sized(14, 250), sized(15, 100), sized(16, 99)]);
    h.createMock.mockResolvedValue(answer([10, 14, 15, 16]));

    expect((await suggestions.suggest('classics', 'en', 100)).map((p) => p.id)).toEqual([14, 15]);
    // Another size is another cut of the same answer: the model is not asked again.
    expect((await suggestions.suggest('classics', 'en', 50)).map((p) => p.id)).toEqual([10, 14, 15]);
    expect((await suggestions.suggest('classics', 'en', 300)).map((p) => p.id)).toEqual([]);
    expect(h.createMock).toHaveBeenCalledTimes(1);
  });

  it('answers a repeated theme from the cache, per locale', async () => {
    h.createMock.mockResolvedValue(answer([14]));
    await suggestions.suggest('Rock', 'en');

    // Same theme, other spacing and case: no second call.
    expect(await suggestions.suggest('  rock ', 'en')).toEqual([card(14)]);
    expect(h.createMock).toHaveBeenCalledTimes(1);
    // Another locale is another question (other markets are allowed).
    await suggestions.suggest('Rock', 'nl');
    expect(h.createMock).toHaveBeenCalledTimes(2);
    // The catalogue is read once and kept for the day.
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('remembers that nothing matched', async () => {
    h.createMock.mockResolvedValueOnce(answer([]));
    expect(await suggestions.suggest('obscure request', 'en')).toEqual([]);
    expect(await suggestions.suggest('obscure request', 'en')).toEqual([]);
    expect(h.createMock).toHaveBeenCalledTimes(1);
    expect(h.getFeatured).not.toHaveBeenCalled();
  });

  it('leaves out a playlist that is no longer in the featured list', async () => {
    h.createMock.mockResolvedValueOnce(answer([14, 10]));
    h.getFeatured.mockResolvedValue([card(10)]);
    expect(await suggestions.suggest('rock', 'en')).toEqual([card(10)]);
  });

  it('does not call the model for a prompt that is too short', async () => {
    expect(await suggestions.suggest(' a ', 'en')).toEqual([]);
    expect(h.createMock).not.toHaveBeenCalled();
  });

  it('does not call the model for an empty catalogue', async () => {
    h.queryRaw.mockResolvedValue([]);
    expect(await suggestions.suggest('rock', 'en')).toEqual([]);
    expect(h.createMock).not.toHaveBeenCalled();
  });

  it('returns nothing, and caches nothing, when the model fails', async () => {
    h.createMock.mockRejectedValueOnce(new Error('openai down'));
    expect(await suggestions.suggest('rock', 'en')).toEqual([]);
    // Not remembered: the next time the model is asked again.
    h.createMock.mockResolvedValueOnce(answer([14]));
    expect(await suggestions.suggest('rock', 'en')).toEqual([card(14)]);

    h.createMock.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    expect(await suggestions.suggest('pop', 'en')).toEqual([]);
  });
});
