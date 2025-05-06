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
    const refreshToken = await this.settings.getSetting(
      'spotify_refresh_token'
    );
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

      const {
        access_token,
        expires_in,
        refresh_token: newRefreshToken,
      } = response.data;
      const newExpiresAt = Date.now() + (expires_in - 60) * 1000; // Store with a 60s buffer

      await this.settings.setSetting('spotify_access_token', access_token);
      await this.settings.setSetting(
        'spotify_token_expires_at',
        newExpiresAt.toString()
      );
      if (newRefreshToken) {
        await this.settings.setSetting(
          'spotify_refresh_token',
          newRefreshToken
        );
        this.logger.log(color.blue('Stored new Spotify refresh token.'));
      }

      this.logger.log(
        color.green.bold('Successfully refreshed Spotify token.')
      );
      return access_token;
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error refreshing Spotify token: ${error}`)
      );
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
        color.red.bold(`Spotify API error ${context}: ${status} - ${message}`)
      );

      if (status === 401) {
        // Clear potentially invalid token for next attempt
        this.settings.deleteSetting('spotify_access_token');
        this.settings.deleteSetting('spotify_token_expires_at');
        return {
          success: false,
          error: 'Spotify authorization error (token likely expired/invalid)',
          needsReAuth: true,
          authUrl: this.getAuthorizationUrl() ?? undefined, // Convert null to undefined
        };
      } else if (status === 404) {
        return {
          success: false,
          error: 'Spotify resource not found',
          needsReAuth: false,
        }; // 404 doesn't imply re-auth needed
      } else if (status === 429) {
        const retryAfter = axiosError.response?.headers?.['retry-after'];
        const errorMessage = `Spotify API error: 429 Too Many Requests. ${
          retryAfter ? `Retry after: ${retryAfter} seconds.` : 'No Retry-After header.'
        }`;
        this.logger.log(color.red.bold(errorMessage));
        return {
          success: false,
          error: errorMessage,
          needsReAuth: false,
          retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
        };
      } else {
        return {
          success: false,
          error: `Spotify API error: ${status || 'Unknown'}`,
          needsReAuth: false, // Assume other errors don't require re-auth unless specified
        };
      }
    } else {
      this.logger.log(color.red.bold(`Non-API error ${context}: ${error}`));
      return {
        success: false,
        error: `Internal error ${context}`,
        needsReAuth: false,
      };
    }
  }

  /**
   * Helper function to introduce a delay.
   * @param ms The number of milliseconds to wait.
   * @returns A promise that resolves after the specified delay.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Fetches the Spotify User ID for the authenticated user.
   * @param accessToken A valid Spotify access token.
   * @returns {Promise<string | null>} The user ID or null if an error occurs.
   */
  private async getUserId(accessToken: string): Promise<string | null> {
    try {
      const response = await axios.get('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.data.id;
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error fetching Spotify user ID: ${error}`)
      );
      // We don't use handleApiError here as the caller (createOrUpdatePlaylist) will handle it.
      return null;
    }
  }

  /**
   * Fetches playlist details from the Spotify API.
   * @param playlistId The Spotify ID of the playlist.
   * @returns {Promise<ApiResult>} Contains playlist data or error info.
   */
  public async getPlaylist(playlistId: string): Promise<ApiResult> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined, // Convert null to undefined
      };
    }

    try {
      // Request only the fields needed by spotify.ts: id, name, description, images.url, tracks.total
      const fields = 'id,name,description,images(url),tracks(total)';
      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}`,
        {
          params: { fields: fields }, // Add fields parameter
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `fetching playlist ${playlistId}`);
    }
  }

  /**
   * Fetches all tracks from a Spotify playlist, handling pagination internally.
   * @param playlistId The Spotify ID of the playlist.
   * @returns {Promise<ApiResult>} Contains an array of track items or error info.
   */
  public async getTracks(playlistId: string): Promise<ApiResult> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined, // Convert null to undefined
      };
    }

    this.logger.log(
      color.blue.bold(
        `Fetching tracks in ${color.white.bold(
          'SpotifyAPI'
        )} for playlist ${color.white.bold(playlistId)}`
      )
    );

    let allItems: any[] = [];
    // Use the fields parameter to potentially reduce response size if needed
    let nextUrl:
      | string
      | null = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&fields=items(track(id,name,artists(name),album(name,images,release_date),external_urls,external_ids,preview_url)),next`; // Max limit is 50 for this endpoint with fields

    try {
      while (nextUrl) {
        const response: AxiosResponse<any> = await axios.get(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        // Filter out null tracks which can sometimes occur
        const validItems = response.data.items.filter(
          (item: any) => item && item.track
        );
        allItems = allItems.concat(validItems);
        nextUrl = response.data.next;
      }
      // Note: The response structure here is slightly different than getPlaylist.
      // We return the combined 'items' array directly.
      return { success: true, data: { items: allItems } };
    } catch (error) {
      return this.handleApiError(
        error,
        `fetching tracks for playlist ${playlistId}`
      );
    }
  }

  /**
   * Fetches details for multiple tracks by their Spotify IDs.
   * Fetches details for multiple tracks by their Spotify IDs, handling token and chunking.
   * @param trackIds An array of Spotify track IDs.
   * @returns {Promise<ApiResult>} Contains track data or error info.
   */
  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    if (!trackIds || trackIds.length === 0) {
      return { success: false, error: 'No track IDs provided' };
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined, // Convert null to undefined
      };
    }

    const chunkSize = 50; // Spotify API limit
    let allTracks: any[] = [];
    let needsReAuth = false; // Flag to track if any chunk requires re-auth

    try {
      // Define the fields needed by spotify.ts getTracksByIds
      const fields =
        'items(id,name,artists(name),album(name,images(url),release_date),external_urls,external_ids,preview_url)'; // Note: API returns 'tracks' not 'items' for this endpoint
      const trackFields =
        'id,name,artists(name),album(name,images(url),release_date),external_urls,external_ids,preview_url'; // Fields for each track object

      for (let i = 0; i < trackIds.length; i += chunkSize) {
        const chunk = trackIds.slice(i, i + chunkSize);
        const response = await axios.get(`https://api.spotify.com/v1/tracks`, {
          params: {
            ids: chunk.join(','),
            // Note: The /v1/tracks endpoint doesn't directly support a 'fields' param for the top-level response in the same way as others.
            // It returns an object { tracks: [...] }. We request all fields for the track objects within the array.
            // If specific fields were needed *within* each track, that's handled by the API structure itself.
            // We are already getting the necessary fields based on the default response.
            // If optimization was needed *within* track objects, it would require a different approach if the API supported it.
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        // Filter out null tracks from the chunk response before concatenating
        const validTracksInChunk = response.data.tracks.filter(
          (track: any) => track !== null
        );
        allTracks = allTracks.concat(validTracksInChunk);
        // Optional: Add a small delay between chunks if needed
        // await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Return the combined tracks array under the 'tracks' key in data
      return { success: true, data: { tracks: allTracks } };
    } catch (error) {
      const errorResult = this.handleApiError(error, `fetching tracks by IDs`);
      // If any chunk failed with a re-auth error, propagate it
      if (errorResult.needsReAuth) {
        needsReAuth = true;
      }
      // Return the error from the first chunk that failed
      // A more sophisticated approach might try to return partial data
      return { ...errorResult, needsReAuth };
    }
  }

  /**
   * Searches for tracks on Spotify, handling token internally.
   * @param searchTerm The search query.
   * @param limit Max number of results (default 20, max 50).
   * @param offset Offset for pagination (default 0).
   * @returns {Promise<ApiResult>} Contains search results or error info.
   */
  public async searchTracks(
    searchTerm: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<ApiResult> {
    if (!searchTerm) {
      return { success: false, error: 'Search term is required' };
    }

    this.logger.log(
      color.blue.bold(
        `Searching ${color.white.bold(
          'SpotifyAPI'
        )} for tracks matching "${color.white.bold(
          searchTerm
        )}" with limit ${color.white.bold(limit)}`
      )
    );

    limit = Math.min(limit, 50); // Enforce Spotify API limit

    let retries = 0;
    const maxRetries = 3;
    let lastErrorResult: ApiResult | null = null;

    // Initial access token fetch
    let accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required (initial attempt)',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined,
      };
    }

    while (retries < maxRetries) {
      try {
        // Request only the fields needed by spotify.ts: tracks(items(id, name, artists(name), album(images(url))), total)
        const fields =
          'tracks(items(id,name,artists(name),album(images(url))),total)';
        const response = await axios.get(`https://api.spotify.com/v1/search`, {
          params: {
            q: searchTerm,
            type: 'track',
            limit: limit,
            offset: offset,
            fields: fields, // Add fields parameter
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        console.log(111, response.data.tracks.items.length);

        // The response contains a 'tracks' object with items, total, etc.
        return { success: true, data: response.data };
      } catch (error) {
        lastErrorResult = this.handleApiError(error, `searching tracks for "${searchTerm}" (attempt ${retries + 1}/${maxRetries})`);

        // Check if it's a 429 error and if we have more retries left (don't retry on the last attempt)
        if (lastErrorResult.error?.includes('429') && retries < maxRetries - 1) {
          const retryAfterSeconds = lastErrorResult.retryAfter;
          // Default backoff: 1s for 1st retry (retries=0 -> (0+1)*1000), 2s for 2nd retry (retries=1 -> (1+1)*1000)
          // For the third retry (retries=2), it would be 3s.
          let waitTimeMs = (retries + 1) * 1000; // Default incremental backoff

          if (retryAfterSeconds) {
            waitTimeMs = retryAfterSeconds * 1000;
            this.logger.log(color.yellow.bold(`Spotify API rate limit (429). Retrying after ${retryAfterSeconds} seconds...`));
          } else {
            this.logger.log(color.yellow.bold(`Spotify API rate limit (429). No Retry-After header. Retrying in ${waitTimeMs / 1000} seconds...`));
          }
          
          await this.delay(waitTimeMs);
          retries++;

          // Re-fetch access token before next attempt
          this.logger.log(color.blue.bold(`Attempting to re-fetch access token for retry ${retries}...`));
          accessToken = await this.getAccessToken();
          if (!accessToken) {
            this.logger.log(color.red.bold('Failed to get access token for retry. Aborting search.'));
            return {
              success: false,
              error: 'Spotify authentication required during retry attempt',
              needsReAuth: true, // Signal re-auth might be needed
              authUrl: this.getAuthorizationUrl() ?? undefined,
            };
          }
          this.logger.log(color.green.bold(`Successfully re-fetched access token for retry ${retries}.`));
          // Continue to the next iteration of the while loop for the next attempt
        } else {
          // Not a 429 error, or it was a 429 on the last attempt (retries === maxRetries -1), or some other error.
          // No more retries for this error type or retries exhausted.
          return lastErrorResult;
        }
      }
    }
    // This line should ideally not be reached if the logic correctly returns from within the loop.
    // It acts as a fallback if all retries are exhausted and the loop finishes.
    return lastErrorResult || { success: false, error: `Max retries (${maxRetries}) reached for searchTracks.`, needsReAuth: false };
  }

  /**
   * Creates or updates a playlist for the user.
   * @param userId The Spotify user ID.
   * @param accessToken A valid Spotify access token.
   * @param playlistName The desired name of the playlist.
   * @param trackIds An array of Spotify track IDs to include.
   * Handles token acquisition internally.
   * @param playlistName The desired name of the playlist.
   * @param trackIds An array of Spotify track IDs.
   * @returns {Promise<ApiResult>} Contains the playlist data or error info.
   */
  public async createOrUpdatePlaylist(
    playlistName: string,
    trackIds: string[]
  ): Promise<ApiResult> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined, // Convert null to undefined
      };
    }

    // Fetch User ID internally
    const userId = await this.getUserId(accessToken);
    if (!userId) {
      return this.handleApiError(
        new Error('Failed to fetch user ID'),
        'fetching user ID for playlist creation'
      );
    }

    const trackUris = trackIds.map((id) => `spotify:track:${id}`);
    const playlistDescription = `Created automatically.`; // Simple description

    try {
      // --- Check for existing playlist ---
      let existingPlaylistId: string | null = null;
      let playlistUrl: string | null = null;
      const maxPlaylistsToCheck = 50; // Spotify API limit per request

      try {
        // Fetch user's playlists to check if one with the same name already exists
        // Request only needed fields: items(id, name, owner(id), external_urls)
        const playlistCheckFields = 'items(id,name,owner(id),external_urls)';
        const userPlaylistsResponse = await axios.get(
          `https://api.spotify.com/v1/me/playlists`,
          {
            params: { limit: maxPlaylistsToCheck, fields: playlistCheckFields }, // Add fields
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );

        const userPlaylists = userPlaylistsResponse.data.items || []; // Ensure it's an array
        const foundPlaylist = userPlaylists.find(
          (p: any) => p.name === playlistName && p.owner.id === userId
        );

        if (foundPlaylist) {
          existingPlaylistId = foundPlaylist.id;
          playlistUrl = foundPlaylist.external_urls.spotify;
          this.logger.log(
            color.blue.bold(
              `Found existing playlist "${color.white.bold(
                playlistName
              )}" with ID ${color.white.bold(
                existingPlaylistId
              )}. Will update tracks.`
            )
          );
        }
      } catch (playlistFetchError) {
        this.logger.log(
          color.yellow.bold(
            `Could not fetch user playlists to check for existing one: ${playlistFetchError}`
          )
        );
        // Continue to create a new playlist if fetching fails
      }
      // --- End Check for existing playlist ---

      let playlistId: string;
      // Use the existingPlaylistId found above
      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
        // Replace tracks in the existing playlist
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
        // Ensure playlistUrl is set if we found an existing playlist
        if (!playlistUrl) {
          // Fetch details if URL wasn't included in the initial check (e.g., due to fields param)
          const playlistDetails = await this.getPlaylist(playlistId); // Use internal getPlaylist
          playlistUrl = playlistDetails.success
            ? playlistDetails.data?.external_urls?.spotify || ''
            : '';
        }
      } else {
        // Create a new playlist if none found
        this.logger.log(
          color.blue.bold(
            `No existing playlist found named "${color.white.bold(
              playlistName
            )}". Creating new playlist for user ${userId}.`
          )
        );
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

      // Return the essential playlist info
      return {
        success: true,
        data: {
          playlistId: playlistId, // Use consistent naming
          playlistUrl: playlistUrl,
          playlistName: playlistName,
        },
      };
    } catch (error) {
      return this.handleApiError(
        error,
        `creating/updating playlist "${playlistName}"`
      );
    }
  }

  /**
   * Generates the Spotify authorization URL.
   * @returns {string | null} The authorization URL or null if configuration is missing.
   */
  public getAuthorizationUrl(): string | null {
    if (!this.clientId) {
      this.logger.log(
        color.red.bold('Missing Spotify Client ID for generating auth URL.')
      );
      return null;
    }
    const scope = 'playlist-modify-public'; // Define the required scope
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${
      this.clientId
    }&response_type=code&redirect_uri=${encodeURIComponent(
      this.redirectUri
    )}&scope=${encodeURIComponent(scope)}`;
    return authUrl;
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
      const response = await axios.get(
        `https://api.spotify.com/v1/me/playlists`,
        {
          params: {
            limit: limit,
            offset: offset,
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `fetching user playlists`);
    }
  }
}

export default SpotifyApi;
