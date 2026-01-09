import { color } from 'console-log-colors';
import { ServiceType } from '../enums/ServiceType';
import {
  IMusicProvider,
  MusicProviderConfig,
  ProviderPlaylistData,
  ProviderTrackData,
  ProviderTracksResult,
  ProviderSearchResult,
  UrlValidationResult,
} from '../interfaces/IMusicProvider';
import { ApiResult } from '../interfaces/ApiResult';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';

// Deezer API base URL (no auth required for public data)
const DEEZER_API_BASE = 'https://api.deezer.com';

// Cache key prefixes for Deezer
const CACHE_KEY_DEEZER_PLAYLIST = 'deezer_playlist_';
const CACHE_KEY_DEEZER_TRACKS = 'deezer_tracks_';
const CACHE_KEY_DEEZER_SEARCH = 'deezer_search_';

// Cache TTL in seconds (only for search - playlist/tracks have no expiry like Spotify)
const CACHE_TTL_SEARCH = 1800; // 30 minutes

/**
 * Deezer provider implementing the IMusicProvider interface.
 * Uses Deezer's public API (no authentication required for public playlists).
 *
 * Features:
 * - No OAuth required (public API access)
 * - Provides ISRC codes for tracks
 * - Provides preview URLs for tracks
 * - Supports search functionality
 */
class DeezerProvider implements IMusicProvider {
  private static instance: DeezerProvider;
  private cache = Cache.getInstance();
  private logger = new Logger();
  private utils = new Utils();

