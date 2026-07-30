import { ServiceType } from '../enums/ServiceType';
import { ApiResult } from './ApiResult';

/**
 * Normalized playlist data returned by any music provider
 */
export interface ProviderPlaylistData {
  id: string; // Service-specific playlist ID
  name: string;
  description: string;
  imageUrl: string | null;
  trackCount: number;
  serviceType: ServiceType;
  originalUrl?: string;
}

/**
 * Normalized track data returned by any music provider
 */
export interface ProviderTrackData {
  id: string; // Service-specific track ID
  name: string;
  artist: string;
  artistsList?: string[]; // For multiple artists
  album: string;
  albumImageUrl: string | null;
  releaseDate: string | null;
  isrc?: string; // International Standard Recording Code
  previewUrl?: string | null;
  duration?: number; // Duration in milliseconds
  serviceType: ServiceType;
  serviceLink: string; // Direct link to track on this service
}

/**
 * Result of fetching tracks from a playlist
 */
/**
 * Named options for IMusicProvider.getTracks.
 *
 * Every field is optional and every provider accepts the whole bag, ignoring
 * what does not apply to it (only Apple Music reads `storefront`). Callers can
 * therefore pass the same options object to any provider without knowing which
 * one they hold.
 */
export interface GetTracksOptions {
  /** Use cached results. Default true. */
  cache?: boolean;
  /** Cap the number of tracks fetched. */
  maxTracks?: number;
  /** Progress updates during long fetches. */
  onProgress?: ProgressCallback;
  /**
   * Keep different versions of the same song (live/remix/remaster) instead of
   * collapsing them on artist+title. The customer's choice, stored on
   * payment_has_playlist.allowDuplicates. Default false.
   */
  allowDuplicates?: boolean;
  /** Apple Music only: the storefront to resolve the playlist against. */
  storefront?: string;
}

export interface ProviderTracksResult {
  tracks: ProviderTrackData[];
  total: number;
  skipped?: {
    total: number;
    summary: {
      unavailable: number;
      localFiles: number;
      podcasts: number;
      duplicates: number;
    };
    details: Array<{
      position: number;
      reason: 'unavailable' | 'localFile' | 'podcast' | 'duplicate';
      name?: string;
      artist?: string;
      duplicateOf?: number;
    }>;
  };
}

/**
 * Result of URL validation
 */
export interface UrlValidationResult {
  isValid: boolean;
  isServiceUrl: boolean; // URL belongs to this service but might not be a playlist
  resourceType?: 'playlist' | 'track' | 'album' | 'artist';
  resourceId?: string;
  errorType?: 'not_playlist' | 'invalid_format' | 'private_playlist' | 'unknown';
}

/**
 * Search result from a music provider
 */
export interface ProviderSearchResult {
  tracks: ProviderTrackData[];
  total: number;
  hasMore: boolean;
}

/**
 * Progress callback for long-running track fetches
 */
export type ProgressCallback = (progress: {
  stage: 'fetching_ids' | 'fetching_metadata' | 'enriching';
  current: number;
  total: number | null; // null if unknown
  percentage: number;
  message?: string;
}) => void;

/**
 * Configuration for a music provider
 */
export interface MusicProviderConfig {
  serviceType: ServiceType;
  displayName: string;
  supportsOAuth: boolean;
  supportsPublicPlaylists: boolean;
  supportsSearch: boolean;
  supportsPlaylistCreation: boolean;
  brandColor: string;
  iconClass: string;
}

/**
 * Interface that all music service providers must implement.
 * This abstraction allows the system to work with multiple music streaming services.
 */
export interface IMusicProvider {
  /**
   * The service type this provider handles
   */
  readonly serviceType: ServiceType;

  /**
   * Configuration for this provider
   */
  readonly config: MusicProviderConfig;

  /**
   * Validate a URL and determine if it belongs to this service
   */
  validateUrl(url: string): UrlValidationResult;

  /**
   * Extract playlist ID from a URL
   */
  extractPlaylistId(url: string): string | null;

  /**
   * Get playlist metadata
   */
  getPlaylist(playlistId: string, ...args: any[]): Promise<ApiResult & { data?: ProviderPlaylistData }>;

  /**
   * Get tracks from a playlist.
   *
   * Options are a named bag rather than positional arguments on purpose. The
   * positional form used to mean different things per provider — the 5th
   * argument was `allowDuplicates` on Spotify but `storefront` on Apple Music —
   * which made every call site a chance to pass the wrong thing. That is
   * exactly how a checkout path silently re-deduped a playlist the customer had
   * asked to keep duplicates on, undercharging the order and truncating the
   * generated PDF. Named options make that class of mistake impossible.
   *
   * @param playlistId The playlist ID
   * @param options See GetTracksOptions
   */
  getTracks(
    playlistId: string,
    options?: GetTracksOptions
  ): Promise<ApiResult & { data?: ProviderTracksResult }>;

  /**
   * Search for tracks (optional - not all providers may support this)
   */
  searchTracks?(
    query: string,
    limit?: number,
    offset?: number
  ): Promise<ApiResult & { data?: ProviderSearchResult }>;

  /**
   * Resolve a shortlink URL to full URL (optional)
   */
  resolveShortlink?(url: string): Promise<ApiResult & { data?: { resolvedUrl: string } }>;

  /**
   * Get OAuth authorization URL (only for providers that support OAuth)
   */
  getAuthorizationUrl?(): string | null;

  /**
   * Handle OAuth callback (only for providers that support OAuth)
   */
  handleAuthCallback?(code: string): Promise<ApiResult & { data?: { accessToken: string } }>;

  /**
   * Create a playlist (only for providers that support this)
   */
  createPlaylist?(
    name: string,
    trackIds: string[],
    accessToken?: string
  ): Promise<ApiResult & { data?: { playlistId: string; url: string } }>;

  /**
   * Delete/unfollow a playlist (only for providers that support this)
   */
  deletePlaylist?(playlistId: string, accessToken?: string): Promise<ApiResult>;
}
