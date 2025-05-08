import axios, { AxiosRequestConfig, AxiosError } from 'axios';
import Logger from './logger';
import Cache from './cache'; // Needed for queue implementation details
import AnalyticsClient from './analytics';
import { color } from 'console-log-colors';
import { ApiResult } from './interfaces/ApiResult'; // Assuming ApiResult interface exists

// --- RapidAPI Queue (Copied from spotify.ts for encapsulation) ---
// In a larger refactor, this might live in its own file.
class RapidAPIQueue {
  private cache: Cache;
  private static instance: RapidAPIQueue;
  private logger = new Logger();

  private constructor() {
    this.cache = Cache.getInstance();
  }

  public static getInstance(): RapidAPIQueue {
    if (!RapidAPIQueue.instance) {
      RapidAPIQueue.instance = new RapidAPIQueue();
    }
    return RapidAPIQueue.instance;
  }

  public async enqueue(request: AxiosRequestConfig): Promise<void> {
    // Store essential parts of the config; storing the whole object might be too large/complex
    const simplifiedRequest = {
      method: request.method,
      url: request.url,
      params: request.params,
      headers: {
        // Only include necessary headers
        'x-rapidapi-key': request.headers?.['x-rapidapi-key'],
        'x-rapidapi-host': request.headers?.['x-rapidapi-host'],
      },
    };
    await this.enqueueRapidAPIRequest(JSON.stringify(simplifiedRequest));
  }

  public async processQueue(): Promise<void> {
    while (true) {
      const queueLength = await this.getRapidAPIQueueLength();
      if (queueLength === 0) {
        break;
      }

      const lastRequestTime = await this.getLastRequestTimestamp();
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      const delay = 250; // 4 requests per second

      if (timeSinceLastRequest < delay) {
        await new Promise((resolve) =>
          setTimeout(resolve, delay - timeSinceLastRequest)
        );
      }

      const requestStr = await this.dequeueRapidAPIRequest();
      if (requestStr) {
        const requestConfig = JSON.parse(requestStr) as AxiosRequestConfig; // Type assertion
        let attempt = 0;
        const maxAttempts = 3;
        const functionName = requestConfig.url?.includes('playlist_tracks')
          ? 'getTracks'
          : requestConfig.url?.includes('playlist')
          ? 'getPlaylist'
          : requestConfig.url?.includes('tracks')
          ? 'getTracksByIds'
          : requestConfig.url?.includes('search')
          ? 'searchTracks'
          : 'unknown';

        while (attempt < maxAttempts) {
          try {
            // Execute the request using the stored config
            const response = await axios(requestConfig);
            await this.setLastRequestTimestamp(Date.now());
            // Here, we ideally need a way to return the result to the original caller.
            // This simple queue doesn't handle that directly.
            // For now, we just log success. A more complex system (e.g., using Promises or callbacks)
            // would be needed to return data asynchronously.
            this.logger.log(
              color.green(`RapidAPI request for ${functionName} successful.`)
            );
            break; // Exit loop if request is successful
          } catch (error: any) {
            const axiosError = error as AxiosError;
            if (axiosError.response && axiosError.response.status === 404) {
              this.logger.log(
                color.yellow(
                  `RapidAPI request for ${functionName} resulted in 404.`
                )
              );
              break; // Don't retry 404s
            } else {
              attempt++;
              this.logger.log(
                color.red.bold(
                  `Error in RapidAPI ${functionName}, attempt ${attempt}/${maxAttempts}. Retrying in 1s... (${error.message})`
                )
              );
              if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } else {
                this.logger.log(
                  color.red.bold(
                    `RapidAPI request for ${functionName} failed after ${maxAttempts} attempts.`
                  )
                );
                // How to signal failure back to the caller? Again, needs a more complex mechanism.
              }
            }
          }
        }
      }
    }
  }

  private async enqueueRapidAPIRequest(request: string): Promise<void> {
    await this.cache.executeCommand('rpush', 'rapidapi_queue', request);
  }

  private async dequeueRapidAPIRequest(): Promise<string | null> {
    return await this.cache.executeCommand('lpop', 'rapidapi_queue');
  }

  private async getRapidAPIQueueLength(): Promise<number> {
    return await this.cache.executeCommand('llen', 'rapidapi_queue');
  }

  private async setLastRequestTimestamp(timestamp: number): Promise<void> {
    await this.cache.executeCommand(
      'set',
      'last_rapidapi_request',
      timestamp.toString()
    );
  }

  private async getLastRequestTimestamp(): Promise<number> {
    const timestamp = await this.cache.executeCommand(
      'get',
      'last_rapidapi_request'
    );
    return timestamp ? parseInt(timestamp, 10) : 0;
  }
}
// --- End RapidAPI Queue ---

