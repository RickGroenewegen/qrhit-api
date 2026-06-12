import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/trustpilot.ts review mapping and caching logic.
 * The constructor wants RAPID_API_KEY and would kick off an initial API
 * fetch + daily cron when running on the main server — Utils.isMainServer
 * is mocked to false so none of that runs. axios, prisma, cache and the
 * lazily imported ChatGPT translator are all mocked.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    cacheStore,
    cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string) => {
      cacheStore.set(key, value);
    }),
    cacheDel: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    translateTrustpilotReviews: vi.fn(async () => undefined),
    prisma: {
      trustPilot: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

vi.mock('axios');

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({ get: h.cacheGet, set: h.cacheSet, del: h.cacheDel }),
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = async () => false;
  },
}));

vi.mock('../../../src/chatgpt', () => ({
  ChatGPT: class {
    translateTrustpilotReviews = h.translateTrustpilotReviews;
  },
}));

process.env['RAPID_API_KEY'] = 'test-rapid-key';

import axios from 'axios';
import Trustpilot from '../../../src/trustpilot';

const axiosRequest = vi.mocked(axios.request);
const trustpilot = Trustpilot.getInstance();

function dbReview(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    name: 'Alice',
    country: 'NL',
    rating: 5,
    image: 'http://img/alice.png',
    locale: 'en-US',
    hide: false,
    landingPage: false,
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
    title_en: 'Great product',
    message_en: 'Loved it',
    title_nl: 'Geweldig product',
    message_nl: 'Geweldig',
    title_de: '',
    message_de: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cacheStore.clear();
});

describe('getReviews', () => {
  it('maps database rows to the public review shape using the requested locale', async () => {
    h.prisma.trustPilot.findMany.mockResolvedValueOnce([dbReview()]);

    const result = await trustpilot.getReviews(true, 0, 'nl');
    expect(result.success).toBe(true);
    expect((result as any).reviews).toEqual([
      {
        id: '1',
        stars: 5,
        title: 'Geweldig product',
        text: 'Geweldig',
        author: 'Alice',
        date: '2026-01-02T03:04:05.000Z',
        authorImage: 'http://img/alice.png',
        authorCountry: 'NL',
        authorReviewCount: 1,
        isVerified: false,
      },
    ]);

    // Only visible reviews, newest first, no take for amount=0
    expect(h.prisma.trustPilot.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      where: { hide: false },
    });
  });

  it('limits results and filters to landing-page reviews when asked', async () => {
    h.prisma.trustPilot.findMany.mockResolvedValueOnce([dbReview()]);
    await trustpilot.getReviews(true, '3', 'en', true);

    expect(h.prisma.trustPilot.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      where: { hide: false, landingPage: true },
      take: 3,
    });
  });

  it('caches results per day/amount/locale/landing flag for an hour', async () => {
    h.prisma.trustPilot.findMany.mockResolvedValueOnce([dbReview()]);
    await trustpilot.getReviews(true, 5, 'nl', true);

    const today = new Date().toISOString().split('T')[0];
    const [key, , ttl] = h.cacheSet.mock.calls[0];
    expect(key).toBe(`trustpilot_reviews_${today}_5_nl_1`);
    expect(ttl).toBe(3600);
  });

  it('serves repeat lookups from cache without hitting the database', async () => {
    h.prisma.trustPilot.findMany.mockResolvedValueOnce([dbReview()]);
    await trustpilot.getReviews(true, 0, 'en');
    const second = await trustpilot.getReviews(true, 0, 'en');

    expect(second.success).toBe(true);
    expect(h.prisma.trustPilot.findMany).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when cache=false', async () => {
    h.prisma.trustPilot.findMany.mockResolvedValue([dbReview()]);
    await trustpilot.getReviews(true, 0, 'en');
    await trustpilot.getReviews(false, 0, 'en');
    expect(h.prisma.trustPilot.findMany).toHaveBeenCalledTimes(2);
  });

  it('returns a generic error when the database fails', async () => {
    h.prisma.trustPilot.findMany.mockRejectedValueOnce(new Error('db'));
    expect(await trustpilot.getReviews(true, 0, 'en')).toEqual({
      success: false,
      error: 'Error fetching Trustpilot reviews from database',
    });
  });
});

