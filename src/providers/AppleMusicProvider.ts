import { color } from 'console-log-colors';
import { ServiceType } from '../enums/ServiceType';
import {
  IMusicProvider,
  MusicProviderConfig,
  ProviderPlaylistData,
  ProviderTrackData,
  ProviderTracksResult,
  UrlValidationResult,
} from '../interfaces/IMusicProvider';
import { ApiResult } from '../interfaces/ApiResult';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';

// Apple Music API base URL
const APPLE_MUSIC_API_BASE = 'https://api.music.apple.com/v1';

// Cache key prefixes for Apple Music
const CACHE_KEY_APPLE_MUSIC_PLAYLIST = 'apple_music_playlist_';
const CACHE_KEY_APPLE_MUSIC_TRACKS = 'apple_music_tracks_';

// Cache TTL in seconds
const CACHE_TTL_PLAYLIST = 3600; // 1 hour
const CACHE_TTL_TRACKS = 3600; // 1 hour

/**
 * Apple Music provider implementing the IMusicProvider interface.
 * Uses Apple Music API with Developer Token authentication.
 *
 * Features:
 * - Developer Token authentication (no user OAuth required for public playlists)
 * - Provides ISRC codes for tracks
 * - Provides release date information
 * - Supports shortlink resolution
 */
class AppleMusicProvider implements IMusicProvider {
  private static instance: AppleMusicProvider;
  private cache = Cache.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private developerToken: string | null = null;