class SpotifyScraper {
  private logger = new Logger();
  private analytics = AnalyticsClient.getInstance();
  private rapidAPIQueue = RapidAPIQueue.getInstance();
  private rapidApiKey = process.env['RAPID_API_KEY'];
  private rapidApiHost = 'spotify-scraper.p.rapidapi.com';

  /**
   * Helper to create standard RapidAPI request options.
   * @param endpoint The specific endpoint path (e.g., '/playlist').
   * @param params Query parameters.
   * @returns AxiosRequestConfig
   */
  private createOptions(endpoint: string, params: any): AxiosRequestConfig {
    if (!this.rapidApiKey) {
      throw new Error('RAPID_API_KEY environment variable is not defined');
    }
    return {
      method: 'GET',
      url: `https://${this.rapidApiHost}${endpoint}`,
      params: params,
      headers: {
        'x-rapidapi-key': this.rapidApiKey,
        'x-rapidapi-host': this.rapidApiHost,
      },
    };
  }

  /**
   * Enqueues a request to fetch playlist details from RapidAPI.
   * Note: This returns immediately after enqueueing. The result processing happens in the queue.
   * @param playlistId The Spotify ID of the playlist.
   * @returns {Promise<ApiResult>} Contains playlist data or error info.
   */
  public async getPlaylist(playlistId: string): Promise<ApiResult> {
    try {
      const options = this.createOptions('/v1/playlist/metadata', {
        playlistId: playlistId,
      });
      // Make the request directly
      const response = await axios.request(options);

      if (response.data && response.data.status === true) {
        this.analytics.increaseCounter(
          'spotify_rapidapi',
          'getPlaylist_called',
          1
        );

        // Transform the scraper API response to match the expected format
        const apiData = response.data;

        const playlistImage =
          apiData.images &&
          apiData.images.length > 0 &&
          apiData.images[0] &&
          apiData.images[0].length > 0
            ? apiData.images[0][0].url
            : '';

        const transformedData = {
          id: apiData.id,
          playlistId: apiData.id, // Assuming scraper's id is the playlistId
          name: apiData.name,
          description: apiData.description || '',
          numberOfTracks: apiData.trackCount || 0,
          images: playlistImage ? [{ url: playlistImage }] : [],
          tracks: { total: apiData.trackCount || 0 }, // To match spotify_api structure if spotify.ts uses it
        };

        return { success: true, data: transformedData };
      } else {
        // Scraper API indicated an error or returned unexpected data
        const errorMessage =
          response.data?.errorId || 'Unexpected response from Scraper API';
        this.logger.log(
          color.yellow(
            `Scraper API getPlaylist for ${playlistId} failed: ${errorMessage}`
          )
        );
        // Assuming 'PlaylistProcessError' or similar might be a specific errorId for not found
        // Adjust if specific errorIds for "not found" are known
        if (
          errorMessage.toLowerCase().includes('not found') ||
          errorMessage.toLowerCase().includes('invalid playlistid')
        ) {
          return { success: false, error: 'playlistNotFound' };
        }
        return { success: false, error: `Scraper API error: ${errorMessage}` };
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching Scraper API playlist ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        // HTTP 404
        return { success: false, error: 'playlistNotFound' };
      }
      // Return a generic error for other issues
      return {
        success: false,
        error: `Scraper API error fetching playlist: ${status || message}`,
      };
    }
  }