describe('getCompanyDetails', () => {
  it('maps the RapidAPI payload to trust score fields and caches for 24h', async () => {
    axiosRequest.mockResolvedValueOnce({
      data: {
        data: {
          company: {
            trust_score: 4.8,
            review_count: 321,
            rating: 'excellent',
            irrelevant: 'dropped',
          },
        },
      },
    } as any);

    const result = await trustpilot.getCompanyDetails();
    expect(result).toEqual({
      success: true,
      company: { trust_score: 4.8, review_count: 321, rating: 'excellent' },
    });

    // Request goes to the RapidAPI host with our key
    const options = axiosRequest.mock.calls[0][0] as any;
    expect(options.params.company_domain).toBe('qrsong.io');
    expect(options.headers['x-rapidapi-key']).toBe('test-rapid-key');

    const [key, , ttl] = h.cacheSet.mock.calls[0];
    expect(key).toBe('trustpilot_company');
    expect(ttl).toBe(86400);
  });

  it('serves cached company details without a network call', async () => {
    h.cacheStore.set(
      'trustpilot_company',
      JSON.stringify({ success: true, company: { trust_score: 4.5 } })
    );
    const result = await trustpilot.getCompanyDetails();
    expect(result).toEqual({ success: true, company: { trust_score: 4.5 } });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('returns a generic error when the API call fails', async () => {
    axiosRequest.mockRejectedValueOnce(new Error('rapidapi down'));
    expect(await trustpilot.getCompanyDetails()).toEqual({
      success: false,
      error: 'Error fetching Trustpilot company details',
    });
  });
});

describe('fetchReviewsFromAPI', () => {
  async function runFetch() {
    vi.useFakeTimers();
    try {
      const p = (trustpilot as any).fetchReviewsFromAPI();
      // Two 1s inter-locale delays
      await vi.advanceTimersByTimeAsync(5000);
      await p;
    } finally {
      vi.useRealTimers();
    }
  }

  it('creates new reviews, updates existing ones per locale and triggers translation', async () => {
    const apiReview = {
      consumer_name: 'Alice',
      consumer_country: 'NL',
      review_rating: 5,
      consumer_image: 'http://img/a.png',
      review_title: 'Great',
      review_text: 'Loved it',
    };
    // en-US: Alice is new; nl-NL: Alice exists; es-ES: nothing
    axiosRequest
      .mockResolvedValueOnce({ data: { data: { reviews: [apiReview] } } } as any)
      .mockResolvedValueOnce({ data: { data: { reviews: [apiReview] } } } as any)
      .mockResolvedValueOnce({ data: { data: { reviews: [] } } } as any);

    h.prisma.trustPilot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 50 });
    h.prisma.trustPilot.create.mockResolvedValueOnce({ id: 50 });
    const translatable = [dbReview({ id: 50 })];
    h.prisma.trustPilot.findMany.mockResolvedValueOnce(translatable);

    await runFetch();

    // One API call per supported locale
    expect(axiosRequest).toHaveBeenCalledTimes(3);
    const locales = axiosRequest.mock.calls.map((c: any[]) => c[0].params.locale);
    expect(locales).toEqual(['en-US', 'nl-NL', 'es-ES']);

    // New review: created with the en fields filled and other locales empty
    const created = h.prisma.trustPilot.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      name: 'Alice',
      country: 'NL',
      rating: 5,
      locale: 'en-US',
      title_en: 'Great',
      message_en: 'Loved it',
      title_nl: '',
      message_nl: '',
    });

    // Existing review: updated with the nl-localized fields
    expect(h.prisma.trustPilot.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({
        locale: 'nl-NL',
        title_nl: 'Great',
        message_nl: 'Loved it',
      }),
    });

    // Daily review cache invalidated
    const today = new Date().toISOString().split('T')[0];
    expect(h.cacheDel).toHaveBeenCalledWith(`trustpilot_reviews_${today}`);

    // Both touched reviews handed to the translator
    expect(h.prisma.trustPilot.findMany).toHaveBeenCalledWith({
      where: { id: { in: [50, 50] } },
    });
    expect(h.translateTrustpilotReviews).toHaveBeenCalledWith(translatable);
  });

  it('swallows API failures without translating anything', async () => {
    axiosRequest.mockRejectedValueOnce(new Error('rapidapi down'));
    await expect(
      (trustpilot as any).fetchReviewsFromAPI()
    ).resolves.toBeUndefined();
    expect(h.translateTrustpilotReviews).not.toHaveBeenCalled();
  });
});

describe('translateExistingReviews', () => {
  it('does nothing when every review already has translations', async () => {
    h.prisma.trustPilot.findMany.mockResolvedValueOnce([]);
    await trustpilot.translateExistingReviews();
    expect(h.translateTrustpilotReviews).not.toHaveBeenCalled();
  });

  it('builds an OR condition per locale and hands untranslated reviews to ChatGPT', async () => {
    const rows = [dbReview({ id: 9 })];
    h.prisma.trustPilot.findMany.mockResolvedValueOnce(rows);

    await trustpilot.translateExistingReviews();

    const where = h.prisma.trustPilot.findMany.mock.calls[0][0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    // One empty-title condition per supported locale
    expect(where.OR).toEqual(
      expect.arrayContaining([{ title_en: '' }, { title_nl: '' }, { title_de: '' }])
    );
    expect(h.translateTrustpilotReviews).toHaveBeenCalledWith(rows);
  });

  it('swallows translation errors', async () => {
    h.prisma.trustPilot.findMany.mockRejectedValueOnce(new Error('db'));
    await expect(trustpilot.translateExistingReviews()).resolves.toBeUndefined();
  });
});
