import fs from 'fs/promises';
import path from 'path';

import { CustomerReview } from './interfaces/CustomerReview';
import { ReviewScores } from './interfaces/ReviewScores';
import Logger from './logger';
import { color } from 'console-log-colors';

/**
 * File-backed customer reviews.
 *
 * Reviews used to be pulled from a RapidAPI Trustpilot reseller when the API
 * booted, written to the `trustpilot` table and translated by ChatGPT in
 * batches of five with a pause in between. That made every restart minutes
 * long, spent a thin credit allowance on each of them, only ever saw 5-star
 * reviews in three locales, and showed nothing new whenever the reseller was
 * out of credits.
 *
 * They now ship with the deploy, the same way the blog does:
 *
 *   src/_data/reviews/reviews.json   every review from Trustpilot, the App Store
 *                                    and Google Play, in its original language
 *                                    and translated into every site locale,
 *                                    plus each platform's score
 *
 * The file is written by the growth-oracle `reviews` pillar
 * (`growth reviews fetch`), never by this process. This class only reads. The
 * `trustpilot` table is left in place and unread, so rolling back is a deploy
 * and not a database restore.
 *
 * The public response shape is unchanged, with `source` and `originalLanguage`
 * added, so a frontend cached from before the deploy keeps working.
 */

const FALLBACK_LOCALE = 'en';

/** App store reviews below this never reach the site, whatever the store says. */
const MIN_APP_REVIEW_RATING = 4;

/**
 * Where reviews.json lives. Resolved from this file rather than from cwd, for
 * the same reasons as the blog (see `CONTENT_DIRS` in blog.ts): `npm run build`
 * copies `_data` next to the compiled file, `tsc -w` does not.
 */
const CONTENT_FILES = [
  path.join(__dirname, '_data', 'reviews', 'reviews.json'),
  path.join(__dirname, '..', '..', 'src', '_data', 'reviews', 'reviews.json'),
  path.join(process.cwd(), 'src', '_data', 'reviews', 'reviews.json'),
];

type ReviewSource = 'trustpilot' | 'appstore' | 'googleplay';

interface ReviewText {
  title: string;
  text: string;
}

interface StoredReview {
  id: string;
  source: ReviewSource;
  rating: number;
  language: string;
  locale: string | null;
  author: string;
  country: string;
  authorImage: string | null;
  authorReviewCount: number;
  verified: boolean;
  publishedAt: string;
  reply: { text: string; publishedAt: string | null } | null;
  original: ReviewText;
  translations: Record<string, ReviewText>;
  hidden: boolean;
  landingPage: boolean;
}

interface StoreRating {
  average: number;
  count: number;
  url: string;
}

interface ReviewStore {
  trustpilot: {
    trustScore: number;
    stars: number;
    reviewCount: number;
    profileUrl: string;
  } | null;
  appstore: StoreRating | null;
  googleplay: StoreRating | null;
  reviews: StoredReview[];
}

export type ReviewsResult =
  | { success: true; reviews: CustomerReview[] }
  | { success: false; error: string };

export type ReviewScoresResult =
  | ({ success: true } & ReviewScores)
  | { success: false; error: string };

export interface ReviewQuery {
  locale?: string;
  /** 0 = all. */
  amount?: number;
  /** Only the reviews curated for landing pages. */
  landingPage?: boolean;
  /** Also return App Store and Google Play reviews. Trustpilot only otherwise. */
  includeApps?: boolean;
}

class Reviews {
  private static instance: Reviews;
  private logger = new Logger();
  private file: string | null = null;
  private storePromise: Promise<ReviewStore> | null = null;
  private storeMtime = 0;
  private lastStatAt = 0;

  public static getInstance(): Reviews {
    if (!Reviews.instance) {
      Reviews.instance = new Reviews();
    }
    return Reviews.instance;
  }

