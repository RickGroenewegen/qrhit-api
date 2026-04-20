export const MAX_CARDS = 3000;
export const MAX_CARDS_PHYSICAL = 1000;

// Spotify API rate limiting
export const SPOTIFY_CONCURRENT_REQUESTS = 2; // Very conservative: 2 concurrent requests (changed from 3)
export const SPOTIFY_PAGE_LIMIT = 100; // Test value, will fallback to 50 if not supported
export const SPOTIFY_PAGE_LIMIT_FALLBACK = 50; // Confirmed Spotify API limit
