import { color } from 'console-log-colors';
import axios, { AxiosInstance } from 'axios';
import YTMusic from 'ytmusic-api';
import { ServiceType } from '../enums/ServiceType';
import {
  IMusicProvider,
  MusicProviderConfig,
  ProgressCallback,
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

// Cache key prefixes for YouTube Music
const CACHE_KEY_YT_PLAYLIST = 'yt_playlist_';
const CACHE_KEY_YT_TRACKS = 'yt_tracks_';
const CACHE_KEY_YT_SEARCH = 'yt_search_';

// Cache TTL in seconds (only for search - playlist/tracks have no expiry like Spotify)
const CACHE_TTL_SEARCH = 1800; // 30 minutes

// YouTube Music API configuration
const YT_MUSIC_API_URL = 'https://www.youtube.com/youtubei/v1/browse';
// Public innertube API key - same as embedded in YouTube Music web client
// This is intentionally public and not a secret
const YT_MUSIC_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';

/**
 * YouTube Music provider implementing the IMusicProvider interface.
 * Uses ytmusic-api for search and custom implementation for playlist fetching
 * with proper pagination support.
 *
 * Note: Radio/auto-generated playlists (IDs starting with "RD") may not work
 * without authentication cookies. Only user-created playlists are fully supported.
 */
class YouTubeMusicProvider implements IMusicProvider {
  private static instance: YouTubeMusicProvider;
  private ytmusic: YTMusic;
  private initialized: boolean = false;
  private cache = Cache.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private axiosClient: AxiosInstance;

  readonly serviceType = ServiceType.YOUTUBE_MUSIC;

  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.YOUTUBE_MUSIC,
    displayName: 'YouTube Music',
    supportsOAuth: false,
    supportsPublicPlaylists: true,
    supportsSearch: true,
    supportsPlaylistCreation: false,
    brandColor: '#FF0000',
    iconClass: 'fa-youtube',
  };

  /**
   * URL patterns for YouTube Music
   */
  private readonly urlPatterns = {
    ytMusicPlaylist: /^https?:\/\/music\.youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
    ytPlaylist: /^https?:\/\/(www\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
    ytMusicWatchWithList: /^https?:\/\/music\.youtube\.com\/watch\?.*list=([a-zA-Z0-9_-]+)/,
    ytWatchWithList: /^https?:\/\/(www\.)?youtube\.com\/watch\?.*list=([a-zA-Z0-9_-]+)/,
    anyYtMusicUrl: /^https?:\/\/music\.youtube\.com\//,
    anyYtUrl: /^https?:\/\/(www\.)?youtube\.com\//,
  };

  constructor() {
    this.ytmusic = new YTMusic();
    this.axiosClient = axios.create({
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  }

  /**
   * Check if playlist ID is a radio/auto-generated playlist
   */
  private isRadioPlaylist(playlistId: string): boolean {
    return playlistId.startsWith('RD');
  }

  /**
   * Ensure the YTMusic client is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      const cookies = process.env.YOUTUBE_MUSIC_COOKIES;
      await this.ytmusic.initialize(cookies ? { cookies } : undefined);
      this.initialized = true;
    }
  }

  /**
   * Force re-initialization of the YTMusic client (e.g., after a stale config 400 error)
   */
  private async reinitialize(): Promise<void> {
    this.initialized = false;
    this.ytmusic = new YTMusic();
    await this.ensureInitialized();
  }

  public static getInstance(): YouTubeMusicProvider {
    if (!YouTubeMusicProvider.instance) {
      YouTubeMusicProvider.instance = new YouTubeMusicProvider();
    }
    return YouTubeMusicProvider.instance;
  }

  /**
   * Validate a URL and determine if it's a valid YouTube Music playlist URL
   */
  validateUrl(url: string): UrlValidationResult {
    const trimmedUrl = url.trim();

    const ytMusicMatch = trimmedUrl.match(this.urlPatterns.ytMusicPlaylist);
    if (ytMusicMatch) {
      return { isValid: true, isServiceUrl: true, resourceType: 'playlist', resourceId: ytMusicMatch[1] };
    }

    const ytMusicWatchMatch = trimmedUrl.match(this.urlPatterns.ytMusicWatchWithList);
    if (ytMusicWatchMatch) {
      return { isValid: true, isServiceUrl: true, resourceType: 'playlist', resourceId: ytMusicWatchMatch[1] };
    }

    const ytPlaylistMatch = trimmedUrl.match(this.urlPatterns.ytPlaylist);
    if (ytPlaylistMatch) {
      return { isValid: true, isServiceUrl: true, resourceType: 'playlist', resourceId: ytPlaylistMatch[2] };
    }

    const ytWatchMatch = trimmedUrl.match(this.urlPatterns.ytWatchWithList);
    if (ytWatchMatch) {
      return { isValid: true, isServiceUrl: true, resourceType: 'playlist', resourceId: ytWatchMatch[2] };
    }

    if (this.urlPatterns.anyYtMusicUrl.test(trimmedUrl)) {
      return { isValid: false, isServiceUrl: true, errorType: 'not_playlist' };
    }

    if (this.urlPatterns.anyYtUrl.test(trimmedUrl)) {
      return { isValid: false, isServiceUrl: true, errorType: 'not_playlist' };
    }

    return { isValid: false, isServiceUrl: false };
  }

  /**
   * Extract playlist ID from a YouTube Music URL
   */
  extractPlaylistId(url: string): string | null {
    const validation = this.validateUrl(url);
    if (validation.isValid && validation.resourceId) {
      return validation.resourceId;
    }
    return null;
  }

  /**
   * Get the best quality thumbnail URL
   */
  private getBestThumbnail(thumbnails: Array<{ url: string; width: number; height: number }>): string | null {
    if (!thumbnails || thumbnails.length === 0) return null;
    const sorted = [...thumbnails].sort((a, b) => b.width - a.width);
    return sorted[0]?.url || null;
  }

  /**
   * Build the request body for YouTube Music API
   */
  private buildRequestBody(browseId?: string): any {
    const body: any = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20231219.01.00',
          hl: 'en',
          gl: 'US',
          experimentIds: [],
          experimentsToken: '',
          utcOffsetMinutes: 0,
        },
        user: { enableSafetyMode: false },
        request: { useSsl: true, internalExperimentFlags: [], consistencyTokenJars: [] },
      },
    };

    if (browseId) {
      body.browseId = browseId;
    }

    return body;
  }

  /**
   * Deep traverse an object to find a value by key
   */
  private deepFind(obj: any, key: string): any {
    if (!obj || typeof obj !== 'object') return undefined;
    if (key in obj) return obj[key];
    for (const k of Object.keys(obj)) {
      const result = this.deepFind(obj[k], key);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /**
   * Find all occurrences of a key in nested object
   */
  private deepFindAll(obj: any, key: string, results: any[] = []): any[] {
    if (!obj || typeof obj !== 'object') return results;
    if (key in obj) {
      results.push(obj[key]);
    }
    for (const k of Object.keys(obj)) {
      this.deepFindAll(obj[k], key, results);
    }
    return results;
  }

  /**
   * Extract video items from playlist response
   */
  private extractPlaylistVideos(data: any): Array<{
    videoId: string;
    title: string;
    artist: string;
    thumbnails: Array<{ url: string; width: number; height: number }>;
    duration: number | null;
  }> {
    const videos: Array<{
      videoId: string;
      title: string;
      artist: string;
      thumbnails: Array<{ url: string; width: number; height: number }>;
      duration: number | null;
    }> = [];

    const items = this.deepFindAll(data, 'musicResponsiveListItemRenderer');

    for (const item of items) {
      try {
        let videoId = item?.playlistItemData?.videoId;
        if (!videoId) {
          videoId = this.deepFind(item, 'videoId');
        }
        if (!videoId) continue;

        let title = '';
        const flexColumns = item?.flexColumns;
        if (flexColumns && Array.isArray(flexColumns) && flexColumns.length > 0) {
          const titleRuns = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
          if (titleRuns && Array.isArray(titleRuns) && titleRuns.length > 0) {
            title = titleRuns[0]?.text || '';
          }
        }

        let artist = 'Unknown Artist';
        if (flexColumns && Array.isArray(flexColumns) && flexColumns.length > 1) {
          const artistRuns = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
          if (artistRuns && Array.isArray(artistRuns)) {
            const artistNames = artistRuns
              .filter((run: any) => run?.text && run.text !== ' • ' && !run.text.includes(':'))
              .map((run: any) => run.text);
            if (artistNames.length > 0) {
              artist = artistNames[0];
            }
          }
        }

        const thumbnails = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

        let duration: number | null = null;
        const fixedColumns = item?.fixedColumns;
        if (fixedColumns && Array.isArray(fixedColumns) && fixedColumns.length > 0) {
          const durationText = fixedColumns[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text;
          if (durationText) {
            const parts = durationText.split(':').map(Number);
            if (parts.length === 2) {
              duration = parts[0] * 60 + parts[1];
            } else if (parts.length === 3) {
              duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
          }
        }

        videos.push({ videoId, title, artist, thumbnails, duration });
      } catch (e) {
        continue;
      }
    }

    return videos;
  }

  /**
   * Extract continuation data from response (supports 2025 and legacy formats)
   */
  private extractContinuationData(data: any): { token: string; itct: string } | null {
    // 2025 format: continuationItemRenderer in contents array
    const shelf = this.deepFind(data, 'musicPlaylistShelfRenderer');

    if (shelf?.contents && Array.isArray(shelf.contents) && shelf.contents.length > 0) {
      const lastItem = shelf.contents[shelf.contents.length - 1];
      if (lastItem?.continuationItemRenderer) {
        const contRenderer = lastItem.continuationItemRenderer;
        const token = contRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (token) {
          return { token, itct: contRenderer.continuationEndpoint?.clickTrackingParams || '' };
        }
      }
    }

    // Check contents for continuationItemRenderer at any position
    if (shelf?.contents && Array.isArray(shelf.contents)) {
      for (const item of shelf.contents) {
        if (item?.continuationItemRenderer) {
          const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
          if (token) {
            return { token, itct: item.continuationItemRenderer?.continuationEndpoint?.clickTrackingParams || '' };
          }
        }
      }
    }

    // Legacy format: continuations array
    if (shelf?.continuations && Array.isArray(shelf.continuations) && shelf.continuations.length > 0) {
      const contData = shelf.continuations[0]?.nextContinuationData;
      if (contData?.continuation) {
        return { token: contData.continuation, itct: contData.clickTrackingParams || '' };
      }
    }

    // Continuation response: musicPlaylistShelfContinuation
    const shelfCont = this.deepFind(data, 'musicPlaylistShelfContinuation');
    if (shelfCont?.contents && Array.isArray(shelfCont.contents) && shelfCont.contents.length > 0) {
      const lastItem = shelfCont.contents[shelfCont.contents.length - 1];
      if (lastItem?.continuationItemRenderer) {
        const token = lastItem.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (token) {
          return { token, itct: lastItem.continuationItemRenderer?.continuationEndpoint?.clickTrackingParams || '' };
        }
      }
    }

    if (shelfCont?.continuations && Array.isArray(shelfCont.continuations) && shelfCont.continuations.length > 0) {
      const contData = shelfCont.continuations[0]?.nextContinuationData;
      if (contData?.continuation) {
        return { token: contData.continuation, itct: contData.clickTrackingParams || '' };
      }
    }

    // sectionListContinuation format
    const sectionCont = this.deepFind(data, 'sectionListContinuation');
    if (sectionCont?.contents && Array.isArray(sectionCont.contents)) {
      for (const section of sectionCont.contents) {
        if (section?.musicPlaylistShelfRenderer?.contents) {
          const contents = section.musicPlaylistShelfRenderer.contents;
          if (Array.isArray(contents) && contents.length > 0) {
            const lastItem = contents[contents.length - 1];
            if (lastItem?.continuationItemRenderer) {
              const token = lastItem.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
              if (token) {
                return { token, itct: lastItem.continuationItemRenderer?.continuationEndpoint?.clickTrackingParams || '' };
              }
            }
          }
        }
      }
    }

    // 2025 format: onResponseReceivedActions (continuation responses)
    if (data.onResponseReceivedActions && Array.isArray(data.onResponseReceivedActions)) {
      for (const action of data.onResponseReceivedActions) {
        const appendAction = action?.appendContinuationItemsAction;
        if (appendAction?.continuationItems && Array.isArray(appendAction.continuationItems)) {
          for (const item of appendAction.continuationItems) {
            if (item?.continuationItemRenderer) {
              const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
              if (token) {
                return { token, itct: item.continuationItemRenderer?.continuationEndpoint?.clickTrackingParams || '' };
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract playlist metadata from response
   */
  private extractPlaylistMetadata(data: any): {
    title: string;
    description: string;
    thumbnails: Array<{ url: string; width: number; height: number }>;
    trackCount: number;
  } {
    const header = this.deepFind(data, 'musicDetailHeaderRenderer') ||
                   this.deepFind(data, 'musicEditablePlaylistDetailHeaderRenderer') ||
                   this.deepFind(data, 'musicResponsiveHeaderRenderer');

    let title = '';
    let description = '';
    let thumbnails: Array<{ url: string; width: number; height: number }> = [];
    let trackCount = 0;

    if (header) {
      const titleRuns = header?.title?.runs || header?.straplineTextOne?.runs;
      if (titleRuns && Array.isArray(titleRuns)) {
        title = titleRuns.map((r: any) => r.text).join('');
      }

      const descRuns = header?.description?.runs || header?.subtitle?.runs;
      if (descRuns && Array.isArray(descRuns)) {
        description = descRuns.map((r: any) => r.text).join('');
      }

      thumbnails = header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
                   header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails ||
                   [];

      // Check multiple possible locations for track count
      const subtitle = header?.subtitle?.runs ? header.subtitle.runs.map((r: any) => r.text).join('') : '';
      const secondSubtitle = header?.secondSubtitle?.runs ? header.secondSubtitle.runs.map((r: any) => r.text).join('') : '';
      const straplineBadges = header?.straplineBadges?.runs ? header.straplineBadges.runs.map((r: any) => r.text).join('') : '';

      // Try all possible text sources
      const allText = `${subtitle} ${secondSubtitle} ${straplineBadges}`;
      // Match various formats: "500 songs", "2,000 songs", "1.962 tracks", etc.
      const countMatch = allText.match(/([\d,.]+)\s*(song|track|video|titel|canciones|chansons|brani|músicas|nummer)/i);
      if (countMatch) {
        // Remove commas, dots used as thousands separators
        const numStr = countMatch[1].replace(/[,.]/g, '');
        trackCount = parseInt(numStr, 10) || 0;
      }
    }

    return { title, description, thumbnails, trackCount };
  }

  /**
   * Fetch all playlist videos with pagination
   */
  private async fetchAllPlaylistVideos(
    playlistId: string,
    onProgress?: ProgressCallback
  ): Promise<{
    videos: Array<{
      videoId: string;
      title: string;
      artist: string;
      thumbnails: Array<{ url: string; width: number; height: number }>;
      duration: number | null;
    }>;
    metadata: {
      title: string;
      description: string;
      thumbnails: Array<{ url: string; width: number; height: number }>;
      trackCount: number;
    };
  }> {
    let browseId = playlistId;

    // Ensure playlist ID has correct prefix for YouTube Music API
    if (browseId.startsWith('PL')) {
      browseId = 'VL' + browseId;
    } else if (!browseId.startsWith('VL') && !browseId.startsWith('RD') && !browseId.startsWith('OL')) {
      browseId = 'VL' + browseId;
    }

    const allVideos: Array<{
      videoId: string;
      title: string;
      artist: string;
      thumbnails: Array<{ url: string; width: number; height: number }>;
      duration: number | null;
    }> = [];

    let metadata = { title: '', description: '', thumbnails: [] as any[], trackCount: 0 };
    let continuationData: { token: string; itct: string } | null = null;
    let pageCount = 0;
    const maxPages = 50;

    // Report initial progress before first API call
    if (onProgress) {
      onProgress({
        stage: 'fetching_ids',
        current: 0,
        total: null,
        percentage: 1,
        message: 'progress.loading',
      });
    }

    // Initial request
    const initialResponse = await this.axiosClient.post(
      `${YT_MUSIC_API_URL}?key=${YT_MUSIC_API_KEY}`,
      this.buildRequestBody(browseId)
    );

    const initialData = initialResponse.data;
    metadata = this.extractPlaylistMetadata(initialData);

    const initialVideos = this.extractPlaylistVideos(initialData);
    allVideos.push(...initialVideos);

    const totalTracksExpected = metadata.trackCount || null;

    // Report initial progress
    if (onProgress) {
      let percentage: number;
      if (totalTracksExpected && totalTracksExpected > 0) {
        percentage = Math.min(99, Math.round((allVideos.length / totalTracksExpected) * 100));
      } else {
        percentage = Math.min(95, Math.round(50 * Math.log10(allVideos.length + 10) - 25));
      }
      onProgress({
        stage: 'fetching_metadata',
        current: allVideos.length,
        total: totalTracksExpected,
        percentage: Math.max(1, percentage),
        message: 'progress.loaded',
      });
    }

    continuationData = this.extractContinuationData(initialData);

    // Fetch remaining pages
    while (continuationData && pageCount < maxPages) {
      pageCount++;

      try {
        const continueResponse = await this.axiosClient.post(
          `${YT_MUSIC_API_URL}?key=${YT_MUSIC_API_KEY}`,
          {
            ...this.buildRequestBody(),
            continuation: continuationData.token,
          }
        );

        const continueData = continueResponse.data;
        const pageVideos = this.extractPlaylistVideos(continueData);

        if (pageVideos.length === 0) {
          break;
        }

        allVideos.push(...pageVideos);
        continuationData = this.extractContinuationData(continueData);

        // Report progress after each page
        if (onProgress) {
          let percentage: number;
          if (totalTracksExpected && totalTracksExpected > 0) {
            percentage = Math.min(99, Math.round((allVideos.length / totalTracksExpected) * 100));
          } else {
            percentage = Math.min(95, Math.round(50 * Math.log10(allVideos.length + 10) - 25));
          }
          onProgress({
            stage: 'fetching_metadata',
            current: allVideos.length,
            total: totalTracksExpected,
            percentage: Math.max(1, percentage),
            message: 'progress.loaded',
          });
        }
      } catch (e: any) {
        this.logger.log(`ERROR: Failed to fetch continuation page: ${e.message}`);
        break;
      }
    }

    return { videos: allVideos, metadata };
  }

  /**
   * Get playlist metadata
   */
  async getPlaylist(playlistId: string, cache: boolean = true): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    const cacheKey = `${CACHE_KEY_YT_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cache) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('ytmusic')}] Fetching playlist from API for ${color.white.bold(playlistId)}`
        )
      );

      const { metadata, videos } = await this.fetchAllPlaylistVideos(playlistId);

      const providerData: ProviderPlaylistData = {
        id: playlistId,
        name: metadata.title || 'Unknown Playlist',
        description: metadata.description || '',
        imageUrl: this.getBestThumbnail(metadata.thumbnails),
        trackCount: metadata.trackCount || videos.length,
        serviceType: ServiceType.YOUTUBE_MUSIC,
        originalUrl: `https://music.youtube.com/playlist?list=${playlistId}`,
      };

      await this.cache.set(cacheKey, JSON.stringify(providerData));

      return { success: true, data: providerData };
    } catch (error: any) {
      this.logger.log(`ERROR: YouTube Music error fetching playlist ${playlistId}: ${error.message}`);

      if (this.isRadioPlaylist(playlistId) && error.message?.includes('400')) {
        return {
          success: false,
          error: 'Radio/auto-generated playlists are not supported. Please use a user-created playlist instead.',
        };
      }

      return { success: false, error: error.message || 'Failed to fetch playlist' };
    }
  }

  /**
   * Get tracks from a YouTube Music playlist with full pagination support
   */
  async getTracks(
    playlistId: string,
    cache: boolean = true,
    _maxTracks?: number,
    onProgress?: ProgressCallback
  ): Promise<ApiResult & { data?: ProviderTracksResult }> {
    if (this.isRadioPlaylist(playlistId)) {
      this.logger.log(`WARNING: Attempting to fetch radio playlist ${playlistId} - this may fail without cookies`);
    }

    const cacheKey = `${CACHE_KEY_YT_TRACKS}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cache) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      const { videos, metadata } = await this.fetchAllPlaylistVideos(playlistId, onProgress);
      const playlistName = metadata.title || null;

      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('ytmusic')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}${playlistName ? ` (${color.white.bold(playlistName)})` : ''}`
        )
      );

      const tracks: ProviderTrackData[] = videos.map((video) => ({
        id: video.videoId,
        name: this.utils.cleanTrackName(video.title),
        artist: video.artist,
        artistsList: [video.artist],
        album: '',
        albumImageUrl: this.getBestThumbnail(video.thumbnails),
        releaseDate: null,
        isrc: undefined,
        previewUrl: null,
        duration: video.duration ? video.duration * 1000 : undefined,
        serviceType: ServiceType.YOUTUBE_MUSIC,
        serviceLink: `https://music.youtube.com/watch?v=${video.videoId}`,
      }));

      const result: ProviderTracksResult = {
        tracks,
        total: tracks.length,
        skipped: {
          total: 0,
          summary: { unavailable: 0, localFiles: 0, podcasts: 0, duplicates: 0 },
          details: [],
        },
      };

      await this.cache.set(cacheKey, JSON.stringify(result));

      return { success: true, data: result };
    } catch (error: any) {
      this.logger.log(`ERROR: YouTube Music error fetching tracks for playlist ${playlistId}: ${error.message}`);

      if (this.isRadioPlaylist(playlistId) && error.message?.includes('400')) {
        return {
          success: false,
          error: 'Radio/auto-generated playlists are not supported. Please use a user-created playlist instead.',
        };
      }

      return { success: false, error: error.message || 'Failed to fetch tracks' };
    }
  }

  /**
   * Search for tracks on YouTube Music
   */
  async searchTracks(
    query: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<ApiResult & { data?: ProviderSearchResult }> {
    const cacheKey = `${CACHE_KEY_YT_SEARCH}${query}_${limit}_${offset}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      await this.ensureInitialized();

      let songs;
      try {
        songs = await this.ytmusic.searchSongs(query);
      } catch (error: any) {
        if (error.message?.includes('400')) {
          this.logger.log(`YouTube Music search got 400, re-initializing and retrying...`);
          await this.reinitialize();
          songs = await this.ytmusic.searchSongs(query);
        } else {
          throw error;
        }
      }

      const sliced = songs.slice(offset, offset + limit);

      const tracks: ProviderTrackData[] = sliced.map((song) => ({
        id: song.videoId,
        name: this.utils.cleanTrackName(song.name),
        artist: song.artist.name,
        artistsList: [song.artist.name],
        album: this.utils.cleanTrackName(song.album?.name || ''),
        albumImageUrl: this.getBestThumbnail(song.thumbnails),
        releaseDate: null,
        isrc: undefined,
        previewUrl: null,
        duration: song.duration || undefined,
        serviceType: ServiceType.YOUTUBE_MUSIC,
        serviceLink: `https://music.youtube.com/watch?v=${song.videoId}`,
      }));

      const result: ProviderSearchResult = {
        tracks,
        total: songs.length,
        hasMore: offset + limit < songs.length,
      };

      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_SEARCH);

      return { success: true, data: result };
    } catch (error: any) {
      this.logger.log(`ERROR: YouTube Music error searching for "${query}": ${error.message}`);
      return { success: false, error: error.message || 'Failed to search tracks' };
    }
  }

  getAuthorizationUrl(): string | null {
    return null;
  }

  async handleAuthCallback(_code: string): Promise<ApiResult & { data?: { accessToken: string } }> {
    return { success: false, error: 'OAuth not supported for YouTube Music.' };
  }
}

export default YouTubeMusicProvider;
