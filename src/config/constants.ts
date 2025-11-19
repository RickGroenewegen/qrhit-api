export const MAX_CARDS = 3000;
export const MAX_CARDS_PHYSICAL = 1000;

// Spotify API rate limiting
export const SPOTIFY_CONCURRENT_REQUESTS = 3; // Conservative: 2-3 concurrent requests
export const SPOTIFY_PAGE_LIMIT = 100; // Test value, will fallback to 50 if not supported
export const SPOTIFY_PAGE_LIMIT_FALLBACK = 50; // Confirmed Spotify API limit
