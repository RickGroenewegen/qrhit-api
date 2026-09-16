/**
 * Shared building blocks for our outbound product feeds.
 *
 * Both `src/merchantcenter.ts` (pushes to the Google Merchant API) and
 * `src/channable.ts` (writes the CSV feed Channable imports) have to describe
 * the SAME catalogue: the same markets, the same product ids, the same PMax
 * custom labels. Keeping that logic here means the two feeds cannot drift
 * apart while they run side by side.
 *
 * Everything in this file is pure — no database, no network, no env lookups —
 * so it stays trivially testable and safe to import from anywhere.
 */

// Genre groupings for PMax campaign segmentation (custom_label_1)
export const GENRE_GROUPS: Record<string, string> = {
  // Pop & Hits
  pop: 'pop_hits',
  kpop: 'pop_hits',
  eurovision: 'pop_hits',
  general: 'pop_hits',
  // Rock & Metal
  rock: 'rock_metal',
  metal: 'rock_metal',
  // Mood & Emotion
  love: 'mood_emotion',
  oldies: 'mood_emotion',
  classical: 'mood_emotion',
  // World & Dance
  hiphop: 'world_dance',
  electronic: 'world_dance',
  rnb: 'world_dance',
  raggae: 'world_dance',
  // Other
  jazz: 'other',
  country: 'other',
  sountracks: 'other',
  '80s': 'other',
};

// Which playlist locales a target country is allowed to show, mirroring the
// public /:locale/playlists page (src/data/country-locales.ts in the frontend).
// A playlist is included for a country when it is international
// (featuredLocale == null) OR its featuredLocale (comma-separated) intersects
// this allowed set. This is the SAME "localised + international" rule the
// website uses, ported here so the product feeds match it instead of doing a
// stricter single-locale exact match.
export const COUNTRY_ALLOWED_LOCALES: Record<string, string[]> = {
  US: ['en'],
  GB: ['en'],
  AU: ['en'],
  CA: ['en', 'fr'],
  NL: ['nl', 'en'],
  BE: ['nl', 'fr', 'en'],
  DE: ['de', 'en'],
  AT: ['de', 'en'],
  CH: ['de', 'fr', 'it', 'en'],
  ES: ['es', 'en'],
  SE: ['sv', 'no', 'en'],
  NO: ['no', 'sv', 'en'],
};

// Mapping of locale-country combinations we publish products for.
// Multiple countries can use the same language content.
export const LOCALE_COUNTRY_PAIRS: Array<{ locale: string; country: string }> =
  [
    { locale: 'en', country: 'US' },
    { locale: 'en', country: 'GB' }, // UK — English content, GBP
    { locale: 'en', country: 'AU' }, // Australia — English content, AUD
    { locale: 'en', country: 'CA' }, // Canada — English content, CAD
    { locale: 'nl', country: 'NL' },
    { locale: 'nl', country: 'BE' }, // Belgium using Dutch content
    { locale: 'de', country: 'DE' },
    { locale: 'de', country: 'AT' }, // Austria using German content
    { locale: 'de', country: 'CH' }, // Switzerland using German content, CHF
    { locale: 'es', country: 'ES' },
    { locale: 'sv', country: 'SE' },
    { locale: 'no', country: 'NO' },
  ];

// The locales we generate content for, in the order their id suffix implies.
export const LOCALE_NUMBERS: Record<string, number> = {
  en: 1,
  nl: 2,
  de: 3,
  es: 4,
  sv: 5,
  no: 6,
};

export const TYPE_NUMBERS: Record<string, number> = {
  digital: 1,
  sheets: 2,
  physical: 3,
};

export interface ProductVariant {
  id: number; // Database ID
  playlistId: string;
  name: string;
  description?: string;
  image: string;
  price: number;
  numberOfTracks: number;
  type: 'digital' | 'sheets' | 'physical';
  locale: string;
  country: string;
  slug: string;
  genre?: string;
  genreSlug?: string; // Genre slug for PMax custom labels
}

// True when a playlist's featuredLocale (possibly comma-separated, possibly
// null/empty) is allowed to show in the given country. International playlists
// (no featuredLocale) are always allowed. Mirrors isPlaylistAllowedInCountry()
// in the frontend.
export function isPlaylistAllowedInCountry(
  featuredLocale: string | null | undefined,
  country: string
): boolean {
  if (!featuredLocale) return true; // international — always shown
  const allowed = COUNTRY_ALLOWED_LOCALES[country];
  if (!allowed) return false;
  const locales = featuredLocale
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  if (locales.length === 0) return true;
  return locales.some((l) => allowed.includes(l));
}

