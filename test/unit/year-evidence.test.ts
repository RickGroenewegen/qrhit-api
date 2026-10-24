/**
 * Unit tests for src/yearEvidence.ts: the Serper search and the Wikipedia and
 * Wikidata lookups the year lookup pastes into its prompt.
 *
 * axios is mocked; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { axiosGetMock, axiosPostMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
  axiosPostMock: vi.fn(),
}));
vi.mock('axios', () => {
  const axiosMock: any = { get: axiosGetMock, post: axiosPostMock };
  axiosMock.default = axiosMock;
  return axiosMock;
});

import {
  claimDates,
  evidenceForReview,
  gatherYearEvidence,
  searchGoogle,
  wikipediaArticle,
} from '../../src/yearEvidence';

const SERPER_RESPONSE = {
  data: {
    knowledgeGraph: {
      title: 'Africa',
      type: 'Song by Toto',
      attributes: { Released: '1982', Album: 'Toto IV' },
    },
    organic: [
      {
        title: 'Africa (Toto song) - Wikipedia',
        link: 'https://en.wikipedia.org/wiki/Africa_(Toto_song)',
        snippet: 'released in 1982 as the third single from Toto IV.',
      },
      {
        title: 'Africa (lied van Toto)',
        link: 'https://nl.m.wikipedia.org/wiki/Africa_(Toto)',
        snippet: 'single uit 1982',
        date: 'Apr 8, 1982',
      },
      { title: 'Africa - Spotify', link: 'https://open.spotify.com/track/x', snippet: 'Toto · Song · 2007' },
      { title: 'no link' },
    ],
  },
};

/** Answers Wikipedia and Wikidata GETs from a table keyed on URL. */
function wikiRoutes(routes: Record<string, unknown>) {
  axiosGetMock.mockImplementation(async (url: string, config?: any) => {
    const key =
      url.includes('wikidata.org') ? `wikidata:${config?.params?.entity}` :
      url.includes('/w/api.php') ? `search:${url}:${config?.params?.srsearch}` :
      url;
    if (!(key in routes)) throw new Error(`unexpected GET ${key}`);
    return { data: routes[key] };
  });
}

