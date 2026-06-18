export const MAX_CARDS = 3000;
export const MAX_CARDS_PHYSICAL = 1000;

// Box product
export const BOX_PRICE = 6.99;
export const BOX_MAX_CARDS = 190;
// What a single empty box costs us to buy from the supplier. Deducted from
// the profit calculation in printer-side reconciliation so reported profit
// reflects true margin, not just (sales − printer invoice).
export const BOX_UNIT_COST = 0.75;

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

// Multiplier on top of the printenbind raw per-card cost for the "add more
// tracks" upgrade. 1.25 = 25% markup. Keeps post-purchase upgrade pricing
// independent of the full margin model used at initial checkout.
export const EXTRA_TRACK_MARKUP_MULT = 1.25;

// Tiers offered to users for the "add more tracks" upgrade.
export const EXTRA_TRACK_TIERS = [10, 25, 50, 75, 100, 200] as const;
export type ExtraTrackTier = (typeof EXTRA_TRACK_TIERS)[number];

// Printer types. Single source of truth for the PaymentHasPlaylist.printerType
// values used across the API (generator, pdf, resellers, admin validation).
export const PRINTER_TYPE = {
  PRINTNBIND: 'printnbind',
  TROMP: 'tromp',
  SCHNEIDERS: 'schneiders',
  RESELLER: 'reseller',
  MUSICMATCH: 'musicmatch',
} as const;

export type PrinterType = (typeof PRINTER_TYPE)[keyof typeof PRINTER_TYPE];

// All valid printerType values.
export const PRINTER_TYPES: PrinterType[] = Object.values(PRINTER_TYPE);

// Default printerType for new playlists (matches the Prisma schema default).
export const DEFAULT_PRINTER_TYPE: PrinterType = PRINTER_TYPE.PRINTNBIND;

// Spotify API rate limiting
export const SPOTIFY_CONCURRENT_REQUESTS = 2; // Very conservative: 2 concurrent requests (changed from 3)
export const SPOTIFY_PAGE_LIMIT = 100; // Test value, will fallback to 50 if not supported
export const SPOTIFY_PAGE_LIMIT_FALLBACK = 50; // Confirmed Spotify API limit

// Refresh-token lifetimes used to estimate when a manual re-authorization is due.
// Spotify announced (June 2026) that user refresh tokens expire 6 months after issue.
export const SPOTIFY_REFRESH_TOKEN_TTL_DAYS = 180;
// Tidal's exact refresh-token lifetime is not documented in our integration; we assume
// the same 6-month window as a safe default. Adjust here if Tidal confirms otherwise.
export const TIDAL_REFRESH_TOKEN_TTL_DAYS = 180;
