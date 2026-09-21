export interface CustomerReview {
  /** `<source>:<the platform's id>`. */
  id: string;
  source: 'trustpilot' | 'appstore' | 'googleplay';
  stars: number;
  /** In the requested locale. Empty for Google Play, which has no titles. */
  title: string;
  text: string;
  author: string;
  /** When the review was published on the platform, ISO 8601. */
  date: string;
  authorImage: string;
  authorCountry: string;
  authorReviewCount: number;
  isVerified: boolean;
  /** ISO 639-1 language the review was written in. */
  originalLanguage: string;
  /** False when `title`/`text` are the reviewer's own words. */
  isTranslated: boolean;
}