/**
 * The offer id a variant gets: "{dbId}_{typeNum}_{localeNum}", e.g. "7_3_1".
 * Unique per playlist + product type + content language.
 */
export function buildOfferId(variant: {
  id: number;
  type: string;
  locale: string;
}): string {
  const typeNum = TYPE_NUMBERS[variant.type] ?? TYPE_NUMBERS['physical'];
  const localeNum = LOCALE_NUMBERS[variant.locale] || 1;
  return `${variant.id}_${typeNum}_${localeNum}`;
}

/**
 * The full product id: "{contentLanguage}~{feedLabel}~{offerId}", e.g.
 * "en~US~7_3_1". The country doubles as the feed label, which is what the
 * Merchant API expects and what Channable exports back into Merchant Center —
 * keeping the format identical means products keep their identity (and their
 * performance history) when the feed moves from one path to the other.
 */
export function buildProductId(variant: {
  id: number;
  type: string;
  locale: string;
  country: string;
}): string {
  return `${variant.locale}~${variant.country}~${buildOfferId(variant)}`;
}

/**
 * Product type breadcrumbs (Google's `product_type`).
 */
export function getProductTypes(variant: {
  type: string;
  genre?: string;
}): string[] {
  const types = ['Music', 'QR Codes'];

  if (variant.genre) {
    types.push(variant.genre);
  }

  switch (variant.type) {
    case 'digital':
      types.push('Digital Downloads');
      break;
    case 'sheets':
      types.push('Printable');
      break;
    case 'physical':
      types.push('Physical Product');
      break;
  }

  return types;
}

/**
 * Get the genre group for PMax segmentation (custom_label_1)
 */
export function getGenreGroup(genreSlug?: string): string {
  if (!genreSlug) return 'other';
  return GENRE_GROUPS[genreSlug.toLowerCase()] || 'other';
}

/**
 * Get track count range for PMax segmentation (custom_label_3)
 */
export function getTrackCountRange(numberOfTracks: number): string {
  if (numberOfTracks < 100) return 'small';
  if (numberOfTracks <= 250) return 'medium';
  return 'large';
}

/**
 * The "Contains N music tracks" line appended to every product description.
 * Falls back to English for any locale we haven't spelled out.
 */
export function getTracksLabel(
  numberOfTracks: number,
  locale: string
): string {
  const tracksLabel: { [key: string]: string } = {
    en: `Contains ${numberOfTracks} music tracks`,
    nl: `Bevat ${numberOfTracks} muzieknummers`,
    de: `Enthält ${numberOfTracks} Musiktitel`,
    fr: `Contient ${numberOfTracks} pistes musicales`,
    es: `Contiene ${numberOfTracks} pistas de música`,
    it: `Contiene ${numberOfTracks} brani musicali`,
    pt: `Contém ${numberOfTracks} faixas de música`,
    pl: `Zawiera ${numberOfTracks} utworów muzycznych`,
    jp: `${numberOfTracks}曲の音楽トラックを含む`,
    cn: `包含${numberOfTracks}首音乐曲目`,
    sv: `Innehåller ${numberOfTracks} musikspår`,
    no: `Inneholder ${numberOfTracks} musikkspor`,
  };
  return tracksLabel[locale] || tracksLabel['en'];
}

/**
 * Resolve the shipping cost (in EUR) for a given country / product type /
 * track count, mirroring the size-tier logic used by PrintEnBind:
 *   - sheets always use the smallest tier (80)
 *   - physical use the smallest tier whose size >= numberOfTracks (capped at 1000)
 * Returns null if no matching cost is found, in which case the caller
 * should fall back to a sane default.
 */
export function getShippingCostForVariant(
  shippingCostsByCountry: Map<string, { size: number; cost: number }[]>,
  country: string,
  type: 'digital' | 'sheets' | 'physical',
  numberOfTracks: number
): number | null {
  if (type === 'digital') return 0;

  const costs = shippingCostsByCountry.get(country);
  if (!costs || costs.length === 0) return null;

  const TIERS = [80, 405, 1000];
  let targetSize: number;
  if (type === 'sheets') {
    targetSize = TIERS[0];
  } else {
    targetSize = TIERS.find((t) => numberOfTracks <= t) ?? TIERS[TIERS.length - 1];
  }

  // Exact tier match first; if not present, fall back to the smallest size
  // >= targetSize, then to the largest available.
  const exact = costs.find((c) => c.size === targetSize);
  if (exact) return exact.cost;

  const sorted = [...costs].sort((a, b) => a.size - b.size);
  const next = sorted.find((c) => c.size >= targetSize);
  if (next) return next.cost;
  return sorted[sorted.length - 1].cost;
}
