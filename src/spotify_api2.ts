import axios, { AxiosError, AxiosResponse } from 'axios';
import Logger from './logger';
import Settings from './settings';
import { color } from 'console-log-colors';
import { ApiResult } from './interfaces/ApiResult';
import { ProgressCallback } from './interfaces/IMusicProvider';
import {
  SPOTIFY_CONCURRENT_REQUESTS,
  SPOTIFY_PAGE_LIMIT,
  SPOTIFY_PAGE_LIMIT_FALLBACK,
} from './config/constants';

/**
 * SpotifyApi2 — Standalone provider for Spotify's post-March-2026 API format.
 *
 * Key differences from SpotifyApi (spotify_api.ts):
 * - `tracks` field renamed to `items` in playlist responses
 * - `track` field renamed to `item` in track item responses
 * - `external_ids` removed from the API
 * - Batch GET /v1/tracks endpoint removed (delegates to SpotifyScraper)
 * - POST /v1/users/{id}/playlists removed (uses /v1/me/playlists)
 *
 * All responses are **normalized back to the old format** so that
 * spotify.ts needs zero changes.
 */

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

interface SpotifyErrorResponse {
  error: {
    status: number;
    message: string;
  };
}

class SpotifyApi2 {
  private logger = new Logger();
  private settings = Settings.getInstance();
  private clientId = process.env['SPOTIFY_CLIENT_ID'];
  private clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
  private redirectUri =
    process.env['SPOTIFY_REDIRECT_URI'] ||
    'http://localhost:3004/spotify_callback';

