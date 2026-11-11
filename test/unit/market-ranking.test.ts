import { describe, it, expect } from 'vitest';
import {
  WORLD,
  RankPlaylist,
  SaleBucket,
  applyRanking,
  countryOfLocale,
  languageGroup,
  pickMarket,
  rankMarket,
  saleWeight,
  scoreForPlace,
  spreadGenres,
} from '../../src/data/marketRanking';

const NOW = new Date('2026-11-11T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const list = (
  id: number,
  over: Partial<RankPlaylist> = {}
): RankPlaylist => ({
  id,
  genreId: id,
  featuredLocale: null,
  createdAt: daysAgo(900),
  ...over,
});

const sold = (
  playlistId: number,
  country: string | null,
  count: number,
  days = 10
): SaleBucket => ({ playlistId, country, daysAgo: days, count });

const order = (playlists: RankPlaylist[], buckets: SaleBucket[], market: string) =>
  rankMarket(playlists, buckets, market, NOW).map((r) => r.id);

describe('saleWeight', () => {
  it('halves every 180 days', () => {
    expect(saleWeight(0)).toBe(1);
    expect(saleWeight(180)).toBeCloseTo(0.5);
  });

  it('counts the same season last year extra', () => {
    expect(saleWeight(365)).toBeGreaterThan(saleWeight(300));
    expect(saleWeight(365) - saleWeight(411)).toBeGreaterThan(0.4);
  });
});

describe('pickMarket', () => {
  it('takes the first country given and falls back to the world', () => {
    expect(pickMarket([null, 'nl', 'DE'])).toBe('NL');
    expect(pickMarket([undefined, '', 'xyz'])).toBe(WORLD);
    expect(pickMarket(['RU', 'NL'])).toBe(WORLD);
  });
});

describe('markets', () => {
  it('groups markets by first language', () => {
    expect(languageGroup('NL')).toEqual(expect.arrayContaining(['NL', 'BE']));
    expect(languageGroup('AT')).toEqual(expect.arrayContaining(['DE', 'AT', 'CH']));
  });

  it('knows the country a language implies', () => {
    expect(countryOfLocale('nl')).toBe('NL');
    expect(countryOfLocale('zz')).toBeNull();
  });
});

describe('rankMarket', () => {
  it('puts what a country buys first, and another country gets another order', () => {
    const playlists = [list(1), list(2), list(3)];
    const buckets = [sold(1, 'NL', 100), sold(2, 'DE', 100), sold(3, 'US', 30)];
    expect(order(playlists, buckets, 'NL')[0]).toBe(1);
    expect(order(playlists, buckets, 'DE')[0]).toBe(2);
  });

  it('ranks an old bestseller above a new list with a few sales', () => {
    const playlists = [list(1), list(2, { createdAt: daysAgo(20) }), list(3), list(4)];
    const buckets = [
      sold(1, 'NL', 300, 30),
      sold(1, 'NL', 300, 400),
      sold(2, 'NL', 5),
      sold(3, 'NL', 40),
      sold(4, 'NL', 60),
    ];
    expect(order(playlists, buckets, WORLD)[0]).toBe(1);
    expect(order(playlists, buckets, 'NL')[0]).toBe(1);
  });

  it('lets a list that stopped selling sink', () => {
    const playlists = [list(1), list(2)];
    const buckets = [sold(1, 'NL', 100, 900), sold(2, 'NL', 20, 10)];
    expect(order(playlists, buckets, 'NL')).toEqual([2, 1]);
  });

  it('leans on the language group, then the world, where a country sold little', () => {
    const playlists = [list(1), list(2), list(3)];
    // Belgium sold nothing; the Netherlands (same group) buys 2, the world 1.
    const buckets = [sold(1, 'US', 200), sold(2, 'NL', 150), sold(3, 'US', 20)];
    expect(order(playlists, buckets, 'BE')[0]).toBe(2);
    // Hungary has no group to lean on: the world's order.
    expect(order(playlists, buckets, 'HU')).toEqual(order(playlists, buckets, WORLD));
  });

  it('gives a list in the market\'s own language a head start', () => {
    const playlists = [list(1), list(2, { featuredLocale: 'hu' })];
    const buckets = [sold(1, 'US', 12), sold(2, 'US', 10)];
    expect(order(playlists, buckets, 'HU')).toEqual([2, 1]);
    expect(order(playlists, buckets, WORLD)).toEqual([1, 2]);
    expect(rankMarket(playlists, buckets, 'HU', NOW)[0].ownLanguage).toBe(true);
  });

  it('ranks a new list with at least the median list\'s sales', () => {
    const playlists = [
      list(1),
      list(2),
      list(3),
      list(4, { createdAt: daysAgo(5) }),
    ];
    const buckets = [sold(1, 'NL', 50), sold(2, 'NL', 20), sold(3, 'NL', 2)];
    const ids = order(playlists, buckets, WORLD);
    expect(ids.indexOf(4)).toBeLessThan(ids.indexOf(3));
    expect(ids[0]).toBe(1);
  });

  it('gives every playlist a place, sold or not', () => {
    const playlists = [list(1), list(2), list(3)];
    expect(order(playlists, [], 'NL').sort()).toEqual([1, 2, 3]);
    expect(order(playlists, [sold(99, 'NL', 5)], 'NL')).toHaveLength(3);
  });

  it('counts a sale without a country for the world only', () => {
    const playlists = [list(1), list(2)];
    const buckets = [sold(1, null, 500), sold(2, 'NL', 60)];
    expect(order(playlists, buckets, WORLD)[0]).toBe(1);
    expect(order(playlists, buckets, 'NL')[0]).toBe(2);
  });
});

describe('spreadGenres', () => {
  it('allows no genre three times in a row at the top', () => {
    const ranked = [1, 1, 1, 1, 2, 3].map((genreId, id) => ({ id, genreId }));
    expect(spreadGenres(ranked).map((p) => p.genreId)).toEqual([1, 1, 2, 1, 1, 3]);
  });

  it('leaves lists without a genre and a single-genre list alone', () => {
    const none = [0, 1, 2, 3].map((id) => ({ id, genreId: null }));
    expect(spreadGenres(none).map((p) => p.id)).toEqual([0, 1, 2, 3]);
    const one = [0, 1, 2, 3].map((id) => ({ id, genreId: 7 }));
    expect(spreadGenres(one).map((p) => p.id)).toEqual([0, 1, 2, 3]);
  });
});

describe('applyRanking', () => {
  it('orders the list, rewrites score to fall strictly, and numbers the places', () => {
    const base = [
      { id: 1, score: 90 },
      { id: 2, score: 80 },
      { id: 3, score: 70 },
    ];
    const out = applyRanking(base, [3, 1, 2]);
    expect(out.map((p) => p.id)).toEqual([3, 1, 2]);
    expect(out.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(out[0].score).toBe(100);
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });

  it('keeps a playlist the ranking does not know after the ranked ones', () => {
    const out = applyRanking([{ id: 9 }, { id: 1 }, { id: 2 }], [2, 1]);
    expect(out.map((p) => p.id)).toEqual([2, 1, 9]);
  });

  it('never gives two of a thousand places the same score', () => {
    const scores = Array.from({ length: 1000 }, (_, i) => scoreForPlace(i, 1000));
    expect(new Set(scores).size).toBe(1000);
  });
});
