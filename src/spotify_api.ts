import axios, { AxiosError, AxiosResponse } from 'axios'; // Import AxiosResponse
import Logger from './logger';
import Settings from './settings';
import { color } from 'console-log-colors';
import { ApiResult } from './interfaces/ApiResult'; // Assuming ApiResult interface exists

// Define interfaces for expected API responses (can be refined later)
interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string; // Optional, not always returned on refresh
}

interface SpotifyErrorResponse {
  error: {
    status: number;
    message: string;
  };
}

class SpotifyApi {
  private logger = new Logger();
  private settings = Settings.getInstance();
  private clientId = process.env['SPOTIFY_CLIENT_ID'];
  private clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
  private redirectUri =
    process.env['SPOTIFY_REDIRECT_URI'] ||
    'http://localhost:3004/spotify_callback'; // Default fallback

  /**
   * Retrieves a valid access token, refreshing if necessary.
   * @returns {Promise<string | null>} A valid access token or null if unable to obtain one.
   */
  public async getAccessToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.log(color.red.bold('Missing Spotify API credentials'));
      return null;
    }

    let accessToken = await this.settings.getSetting('spotify_access_token');
    const refreshToken = await this.settings.getSetting('spotify_refresh_token');
    const expiresAtStr = await this.settings.getSetting(
      'spotify_token_expires_at'
    );
    const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

    if (accessToken && Date.now() < expiresAt) {
      return accessToken; // Token is valid
    }

    if (refreshToken) {
      this.logger.log(
        color.blue.bold(
          'Spotify access token expired or invalid, attempting refresh...'
        )
      );
      const refreshedToken = await this.refreshAccessToken(refreshToken);
      if (refreshedToken) {
        return refreshedToken; // Return the newly refreshed token
      } else {
        this.logger.log(
          color.yellow.bold(
            'Spotify token refresh failed. Authorization might be required.'
          )
        );
        return null; // Refresh failed
      }
    }

    this.logger.log(
      color.yellow.bold(
        'No valid Spotify access token or refresh token found. Authorization required.'
      )
    );
    return null; // No valid token and no refresh token
  }

  /**
   * Refreshes the Spotify access token using a refresh token.
   * Stores the new token(s) and expiry time.
   * @param refreshToken The refresh token.
   * @returns {Promise<string | null>} The new access token or null if refresh failed.
   */
  private async refreshAccessToken(
    refreshToken: string
  ): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.log(
        color.red.bold('Missing Spotify API credentials for refresh')
      );
      return null;
    }

    try {
      const response = await axios.post<SpotifyTokenResponse>(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(
              `${this.clientId}:${this.clientSecret}`
            ).toString('base64')}`,
          },
        }
      );

      const { access_token, expires_in, refresh_token: newRefreshToken } =
        response.data;
      const newExpiresAt = Date.now() + (expires_in - 60) * 1000; // Store with a 60s buffer

      await this.settings.setSetting('spotify_access_token', access_token);
      await this.settings.setSetting(
        'spotify_token_expires_at',
        newExpiresAt.toString()
      );
      if (newRefreshToken) {
        await this.settings.setSetting('spotify_refresh_token', newRefreshToken);
        this.logger.log(color.blue('Stored new Spotify refresh token.'));
      }

      this.logger.log(
        color.green.bold('Successfully refreshed Spotify token.')
      );
      return access_token;
    } catch (error) {
      this.logger.log(color.red.bold(`Error refreshing Spotify token: ${error}`));
      // Optionally clear tokens if refresh fails permanently (e.g., invalid refresh token)
      // await this.settings.deleteSetting('spotify_refresh_token');
      // await this.settings.deleteSetting('spotify_access_token');
      // await this.settings.deleteSetting('spotify_token_expires_at');
      return null;
    }
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   * Stores the new tokens and expiry time.
   * @param authCode The authorization code received from Spotify callback.
   * @returns {Promise<string | null>} The new access token or null if exchange failed.
   */
  public async getTokensFromAuthCode(authCode: string): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.log(
        color.red.bold('Missing Spotify API credentials for auth code exchange')
      );
      return null;
    }

    try {
      const response = await axios.post<SpotifyTokenResponse>(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: this.redirectUri,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(
              `${this.clientId}:${this.clientSecret}`
            ).toString('base64')}`,
          },
        }
      );

      const { access_token, expires_in, refresh_token } = response.data;
      const expiresAt = Date.now() + (expires_in - 60) * 1000; // Store with a 60s buffer

      await this.settings.setSetting('spotify_access_token', access_token);
      await this.settings.setSetting(
        'spotify_token_expires_at',
        expiresAt.toString()
      );
      if (refresh_token) {
        await this.settings.setSetting('spotify_refresh_token', refresh_token);
      } else {
        this.logger.log(
          color.yellow('No refresh token received from auth code grant.')
        );
      }

      this.logger.log(
        color.green.bold(
          'Successfully obtained Spotify tokens using auth code.'
        )
      );
      return access_token;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error exchanging Spotify auth code for tokens: ${error}`
        )
      );
      return null;
    }
  }

  /**
   * Handles Spotify API errors, logging and returning a structured error.
   * @param error The error object (expected to be AxiosError).
   * @param context A string describing the context of the call (e.g., 'fetching playlist').
   * @returns {ApiResult} An ApiResult object with success: false.
   */
  private handleApiError(error: any, context: string): ApiResult {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<SpotifyErrorResponse>;
      const status = axiosError.response?.status;
      const message =
        axiosError.response?.data?.error?.message || axiosError.message;

      this.logger.log(
        color.red.bold(
          `Spotify API error ${context}: ${status} - ${message}`
        )
      );

      if (status === 401) {
        // Clear potentially invalid token for next attempt
        this.settings.deleteSetting('spotify_access_token');
        this.settings.deleteSetting('spotify_token_expires_at');
        return {
          success: false,
          error: 'Spotify authorization error (token likely expired/invalid)',
          // needsReAuth: true, // Removed as it's not in ApiResult interface
        };
      } else if (status === 404) {
        return { success: false, error: 'Spotify resource not found' };
      } else {
        return {
          success: false,
          error: `Spotify API error: ${status || 'Unknown'}`,
        };
      }
    } else {
      this.logger.log(color.red.bold(`Non-API error ${context}: ${error}`));
      return { success: false, error: `Internal error ${context}` };
    }
  }

  /**
   * Fetches playlist details from the Spotify API.
   * @param playlistId The Spotify ID of the playlist.
   * @param accessToken A valid Spotify access token.
   * @returns {Promise<ApiResult>} Contains playlist data or error info.
   */
  public async getPlaylist(
    playlistId: string,
    accessToken: string
  ): Promise<ApiResult> {
    try {
      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `fetching playlist ${playlistId}`);
    }
  }

  /**
   * Fetches all tracks from a Spotify playlist, handling pagination.
   * @param playlistId The Spotify ID of the playlist.
   * @param accessToken A valid Spotify access token.
   * @returns {Promise<ApiResult>} Contains an array of track items or error info.
   */
  public async getTracks(
    playlistId: string,
    accessToken: string
  ): Promise<ApiResult> {
    let allItems: any[] = [];
    let nextUrl: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`; // Max limit is 100 for this endpoint