describe('searchGoogle', () => {
  beforeEach(() => {
    axiosPostMock.mockReset();
    process.env['SERPER_API_KEY'] = 'test-key';
  });
  afterEach(() => {
    delete process.env['SERPER_API_KEY'];
  });

  it('asks Serper for ten results and maps them to the year-check shape', async () => {
    axiosPostMock.mockResolvedValue(SERPER_RESPONSE);
    const { google, knowledgeGraph } = await searchGoogle('Toto', 'Africa');

    const [url, body, config] = axiosPostMock.mock.calls[0];
    expect(url).toBe('https://google.serper.dev/search');
    expect(body).toEqual({ q: 'Toto - Africa (song) release date', num: 10 });
    expect(config.headers['X-API-KEY']).toBe('test-key');

    expect(google).toHaveLength(3);
    expect(google[0]).toEqual({
      title: 'Africa (Toto song) - Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Africa_(Toto_song)',
      snippet: 'released in 1982 as the third single from Toto IV.',
      domain: 'en.wikipedia.org',
    });
    expect(google[1].snippet).toBe('Apr 8, 1982 · single uit 1982');
    expect(knowledgeGraph).toEqual({
      Title: 'Africa',
      Type: 'Song by Toto',
      Released: '1982',
      Album: 'Toto IV',
    });
  });

  it('returns nothing without SERPER_API_KEY and never calls Serper', async () => {
    delete process.env['SERPER_API_KEY'];
    expect(await searchGoogle('Toto', 'Africa')).toEqual({ google: [], knowledgeGraph: null });
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('returns nothing when Serper fails', async () => {
    axiosPostMock.mockRejectedValue(new Error('403'));
    expect(await searchGoogle('Toto', 'Africa')).toEqual({ google: [], knowledgeGraph: null });
  });
});

describe('wikipediaArticle', () => {
  it('reads language and title from desktop and mobile links', () => {
    expect(wikipediaArticle('https://en.wikipedia.org/wiki/Africa_(Toto_song)')).toEqual({
      lang: 'en',
      title: 'Africa (Toto song)',
    });
    expect(wikipediaArticle('https://nl.m.wikipedia.org/wiki/F%C3%BCr_Elise#Geschiedenis')).toEqual({
      lang: 'nl',
      title: 'Für Elise',
    });
  });

  it('ignores anything that is not an article', () => {
    expect(wikipediaArticle('https://www.discogs.com/master/1')).toBeNull();
    expect(wikipediaArticle('https://commons.wikimedia.org/wiki/File:X.jpg')).toBeNull();
  });
});

describe('claimDates', () => {
  const claim = (time: string, precision: number) => ({
    mainsnak: { datavalue: { value: { time, precision } } },
  });

  it('formats Wikidata times by precision, oldest first, without duplicates', () => {
    expect(
      claimDates([
        claim('+1983-02-05T00:00:00Z', 11),
        claim('+1982-04-00T00:00:00Z', 10),
        claim('+1982-00-00T00:00:00Z', 9),
        claim('+1982-00-00T00:00:00Z', 9),
      ])
    ).toEqual(['1982', '1982-04', '1983-02-05']);
  });

  it('skips claims without a time and accepts no claims at all', () => {
    expect(claimDates([{ mainsnak: { snaktype: 'novalue' } }])).toEqual([]);
    expect(claimDates(undefined)).toEqual([]);
  });
});

describe('gatherYearEvidence', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    process.env['SERPER_API_KEY'] = 'test-key';
  });
  afterEach(() => {
    delete process.env['SERPER_API_KEY'];
  });

  it('reads the Wikipedia pages Google found, one per language, with their Wikidata dates', async () => {
    axiosPostMock.mockResolvedValue(SERPER_RESPONSE);
    wikiRoutes({
      'https://en.wikipedia.org/api/rest_v1/page/summary/Africa_(Toto_song)': {
        type: 'standard',
        title: 'Africa (song)',
        extract: 'Africa is a song by Toto, released in 1982.',
        wikibase_item: 'Q383842',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Africa_(song)' } },
      },
      'https://nl.wikipedia.org/api/rest_v1/page/summary/Africa_(Toto)': {
        type: 'standard',
        title: 'Africa (Toto)',
        extract: 'Africa is een single uit 1982.',
      },
      'wikidata:Q383842': {
        claims: {
          P577: [{ mainsnak: { datavalue: { value: { time: '+1982-04-08T00:00:00Z', precision: 11 } } } }],
        },
      },
    });

    const evidence = await gatherYearEvidence('Toto', 'Africa');
    expect(evidence.google).toHaveLength(3);
    expect(evidence.wikipedia).toEqual([
      {
        lang: 'en',
        title: 'Africa (song)',
        url: 'https://en.wikipedia.org/wiki/Africa_(song)',
        extract: 'Africa is a song by Toto, released in 1982.',
        published: ['1982-04-08'],
        composed: [],
      },
      {
        lang: 'nl',
        title: 'Africa (Toto)',
        url: 'https://nl.wikipedia.org/wiki/Africa_(Toto)',
        extract: 'Africa is een single uit 1982.',
        published: [],
        composed: [],
      },
    ]);
    // Wikimedia refuses axios' own User-Agent with a 403.
    for (const [, config] of axiosGetMock.mock.calls) {
      expect(config.headers['User-Agent']).toMatch(/^QRHit\/1\.0 \(/);
    }
  });

  it("falls back to Wikipedia's own search when Google found no Wikipedia page", async () => {
    delete process.env['SERPER_API_KEY'];
    wikiRoutes({
      'search:https://en.wikipedia.org/w/api.php:Ludwig van Beethoven Für Elise': {
        query: { search: [{ title: 'Für Elise' }] },
      },
      'https://en.wikipedia.org/api/rest_v1/page/summary/F%C3%BCr_Elise': {
        type: 'standard',
        title: 'Für Elise',
        extract: 'Bagatelle No. 25 in A minor, composed in 1810.',
        wikibase_item: 'Q232497',
      },
      'wikidata:Q232497': {
        claims: {
          P571: [{ mainsnak: { datavalue: { value: { time: '+1810-04-27T00:00:00Z', precision: 11 } } } }],
          P577: [{ mainsnak: { datavalue: { value: { time: '+1867-00-00T00:00:00Z', precision: 9 } } } }],
        },
      },
    });

    const evidence = await gatherYearEvidence('Ludwig van Beethoven', 'Für Elise');
    expect(evidence.google).toEqual([]);
    expect(evidence.wikipedia).toHaveLength(1);
    expect(evidence.wikipedia[0]).toMatchObject({
      lang: 'en',
      title: 'Für Elise',
      url: 'https://en.wikipedia.org/wiki/F%C3%BCr_Elise',
      published: ['1867'],
      composed: ['1810-04-27'],
    });
  });

  it('leaves out disambiguation pages and pages that fail', async () => {
    axiosPostMock.mockResolvedValue(SERPER_RESPONSE);
    wikiRoutes({
      'https://en.wikipedia.org/api/rest_v1/page/summary/Africa_(Toto_song)': {
        type: 'disambiguation',
        title: 'Africa',
        extract: 'Africa may refer to:',
      },
      // nl is not in the table, so its GET throws
    });
    const evidence = await gatherYearEvidence('Toto', 'Africa');
    expect(evidence.wikipedia).toEqual([]);
    expect(evidence.google).toHaveLength(3);
  });
});

describe('evidenceForReview', () => {
  it('adds the Wikipedia pages Google did not list', () => {
    const google = [
      { title: 'Africa - Wikipedia', url: 'https://en.wikipedia.org/wiki/Africa_(Toto_song)', snippet: 's', domain: 'en.wikipedia.org' },
    ];
    const results = evidenceForReview({
      google,
      knowledgeGraph: null,
      wikipedia: [
        { lang: 'en', title: 'Africa (song)', url: 'https://en.wikipedia.org/wiki/Africa_(song)', extract: 'x', published: [], composed: [] },
        { lang: 'nl', title: 'Africa (Toto)', url: 'https://nl.wikipedia.org/wiki/Africa_(Toto)', extract: 'Africa is een single.', published: [], composed: [] },
      ],
    });
    expect(results).toEqual([
      google[0],
      { title: 'Africa (Toto)', url: 'https://nl.wikipedia.org/wiki/Africa_(Toto)', snippet: 'Africa is een single.', domain: 'nl.wikipedia.org' },
    ]);
  });
});
