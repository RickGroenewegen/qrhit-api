import { color } from 'console-log-colors';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { ServiceType } from '../enums/ServiceType';
import {
  IMusicProvider,
  MusicProviderConfig,
  GetTracksOptions,
  ProviderPlaylistData,
  ProviderSearchResult,
  ProviderTrackData,
  ProviderTracksResult,
  UrlValidationResult,
} from '../interfaces/IMusicProvider';
import { applyDuplicateFilter } from './trackDedupe';
import { ApiResult } from '../interfaces/ApiResult';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';
import Translation from '../translation';
import { MAX_CARDS } from '../config/constants';
import { isUrlOnHosts, SHORTLINK_HOSTS } from '../shortlinks';

// Apple Music API base URL
const APPLE_MUSIC_API_BASE = 'https://api.music.apple.com/v1';

// Cache key prefixes for Apple Music
const CACHE_KEY_APPLE_MUSIC_PLAYLIST = 'apple_music_playlist_';
const CACHE_KEY_APPLE_MUSIC_TRACKS = 'apple_music_tracks_';
const CACHE_KEY_APPLE_MUSIC_SEARCH = 'apple_music_search_';
const CACHE_TTL_SEARCH = 3600; // 1 hour

// Developer token (MusicKit JWT) generated from the .p8 key.
// The JWT is valid for up to 180 days (Apple's max); we cache it for 30 days
// so it is always regenerated well before it can expire.
const CACHE_KEY_APPLE_MUSIC_TOKEN = 'apple_music_developer_token';
const APPLE_MUSIC_TOKEN_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const APPLE_MUSIC_TOKEN_EXPIRY = 180 * 24 * 60 * 60; // 180 days in seconds (Apple max)

// No TTL for playlist/tracks cache - matches Spotify behavior

