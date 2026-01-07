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
  getPlaylist(playlistId: string): Promise<ApiResult & { data?: ProviderPlaylistData }>;

  /**
   * Get tracks from a playlist
   */
  getTracks(playlistId: string): Promise<ApiResult & { data?: ProviderTracksResult }>;

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