import axios, { AxiosError, AxiosResponse } from 'axios'; // Import AxiosResponse

// ... other code ...

    try {
      while (nextUrl) {
        // Add explicit type annotation
        const response: AxiosResponse<any> = await axios.get(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        allItems = allItems.concat(response.data.items);
        nextUrl = response.data.next;
      }
      // Note: The response structure here is slightly different than getPlaylist.
      // We return the combined 'items' array directly.
      return { success: true, data: { items: allItems } };
    } catch (error) {
      return this.handleApiError(error, `fetching tracks for playlist ${playlistId}`);
    }
  }

  /**
   * Fetches details for multiple tracks by their Spotify IDs.
   * @param trackIds An array of Spotify track IDs (max 50 per request).
   * @param accessToken A valid Spotify access token.
   * @returns {Promise<ApiResult>} Contains track data or error info.
   */
  public async getTracksByIds(
    trackIds: string[],
    accessToken: string
  ): Promise<ApiResult> {
    if (!trackIds || trackIds.length === 0) {
      return { success: false, error: 'No track IDs provided' };
    }
    if (trackIds.length > 50) {
      // Note: This basic implementation doesn't handle > 50 IDs.
      // A more robust version would chunk the requests.
      this.logger.log(
        color.yellow(
          'Warning: getTracksByIds called with > 50 IDs. Only fetching first 50.'
        )
      );
      trackIds = trackIds.slice(0, 50);
    }

    try {
      const response = await axios.get(`https://api.spotify.com/v1/tracks`, {
        params: { ids: trackIds.join(',') },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      // The response contains a 'tracks' array.
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `fetching tracks by IDs`);
    }
  }

  /**
   * Searches for tracks on Spotify.
   * @param searchTerm The search query.
   * @param accessToken A valid Spotify access token.
   * @param limit Max number of results (default 20, max 50).
   * @param offset Offset for pagination (default 0).
   * @returns {Promise<ApiResult>} Contains search results or error info.
   */
  public async searchTracks(
    searchTerm: string,
    accessToken: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<ApiResult> {
    if (!searchTerm) {
      return { success: false, error: 'Search term is required' };
    }
    limit = Math.min(limit, 50); // Enforce Spotify API limit

    try {
      const response = await axios.get(`https://api.spotify.com/v1/search`, {
        params: {
          q: searchTerm,
          type: 'track',
          limit: limit,
          offset: offset,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      // The response contains a 'tracks' object with items, total, etc.
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `searching tracks for "${searchTerm}"`);
    }
  }

  /**
   * Fetches the current user's profile information.
   * @param accessToken A valid Spotify access token.
   * @returns {Promise<ApiResult>} Contains user profile data or error info.
   */
  public async getUserProfile(accessToken: string): Promise<ApiResult> {
     try {
      const response = await axios.get('https://api.spotify.com/v1/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, 'fetching user profile');
    }
  }

   /**
   * Creates or updates a playlist for the user.
   * @param userId The Spotify user ID.
   * @param accessToken A valid Spotify access token.
   * @param playlistName The desired name of the playlist.
   * @param trackIds An array of Spotify track IDs to include.
   * @param existingPlaylistId Optional. If provided, updates this playlist instead of creating a new one.
   * @returns {Promise<ApiResult>} Contains the created/updated playlist data or error info.
   */
  public async createOrUpdatePlaylist(
    userId: string,
    accessToken: string,
    playlistName: string,
    trackIds: string[],
    existingPlaylistId?: string | null
  ): Promise<ApiResult> {
    const trackUris = trackIds.map((id) => `spotify:track:${id}`);
    const playlistDescription = `Created automatically.`; // Simple description

    try {
      let playlistId: string;
      let playlistUrl: string;

      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
        this.logger.log(
          color.blue.bold(
            `Updating existing playlist ID ${playlistId} with ${trackUris.length} tracks.`
          )
        );
        // Replace tracks (max 100 per request)
        const chunkSize = 100;
        for (let i = 0; i < trackUris.length; i += chunkSize) {
          const chunk = trackUris.slice(i, i + chunkSize);
          const method = i === 0 ? 'put' : 'post'; // First chunk replaces, subsequent chunks add
          await axios({
            method: method,
            url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            data: JSON.stringify({ uris: chunk }),
          });
        }
        // We need to fetch the playlist URL again if we only had the ID
        const playlistDetails = await this.getPlaylist(playlistId, accessToken);
        playlistUrl = playlistDetails.success ? playlistDetails.data.external_urls.spotify : '';

      } else {
        this.logger.log(
          color.blue.bold(
            `Creating new playlist "${playlistName}" for user ${userId}.`
          )
        );
        // Create new playlist
        const createResponse = await axios.post(
          `https://api.spotify.com/v1/users/${userId}/playlists`,
          JSON.stringify({
            name: playlistName,
            description: playlistDescription,
            public: true, // Or false depending on requirements
          }),
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          }
        );
        playlistId = createResponse.data.id;
        playlistUrl = createResponse.data.external_urls.spotify;

        // Add tracks (max 100 per request)
        const chunkSize = 100;
        for (let i = 0; i < trackUris.length; i += chunkSize) {
          const chunk = trackUris.slice(i, i + chunkSize);
          await axios.post(
            `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
            JSON.stringify({ uris: chunk }),
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
            }
          );
        }
      }

      return {
        success: true,
        data: {
          id: playlistId,
          external_urls: { spotify: playlistUrl },
          name: playlistName,
        },
      };
    } catch (error) {
      return this.handleApiError(error, `creating/updating playlist "${playlistName}"`);
    }
  }

   /**
   * Fetches the current user's playlists.
   * @param accessToken A valid Spotify access token.
   * @param limit Max number of playlists per request (default 20, max 50).
   * @param offset Offset for pagination (default 0).
   * @returns {Promise<ApiResult>} Contains playlist data or error info.
   */
  public async getUserPlaylists(
    accessToken: string,
    limit: number = 50, // Defaulting to max limit for checking existing
    offset: number = 0
  ): Promise<ApiResult> {
    limit = Math.min(limit, 50); // Enforce API limit

    try {
      // Note: This only gets the first page. A full implementation would paginate.
      const response = await axios.get(`https://api.spotify.com/v1/me/playlists`, {
        params: {
          limit: limit,
          offset: offset,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `fetching user playlists`);
    }
  }
}

export default SpotifyApi;
