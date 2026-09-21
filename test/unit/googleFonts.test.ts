import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/googleFonts.ts.
 *
 * Redis and fetch are mocked; the module must never throw into a PDF render
 * or the designer, so the failure paths return empty/fallback values.
 */

const store = new Map<string, string>();

vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string, _ttl?: number) => {
        store.set(key, value);
      },
      del: async (key: string) => {
        store.delete(key);
      },
    }),
  },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import GoogleFonts, { variantsToWeights, familyToCss } from '../../src/googleFonts';

const GOOGLE_RESPONSE = {
  items: [
    { family: 'Lobster', category: 'display', variants: ['regular'] },
    { family: 'Open Sans', category: 'sans-serif', variants: ['300', 'regular', 'italic', '700', '700italic'] },
    { family: 'Unna', category: 'serif', variants: ['regular', 'italic', '700', '700italic'] },
  ],
};

function mockFetch(status = 200, body: unknown = GOOGLE_RESPONSE) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  global.fetch = fetchMock as any;
  return fetchMock;
}

describe('variantsToWeights', () => {
  it('maps regular to 400 and keeps numeric upright weights, ascending', () => {
    expect(variantsToWeights(['700', 'regular', 'italic', '300italic', '300'])).toEqual(['300', '400', '700']);
  });

  it('returns an empty list when only italics exist', () => {
    expect(variantsToWeights(['italic', '700italic'])).toEqual([]);
  });
});

describe('familyToCss', () => {
  it('quotes the family and picks a generic fallback from the category', () => {
    expect(familyToCss({ family: 'Open Sans', category: 'sans-serif', weights: ['400'] })).toBe(
      '"Open Sans", Arial, sans-serif'
    );
    expect(familyToCss({ family: 'Caveat', category: 'handwriting', weights: ['400'] })).toBe(
      '"Caveat", Arial, cursive'
    );
    expect(familyToCss({ family: 'Lobster', category: 'display', weights: ['400'] })).toBe(
      '"Lobster", Arial, sans-serif'
    );
  });
});

describe('GoogleFonts', () => {
  let googleFonts: GoogleFonts;

  beforeEach(() => {
    store.clear();
    process.env['GOOGLE_API_KEY'] = 'test-key';
    // Fresh singleton per test so the in-memory memo does not leak.
    (GoogleFonts as any).instance = undefined;
    googleFonts = GoogleFonts.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the catalogue once and serves later calls from memory', async () => {
    const fetchMock = mockFetch();

    const first = await googleFonts.getCatalogue();
    const second = await googleFonts.getCatalogue();

    expect(first).toHaveLength(3);
    expect(first[1]).toEqual({ family: 'Open Sans', category: 'sans-serif', weights: ['300', '400', '700'] });
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has('google_fonts:catalogue')).toBe(true);
  });

  it('serves the catalogue from Redis without calling Google', async () => {
    store.set(
      'google_fonts:catalogue',
      JSON.stringify([{ family: 'Cached', category: 'serif', weights: ['400'] }])
    );
    const fetchMock = mockFetch();

    const list = await googleFonts.getCatalogue();

    expect(list).toEqual([{ family: 'Cached', category: 'serif', weights: ['400'] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty catalogue without an API key', async () => {
    delete process.env['GOOGLE_API_KEY'];
    const fetchMock = mockFetch();

    expect(await googleFonts.getCatalogue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty catalogue when Google answers with an error', async () => {
    mockFetch(403, { error: { message: 'forbidden' } });

    expect(await googleFonts.getCatalogue()).toEqual([]);
    expect(store.has('google_fonts:catalogue')).toBe(false);
  });

  it('finds a family case-insensitively', async () => {
    mockFetch();

    expect((await googleFonts.findFamily('open sans'))?.family).toBe('Open Sans');
    expect(await googleFonts.findFamily('Nope')).toBeUndefined();
    expect(await googleFonts.findFamily('')).toBeUndefined();
  });

  describe('resolveWeights', () => {
    it('keeps the configured weights for fonts in the fixed list', async () => {
      const fetchMock = mockFetch();

      expect(await googleFonts.resolveWeights('Teko, Arial, sans-serif')).toBe('300;400;500;600;700');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('takes the weights of a catalogue font from its variants', async () => {
      mockFetch();

      expect(await googleFonts.resolveWeights('"Open Sans", Arial, sans-serif')).toBe('300;400;700');
      expect(await googleFonts.resolveWeights('"Lobster", Arial, sans-serif')).toBe('400');
    });

    it('falls back to 400 for a font Google does not know', async () => {
      mockFetch();

      expect(await googleFonts.resolveWeights('"Comic Wonder", Arial, sans-serif')).toBe('400');
    });

    it('uses the default for an empty font', async () => {
      expect(await googleFonts.resolveWeights('')).toBe('400;700');
      expect(await googleFonts.resolveWeights(null)).toBe('400;700');
    });
  });

  it('weightsHelper pre-resolves the order font and leaves other fonts to the fixed list', async () => {
    mockFetch();

    const helper = await googleFonts.weightsHelper('"Open Sans", Arial, sans-serif');

    expect(helper('"Open Sans", Arial, sans-serif')).toBe('300;400;700');
    expect(helper('Righteous, Arial, sans-serif')).toBe('400');
    expect(helper('Unknown')).toBe('400;700');
  });
});