  /**
   * Enqueues requests to fetch all tracks for a playlist from RapidAPI, handling pagination.
   * Note: This returns immediately after enqueueing the *first* request.
   * The queue processor needs to handle fetching subsequent pages if the API doesn't return all tracks at once.
   * @param playlistId The Spotify ID of the playlist.
   * @param limit Number of tracks per page (RapidAPI default/max might vary).
   * Fetches all tracks for a playlist from RapidAPI, handling pagination.
   * @param playlistId The Spotify ID of the playlist.
   * @returns {Promise<ApiResult>} Contains an array of track items or error info.
   */
  public async getTracks(playlistId: string): Promise<ApiResult> {
    this.logger.log(
      color.blue.bold(
        `Fetching tracks in ${color.white.bold(
          'Scraper API' // Updated to reflect the new API
        )} for playlist ${color.white.bold(playlistId)}`
      )
    );

    try {
      const options = this.createOptions('/v1/playlist/contents', {
        playlistId: playlistId,
      });

      // Make the request directly
      const response = await axios.request(options);
      this.analytics.increaseCounter(
        'spotify_rapidapi', // Keeping this counter name for now
        'getTracks_called',
        1
      );

      if (response.data && response.data.status === true) {
        if (
          response.data.contents &&
          Array.isArray(response.data.contents.items)
        ) {
          // The new API returns all items directly under contents.items
          // and contents also includes totalCount.
          return { success: true, data: response.data.contents };
        } else {
          this.logger.log(
            color.yellow(
              `Scraper API getTracks for ${playlistId} returned unexpected data structure.`
            )
          );
          return {
            success: false,
            error: 'Unexpected data structure from Scraper API',
          };
        }
      } else {
        // Scraper API indicated an error
        const errorMessage =
          response.data?.errorId || 'Unknown error from Scraper API';
        this.logger.log(
          color.yellow(
            `Scraper API getTracks for ${playlistId} failed: ${errorMessage}`
          )
        );
        if (
          errorMessage.toLowerCase().includes('not found') ||
          errorMessage.toLowerCase().includes('invalid playlistid')
        ) {
          return { success: false, error: 'playlistNotFound' };
        }
        return { success: false, error: `Scraper API error: ${errorMessage}` };
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching Scraper API tracks for ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        // HTTP 404
        return { success: false, error: 'playlistNotFound' };
      }
      // Return a generic error for other issues
      return {
        success: false,
        error: `Scraper API error fetching tracks: ${status || message}`,
      };
    }
  }