  public async getAccessToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.log(color.red.bold('Missing Spotify API credentials'));
      return null;
    }

    let accessToken = await this.settings.getSetting('spotify_access_token');
    const refreshToken = await this.settings.getSetting('spotify_refresh_token');
    const expiresAtStr = await this.settings.getSetting('spotify_token_expires_at');
    const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

    if (accessToken && Date.now() < expiresAt) {
      return accessToken;
    }

    if (refreshToken) {
      const refreshedToken = await this.refreshAccessToken(refreshToken);
      if (refreshedToken) {
        return refreshedToken;
      } else {
        this.logger.log(
          color.yellow.bold('Spotify token refresh failed. Authorization might be required.')
        );
        return null;
      }
    }

    this.logger.log(
      color.yellow.bold('No valid Spotify access token or refresh token found. Authorization required.')
    );
    return null;
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
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

      const { access_token, expires_in, refresh_token: newRefreshToken } = response.data;
      const newExpiresAt = Date.now() + (expires_in - 60) * 1000;

      await this.settings.setSetting('spotify_access_token', access_token);
      await this.settings.setSetting('spotify_token_expires_at', newExpiresAt.toString());
      if (newRefreshToken) {
        await this.settings.setSetting('spotify_refresh_token', newRefreshToken);
      }

      this.logger.log(
        color.green.bold(`[${color.white.bold('spotify-api2')}] Successfully refreshed token.`)
      );
      return access_token;
    } catch (error) {
      this.logger.log(
        color.red.bold(`[${color.white.bold('spotify-api2')}] Token refresh error: ${error}`)
      );
      return null;
    }
  }

  private handleApiError(error: any, context: string): ApiResult {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<SpotifyErrorResponse>;
      const status = axiosError.response?.status;
      const message = axiosError.response?.data?.error?.message || axiosError.message;

      if (status === 401) {
        this.settings.deleteSetting('spotify_access_token');
        this.settings.deleteSetting('spotify_token_expires_at');
        return {
          success: false,
          error: 'Spotify authorization error (token likely expired/invalid)',
          needsReAuth: true,
          authUrl: this.getAuthorizationUrl() ?? undefined,
        };
      } else if (status === 400) {
        if (
          message &&
          (message.toLowerCase().includes('invalid_grant') ||
            message.toLowerCase().includes('invalid_request') ||
            message.toLowerCase().includes('invalid client') ||
            message.toLowerCase().includes('invalid_token') ||
            message.toLowerCase().includes('token expired'))
        ) {
          this.settings.deleteSetting('spotify_access_token');
          this.settings.deleteSetting('spotify_token_expires_at');
          return {
            success: false,
            error: 'Spotify authorization error (token likely expired/invalid)',
            needsReAuth: true,
            authUrl: this.getAuthorizationUrl() ?? undefined,
          };
        }
        return { success: false, error: 'Spotify API error: 400 Bad Request', needsReAuth: false };
      } else if (status === 404) {
        return { success: false, error: 'Spotify resource not found', needsReAuth: false };
      } else if (status === 429) {
        const retryAfter = axiosError.response?.headers?.['retry-after'];
        const errorMessage = `Spotify API error: 429 Too Many Requests. ${
          retryAfter ? `Retry after: ${retryAfter} seconds.` : 'No Retry-After header.'
        }`;
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
          needsReAuth: false,
        };
      }
    } else {
      this.logger.log(color.red.bold(`Non-API error ${context}: ${error}`));
      return { success: false, error: `Internal error ${context}`, needsReAuth: false };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: string,
    maxRetries: number = 3
  ): Promise<T | ApiResult> {
    let retries = 0;
    let lastError: any;

    while (retries < maxRetries) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'];
          const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : null;

          if (retries < maxRetries - 1) {
            let waitTimeMs: number;
            if (retryAfterSeconds) {
              waitTimeMs = retryAfterSeconds * 1000 + 500;
            } else {
              const baseDelay = Math.pow(2, retries) * 1000;
              const jitter = Math.random() * 1000;
              waitTimeMs = baseDelay + jitter;
            }

            this.logger.log(
              color.yellow.bold(
                `[${color.white.bold('spotify-api2')}] Rate limit hit ${color.white.bold(context)}. Waiting ${color.white.bold(waitTimeMs)} ms before retry ${color.white.bold(retries + 1)} / ${color.white.bold(maxRetries)}`
              )
            );

            await this.delay(waitTimeMs);
            retries++;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private async getUserId(accessToken: string): Promise<string | null> {
    try {
      const result = await this.executeWithRetry(async () => {
        const response = await axios.get('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        return response.data;
      }, 'fetching user ID');

      if (result && typeof result === 'object' && 'success' in result) {
        return null;
      }
      return result.id;
    } catch (error) {
      this.logger.log(color.red.bold(`Error fetching Spotify user ID: ${error}`));
      return null;
    }
  }

  public isSpotifyOwnedPlaylist(playlistId: string): { isOwned: boolean; type?: string } {
    if (playlistId.startsWith('37i9dQZF1DX')) return { isOwned: true, type: 'editorial' };
    if (playlistId.startsWith('37i9dQZF1DZ')) return { isOwned: true, type: 'this_is' };
    if (playlistId.startsWith('37i9dQZF1E')) return { isOwned: true, type: 'daily_mix' };
    if (playlistId.startsWith('37i9dQZEVX')) return { isOwned: true, type: 'personalized' };
    return { isOwned: false };
  }

  /**
   * Fetches playlist details using new API format.
   * New API: `items(total)` instead of `tracks(total)`
   * Normalizes response back to old format: data.tracks = data.items
   */
  public async getPlaylist(playlistId: string): Promise<ApiResult> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined,
      };
    }

    try {
      // New API: tracks → items
      const fields = 'id,name,description,images(url),items(total)';

      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}`,
        {
          params: { fields },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      const data = response.data;

      // Normalize: items → tracks for backwards compatibility
      if (data.items && !data.tracks) {
        data.tracks = data.items;
        delete data.items;
      }

      return { success: true, data };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const ownershipCheck = this.isSpotifyOwnedPlaylist(playlistId);
        if (ownershipCheck.isOwned) {
          return {
            success: false,
            error: 'spotifyOwnedPlaylist',
            playlistType: ownershipCheck.type,
          };
        }
      }
      return this.handleApiError(error, `fetching playlist ${playlistId}`);
    }
  }

  /**
   * Fetches all tracks from a playlist using new API format.
   * New API: `item(...)` instead of `track(...)`, no `external_ids`
   * Normalizes each response item: item.item → item.track
   */
  public async getTracks(playlistId: string, onProgress?: ProgressCallback): Promise<ApiResult> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined,
      };
    }

    const startTime = Date.now();
    let usedLimit = SPOTIFY_PAGE_LIMIT;

    try {
      // New API: track → item, no external_ids
      const fieldsParam = 'items(item(id,name,artists(name),album(name,images,release_date),external_urls,preview_url)),next,total';
      const initialUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${SPOTIFY_PAGE_LIMIT}&offset=0&fields=${fieldsParam}`;

      let initialResponse: AxiosResponse<any>;
      try {
        initialResponse = await axios.get(initialUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (error: any) {
        if (error.response && error.response.status === 400) {
          usedLimit = SPOTIFY_PAGE_LIMIT_FALLBACK;
          const fallbackUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${SPOTIFY_PAGE_LIMIT_FALLBACK}&offset=0&fields=${fieldsParam}`;
          initialResponse = await axios.get(fallbackUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        } else {
          throw error;
        }
      }

      const initialData = initialResponse.data;
      const total = initialData.total || 0;

      // Normalize: item → track in each item
      this.normalizeTrackItems(initialData.items);

      const validInitialItems = initialData.items.filter(
        (item: any) => item && item.track
      );

      if (onProgress && total > 0) {
        const percentage = Math.min(99, Math.round((validInitialItems.length / total) * 100));
        onProgress({
          stage: 'fetching_metadata',
          current: validInitialItems.length,
          total: total,
          percentage: Math.max(1, percentage),
          message: 'progress.loaded',
        });
      }

      if (validInitialItems.length >= total) {
        const elapsed = Date.now() - startTime;
        this.logger.log(
          color.blue.bold(`[${color.white.bold('spotify-api2')}] Fetched ${color.white.bold(total)} tracks in ${color.white.bold(elapsed + 'ms')} (single request)`)
        );
        return { success: true, data: { items: validInitialItems } };
      }

      const remainingTracks = total - validInitialItems.length;
      const totalPages = Math.ceil(remainingTracks / usedLimit);

      const pageRequests: Array<{ offset: number; pageIndex: number }> = [];
      for (let i = 1; i <= totalPages; i++) {
        pageRequests.push({ offset: i * usedLimit, pageIndex: i });
      }

      const allItems = [...validInitialItems];
      const pageResults = await this.fetchTracksInBatches(
        playlistId, pageRequests, usedLimit, accessToken, fieldsParam,
        onProgress, total, validInitialItems.length
      );

      for (const pageResult of pageResults) {
        if (pageResult.status === 'fulfilled' && pageResult.value.success) {
          const validItems = pageResult.value.items.filter(
            (item: any) => item && item.track
          );
          allItems.push(...validItems);
        } else if (pageResult.status === 'rejected' || !pageResult.value.success) {
          this.logger.log(
            color.yellow(`[${color.white.bold('spotify-api2')}] Parallel fetch failed, falling back to sequential for playlist ${playlistId}`)
          );
          return this.getTracksSequential(playlistId, accessToken);
        }
      }

      const elapsed = Date.now() - startTime;
      this.logger.log(
        color.blue.bold(
          `[${color.white.bold('spotify-api2')}] Fetched ${color.white.bold(allItems.length)} tracks in ${color.white.bold(elapsed + 'ms')} (parallel: ${color.white.bold(pageRequests.length + 1)} requests, limit = ${color.white.bold(usedLimit)})`
        )
      );

      return { success: true, data: { items: allItems } };
    } catch (error) {
      this.logger.log(
        color.yellow(`[${color.white.bold('spotify-api2')}] Parallel fetch error for playlist ${playlistId}, falling back to sequential`)
      );
      try {
        return await this.getTracksSequential(playlistId, accessToken);
      } catch (fallbackError) {
        return this.handleApiError(fallbackError, `fetching tracks for playlist ${playlistId}`);
      }
    }
  }

  /**
   * Normalizes new API format items: renames `item` to `track` in each entry.
   */
  private normalizeTrackItems(items: any[]): void {
    if (!items) return;
    for (const entry of items) {
      if (entry && entry.item && !entry.track) {
        entry.track = entry.item;
        delete entry.item;
      }
    }
  }

  private async fetchTracksInBatches(
    playlistId: string,
    pageRequests: Array<{ offset: number; pageIndex: number }>,
    limit: number,
    accessToken: string,
    fieldsParam: string,
    onProgress?: ProgressCallback,
    totalTracks?: number,
    initialItemsCount?: number
  ): Promise<PromiseSettledResult<{ success: boolean; items: any[] }>[]> {
    const results: PromiseSettledResult<{ success: boolean; items: any[] }>[] = [];
    let totalFetched = initialItemsCount || 0;

    for (let i = 0; i < pageRequests.length; i += SPOTIFY_CONCURRENT_REQUESTS) {
      const batch = pageRequests.slice(i, i + SPOTIFY_CONCURRENT_REQUESTS);

      const batchPromises = batch.map(async ({ offset }) => {
        const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=${fieldsParam}`;

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response: AxiosResponse<any> = await axios.get(url, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            const items = response.data.items || [];
            // Normalize: item → track
            this.normalizeTrackItems(items);
            return { success: true, items };
          } catch (error: any) {
            if (error.response && error.response.status === 429) {
              throw error;
            }
            if (attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
        return { success: false, items: [] };
      });

      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults);

      if (onProgress && totalTracks && totalTracks > 0) {
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value.success) {
            totalFetched += result.value.items.filter((item: any) => item && item.track).length;
          }
        }
        const percentage = Math.min(99, Math.round((totalFetched / totalTracks) * 100));
        onProgress({
          stage: 'fetching_metadata',
          current: totalFetched,
          total: totalTracks,
          percentage: Math.max(1, percentage),
          message: 'progress.loaded',
        });
      }
    }

    return results;
  }

  /**
   * Sequential fallback for track fetching using new API format.
   */
  private async getTracksSequential(
    playlistId: string,
    accessToken: string
  ): Promise<ApiResult> {
    let allItems: any[] = [];
    // New API: item instead of track, no external_ids
    let nextUrl: string | null =
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&fields=items(item(id,name,artists(name),album(name,images,release_date),external_urls,preview_url)),next`;

    try {
      while (nextUrl) {
        const currentUrl = nextUrl;
        const response: AxiosResponse<any> = await axios.get(currentUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const result = response.data;

        // Normalize: item → track
        this.normalizeTrackItems(result.items);

        const validItems = result.items.filter((item: any) => item && item.track);
        allItems = allItems.concat(validItems);
        nextUrl = result.next;
      }
      return { success: true, data: { items: allItems } };
    } catch (error) {
      return this.handleApiError(
        error,
        `fetching tracks for playlist ${playlistId} (sequential fallback)`
      );
    }
  }

  /**
   * Fetches tracks by IDs — delegates to SpotifyScraper since the batch
   * GET /v1/tracks endpoint has been removed in the new API.
   */
  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    if (!trackIds || trackIds.length === 0) {
      return { success: false, error: 'No track IDs provided' };
    }

    // Batch endpoint removed in new API — delegate to scraper
    const SpotifyScraper = (await import('./spotify_scraper')).default;
    const scraper = new SpotifyScraper();

    this.logger.log(
      color.blue.bold(
        `[${color.white.bold('spotify-api2')}] Delegating getTracksByIds (${color.white.bold(trackIds.length)} tracks) to SpotifyScraper`
      )
    );

    return scraper.getTracksByIds(trackIds);
  }

  /**
   * Search tracks — unchanged from old API format.
   */
  public async searchTracks(
    searchTerm: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<ApiResult> {
    if (!searchTerm) {
      return { success: false, error: 'Search term is required' };
    }

    limit = Math.min(limit, 50);

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        error: 'Spotify authentication required',
        needsReAuth: true,
        authUrl: this.getAuthorizationUrl() ?? undefined,
      };
    }

    try {
      const fields = 'tracks(items(id,name,artists(name),album(images(url))),total)';
      const response = await axios.get('https://api.spotify.com/v1/search', {
        params: {
          q: searchTerm,
          type: 'track',
          limit,
          offset,
          fields,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      return { success: true, data: response.data };
    } catch (error) {
      return this.handleApiError(error, `searching tracks for "${searchTerm}"`);
    }
  }

  /**
   * Create or update playlist — uses POST /v1/me/playlists (new API).
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
        authUrl: this.getAuthorizationUrl() ?? undefined,
      };
    }

    const trackUris = trackIds.map((id) => `spotify:track:${id}`);
    const playlistDescription = 'Created automatically.';

    // Fetch User ID for ownership check
    const userId = await this.getUserId(accessToken);

    try {
      let existingPlaylistId: string | null = null;
      let playlistUrl: string | null = null;
      const maxPlaylistsToCheck = 50;

      try {
        const playlistCheckFields = 'items(id,name,owner(id),external_urls)';

        const playlistsResult = await this.executeWithRetry(async () => {
          const response = await axios.get('https://api.spotify.com/v1/me/playlists', {
            params: { limit: maxPlaylistsToCheck, fields: playlistCheckFields },
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          return response.data;
        }, 'fetching user playlists for duplicate check');

        if (playlistsResult && typeof playlistsResult === 'object' && 'success' in playlistsResult) {
          // Failed to fetch — continue to create new
        } else {
          const userPlaylists = playlistsResult.items || [];
          const foundPlaylist = userPlaylists.find(
            (p: any) => p.name === playlistName && (userId ? p.owner.id === userId : true)
          );

          if (foundPlaylist) {
            existingPlaylistId = foundPlaylist.id;
            playlistUrl = foundPlaylist.external_urls.spotify;
          }
        }
      } catch {
        // Continue to create new if fetching fails
      }

      let playlistId: string;
      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
        const chunkSize = 100;
        for (let i = 0; i < trackUris.length; i += chunkSize) {
          const chunk = trackUris.slice(i, i + chunkSize);
          const method = i === 0 ? 'put' : 'post';

          const updateResult = await this.executeWithRetry(async () => {
            await axios({
              method,
              url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              data: JSON.stringify({ uris: chunk }),
            });
            return { success: true };
          }, `updating playlist ${playlistId} tracks`);

          if (updateResult && typeof updateResult === 'object' && 'success' in updateResult && !(updateResult as any).success) {
            return updateResult as ApiResult;
          }
        }
        if (!playlistUrl) {
          const playlistDetails = await this.getPlaylist(playlistId);
          playlistUrl = playlistDetails.success ? playlistDetails.data?.external_urls?.spotify || '' : '';
        }
      } else {
        const createResult = await this.executeWithRetry(async () => {
          const response = await axios.post(
            'https://api.spotify.com/v1/me/playlists',
            JSON.stringify({
              name: playlistName,
              description: playlistDescription,
              public: true,
            }),
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
            }
          );
          return response.data;
        }, `creating playlist "${playlistName}"`);

        if (createResult && typeof createResult === 'object' && 'success' in createResult) {
          return createResult as ApiResult;
        }

        playlistId = createResult.id;
        playlistUrl = createResult.external_urls.spotify;

        const chunkSize = 100;
        for (let i = 0; i < trackUris.length; i += chunkSize) {
          const chunk = trackUris.slice(i, i + chunkSize);

          const addResult = await this.executeWithRetry(async () => {
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
            return { success: true };
          }, `adding tracks to playlist ${playlistId}`);

          if (addResult && typeof addResult === 'object' && 'success' in addResult && !(addResult as any).success) {
            return addResult as ApiResult;
          }
        }
      }

      return {
        success: true,
        data: {
          playlistId,
          playlistUrl,
          playlistName,
        },
      };
    } catch (error) {
      return this.handleApiError(error, `creating/updating playlist "${playlistName}"`);
    }
  }

  public getAuthorizationUrl(): string | null {
    if (!this.clientId) {
      return null;
    }
    const scope = 'playlist-modify-public';
    return `https://accounts.spotify.com/authorize?client_id=${
      this.clientId
    }&response_type=code&redirect_uri=${encodeURIComponent(
      this.redirectUri
    )}&scope=${encodeURIComponent(scope)}`;
  }
}

export default SpotifyApi2;
