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
import TidalApi from '../tidal_api';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';

// Cache key prefixes for Tidal
const CACHE_KEY_TIDAL_PLAYLIST = 'tidal_playlist_';
const CACHE_KEY_TIDAL_TRACKS = 'tidal_tracks_';

// Cache TTL in seconds
const CACHE_TTL_PLAYLIST = 3600; // 1 hour
const CACHE_TTL_TRACKS = 3600; // 1 hour

/**
 * Tidal provider implementing the IMusicProvider interface.
 * Uses Tidal's official API via OAuth 2.0 + PKCE.
 *
 * Features:
 * - OAuth authentication required for playlist access
 * - Provides ISRC codes for tracks
 * - Provides release year from album data
 */
class TidalProvider implements IMusicProvider {
  private static instance: TidalProvider;
  private tidalApi = TidalApi.getInstance();
  private cache = Cache.getInstance();
  private logger = new Logger();
  private utils = new Utils();

  readonly serviceType = ServiceType.TIDAL;

  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.TIDAL,
    displayName: 'Tidal',
    supportsOAuth: true,
    supportsPublicPlaylists: false, // Requires OAuth for all playlists
    supportsSearch: false, // Not implemented yet
    supportsPlaylistCreation: false, // Tidal API doesn't support this yet
    brandColor: '#000000',
    iconClass: 'fa-music', // Tidal doesn't have a FontAwesome icon
  };

  /**
   * URL patterns for Tidal
   * Tidal playlist IDs are UUIDs (36 characters with dashes)
   */
  private readonly urlPatterns = {
    // https://tidal.com/browse/playlist/uuid
    tidalBrowsePlaylist:
      /^https?:\/\/tidal\.com\/browse\/playlist\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    // https://tidal.com/playlist/uuid (without browse)
    tidalDirectPlaylist:
      /^https?:\/\/tidal\.com\/playlist\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    // https://listen.tidal.com/playlist/uuid
    tidalListenPlaylist:
      /^https?:\/\/listen\.tidal\.com\/playlist\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    // tidal://playlist/uuid (URI scheme)
    tidalUri:
      /^tidal:\/\/playlist\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    // Any Tidal URL
    anyTidalUrl: /^https?:\/\/(listen\.)?tidal\.com\//i,
    // Bare UUID (just the playlist ID)
    bareUuid: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  };

  public static getInstance(): TidalProvider {
    if (!TidalProvider.instance) {
      TidalProvider.instance = new TidalProvider();
    }
    return TidalProvider.instance;
  }

  /**
   * Validate a URL and determine if it's a valid Tidal playlist URL
   */
  validateUrl(url: string): UrlValidationResult {
    const trimmedUrl = url.trim();

    // Check Tidal browse playlist URL
    const browseMatch = trimmedUrl.match(this.urlPatterns.tidalBrowsePlaylist);
    if (browseMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: browseMatch[1],
      };
    }

    // Check Tidal direct playlist URL (without browse)
    const directMatch = trimmedUrl.match(this.urlPatterns.tidalDirectPlaylist);
    if (directMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: directMatch[1],
      };
    }

    // Check Tidal listen playlist URL
    const listenMatch = trimmedUrl.match(this.urlPatterns.tidalListenPlaylist);
    if (listenMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: listenMatch[1],
      };
    }

    // Check Tidal URI scheme
    const uriMatch = trimmedUrl.match(this.urlPatterns.tidalUri);
    if (uriMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: uriMatch[1],
      };
    }

    // Check bare UUID
    const uuidMatch = trimmedUrl.match(this.urlPatterns.bareUuid);
    if (uuidMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: trimmedUrl,
      };
    }

    // Check if it's a Tidal URL but not a playlist
    if (this.urlPatterns.anyTidalUrl.test(trimmedUrl)) {
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
   * Extract playlist ID from a Tidal URL
   */
  extractPlaylistId(url: string): string | null {
    const validation = this.validateUrl(url);
    if (validation.isValid && validation.resourceId) {
      return validation.resourceId;
    }
    return null;
  }

  /**
   * Get the best quality image URL from Tidal image data
   */
  private getImageUrl(imageId: string | null, width: number = 640): string | null {
    if (!imageId) return null;
    // Tidal image URL format
    const formattedId = imageId.replace(/-/g, '/');
    return `https://resources.tidal.com/images/${formattedId}/${width}x${width}.jpg`;
  }

  /**
   * Get playlist metadata
   */
  async getPlaylist(
    playlistId: string
  ): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_TIDAL_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('tidal')}] Fetching playlist from API for ${color.white.bold(playlistId)}`
        )
      );

      const result = await this.tidalApi.getPlaylist(playlistId);

      if (!result.success || !result.data) {
        if (result.needsReAuth) {
          return {
            success: false,
            error: 'Please connect your Tidal account first',
            needsReAuth: true,
          };
        }
        return { success: false, error: result.error || 'Failed to fetch playlist' };
      }

      const playlist = result.data.data;
      const attributes = playlist.attributes || {};

      const providerData: ProviderPlaylistData = {
        id: playlistId,
        name: attributes.name || 'Untitled Playlist',
        description: attributes.description || '',
        imageUrl: this.getImageUrl(attributes.squareImage),
        trackCount: attributes.numberOfItems || 0,
        serviceType: ServiceType.TIDAL,
        originalUrl: `https://tidal.com/browse/playlist/${playlistId}`,
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(providerData), CACHE_TTL_PLAYLIST);

      return { success: true, data: providerData };
    } catch (error: any) {
      this.logger.log(`ERROR: Tidal error fetching playlist ${playlistId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to fetch playlist',
      };
    }
  }

  /**
   * Get tracks from a Tidal playlist
   */
  async getTracks(
    playlistId: string
  ): Promise<ApiResult & { data?: ProviderTracksResult }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_TIDAL_TRACKS}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('tidal')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}`
        )
      );

      // First get playlist items (track references)
      const allTrackIds: string[] = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const itemsResult = await this.tidalApi.getPlaylistItems(playlistId, limit, offset);

        if (!itemsResult.success || !itemsResult.data) {
          if (itemsResult.needsReAuth) {
            return {
              success: false,
              error: 'Please connect your Tidal account first',
              needsReAuth: true,
            };
          }
          return { success: false, error: itemsResult.error || 'Failed to fetch tracks' };
        }

        const items = itemsResult.data.data || [];
        for (const item of items) {
          if (item.type === 'tracks') {
            allTrackIds.push(item.id);
          }
        }

        // Check if there are more items
        const meta = itemsResult.data.meta;
        hasMore = meta && offset + items.length < meta.total;
        offset += limit;

        // Safety limit to prevent infinite loops
        if (allTrackIds.length >= 1000) {
          hasMore = false;
        }
      }

      // Now fetch track details in batches
      const tracks: ProviderTrackData[] = [];
      const batchSize = 50; // Tidal API limit

      for (let i = 0; i < allTrackIds.length; i += batchSize) {
        const batchIds = allTrackIds.slice(i, i + batchSize);
        const tracksResult = await this.tidalApi.getTracks(batchIds);

        if (tracksResult.success && tracksResult.data) {
          const trackData = tracksResult.data.data || [];
          const included = tracksResult.data.included || [];

          // Create lookup maps for albums and artists from included data
          const albumsMap = new Map<string, any>();
          const artistsMap = new Map<string, any>();

          for (const inc of included) {
            if (inc.type === 'albums') {
              albumsMap.set(inc.id, inc);
            } else if (inc.type === 'artists') {
              artistsMap.set(inc.id, inc);
            }
          }

          for (const track of trackData) {
            const attrs = track.attributes || {};

            // Get album info
            const albumRel = track.relationships?.albums?.data?.[0];
            const album = albumRel ? albumsMap.get(albumRel.id) : null;
            const albumAttrs = album?.attributes || {};

            // Get artist info
            const artistRel = track.relationships?.artists?.data?.[0];
            const artist = artistRel ? artistsMap.get(artistRel.id) : null;
            const artistName = artist?.attributes?.name || 'Unknown Artist';

            // Get all artists for artistsList
            const artistsList: string[] = [];
            const artistRels = track.relationships?.artists?.data || [];
            for (const ar of artistRels) {
              const a = artistsMap.get(ar.id);
              if (a?.attributes?.name) {
                artistsList.push(a.attributes.name);
              }
            }

            // Extract release date and year
            let releaseDate = albumAttrs.releaseDate || null;

            tracks.push({
              id: track.id,
              name: this.utils.cleanTrackName(attrs.title || 'Unknown'),
              artist: artistName,
              artistsList: artistsList.length > 0 ? artistsList : [artistName],
              album: this.utils.cleanTrackName(albumAttrs.title || ''),
              albumImageUrl: this.getImageUrl(albumAttrs.cover),
              releaseDate: releaseDate,
              isrc: attrs.isrc || undefined,
              previewUrl: null, // Tidal doesn't provide preview URLs via API
              duration: attrs.duration ? attrs.duration * 1000 : undefined, // Convert to ms
              serviceType: ServiceType.TIDAL,
              serviceLink: `https://tidal.com/browse/track/${track.id}`,
            });
          }
        }
      }

      const result: ProviderTracksResult = {
        tracks,
        total: tracks.length,
        skipped: {
          total: allTrackIds.length - tracks.length,
          summary: {
            unavailable: allTrackIds.length - tracks.length,
            localFiles: 0,
            podcasts: 0,
            duplicates: 0,
          },
          details: [],
        },
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_TRACKS);

      return { success: true, data: result };
    } catch (error: any) {
      this.logger.log(
        `ERROR: Tidal error fetching tracks for playlist ${playlistId}: ${error.message}`
      );
      return {
        success: false,
        error: error.message || 'Failed to fetch tracks',
      };
    }
  }

  /**
   * Get OAuth authorization URL
   */
  getAuthorizationUrl(): string | null {
    return this.tidalApi.getAuthorizationUrl();
  }

  /**
   * Handle OAuth callback
   */
  async handleAuthCallback(
    code: string
  ): Promise<ApiResult & { data?: { accessToken: string } }> {
    const result = await this.tidalApi.exchangeCodeForToken(code);

    if (result.success) {
      return {
        success: true,
        data: { accessToken: 'stored' }, // Token is stored internally
      };
    }

    return {
      success: false,
      error: result.error || 'Failed to authenticate with Tidal',
    };
  }

  /**
   * Check if connected to Tidal
   */
  async isConnected(): Promise<boolean> {
    return this.tidalApi.isConnected();
  }

  /**
   * Disconnect from Tidal (clear tokens)
   */
  async disconnect(): Promise<void> {
    await this.tidalApi.clearTokens();
  }
}

export default TidalProvider;
