import { color } from 'console-log-colors';
import { ServiceType } from '../enums/ServiceType';
import {
  IMusicProvider,
  MusicProviderConfig,
  ProgressCallback,
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

// Rate limiting constants for Tidal API
// Minimum delay between requests, coordinated across all workers/nodes via Redis
const TIDAL_RATE_LIMIT_KEY = 'tidal_api';
const TIDAL_MIN_DELAY_MS = 250; // 250ms between requests (max ~4 req/sec)

// No TTL for playlist/tracks cache - matches Spotify behavior

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
   * Apply rate limiting before Tidal API calls
   * Uses Redis-based distributed rate limiting to coordinate across all workers/nodes
   * Ensures minimum delay between requests globally
   */
  private async applyRateLimit(): Promise<void> {
    await this.cache.distributedRateLimit(TIDAL_RATE_LIMIT_KEY, TIDAL_MIN_DELAY_MS);
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
    playlistId: string,
    cache: boolean = true
  ): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    // Check cache first (skip if cache=false to force refresh)
    const cacheKey = `${CACHE_KEY_TIDAL_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cache) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('tidal')}] Fetching playlist from API for ${color.white.bold(playlistId)}`
        )
      );

      // Apply rate limiting before API call
      await this.applyRateLimit();
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
      await this.cache.set(cacheKey, JSON.stringify(providerData));

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
    playlistId: string,
    cache: boolean = true,
    maxTracks?: number,
    onProgress?: ProgressCallback
  ): Promise<ApiResult & { data?: ProviderTracksResult }> {
    // Check cache first (skip if cache=false to force refresh)
    const cacheKey = `${CACHE_KEY_TIDAL_TRACKS}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cache) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('tidal')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}${maxTracks ? ` (limit: ${maxTracks})` : ''}`
        )
      );

      // Helper function for delay (rate limiting)
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      // Helper function with retry mechanism (handles both exceptions and API errors like 429)
      // Also applies Redis-based rate limiting before each API call
      const fetchWithRetry = async <T extends { success: boolean; error?: string }>(
        fn: () => Promise<T>,
        retries: number = 3,
        delayMs: number = 2000
      ): Promise<T> => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            // Apply rate limiting before each API call (coordinates across all workers/nodes)
            await this.applyRateLimit();
            const result = await fn();

            // Check for rate limit or transient errors
            if (!result.success && result.error?.includes('429')) {
              if (attempt === retries) return result;
              const backoffDelay = delayMs * attempt;
              this.logger.log(
                color.yellow.bold(
                  `[${color.white.bold('tidal')}] Rate limited (429), retry ${attempt}/${retries} after ${backoffDelay}ms`
                )
              );
              await delay(backoffDelay);
              continue;
            }

            return result;
          } catch (error: any) {
            if (attempt === retries) throw error;
            const backoffDelay = delayMs * attempt;
            this.logger.log(
              color.yellow.bold(
                `[${color.white.bold('tidal')}] Retry ${attempt}/${retries} after error: ${error.message}, waiting ${backoffDelay}ms`
              )
            );
            await delay(backoffDelay);
          }
        }
        throw new Error('Max retries exceeded');
      };

      // First, get the playlist metadata to know the total track count
      await this.applyRateLimit();
      const playlistResult = await this.tidalApi.getPlaylist(playlistId);
      const totalTracksExpected = playlistResult.data?.data?.attributes?.numberOfItems || null;

      // Interleaved approach: fetch a page of IDs, then immediately fetch their metadata
      // This provides smoother, more linear progress compared to two separate phases
      const allTracks: ProviderTrackData[] = [];
      let cursor: string | undefined = undefined;
      let hasMore = true;
      let pageCount = 0;
      const metadataBatchSize = 20;

      // Report initial progress before first API call
      if (onProgress) {
        onProgress({
          stage: 'fetching_ids',
          current: 0,
          total: totalTracksExpected,
          percentage: 1,
          message: 'progress.loading',
        });
      }

      while (hasMore) {
        // Step A: Get a page of track IDs
        const itemsResult = await fetchWithRetry(() =>
          this.tidalApi.getPlaylistItems(playlistId, 'US', cursor)
        );

        if (!itemsResult.success || !itemsResult.data) {
          if (itemsResult.needsReAuth) {
            return {
              success: false,
              error: 'Please connect your Tidal account first',
              needsReAuth: true,
            };
          }
          // If we already have some tracks, continue with what we have
          if (allTracks.length > 0) {
            this.logger.log(color.yellow(`[tidal] Partial fetch: got ${allTracks.length} tracks before error`));
            break;
          }
          return { success: false, error: itemsResult.error || 'Failed to fetch tracks' };
        }

        const items = itemsResult.data.data || [];
        const pageTrackIds: string[] = [];
        for (const item of items) {
          if (item.type === 'tracks') {
            pageTrackIds.push(item.id);
          }
        }

        pageCount++;

        // Step B: Immediately fetch metadata for this page's tracks (in batches of 20)
        for (let i = 0; i < pageTrackIds.length; i += metadataBatchSize) {
          const batchIds = pageTrackIds.slice(i, i + metadataBatchSize);

          const tracksResult = await fetchWithRetry(() =>
            this.tidalApi.getTracks(batchIds)
          );

          if (tracksResult.success && tracksResult.data) {
            const trackData = tracksResult.data.data || [];
            const included = tracksResult.data.included || [];

            const albumsMap = new Map<string, any>();
            const artistsMap = new Map<string, any>();

            for (const inc of included) {
              if (inc.type === 'albums') albumsMap.set(inc.id, inc);
              else if (inc.type === 'artists') artistsMap.set(inc.id, inc);
            }

            // Create a map for quick lookup to preserve order
            const fetchedTracksMap = new Map<string, ProviderTrackData>();
            for (const track of trackData) {
              const attrs = track.attributes || {};
              const albumRel = track.relationships?.albums?.data?.[0];
              const album = albumRel ? albumsMap.get(albumRel.id) : null;
              const albumAttrs = album?.attributes || {};
              const artistRel = track.relationships?.artists?.data?.[0];
              const artist = artistRel ? artistsMap.get(artistRel.id) : null;
              const artistName = artist?.attributes?.name || 'Unknown Artist';

              const artistsList: string[] = [];
              for (const ar of track.relationships?.artists?.data || []) {
                const a = artistsMap.get(ar.id);
                if (a?.attributes?.name) artistsList.push(a.attributes.name);
              }

              fetchedTracksMap.set(track.id, {
                id: track.id,
                name: this.utils.cleanTrackName(attrs.title || 'Unknown'),
                artist: artistName,
                artistsList: artistsList.length > 0 ? artistsList : [artistName],
                album: this.utils.cleanTrackName(albumAttrs.title || ''),
                albumImageUrl: this.getImageUrl(albumAttrs.cover),
                releaseDate: albumAttrs.releaseDate || null,
                isrc: attrs.isrc || undefined,
                previewUrl: null,
                duration: attrs.duration ? attrs.duration * 1000 : undefined,
                serviceType: ServiceType.TIDAL,
                serviceLink: `https://tidal.com/browse/track/${track.id}`,
              });
            }

            // Add tracks in order, with placeholders for any that weren't found
            for (const trackId of batchIds) {
              const trackData = fetchedTracksMap.get(trackId);
              if (trackData) {
                allTracks.push(trackData);
              } else {
                // Placeholder for unavailable track
                allTracks.push({
                  id: trackId,
                  name: '',
                  artist: '',
                  artistsList: [],
                  album: '',
                  albumImageUrl: null,
                  releaseDate: null,
                  isrc: undefined,
                  previewUrl: null,
                  duration: undefined,
                  serviceType: ServiceType.TIDAL,
                  serviceLink: `https://tidal.com/browse/track/${trackId}`,
                });
              }
            }
          }

          // Report progress using linear calculation when total is known
          if (onProgress) {
            let percentage: number;
            if (totalTracksExpected && totalTracksExpected > 0) {
              // Linear progress based on known total
              percentage = Math.min(99, Math.round((allTracks.length / totalTracksExpected) * 100));
            } else {
              // Fallback to log scale if total unknown
              percentage = Math.min(95, Math.round(50 * Math.log10(allTracks.length + 10) - 25));
            }
            onProgress({
              stage: 'fetching_metadata',
              current: allTracks.length,
              total: totalTracksExpected,
              percentage: Math.max(1, percentage),
              message: 'progress.loaded',
            });
          }

          // Small delay between metadata batches
          if (i + metadataBatchSize < pageTrackIds.length) await delay(200);
        }

        // Check for next page
        const nextCursor = itemsResult.data.links?.meta?.nextCursor;
        hasMore = !!nextCursor && items.length > 0;
        cursor = nextCursor;

        // Check limits
        if (maxTracks && allTracks.length >= maxTracks) {
          allTracks.splice(maxTracks);
          hasMore = false;
        }
        if (allTracks.length >= 3000 || pageCount >= 200) {
          hasMore = false;
        }

        // Delay between pages
        if (hasMore) await delay(300);
      }

      const tracks = allTracks;

      const result: ProviderTracksResult = {
        tracks,
        total: tracks.length,
        skipped: {
          total: 0,
          summary: {
            unavailable: 0,
            localFiles: 0,
            podcasts: 0,
            duplicates: 0,
          },
          details: [],
        },
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(result));

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
