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
import Spotify from '../spotify';

/**
 * Spotify provider implementing the IMusicProvider interface.
 * This is a facade that wraps the existing Spotify class to provide
 * a standardized interface for the music service abstraction.
 */
class SpotifyProvider implements IMusicProvider {
  private static instance: SpotifyProvider;
  private spotify = Spotify.getInstance();

  readonly serviceType = ServiceType.SPOTIFY;

  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.SPOTIFY,
    displayName: 'Spotify',
    supportsOAuth: true,
    supportsPublicPlaylists: true,
    supportsSearch: true,
    supportsPlaylistCreation: true,
    brandColor: '#1DB954',
    iconClass: 'fa-spotify',
  };

  /**
   * URL patterns for Spotify
   */
  private readonly urlPatterns = {
    // Standard playlist URL: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBQVN
    standardPlaylist: /^https?:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/,
    // Internationalized playlist URL: https://open.spotify.com/intl-nl/playlist/37i9dQZF1DXcBWIGoYBQVN
    intlPlaylist: /^https?:\/\/open\.spotify\.com\/intl-[a-z]{2}\/playlist\/([a-zA-Z0-9]+)/,
    // Spotify URI: spotify:playlist:37i9dQZF1DXcBWIGoYBQVN
    spotifyUri: /^spotify:playlist:([a-zA-Z0-9]+)$/,
    // Bare playlist ID (22 characters)
    bareId: /^[a-zA-Z0-9]{22}$/,
    // Shortlinks
    shortlink: /^https?:\/\/(spotify\.link|spotify\.app\.link)\//,
    // Track URL (not playlist)
    trackUrl: /^https?:\/\/open\.spotify\.com\/(intl-[a-z]{2}\/)?track\//,
    // Album URL (not playlist)
    albumUrl: /^https?:\/\/open\.spotify\.com\/(intl-[a-z]{2}\/)?album\//,
    // Artist URL (not playlist)
    artistUrl: /^https?:\/\/open\.spotify\.com\/(intl-[a-z]{2}\/)?artist\//,
    // Any Spotify URL
    anySpotifyUrl: /^https?:\/\/(open\.)?spotify\.(com|link|app\.link)/,
  };

  public static getInstance(): SpotifyProvider {
    if (!SpotifyProvider.instance) {
      SpotifyProvider.instance = new SpotifyProvider();
    }
    return SpotifyProvider.instance;
  }

  /**
   * Validate a URL and determine if it's a valid Spotify playlist URL
   */
  validateUrl(url: string): UrlValidationResult {
    const trimmedUrl = url.trim();

    // Check if it's a bare playlist ID
    if (this.urlPatterns.bareId.test(trimmedUrl)) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: trimmedUrl,
      };
    }

    // Check if it's a Spotify URI
    const uriMatch = trimmedUrl.match(this.urlPatterns.spotifyUri);
    if (uriMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: uriMatch[1],
      };
    }

    // Check standard playlist URL
    const standardMatch = trimmedUrl.match(this.urlPatterns.standardPlaylist);
    if (standardMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: standardMatch[1],
      };
    }

    // Check internationalized playlist URL
    const intlMatch = trimmedUrl.match(this.urlPatterns.intlPlaylist);
    if (intlMatch) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        resourceId: intlMatch[1],
      };
    }

    // Check shortlinks (valid but needs resolution)
    if (this.urlPatterns.shortlink.test(trimmedUrl)) {
      return {
        isValid: true,
        isServiceUrl: true,
        resourceType: 'playlist',
        // ID will be resolved later
      };
    }

    // Check if it's a Spotify URL but not a playlist
    if (this.urlPatterns.anySpotifyUrl.test(trimmedUrl)) {
      if (this.urlPatterns.trackUrl.test(trimmedUrl)) {
        return {
          isValid: false,
          isServiceUrl: true,
          resourceType: 'track',
          errorType: 'not_playlist',
        };
      }
      if (this.urlPatterns.albumUrl.test(trimmedUrl)) {
        return {
          isValid: false,
          isServiceUrl: true,
          resourceType: 'album',
          errorType: 'not_playlist',
        };
      }
      if (this.urlPatterns.artistUrl.test(trimmedUrl)) {
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

    // Not a Spotify URL
    return {
      isValid: false,
      isServiceUrl: false,
    };
  }

  /**
   * Extract playlist ID from a Spotify URL
   */
  extractPlaylistId(url: string): string | null {
    const validation = this.validateUrl(url);
    if (validation.isValid && validation.resourceId) {
      return validation.resourceId;
    }
    return null;
  }

  /**
   * Get playlist metadata from Spotify
   */
  async getPlaylist(playlistId: string): Promise<ApiResult & { data?: ProviderPlaylistData }> {
    const result = await this.spotify.getPlaylist(
      playlistId,
      true, // cache
      '', // captchaToken
      false, // checkCaptcha
      false, // featured
      false, // isSlug
      'en', // locale
      '', // clientIp
      '' // userAgent
    );

    if (!result.success || !result.data) {
      return result;
    }

    // Map to standardized format
    const playlist = result.data;
    const providerData: ProviderPlaylistData = {
      id: playlist.playlistId || playlistId,
      name: playlist.name,
      description: playlist.description || '',
      imageUrl: playlist.image || null,
      trackCount: playlist.numberOfTracks || 0,
      serviceType: ServiceType.SPOTIFY,
      originalUrl: `https://open.spotify.com/playlist/${playlist.playlistId || playlistId}`,
    };

    return {
      success: true,
      data: providerData,
    };
  }

  /**
   * Get tracks from a Spotify playlist
   */
  async getTracks(
    playlistId: string,
    cache?: boolean,
    _maxTracks?: number,
    onProgress?: ProgressCallback
  ): Promise<ApiResult & { data?: ProviderTracksResult }> {
    const result = await this.spotify.getTracks(
      playlistId,
      cache !== false, // cache
      '', // captchaToken
      false, // checkCaptcha
      false, // isSlug
      '', // clientIp
      '', // userAgent
      onProgress // pass through progress callback
    );

    if (!result.success || !result.data) {
      return result;
    }

    // Map tracks to standardized format
    const tracks: ProviderTrackData[] = result.data.tracks.map((track: any) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
      artistsList: track.artist ? [track.artist] : [],
      album: track.album || '',
      albumImageUrl: track.image || null,
      releaseDate: track.releaseDate || null,
      isrc: track.isrc || undefined,
      previewUrl: track.preview || null,
      duration: undefined, // Not available in current response
      serviceType: ServiceType.SPOTIFY,
      serviceLink: track.spotifyLink || `https://open.spotify.com/track/${track.id}`,
    }));

    const providerResult: ProviderTracksResult = {
      tracks,
      total: result.data.totalTracks || tracks.length,
      skipped: result.data.skippedTracks
        ? {
            total: result.data.skippedTracks.total,
            summary: result.data.skippedTracks.summary,
            details: result.data.skippedTracks.details,
          }
        : undefined,
    };

    return {
      success: true,
      data: providerResult,
    };
  }

  /**
   * Search for tracks on Spotify
   */
  async searchTracks(
    query: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<ApiResult & { data?: ProviderSearchResult }> {
    const result = await this.spotify.searchTracks(query, limit, offset);

    if (!result.success || !result.data) {
      return result;
    }

    const tracks: ProviderTrackData[] = result.data.tracks.map((track: any) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
      artistsList: track.artist ? [track.artist] : [],
      album: track.album || '',
      albumImageUrl: track.image || null,
      releaseDate: track.releaseDate || null,
      isrc: track.isrc || undefined,
      previewUrl: track.preview || null,
      duration: undefined,
      serviceType: ServiceType.SPOTIFY,
      serviceLink: track.spotifyLink || `https://open.spotify.com/track/${track.id}`,
    }));

    return {
      success: true,
      data: {
        tracks,
        total: result.data.total || tracks.length,
        hasMore: result.data.hasMore || false,
      },
    };
  }

  /**
   * Resolve a Spotify shortlink
   */
  async resolveShortlink(url: string): Promise<ApiResult & { data?: { resolvedUrl: string } }> {
    const result = await this.spotify.resolveShortlink(url);

    if (!result.success || !result.url) {
      return {
        success: false,
        error: result.error || 'Failed to resolve shortlink',
      };
    }

    return {
      success: true,
      data: {
        resolvedUrl: result.url,
      },
    };
  }

  /**
   * Get Spotify OAuth authorization URL
   */
  getAuthorizationUrl(): string | null {
    return this.spotify.getAuthorizationUrl();
  }

  /**
   * Handle Spotify OAuth callback
   */
  async handleAuthCallback(code: string): Promise<ApiResult & { data?: { accessToken: string } }> {
    const accessToken = await this.spotify.getTokensFromAuthCode(code);

    if (!accessToken) {
      return {
        success: false,
        error: 'Failed to get access token',
      };
    }

    return {
      success: true,
      data: { accessToken },
    };
  }

  /**
   * Create a playlist on Spotify
   * Note: Uses stored tokens from OAuth flow, not passed accessToken
   */
  async createPlaylist(
    name: string,
    trackIds: string[]
  ): Promise<ApiResult & { data?: { playlistId: string; url: string } }> {
    const result = await this.spotify.createOrUpdatePlaylist(name, trackIds);

    if (!result.success || !result.data) {
      return result;
    }

    return {
      success: true,
      data: {
        playlistId: result.data.playlistId,
        url: result.data.url || `https://open.spotify.com/playlist/${result.data.playlistId}`,
      },
    };
  }

  /**
   * Delete/unfollow a Spotify playlist
   * Note: Uses stored tokens from OAuth flow
   */
  async deletePlaylist(playlistId: string): Promise<ApiResult> {
    return await this.spotify.deletePlaylist(playlistId);
  }
}

export default SpotifyProvider;
