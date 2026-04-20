export const MAX_CARDS = 3000;
export const MAX_CARDS_PHYSICAL = 1000;

export const FLAT_SHIPPING_ENABLED =
  process.env.FLAT_SHIPPING_ENABLED === 'true';
export const FLAT_SHIPPING_RATE = 2.99;
export const FLAT_SHIPPING_CAP_PER_CARD = 1.5;

// Countries eligible for the flat-shipping promise. Marketing surfaces this
// as "all EU countries ship for the same flat fee". NL is the baseline (no
// redistribution needed); the rest get the difference redistributed into
// per-card prices.
export const FLAT_SHIPPING_COUNTRIES = [
  'NL',
  'BE',
  'DE',
  'AT',
  'BG',
  'CY',
  'CZ',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
];

// Spotify API rate limiting
export const SPOTIFY_CONCURRENT_REQUESTS = 2; // Very conservative: 2 concurrent requests (changed from 3)
export const SPOTIFY_PAGE_LIMIT = 100; // Test value, will fallback to 50 if not supported
export const SPOTIFY_PAGE_LIMIT_FALLBACK = 50; // Confirmed Spotify API limit
