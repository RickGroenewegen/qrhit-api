export const MAX_CARDS = 3000;
export const MAX_CARDS_PHYSICAL = 1000;

// Box product
export const BOX_PRICE = 6.99;
export const BOX_MAX_CARDS = 190;

// Per-box price by total boxes on a single cart item. Index 0 is unused;
// index N is the per-box price when the item has N boxes (anything past the
// array length uses the last value — the €4 plateau).
//   1 box: €6.99 · 2: €6.00 · 3: €5.00 · 4: €4.50 · 5+: €4.00
export const BOX_TIER_PRICES = [BOX_PRICE, BOX_PRICE, 6.0, 5.0, 4.5, 4.0] as const;

export function boxTierPrice(boxCount: number): number {
  if (boxCount < 1) return BOX_PRICE;
  const idx = Math.min(boxCount, BOX_TIER_PRICES.length - 1);
  return BOX_TIER_PRICES[idx];
}

export function boxDiscount(boxCount: number): number {
  return 1 - boxTierPrice(boxCount) / BOX_PRICE;
}

// Spotify API rate limiting
export const SPOTIFY_CONCURRENT_REQUESTS = 2; // Very conservative: 2 concurrent requests (changed from 3)
export const SPOTIFY_PAGE_LIMIT = 100; // Test value, will fallback to 50 if not supported
export const SPOTIFY_PAGE_LIMIT_FALLBACK = 50; // Confirmed Spotify API limit