  readonly serviceType = ServiceType.DEEZER;

  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.DEEZER,
    displayName: 'Deezer',
    supportsOAuth: false,
    supportsPublicPlaylists: true,
    supportsSearch: true,
    supportsPlaylistCreation: false,
    brandColor: '#FEAA2D',
    iconClass: 'fa-deezer',
  };

  /**
   * URL patterns for Deezer
   * Playlist IDs are numeric
   */
  private readonly urlPatterns = {
    // https://www.deezer.com/playlist/908622995
    deezerPlaylist: /^https?:\/\/(www\.)?deezer\.com\/playlist\/(\d+)/i,
    // https://www.deezer.com/en/playlist/908622995 (with locale)
    deezerPlaylistWithLocale: /^https?:\/\/(www\.)?deezer\.com\/[a-z]{2}\/playlist\/(\d+)/i,
    // deezer://playlist/908622995 (URI scheme)
    deezerUri: /^deezer:\/\/playlist\/(\d+)/i,
    // Bare numeric ID
    bareId: /^\d+$/,
    // Shortlinks: https://link.deezer.com/xxx or https://deezer.page.link/xxx
    shortlink: /^https?:\/\/(link\.deezer\.com|deezer\.page\.link)\//i,
    // Any Deezer URL
    anyDeezerUrl: /^https?:\/\/(www\.)?deezer\.com\//i,
  };

  public static getInstance(): DeezerProvider {
    if (!DeezerProvider.instance) {
      DeezerProvider.instance = new DeezerProvider();
    }
    return DeezerProvider.instance;
  }

  /**
   * Validate a URL and determine if it's a valid Deezer playlist URL
   */
  validateUrl(url: string): UrlValidationResult {
    const trimmedUrl = url.trim();

    // Check Deezer playlist URL with locale
    const localeMatch = trimmedUrl.match(this.urlPatterns.deezerPlaylistWithLocale);
    if (localeMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: localeMatch[2],
      };
    }

    // Check standard Deezer playlist URL
    const playlistMatch = trimmedUrl.match(this.urlPatterns.deezerPlaylist);
    if (playlistMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: playlistMatch[2],
      };
    }

    // Check Deezer URI scheme
    const uriMatch = trimmedUrl.match(this.urlPatterns.deezerUri);
    if (uriMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: uriMatch[1],
      };
    }

    // Check bare numeric ID
    const bareMatch = trimmedUrl.match(this.urlPatterns.bareId);
    if (bareMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: trimmedUrl,
      };
    }

    // Check shortlinks (need to be resolved)
    if (this.urlPatterns.shortlink.test(trimmedUrl)) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        // No resourceId - needs to be resolved via resolveShortlink
      };
    }

    // Check if it's a Deezer URL but not a playlist
    if (this.urlPatterns.anyDeezerUrl.test(trimmedUrl)) {
      return {
        isValid: false,
        isServiceUrl: true,
        errorType: 'not_playlist',
      };
    }

    return {
      isValid: false,
      isServiceUrl: false,
    };
  }

  /**
   * Extract playlist ID from a Deezer URL
   */
  extractPlaylistId(url: string): string | null {
    const validation = this.validateUrl(url);
    if (validation.isValid && validation.resourceId) {
      return validation.resourceId;
    }
    return null;
  }

  /**
   * Resolve a Deezer shortlink to its full URL
   */
  async resolveShortlink(url: string): Promise<ApiResult & { data?: { resolvedUrl: string } }> {
    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('deezer')}] Resolving shortlink: ${color.white.bold(url)}`
        )
      );

      // Follow redirects to get the final URL
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
      });

      const resolvedUrl = response.url;

      // Validate the resolved URL is a Deezer playlist
      const validation = this.validateUrl(resolvedUrl);
      if (validation.isServiceUrl && validation.resourceId) {
        this.logger.log(
          color.green.bold(
            `[${color.white.bold('deezer')}] Shortlink resolved to: ${color.white.bold(resolvedUrl)}`
          )
        );
        return {
          success: true,
          data: { resolvedUrl },
        };
      }

      // Check if it resolved to a Deezer URL but not a playlist
      if (validation.isServiceUrl && !validation.isValid) {
        return {
          success: false,
          error: 'Shortlink resolved to a Deezer URL but not a playlist',
        };
      }

      return {
        success: false,
        error: 'Shortlink did not resolve to a valid Deezer playlist URL',
      };
    } catch (error: any) {
      this.logger.log(`ERROR: Failed to resolve Deezer shortlink: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to resolve shortlink',
      };
    }
  }

  /**
   * Make a request to the Deezer API
   */
  private async apiRequest<T>(endpoint: string): Promise<{ success: boolean; data?: T; error?: string }> {
    try {
      const url = `${DEEZER_API_BASE}${endpoint}`;
      const response = await fetch(url);

      if (!response.ok) {
        return {
          success: false,
          error: `Deezer API error: ${response.status} ${response.statusText}`,
        };
      }

      const data = await response.json();

      // Deezer returns error object for invalid requests
      if (data.error) {
        return {
          success: false,
          error: data.error.message || 'Unknown Deezer API error',
        };
      }

      return { success: true, data };
    } catch (error: any) {
      this.logger.log(`ERROR: Deezer API request failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get playlist metadata
   */
  async getPlaylist(playlistId: string): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_DEEZER_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('deezer')}] Fetching playlist from API for ${color.white.bold(playlistId)}`
        )
      );

      const result = await this.apiRequest<any>(`/playlist/${playlistId}`);

      if (!result.success || !result.data) {
        return { success: false, error: result.error || 'Failed to fetch playlist' };
      }

      const playlist = result.data;

      const providerData: ProviderPlaylistData = {
        id: playlistId,
        name: playlist.title,
        description: playlist.description || '',
        imageUrl: playlist.picture_xl || playlist.picture_big || playlist.picture_medium,
        trackCount: playlist.nb_tracks,
        serviceType: ServiceType.DEEZER,
        originalUrl: `https://www.deezer.com/playlist/${playlistId}`,
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(providerData));

      return { success: true, data: providerData };
    } catch (error: any) {
      this.logger.log(`ERROR: Deezer error fetching playlist ${playlistId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to fetch playlist',
      };
    }
  }

  /**
   * Get tracks from a Deezer playlist
   */
  async getTracks(playlistId: string): Promise<ApiResult & { data?: ProviderTracksResult }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_DEEZER_TRACKS}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('deezer')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}`
        )
      );

      // Deezer API paginates tracks, need to fetch all
      const allTracks: ProviderTrackData[] = [];
      let nextUrl: string | null = `/playlist/${playlistId}/tracks?limit=100`;
      let skippedCount = 0;

      while (nextUrl) {
        const result: { success: boolean; data?: any; error?: string } = await this.apiRequest<any>(nextUrl);

        if (!result.success || !result.data) {
          if (allTracks.length === 0) {
            return { success: false, error: result.error || 'Failed to fetch tracks' };
          }
          break;
        }

        const tracksData = result.data.data || [];

        for (const track of tracksData) {
          // Skip unavailable tracks
          if (!track.readable) {
            skippedCount++;
            continue;
          }

          allTracks.push({
            id: track.id.toString(),
            name: this.utils.cleanTrackName(track.title_short || track.title),
            artist: track.artist?.name || 'Unknown Artist',
            artistsList: [track.artist?.name || 'Unknown Artist'],
            album: this.utils.cleanTrackName(track.album?.title || ''),
            albumImageUrl: track.album?.cover_xl || track.album?.cover_big || track.album?.cover_medium,
            releaseDate: null, // Deezer doesn't provide release date in playlist tracks
            isrc: track.isrc || undefined,
            previewUrl: track.preview || null,
            duration: track.duration ? track.duration * 1000 : undefined, // Convert to ms
            serviceType: ServiceType.DEEZER,
            serviceLink: track.link || `https://www.deezer.com/track/${track.id}`,
          });
        }

        // Check for next page
        if (result.data.next) {
          // Extract path from full URL
          const nextUrlObj = new URL(result.data.next);
          nextUrl = nextUrlObj.pathname + nextUrlObj.search;
        } else {
          nextUrl = null;
        }

        // Safety limit
        if (allTracks.length >= 1000) {
          break;
        }
      }

      const trackResult: ProviderTracksResult = {
        tracks: allTracks,
        total: allTracks.length,
        skipped: {
          total: skippedCount,
          summary: {
            unavailable: skippedCount,
            localFiles: 0,
            podcasts: 0,
            duplicates: 0,
          },
          details: [],
        },
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(trackResult));

      return { success: true, data: trackResult };
    } catch (error: any) {
      this.logger.log(`ERROR: Deezer error fetching tracks for playlist ${playlistId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to fetch tracks',
      };
    }
  }

  /**
   * Search for tracks on Deezer
   */
  async searchTracks(
    query: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<ApiResult & { data?: ProviderSearchResult }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_DEEZER_SEARCH}${query}_${limit}_${offset}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      const encodedQuery = encodeURIComponent(query);
      const result = await this.apiRequest<any>(`/search/track?q=${encodedQuery}&limit=${limit}&index=${offset}`);

      if (!result.success || !result.data) {
        return { success: false, error: result.error || 'Failed to search tracks' };
      }

      const tracks: ProviderTrackData[] = (result.data.data || []).map((track: any) => ({
        id: track.id.toString(),
        name: this.utils.cleanTrackName(track.title_short || track.title),
        artist: track.artist?.name || 'Unknown Artist',
        artistsList: [track.artist?.name || 'Unknown Artist'],
        album: this.utils.cleanTrackName(track.album?.title || ''),
        albumImageUrl: track.album?.cover_xl || track.album?.cover_big || track.album?.cover_medium,
        releaseDate: null,
        isrc: track.isrc || undefined,
        previewUrl: track.preview || null,
        duration: track.duration ? track.duration * 1000 : undefined,
        serviceType: ServiceType.DEEZER,
        serviceLink: track.link || `https://www.deezer.com/track/${track.id}`,
      }));

      const searchResult: ProviderSearchResult = {
        tracks,
        total: result.data.total || tracks.length,
        hasMore: result.data.next !== undefined,
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(searchResult), CACHE_TTL_SEARCH);

      return { success: true, data: searchResult };
    } catch (error: any) {
      this.logger.log(`ERROR: Deezer error searching for "${query}": ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to search tracks',
      };
    }
  }

  // OAuth methods not supported (Deezer no longer accepts new apps)
  getAuthorizationUrl(): string | null {
    return null;
  }

  async handleAuthCallback(_code: string): Promise<ApiResult & { data?: { accessToken: string } }> {
    return {
      success: false,
      error: 'OAuth not supported for Deezer (new applications no longer accepted).',
    };
  }
}

export default DeezerProvider;
