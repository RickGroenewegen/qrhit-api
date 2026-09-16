export interface ApiResult {
  success: boolean;
  error?: string;
  blocked?: boolean; // The playlist (PaymentHasPlaylist) was blocked by an admin
  data?: any;
  needsReAuth?: boolean;
  authUrl?: string; // Add optional property for authorization URL
  retryAfter?: number; // Add optional property for Retry-After header value
  playlistType?: string; // Type of Spotify-owned playlist (editorial, this_is, daily_mix, personalized)
}