  readonly serviceType = ServiceType.APPLE_MUSIC;

  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.APPLE_MUSIC,
    displayName: 'Apple Music',
    supportsOAuth: false, // We use Developer Token, not user OAuth
    supportsPublicPlaylists: true,
    supportsSearch: false, // Not implemented yet
    supportsPlaylistCreation: false,
    brandColor: '#FA243C',
    iconClass: 'fa-apple',
  };

  /**
   * URL patterns for Apple Music
   * Apple Music playlist IDs typically start with "pl."
   */
  private readonly urlPatterns = {
    // https://music.apple.com/us/playlist/playlist-name/pl.u-xxxxx
    appleMusicPlaylist: /^https?:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/[^/]+\/([a-zA-Z0-9._-]+)/i,
    // https://music.apple.com/us/playlist/pl.u-xxxxx (without name)
    appleMusicPlaylistShort: /^https?:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/(pl\.[a-zA-Z0-9_-]+)/i,
    // itms://music.apple.com/... (URI scheme)
    appleMusicUri: /^itms:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/[^/]+\/([a-zA-Z0-9._-]+)/i,
    // Shortlinks: https://music.apple.com/... shortened or https://apple.co/...
    shortlink: /^https?:\/\/(apple\.co|music\.apple\.com\/[a-z]{2}\/playlist\/[^/]*\/[^/]*\?.*)/i,
    // Any Apple Music URL
    anyAppleMusicUrl: /^https?:\/\/music\.apple\.com\//i,
    // Bare playlist ID (starts with pl.)
    barePlaylistId: /^pl\.[a-zA-Z0-9_-]+$/i,
  };

  public static getInstance(): AppleMusicProvider {
    if (!AppleMusicProvider.instance) {
      AppleMusicProvider.instance = new AppleMusicProvider();
    }
    return AppleMusicProvider.instance;
  }

  /**
   * Get the Developer Token for Apple Music API
   * The token should be set in environment variables
   */
  private getDeveloperToken(): string | null {
    if (!this.developerToken) {
      this.developerToken = process.env['APPLE_MUSIC_DEVELOPER_TOKEN'] || null;
    }
    return this.developerToken;
  }

  /**
   * Extract storefront (country code) from URL, default to 'us'
   */
  private extractStorefront(url: string): string {
    const match = url.match(/music\.apple\.com\/([a-z]{2})\//i);
    return match ? match[1].toLowerCase() : 'us';
  }

  /**
   * Validate a URL and determine if it's a valid Apple Music playlist URL
   */
  validateUrl(url: string): UrlValidationResult {
    const trimmedUrl = url.trim();

    // Check Apple Music playlist URL with name
    const playlistMatch = trimmedUrl.match(this.urlPatterns.appleMusicPlaylist);
    if (playlistMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: playlistMatch[2],
      };
    }

    // Check Apple Music playlist URL without name
    const shortMatch = trimmedUrl.match(this.urlPatterns.appleMusicPlaylistShort);
    if (shortMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: shortMatch[2],
      };
    }

    // Check Apple Music URI scheme
    const uriMatch = trimmedUrl.match(this.urlPatterns.appleMusicUri);
    if (uriMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: uriMatch[2],
      };
    }

    // Check bare playlist ID
    const bareMatch = trimmedUrl.match(this.urlPatterns.barePlaylistId);
    if (bareMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: trimmedUrl,
      };
    }

    // Check if it's an Apple Music URL but not a playlist
    if (this.urlPatterns.anyAppleMusicUrl.test(trimmedUrl)) {
      // Check if it's an album
      if (/\/album\//.test(trimmedUrl)) {
        return {
          isValid: false,
          isServiceUrl: true,
          resourceType: 'album',
          errorType: 'not_playlist',
        };
      }
      // Check if it's a track/song
      if (/\/song\//.test(trimmedUrl) || /\/music-video\//.test(trimmedUrl)) {
        return {
          isValid: false,
          isServiceUrl: true,
          resourceType: 'track',
          errorType: 'not_playlist',
        };
      }
      // Check if it's an artist
      if (/\/artist\//.test(trimmedUrl)) {
        return {
          isValid: false,
          isServiceUrl: true,
          resourceType: 'artist',
          errorType: 'not_playlist',
        };
      }
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
   * Extract playlist ID from an Apple Music URL
   */
  extractPlaylistId(url: string): string | null {
    const validation = this.validateUrl(url);
    if (validation.isValid && validation.resourceId) {
      return validation.resourceId;
    }
    return null;
  }

  /**
   * Make a request to the Apple Music API
   */
  private async apiRequest<T>(
    endpoint: string,
    storefront: string = 'us'
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const token = this.getDeveloperToken();
    if (!token) {
      return {
        success: false,
        error: 'Apple Music Developer Token not configured',
      };
    }

    try {
      const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return {
            success: false,
            error: 'Invalid or expired Apple Music Developer Token',
          };
        }
        if (response.status === 404) {
          return {
            success: false,
            error: 'Playlist not found',
          };
        }
        return {
          success: false,
          error: `Apple Music API error: ${response.status} ${response.statusText}`,
        };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error: any) {
      this.logger.log(`ERROR: Apple Music API request failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get playlist metadata
   */
  async getPlaylist(
    playlistId: string,
    storefront: string = 'us'
  ): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_APPLE_MUSIC_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('apple_music')}] Fetching playlist from API for ${color.white.bold(playlistId)}`
        )
      );

      const result = await this.apiRequest<any>(`/playlists/${playlistId}`, storefront);

      if (!result.success || !result.data) {
        return { success: false, error: result.error || 'Failed to fetch playlist' };
      }

      const playlist = result.data.data?.[0];
      if (!playlist) {
        return { success: false, error: 'Playlist not found' };
      }

      const attributes = playlist.attributes || {};
      const artwork = attributes.artwork;

      const providerData: ProviderPlaylistData = {
        id: playlistId,
        name: attributes.name || 'Untitled Playlist',
        description: attributes.description?.standard || '',
        imageUrl: artwork
          ? artwork.url.replace('{w}', '640').replace('{h}', '640')
          : null,
        trackCount: attributes.trackCount || 0,
        serviceType: ServiceType.APPLE_MUSIC,
        originalUrl: attributes.url || `https://music.apple.com/${storefront}/playlist/${playlistId}`,
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(providerData), CACHE_TTL_PLAYLIST);

      return { success: true, data: providerData };
    } catch (error: any) {
      this.logger.log(`ERROR: Apple Music error fetching playlist ${playlistId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to fetch playlist',
      };
    }
  }

  /**
   * Get tracks from an Apple Music playlist
   */
  async getTracks(
    playlistId: string,
    storefront: string = 'us'
  ): Promise<ApiResult & { data?: ProviderTracksResult }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_APPLE_MUSIC_TRACKS}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('apple_music')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}`
        )
      );

      // Fetch playlist with tracks included
      const allTracks: ProviderTrackData[] = [];
      let nextUrl: string | null = `/playlists/${playlistId}/tracks?limit=100`;
      let skippedCount = 0;

      while (nextUrl) {
        const result: { success: boolean; data?: any; error?: string } = await this.apiRequest<any>(nextUrl, storefront);

        if (!result.success || !result.data) {
          if (allTracks.length === 0) {
            return { success: false, error: result.error || 'Failed to fetch tracks' };
          }
          break;
        }

        const tracksData = result.data.data || [];

        for (const track of tracksData) {
          const attributes = track.attributes || {};

          // Skip unavailable tracks
          if (!attributes.playParams) {
            skippedCount++;
            continue;
          }

          const artwork = attributes.artwork;
          const releaseDate = attributes.releaseDate || null;

          allTracks.push({
            id: track.id,
            name: this.utils.cleanTrackName(attributes.name || 'Unknown'),
            artist: attributes.artistName || 'Unknown Artist',
            artistsList: [attributes.artistName || 'Unknown Artist'],
            album: this.utils.cleanTrackName(attributes.albumName || ''),
            albumImageUrl: artwork
              ? artwork.url.replace('{w}', '640').replace('{h}', '640')
              : null,
            releaseDate: releaseDate,
            isrc: attributes.isrc || undefined,
            previewUrl: attributes.previews?.[0]?.url || null,
            duration: attributes.durationInMillis || undefined,
            serviceType: ServiceType.APPLE_MUSIC,
            serviceLink: attributes.url || `https://music.apple.com/${storefront}/song/${track.id}`,
          });
        }

        // Check for next page
        if (result.data.next) {
          nextUrl = result.data.next.replace(APPLE_MUSIC_API_BASE + '/catalog/' + storefront, '');
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
      await this.cache.set(cacheKey, JSON.stringify(trackResult), CACHE_TTL_TRACKS);

      return { success: true, data: trackResult };
    } catch (error: any) {
      this.logger.log(`ERROR: Apple Music error fetching tracks for playlist ${playlistId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to fetch tracks',
      };
    }
  }

  /**
   * Resolve an Apple Music shortlink to its full URL
   */
  async resolveShortlink(url: string): Promise<ApiResult & { data?: { resolvedUrl: string } }> {
    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('apple_music')}] Resolving shortlink: ${color.white.bold(url)}`
        )
      );

      // Follow redirects to get the final URL
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
      });

      const resolvedUrl = response.url;

      // Validate the resolved URL is an Apple Music playlist
      const validation = this.validateUrl(resolvedUrl);
      if (validation.isServiceUrl && validation.resourceId) {
        this.logger.log(
          color.green.bold(
            `[${color.white.bold('apple_music')}] Shortlink resolved to: ${color.white.bold(resolvedUrl)}`
          )
        );
        return {
          success: true,
          data: { resolvedUrl },
        };
      }

      // Check if it resolved to an Apple Music URL but not a playlist
      if (validation.isServiceUrl && !validation.isValid) {
        return {
          success: false,
          error: 'Shortlink resolved to an Apple Music URL but not a playlist',
        };
      }

      return {
        success: false,
        error: 'Shortlink did not resolve to a valid Apple Music playlist URL',
      };
    } catch (error: any) {
      this.logger.log(`ERROR: Failed to resolve Apple Music shortlink: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to resolve shortlink',
      };
    }
  }

  // OAuth methods not applicable for Apple Music (uses Developer Token)
  getAuthorizationUrl(): string | null {
    return null;
  }

  async handleAuthCallback(_code: string): Promise<ApiResult & { data?: { accessToken: string } }> {
    return {
      success: false,
      error: 'OAuth not applicable for Apple Music. Uses Developer Token authentication.',
    };
  }
}

export default AppleMusicProvider;
