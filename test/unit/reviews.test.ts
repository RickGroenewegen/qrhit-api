import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/reviews.ts, the file-backed review reader.
 *
 * reviews.json is written by the growth-oracle `reviews` pillar and shipped
 * with the deploy; the API only reads it. fs is mocked so the tests pin the
 * behaviour (what is visible where, which text a locale gets) rather than
 * whatever the committed file happens to contain today.
 */

const h = vi.hoisted(() => ({
  file: '' as string,
  mtimeMs: 1,
  readFile: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: h.readFile, stat: h.stat, access: h.access },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

import Reviews from '../../src/reviews';

function review(overrides: Record<string, any> = {}) {
  const base = {
    id: 'trustpilot:1',
    source: 'trustpilot',
    rating: 5,
    language: 'de',
    locale: 'de',
    author: 'Katrin',
    country: 'DE',
    authorImage: null,
    authorReviewCount: 2,
    verified: true,
    publishedAt: '2026-08-03T10:00:00.000Z',
    reply: null,
    original: { title: 'Tolles Geschenk', text: 'Kam total gut an.' },
    translations: {
      de: { title: 'Tolles Geschenk', text: 'Kam total gut an.' },
      en: { title: 'Great gift', text: 'It went down really well.' },
      nl: { title: 'Geweldig cadeau', text: 'Viel enorm in de smaak.' },
    },
    hidden: false,
    landingPage: false,
  };
  return { ...base, ...overrides };
}

function store(reviews: any[]) {
  return {
    version: 2,
    trustpilot: {
      fetchedAt: '2026-09-17T11:00:00.000Z',
      profileUrl: 'https://www.trustpilot.com/review/qrsong.io',
      trustScore: 4.7,
      stars: 4.5,
      reviewCount: 39,
    },
    appstore: { average: 4.654, count: 130, url: 'https://apps.apple.com/app/id1' },
    googleplay: { average: 4.429, count: 59, url: 'https://play.google.com/x' },
    reviews,
  };
}

function load(reviews: any[]) {
  h.file = JSON.stringify(store(reviews));
  h.readFile.mockImplementation(async () => h.file);
}

/** A fresh singleton per test: the store is cached on the instance. */
function fresh(): Reviews {
  (Reviews as any).instance = undefined;
  return Reviews.getInstance();
}

beforeEach(() => {
  h.readFile.mockReset();
  h.access.mockReset().mockResolvedValue(undefined);
  h.stat.mockReset().mockImplementation(async () => ({ mtimeMs: h.mtimeMs }));
});

describe('Reviews.getReviews', () => {
  it('serves the requested locale, and says whether it is a translation', async () => {
    load([review()]);
    const reviews = fresh();

    const nl: any = await reviews.getReviews({ locale: 'nl' });
    expect(nl.success).toBe(true);
    expect(nl.reviews[0].title).toBe('Geweldig cadeau');
    expect(nl.reviews[0].isTranslated).toBe(true);
    expect(nl.reviews[0].originalLanguage).toBe('de');

    const de: any = await reviews.getReviews({ locale: 'de' });
    expect(de.reviews[0].text).toBe('Kam total gut an.');
    expect(de.reviews[0].isTranslated).toBe(false);
  });

  it('falls back to English, then to the original, for a locale without a translation', async () => {
    load([
      review(),
      review({
        id: 'trustpilot:2',
        publishedAt: '2026-01-01T00:00:00.000Z',
        translations: {},
      }),
    ]);
    const res: any = await fresh().getReviews({ locale: 'pl' });
    expect(res.reviews[0].title).toBe('Great gift');
    expect(res.reviews[1].title).toBe('Tolles Geschenk');
  });

  it('never returns a hidden review', async () => {
    load([review({ hidden: true }), review({ id: 'trustpilot:2', author: 'Ralf' })]);
    const res: any = await fresh().getReviews({ locale: 'en' });
    expect(res.reviews.map((r: any) => r.author)).toEqual(['Ralf']);
  });

  it('filters on landing-page reviews', async () => {
    load([review(), review({ id: 'trustpilot:2', author: 'Stef', landingPage: true })]);
    const res: any = await fresh().getReviews({ locale: 'en', landingPage: true });
    expect(res.reviews.map((r: any) => r.author)).toEqual(['Stef']);
  });

  it('orders newest first by the real publication date and applies the amount', async () => {
    load([
      review({ id: 'trustpilot:1', author: 'old', publishedAt: '2025-03-06T00:00:00.000Z' }),
      review({ id: 'trustpilot:2', author: 'new', publishedAt: '2026-08-08T00:00:00.000Z' }),
      review({ id: 'trustpilot:3', author: 'mid', publishedAt: '2026-01-12T00:00:00.000Z' }),
    ]);
    const reviews = fresh();
    const all: any = await reviews.getReviews({ locale: 'en', amount: 0 });
    expect(all.reviews.map((r: any) => r.author)).toEqual(['new', 'mid', 'old']);
    expect(all.reviews[0].date).toBe('2026-08-08T00:00:00.000Z');

    const two: any = await reviews.getReviews({ locale: 'en', amount: 2 });
    expect(two.reviews).toHaveLength(2);
  });

  it('keeps app store reviews out unless asked for', async () => {
    load([
      review(),
      review({ id: 'appstore:9', source: 'appstore', author: 'Groenstra' }),
      review({ id: 'googleplay:9', source: 'googleplay', author: 'emma' }),
    ]);
    const reviews = fresh();

    const plain: any = await reviews.getReviews({ locale: 'en' });
    expect(plain.reviews.map((r: any) => r.source)).toEqual(['trustpilot']);

    const withApps: any = await reviews.getReviews({ locale: 'en', includeApps: true });
    expect(withApps.reviews.map((r: any) => r.source).sort()).toEqual([
      'appstore',
      'googleplay',
      'trustpilot',
    ]);
  });

  it('never shows an app store review under 4 stars, even when it is not hidden', async () => {
    load([
      review({ id: 'googleplay:1', source: 'googleplay', author: 'three', rating: 3 }),
      review({ id: 'googleplay:2', source: 'googleplay', author: 'four', rating: 4 }),
      review({ id: 'appstore:1', source: 'appstore', author: 'one', rating: 1 }),
    ]);
    const res: any = await fresh().getReviews({ locale: 'en', includeApps: true });
    expect(res.reviews.map((r: any) => r.author)).toEqual(['four']);
  });

  it('reports failure instead of throwing when the file is unreadable', async () => {
    h.readFile.mockRejectedValue(new Error('ENOENT'));
    const res: any = await fresh().getReviews({ locale: 'en' });
    expect(res).toEqual({ success: false, error: 'Error reading reviews' });
  });

  it('does not cache a failed read', async () => {
    const reviews = fresh();
    h.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    expect(((await reviews.getReviews()) as any).success).toBe(false);

    load([review()]);
    expect(((await reviews.getReviews()) as any).success).toBe(true);
  });

  it('parses the file once across requests', async () => {
    load([review()]);
    const reviews = fresh();
    await reviews.getReviews({ locale: 'en' });
    await reviews.getReviews({ locale: 'nl' });
    await reviews.getScores();
    expect(h.readFile).toHaveBeenCalledTimes(1);
  });
});

describe('Reviews.getScores', () => {
  it('keeps the legacy company shape and adds the app stores', async () => {
    load([review()]);
    const res: any = await fresh().getScores();
    expect(res.success).toBe(true);
    expect(res.company).toEqual({ trust_score: 4.7, review_count: 39, rating: 4.5 });
    expect(res.apps.ios).toEqual({
      rating: 4.654,
      rating_count: 130,
      url: 'https://apps.apple.com/app/id1',
    });
    expect(res.apps.android.rating_count).toBe(59);
  });

  it('reports failure when the store has no Trustpilot block', async () => {
    h.file = JSON.stringify({ ...store([]), trustpilot: null });
    h.readFile.mockImplementation(async () => h.file);
    const res: any = await fresh().getScores();
    expect(res.success).toBe(false);
  });
});