  /**
   * Enqueues a request to fetch details for multiple tracks by ID from RapidAPI.
   * @param trackIds Array of Spotify track IDs.
   * Fetches details for multiple tracks by ID from RapidAPI.
   * @param trackIds Array of Spotify track IDs.
   * @returns {Promise<ApiResult>} Contains track data or error info.
   */
  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    if (!trackIds || trackIds.length === 0) {
      return { success: false, error: 'No track IDs provided' };
    }
    // Note: Check RapidAPI documentation for limits on number of IDs per request.
    // This implementation assumes the API handles the comma-separated list correctly
    // and doesn't require chunking like the official Spotify API. Adjust if needed.
    try {
      const options = this.createOptions('/tracks/', {
        ids: trackIds.join(','),
      });
      // Make the request directly
      const response = await axios.request(options);
      this.analytics.increaseCounter(
        'spotify_rapidapi',
        'getTracksByIds_called',
        1
      );

      if (!response.data || !response.data.tracks) {
        this.logger.log(
          color.yellow(`RapidAPI getTracksByIds returned unexpected data.`)
        );
        return { success: false, error: 'Unexpected response from RapidAPI' };
      }

      // Return the tracks array directly under the 'tracks' key in data
      return { success: true, data: { tracks: response.data.tracks } };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching RapidAPI tracks by IDs: ${status} - ${message}`
        )
      );

      if (status === 404) {
        // RapidAPI might return 404 if *any* ID is invalid, or only if *all* are.
        // Returning a generic error might be safer unless the behavior is known.
        return {
          success: false,
          error:
            'RapidAPI resource not found (one or more track IDs might be invalid)',
        };
      }
      // Return a generic error for other issues
      return {
        success: false,
        error: `RapidAPI error fetching tracks by IDs: ${status || message}`,
      };
    }
  }

  /**
   * Enqueues a request to search for tracks on RapidAPI.
   * @param searchTerm The search query.
   * @param limit Max number of results.
   * @param offset Offset for pagination.
   * @returns {Promise<ApiResult>} Contains search results or error info.
   */
  public async searchTracks(
    searchTerm: string,
    limit: number = 10,
    offset: number = 0
  ): Promise<ApiResult> {
    if (!searchTerm) {
      return { success: false, error: 'Search term is required' };
    }

    // Logger call for searching tracks is intentionally omitted as per previous version.

    try {
      const options = this.createOptions('/v1/search', {
        term: searchTerm,
        type: 'track', // API expects 'track' (singular)
        // limit and offset are not supported by this Scraper API endpoint
      });

      // Make the request directly
      const response = await axios.request(options);

      this.analytics.increaseCounter(
        'spotify_rapidapi', // Consider changing to 'spotify_scraper' for clarity
        'searchTracks_called',
        1
      );

      if (response.data && response.data.status === true) {
        if (response.data.tracks && Array.isArray(response.data.tracks.items)) {
          const transformedItems = response.data.tracks.items
            .map((apiItem: any) => {
              if (!apiItem || !apiItem.id) {
                this.logger.log(
                  color.yellow(
                    'Scraper API search returned an item without an ID. Skipping.'
                  )
                );
                return null;
              }

              let artistsList = [{ name: 'Unknown Artist' }];
              if (
                apiItem.artists &&
                Array.isArray(apiItem.artists) &&
                apiItem.artists.length > 0
              ) {
                const mappedArtists = apiItem.artists
                  .map((artist: any) =>
                    artist.name ? { name: artist.name } : null
                  )
                  .filter((artist: any) => artist !== null);
                if (mappedArtists.length > 0) {
                  artistsList = mappedArtists;
                }
              }

              let albumImagesList: { url: string }[] = [];
              if (
                apiItem.album &&
                apiItem.album.cover &&
                Array.isArray(apiItem.album.cover) &&
                apiItem.album.cover.length > 0
              ) {
                albumImagesList = apiItem.album.cover
                  .map((image: any) => (image.url ? { url: image.url } : null))
                  .filter((image: any) => image !== null);
              }
              const albumName = apiItem.album?.name || 'Unknown Album';

              return {
                id: apiItem.id,
                name: apiItem.name || 'Unknown Track',
                artists: artistsList,
                album: {
                  name: albumName,
                  images: albumImagesList,
                },
                // Add other fields if spotify.ts expects them, e.g., external_urls, preview_url
                // external_urls: { spotify: apiItem.shareUrl }, // Example based on new API structure
                // preview_url: null, // New API doesn't seem to provide preview_url directly in search
              };
            })
            .filter((track: any) => track !== null);

          const total =
            typeof response.data.tracks.totalCount === 'number'
              ? response.data.tracks.totalCount
              : transformedItems.length;

          return {
            success: true,
            data: {
              tracks: {
                items: transformedItems,
                total: total,
              },
            },
          };
        } else {
          this.logger.log(
            color.yellow(
              `Scraper API searchTracks for "${searchTerm}" returned no items or an unexpected data structure.`
            )
          );
          return {
            success: false,
            error:
              'No items or unexpected data structure from Scraper API search',
          };
        }
      } else {
        // Scraper API indicated an error
        const errorMessage =
          response.data?.errorId || 'Unknown error from Scraper API';
        this.logger.log(
          color.yellow(
            `Scraper API searchTracks for "${searchTerm}" failed: ${errorMessage}`
          )
        );
        return { success: false, error: `Scraper API error: ${errorMessage}` };
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error searching Scraper API tracks for "${searchTerm}": ${status} - ${message}`
        )
      );

      // Return a generic error for search issues
      return {
        success: false,
        error: `Scraper API error searching tracks: ${status || message}`,
      };
    }
  }

  // Method to explicitly trigger queue processing (might be called from a cron job or specific event)
  public async processApiQueue(): Promise<void> {
    this.logger.log(color.blue('Starting RapidAPI queue processing...'));
    await this.rapidAPIQueue.processQueue();
    this.logger.log(color.blue('RapidAPI queue processing finished.'));
  }
}

export default SpotifyScraper;
