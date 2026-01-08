import { color } from 'console-log-colors';
import YTMusic from 'ytmusic-api';
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

// Cache key prefixes for YouTube Music
const CACHE_KEY_YT_PLAYLIST = 'yt_playlist_';
const CACHE_KEY_YT_TRACKS = 'yt_tracks_';
const CACHE_KEY_YT_SEARCH = 'yt_search_';

// Cache TTL in seconds
const CACHE_TTL_PLAYLIST = 3600; // 1 hour
const CACHE_TTL_TRACKS = 3600; // 1 hour
const CACHE_TTL_SEARCH = 1800; // 30 minutes

/**
 * YouTube Music provider implementing the IMusicProvider interface.
 * Uses ytmusic-api to scrape YouTube Music for proper music metadata.
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
  }

  /**
   * Check if playlist ID is a radio/auto-generated playlist
   * Radio playlists start with "RD" prefix
   */
  private isRadioPlaylist(playlistId: string): boolean {
    return playlistId.startsWith('RD');
  }

  /**
   * Ensure the YTMusic client is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      // Initialize with optional cookies from environment variable
      const cookies = process.env.YOUTUBE_MUSIC_COOKIES;
      await this.ytmusic.initialize(cookies ? { cookies } : undefined);
      this.initialized = true;
    }
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

    // Check YouTube Music playlist URL
    const ytMusicMatch = trimmedUrl.match(this.urlPatterns.ytMusicPlaylist);
    if (ytMusicMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: ytMusicMatch[1],
      };
    }

    // Check YouTube Music watch URL with playlist
    const ytMusicWatchMatch = trimmedUrl.match(this.urlPatterns.ytMusicWatchWithList);
    if (ytMusicWatchMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: ytMusicWatchMatch[1],
      };
    }

    // Check regular YouTube playlist URL
    const ytPlaylistMatch = trimmedUrl.match(this.urlPatterns.ytPlaylist);
    if (ytPlaylistMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: ytPlaylistMatch[2],
      };
    }

    // Check YouTube watch URL with playlist
    const ytWatchMatch = trimmedUrl.match(this.urlPatterns.ytWatchWithList);
    if (ytWatchMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: ytWatchMatch[2],
      };
    }

    // Check if it's a YouTube Music URL but not a playlist
    if (this.urlPatterns.anyYtMusicUrl.test(trimmedUrl)) {
      return {
        isValid: false,
        isServiceUrl: true,
        errorType: 'not_playlist',
      };
    }

    // Check if it's a YouTube URL but not a playlist
    if (this.urlPatterns.anyYtUrl.test(trimmedUrl)) {
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
    // Sort by width descending and return the largest
    const sorted = [...thumbnails].sort((a, b) => b.width - a.width);
    return sorted[0]?.url || null;
  }

  /**
   * Get playlist metadata
   */
  async getPlaylist(playlistId: string): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    // Check cache first
    const cacheKey = `${CACHE_KEY_YT_PLAYLIST}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      await this.ensureInitialized();

      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('ytmusic')}] Fetching playlist from API for ${color.white.bold(playlistId)}`
        )
      );

      const playlist = await this.ytmusic.getPlaylist(playlistId);

      // ytmusic-api returns incorrect videoCount, so fetch actual tracks to get correct count
      const videos = await this.ytmusic.getPlaylistVideos(playlistId);
      const actualTrackCount = videos.length;

      const providerData: ProviderPlaylistData = {
        id: playlistId,
        name: playlist.name,
        description: '',
        imageUrl: this.getBestThumbnail(playlist.thumbnails),
        trackCount: actualTrackCount,
        serviceType: ServiceType.YOUTUBE_MUSIC,
        originalUrl: `https://music.youtube.com/playlist?list=${playlistId}`,
      };

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(providerData), CACHE_TTL_PLAYLIST);

      return { success: true, data: providerData };
    } catch (error: any) {
      this.logger.log(`ERROR: ytmusic-api error fetching playlist ${playlistId}: ${error.message}`);

      // Provide helpful error message for radio playlists
      if (this.isRadioPlaylist(playlistId) && error.message?.includes('400')) {
        return {
          success: false,
          error: 'Radio/auto-generated playlists are not supported. Please use a user-created playlist instead.',
        };
      }

      return {
        success: false,
        error: error.message || 'Failed to fetch playlist',
      };
    }
  }

  /**
   * Get tracks from a YouTube Music playlist
   */
  async getTracks(playlistId: string): Promise<ApiResult & { data?: ProviderTracksResult }> {
    // Check if this is a radio playlist and warn early
    if (this.isRadioPlaylist(playlistId)) {
      this.logger.log(`WARNING: Attempting to fetch radio playlist ${playlistId} - this may fail without cookies`);
    }

    // Check cache first
    const cacheKey = `${CACHE_KEY_YT_TRACKS}${playlistId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      await this.ensureInitialized();

      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('ytmusic')}] Fetching tracks from API for playlist ${color.white.bold(playlistId)}`
        )
      );

      const videos = await this.ytmusic.getPlaylistVideos(playlistId);

      const tracks: ProviderTrackData[] = videos.map((video) => ({
        id: video.videoId,
        name: this.utils.cleanTrackName(video.name),
        artist: video.artist.name,
        artistsList: [video.artist.name],
        album: '',
        albumImageUrl: this.getBestThumbnail(video.thumbnails),
        releaseDate: null,
        isrc: undefined,
        previewUrl: null,
        duration: video.duration || undefined,
        serviceType: ServiceType.YOUTUBE_MUSIC,
        serviceLink: `https://music.youtube.com/watch?v=${video.videoId}`,
      }));

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
      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_TRACKS);

      return { success: true, data: result };
    } catch (error: any) {
      this.logger.log(`ERROR: ytmusic-api error fetching tracks for playlist ${playlistId}: ${error.message}`);

      // Provide helpful error message for radio playlists
      if (this.isRadioPlaylist(playlistId) && error.message?.includes('400')) {
        return {
          success: false,
          error: 'Radio/auto-generated playlists are not supported. Please use a user-created playlist instead.',
        };
      }

      return {
        success: false,
        error: error.message || 'Failed to fetch tracks',
      };
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
    // Check cache first
    const cacheKey = `${CACHE_KEY_YT_SEARCH}${query}_${limit}_${offset}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    try {
      await this.ensureInitialized();

      const songs = await this.ytmusic.searchSongs(query);

      // Apply offset and limit
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

      // Cache the result
      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_SEARCH);

      return { success: true, data: result };
    } catch (error: any) {
      this.logger.log(`ERROR: ytmusic-api error searching for "${query}": ${error.message}`);

      return {
        success: false,
        error: error.message || 'Failed to search tracks',
      };
    }
  }

  // OAuth methods not supported
  getAuthorizationUrl(): string | null {
    return null;
  }

  async handleAuthCallback(_code: string): Promise<ApiResult & { data?: { accessToken: string } }> {
    return {
      success: false,
      error: 'OAuth not supported for YouTube Music.',
    };
  }
}

export default YouTubeMusicProvider;