  private async resolveFile(): Promise<string> {
    if (this.file) return this.file;
    for (const candidate of CONTENT_FILES) {
      try {
        await fs.access(candidate);
        this.file = candidate;
        return candidate;
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`no reviews.json found in: ${CONTENT_FILES.join(', ')}`);
  }

  /**
   * The store is parsed once and held in memory; it only changes on deploy. In
   * development `growth reviews fetch` rewrites it under a running API, so the
   * mtime is checked at most once a minute and a newer file is picked up
   * without a restart. Held as the promise so concurrent first requests share
   * one read.
   */
  private async loadStore(): Promise<ReviewStore> {
    const file = await this.resolveFile();
    if (this.storePromise && Date.now() - this.lastStatAt > 60_000) {
      this.lastStatAt = Date.now();
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs !== this.storeMtime) this.storePromise = null;
    }
    if (!this.storePromise) {
      this.storePromise = (async () => {
        const [raw, stat] = await Promise.all([
          fs.readFile(file, 'utf8'),
          fs.stat(file),
        ]);
        const parsed = JSON.parse(raw) as ReviewStore;
        if (!Array.isArray(parsed?.reviews)) {
          throw new Error('reviews.json has no reviews array');
        }
        this.storeMtime = stat.mtimeMs;
        this.lastStatAt = Date.now();
        return parsed;
      })().catch((error) => {
        // Do not cache a failed read, or one bad moment leaves the process
        // without reviews until it restarts.
        this.storePromise = null;
        throw error;
      });
    }
    return this.storePromise;
  }

  private textFor(review: StoredReview, locale: string): ReviewText {
    return (
      review.translations[locale] ??
      review.translations[FALLBACK_LOCALE] ??
      review.original
    );
  }

  public async getReviews(query: ReviewQuery = {}): Promise<ReviewsResult> {
    try {
      const store = await this.loadStore();
      const locale = (query.locale || FALLBACK_LOCALE).toLowerCase();
      const amount = query.amount && query.amount > 0 ? query.amount : 0;

      const visible = store.reviews
        .filter((review) => {
          if (review.hidden) return false;
          if (query.landingPage && !review.landingPage) return false;
          if (review.source === 'trustpilot') return true;
          return !!query.includeApps && review.rating >= MIN_APP_REVIEW_RATING;
        })
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

      const reviews: CustomerReview[] = (
        amount ? visible.slice(0, amount) : visible
      ).map((review) => {
        const shown = this.textFor(review, locale);
        return {
          id: review.id,
          source: review.source,
          stars: review.rating,
          title: shown.title,
          text: shown.text,
          author: review.author,
          date: review.publishedAt,
          authorImage: review.authorImage ?? '',
          authorCountry: review.country,
          authorReviewCount: review.authorReviewCount,
          isVerified: review.verified,
          originalLanguage: review.language,
          isTranslated: review.locale !== locale,
        };
      });

      return { success: true, reviews };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Error reading reviews: ${color.white.bold(error?.message ?? error)}`
        )
      );
      return { success: false, error: 'Error reading reviews' };
    }
  }

  /**
   * The scores. `company` keeps the shape `/reviews_details` has always had;
   * `apps` is new.
   */
  public async getScores(): Promise<ReviewScoresResult> {
    try {
      const store = await this.loadStore();
      if (!store.trustpilot) throw new Error('reviews.json has no trustpilot block');
      const pick = (s: StoreRating | null) =>
        s ? { rating: s.average, rating_count: s.count, url: s.url } : null;
      const scores: ReviewScores = {
        company: {
          trust_score: store.trustpilot.trustScore,
          review_count: store.trustpilot.reviewCount,
          rating: store.trustpilot.stars,
        },
        apps: {
          ios: pick(store.appstore),
          android: pick(store.googleplay),
        },
      };
      return { success: true, ...scores };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Error reading review scores: ${color.white.bold(error?.message ?? error)}`
        )
      );
      return { success: false, error: 'Error reading review scores' };
    }
  }
}

export default Reviews;