// Map frontend locale codes to Apple Music storefront country codes
const LOCALE_TO_STOREFRONT = Translation.LOCALE_STOREFRONTS;
const DEFAULT_STOREFRONT = 'nl';

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
  private developerTokenExpiry = 0; // epoch seconds; 0 = unknown

  readonly serviceType = ServiceType.APPLE_MUSIC;

  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.APPLE_MUSIC,
    displayName: 'Apple Music',
    supportsOAuth: false, // We use Developer Token, not user OAuth
    supportsPublicPlaylists: true,
    supportsSearch: true,
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
   * Get the Developer Token (MusicKit JWT) for the Apple Music API.
   *
   * The token is generated on demand from the `apple_music.p8` private key and
   * cached in Redis (shared with the `GET /apple-music/token` route) so it is
   * regenerated automatically long before it can expire. A static
   * `APPLE_MUSIC_DEVELOPER_TOKEN` env var is only used as a last-resort fallback
   * when the key file / config is missing.
   */
  public async getDeveloperToken(): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);
    const buffer = 24 * 60 * 60; // refresh a day before expiry

    // 1. In-memory memo (only trust it while comfortably valid)
    if (this.developerToken && this.developerTokenExpiry > now + buffer) {
      return this.developerToken;
    }

    // 2. Shared Redis cache (populated here or by the /apple-music/token route)
    const cached = await this.cache.get(CACHE_KEY_APPLE_MUSIC_TOKEN);
    if (cached) {
      const exp = this.decodeTokenExpiry(cached);
      if (exp > now + buffer) {
        this.developerToken = cached;
        this.developerTokenExpiry = exp;
        return cached;
      }
    }

    // 3. Generate a fresh JWT from the .p8 key
    const generated = this.generateDeveloperToken();
    if (generated) {
      this.developerToken = generated;
      this.developerTokenExpiry = this.decodeTokenExpiry(generated);
      await this.cache.set(
        CACHE_KEY_APPLE_MUSIC_TOKEN,
        generated,
        APPLE_MUSIC_TOKEN_CACHE_TTL
      );
      return generated;
    }

    // 4. Last-resort fallback: legacy static env var
    return process.env['APPLE_MUSIC_DEVELOPER_TOKEN'] || null;
  }

  /**
   * Sign a new Apple Music developer token (ES256 JWT) from the .p8 key.
   * Returns null if the key file or Team ID / Key ID are not configured.
   */
  private generateDeveloperToken(): string | null {
    try {
      const keyPath = path.join(
        process.env['APP_ROOT'] || '',
        '..',
        'apple_music.p8'
      );
      const teamId = process.env['APPLE_MUSIC_TEAM_ID'];
      const keyId = process.env['APPLE_MUSIC_KEY_ID'];

      if (!fs.existsSync(keyPath) || !teamId || !keyId) {
        this.logger.log(
          color.red.bold(
            `[${color.white.bold('apple_music')}] Cannot generate developer token: missing key file or Team ID / Key ID`
          )
        );
        return null;
      }

      const privateKey = fs.readFileSync(keyPath, 'utf8');
      const token = jwt.sign({}, privateKey, {
        algorithm: 'ES256',
        expiresIn: APPLE_MUSIC_TOKEN_EXPIRY,
        issuer: teamId,
        header: { alg: 'ES256', kid: keyId },
      });

      this.logger.log(
        color.green.bold(
          `[${color.white.bold('apple_music')}] Generated a fresh developer token`
        )
      );
      return token;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `[${color.white.bold('apple_music')}] Failed to generate developer token: ${color.white.bold(error.message)}`
        )
      );
      return null;
    }
  }

  /**
   * Decode a JWT's `exp` claim (epoch seconds) without verifying the signature.
   * Returns 0 if it cannot be parsed.
   */
  private decodeTokenExpiry(token: string): number {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return 0;
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64').toString('utf8')
      );
      return typeof payload.exp === 'number' ? payload.exp : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Map a frontend locale code to an Apple Music storefront code
   */
  public getStorefrontForLocale(locale?: string): string {
    if (!locale) return DEFAULT_STOREFRONT;
    return LOCALE_TO_STOREFRONT[locale.toLowerCase()] || DEFAULT_STOREFRONT;
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
   * Make a request to the Apple Music API. `quiet404` keeps a 404 out of the
   * log for callers that expect one (the storefront resolver's id lookups).
   */
  private async apiRequest<T>(
    endpoint: string,
    storefront: string = DEFAULT_STOREFRONT,
    { quiet404 = false }: { quiet404?: boolean } = {}
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const token = await this.getDeveloperToken();
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
        if (!(quiet404 && response.status === 404)) {
          const body = await response.text().catch(() => '');
          this.logger.log(
            color.red.bold(
              `[${color.white.bold('apple_music')}] API error ${color.white.bold(String(response.status))} ${color.white.bold(response.statusText)} for ${color.white.bold(url)} body: ${color.white.bold(body.slice(0, 500))}`
            )
          );
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
    storefront: string = DEFAULT_STOREFRONT,
    cache: boolean = true
  ): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    // Check cache first (skip if cache=false to force refresh)
    const cacheKey = `${CACHE_KEY_APPLE_MUSIC_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cache) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('apple_music')}] Fetching playlist from API for ${color.white.bold(playlistId)} (storefront: ${color.white.bold(storefront)})`
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
      await this.cache.set(cacheKey, JSON.stringify(providerData));

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
    options: GetTracksOptions = {}
  ): Promise<ApiResult & { data?: ProviderTracksResult }> {
    const {
      cache = true,
      onProgress,
      allowDuplicates = false,
      storefront = DEFAULT_STOREFRONT,
    } = options;
    // Check cache first (skip if cache=false to force refresh)
    // Storefront stays in the key because it changes WHICH tracks come back.
    // The duplicate filter does not — the cache holds the complete list and the
    // filter is applied on the way out, so one entry serves both variants.
    const cacheKey = `${CACHE_KEY_APPLE_MUSIC_TRACKS}${storefront}_${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cache) {
      return {
        success: true,
        data: applyDuplicateFilter(JSON.parse(cached), allowDuplicates),
      };
    }

    try {
      // First, get the playlist to know the total track count and name
      const playlistResult = await this.apiRequest<any>(`/playlists/${playlistId}`, storefront);
      const totalTracksExpected = playlistResult.data?.data?.[0]?.attributes?.trackCount || null;
      const playlistName = playlistResult.data?.data?.[0]?.attributes?.name || null;

      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('apple_music')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}${playlistName ? ` (${color.white.bold(playlistName)})` : ''} (storefront: ${color.white.bold(storefront)})`
        )
      );

      // Fetch playlist with tracks included
      const allTracks: ProviderTrackData[] = [];
      let nextUrl: string | null = `/playlists/${playlistId}/tracks?limit=100`;
      let skippedCount = 0;

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

        // Report progress using linear calculation when total is known
        if (onProgress) {
          let percentage: number;
          if (totalTracksExpected && totalTracksExpected > 0) {
            percentage = Math.min(99, Math.round((allTracks.length / totalTracksExpected) * 100));
          } else {
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

        // Check for next page
        if (result.data.next) {
          // Apple Music returns next URLs in format: /v1/catalog/{storefront}/playlists/...
          // We need to extract just the endpoint part after /catalog/{storefront}
          const nextUrlStr = result.data.next;
          const catalogPrefix = `/v1/catalog/${storefront}`;
          if (nextUrlStr.startsWith(catalogPrefix)) {
            nextUrl = nextUrlStr.substring(catalogPrefix.length);
          } else if (nextUrlStr.startsWith(APPLE_MUSIC_API_BASE)) {
            // Handle full URL format just in case
            nextUrl = nextUrlStr.replace(APPLE_MUSIC_API_BASE + '/catalog/' + storefront, '');
          } else {
            // Assume it's already in the correct format
            nextUrl = nextUrlStr;
          }
        } else {
          nextUrl = null;
        }

        // Safety limit to prevent infinite loops
        if (allTracks.length >= MAX_CARDS) {
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

      // Cache the complete list, then filter on the way out.
      await this.cache.set(cacheKey, JSON.stringify(trackResult));

      return {
        success: true,
        data: applyDuplicateFilter(trackResult, allowDuplicates),
      };
    } catch (error: any) {
      this.logger.log(`ERROR: Apple Music error fetching tracks for playlist ${playlistId}: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to fetch tracks',
      };
    }
  }

  /**
   * Search for tracks on Apple Music
   */
  async searchTracks(
    query: string,
    limit: number = 20,
    offset: number = 0,
    storefront: string = DEFAULT_STOREFRONT
  ): Promise<ApiResult & { data?: ProviderSearchResult }> {
    const cacheKey = `${CACHE_KEY_APPLE_MUSIC_SEARCH}${storefront}_${query}_${limit}_${offset}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      const encodedQuery = encodeURIComponent(query);
      const result = await this.apiRequest<any>(
        `/search?term=${encodedQuery}&types=songs&limit=${limit}&offset=${offset}`,
        storefront
      );

      if (!result.success || !result.data) {
        return { success: false, error: result.error || 'Failed to search tracks' };
      }

      const songsData = result.data.results?.songs?.data || [];

      const tracks: ProviderTrackData[] = songsData.map((track: any) => {
        const attributes = track.attributes || {};
        const artwork = attributes.artwork;
        return {
          id: track.id,
          name: this.utils.cleanTrackName(attributes.name || 'Unknown'),
          artist: attributes.artistName || 'Unknown Artist',
          artistsList: [attributes.artistName || 'Unknown Artist'],
          album: this.utils.cleanTrackName(attributes.albumName || ''),
          albumImageUrl: artwork
            ? artwork.url.replace('{w}', '300').replace('{h}', '300')
            : null,
          releaseDate: attributes.releaseDate || null,
          isrc: attributes.isrc || undefined,
          previewUrl: attributes.previews?.[0]?.url || null,
          duration: attributes.durationInMillis || undefined,
          serviceType: ServiceType.APPLE_MUSIC,
          serviceLink: attributes.url || `https://music.apple.com/${storefront}/song/${track.id}`,
        };
      });

      const searchResult: ProviderSearchResult = {
        tracks,
        total: result.data.results?.songs?.total || tracks.length,
        hasMore: result.data.results?.songs?.next !== undefined,
      };

      await this.cache.set(cacheKey, JSON.stringify(searchResult), CACHE_TTL_SEARCH);

      return { success: true, data: searchResult };
    } catch (error: any) {
      this.logger.log(`ERROR: Apple Music error searching for "${query}": ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to search tracks',
      };
    }
  }

  /**
   * Resolve an Apple Music shortlink to its full URL
   */
  async resolveShortlink(url: string): Promise<ApiResult & { data?: { resolvedUrl: string } }> {
    if (!isUrlOnHosts(url, SHORTLINK_HOSTS.appleMusic)) {
      return { success: false, error: 'Not an Apple Music shortlink' };
    }

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

  /**
   * Resolve an Apple Music song link to a song that can be streamed in the
   * given storefront. Returns the original link when nothing better is found.
   *
   * Apple removes catalog ids (a label re-issues an album) and lists songs a
   * storefront cannot stream (no `playParams`), so a link is only kept when
   * Apple says it streams there, even when the storefront already matches.
   * Otherwise the song is found again by ISRC. The caller passes the ISRC we
   * store when it has one: a removed id no longer tells Apple's API its ISRC.
   */
  async resolveSongToStorefront(
    appleMusicLink: string,
    storefront: string,
    knownIsrc?: string | null
  ): Promise<string> {
    // Extract storefront and song ID from the link
    // Formats:
    //   .../{cc}/song/{name}/{id}
    //   .../{cc}/album/{name}/{albumId}?i={songId}  (song ID is in the query param)
    //   .../song/{id}  (summary-page cards: only the track id is known there)
    const match = appleMusicLink.match(/music\.apple\.com\/(?:([a-z]{2})\/)?(?:song|album)\/(?:[^/]+\/)?(\d+)/i);
    if (!match) return appleMusicLink;

    const [, linkStorefront, pathId] = match;
    const originalStorefront = linkStorefront || DEFAULT_STOREFRONT;

    // If ?i= param exists, that's the actual song ID; the path ID is the album
    const iParam = appleMusicLink.match(/[?&]i=(\d+)/);
    const songId = iParam ? iParam[1] : pathId;

    // am_sf2: the entries of the resolver before playParams was checked can
    // point at songs a storefront cannot stream.
    const cacheKey = `am_sf2:${songId}:${storefront}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    // A miss is remembered for an hour so a dead link costs Apple calls once,
    // not on every scan. Keyed on the ISRC too: a later call that brings one
    // may still succeed.
    const missKey = `am_sf_miss:${songId}:${storefront}:${knownIsrc || '-'}`;
    if (await this.cache.get(missKey)) return appleMusicLink;

    // Step 1: the song id itself, if the target storefront can stream it
    // (catalog ids are mostly global). The id lookups here expect a 404 when
    // a region has its own ids for an album, so they do not log it; the
    // "resolve failed" line below reports a song that really cannot play.
    const directResult = await this.apiRequest<any>(`/songs/${songId}`, storefront, { quiet404: true });
    const direct = directResult.data?.data?.[0]?.attributes;

    if (directResult.success && direct?.url && direct.playParams) {
      // A link already in this storefront (and parseable) is kept as it is
      const resolvedUrl = linkStorefront === storefront ? appleMusicLink : direct.url;
      if (resolvedUrl !== appleMusicLink) {
        this.logger.log(
          color.green.bold(
            `[${color.white.bold('apple_music')}] Storefront resolved ${color.white.bold(originalStorefront)} → ${color.white.bold(storefront)}: ${color.white.bold(appleMusicLink)} → ${color.white.bold(resolvedUrl)}`
          )
        );
      }
      await this.cache.set(cacheKey, resolvedUrl, 86400);
      return resolvedUrl;
    }

    // Step 2: the ISRC. Ours when the caller has it, otherwise Apple's for
    // this id (the link's storefront, then the default one).
    let isrc = knownIsrc || null;
    if (!isrc) {
      const originalResult = await this.apiRequest<any>(`/songs/${songId}`, originalStorefront, { quiet404: true });
      isrc = originalResult.data?.data?.[0]?.attributes?.isrc || null;
    }
    if (!isrc && originalStorefront !== DEFAULT_STOREFRONT) {
      const fallbackResult = await this.apiRequest<any>(`/songs/${songId}`, DEFAULT_STOREFRONT, { quiet404: true });
      isrc = fallbackResult.data?.data?.[0]?.attributes?.isrc || null;
    }

    // Step 3: the first version of that recording the storefront can stream
    if (isrc) {
      const isrcResult = await this.apiRequest<any>(
        `/songs?filter[isrc]=${encodeURIComponent(isrc)}`,
        storefront
      );
      const streamable = (isrcResult.data?.data || []).find(
        (song: any) => song.attributes?.url && song.attributes?.playParams
      );
      if (isrcResult.success && streamable) {
        const resolvedUrl = streamable.attributes.url;
        this.logger.log(
          color.green.bold(
            `[${color.white.bold('apple_music')}] Storefront resolved ${color.white.bold(originalStorefront)} → ${color.white.bold(storefront)} via ISRC: ${color.white.bold(appleMusicLink)} → ${color.white.bold(resolvedUrl)}`
          )
        );
        await this.cache.set(cacheKey, resolvedUrl, 86400);
        return resolvedUrl;
      }
    }

    this.logger.log(
      color.yellow.bold(
        `[${color.white.bold('apple_music')}] Storefront resolve failed: song ${color.white.bold(songId)} ${
          isrc ? `(ISRC ${color.white.bold(isrc)}) ` : ''
        }cannot be streamed in ${color.white.bold(storefront)}`
      )
    );
    await this.cache.set(missKey, '1', 3600);
    return appleMusicLink;
  }
}

export default AppleMusicProvider;
