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

class SpotifyRapidApi {
  private logger = new Logger();
  private analytics = AnalyticsClient.getInstance();
  private rapidAPIQueue = RapidAPIQueue.getInstance();
  private rapidApiKey = process.env['RAPID_API_KEY'];
  private rapidApiHost = 'spotify23.p.rapidapi.com';

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
      const options = this.createOptions('/playlist', { id: playlistId });
      // Make the request directly
      const response = await axios.request(options);
      this.analytics.increaseCounter(
        'spotify_rapidapi',
        'getPlaylist_called',
        1
      );

      // Check if the response contains the expected data structure
      // Adjust this check based on the actual structure returned by RapidAPI for playlists
      if (!response.data) {
        // A basic check, might need to be more specific (e.g., response.data.name)
        this.logger.log(
          color.yellow(
            `RapidAPI getPlaylist for ${playlistId} returned unexpected data.`
          )
        );
        return { success: false, error: 'Unexpected response from RapidAPI' };
      }

      // Return the playlist data directly
      // The structure might differ from Spotify API, ensure the calling code handles it
      return { success: true, data: response.data };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching RapidAPI playlist ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' }; // Map 404
      }
      // Return a generic error for other issues
      return {
        success: false,
        error: `RapidAPI error fetching playlist: ${status || message}`,
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
    let allItems: any[] = [];
    let offset = 0;
    const limit = 100; // RapidAPI endpoint seems to support 100

    this.logger.log(
      color.blue.bold(
        `Fetching tracks in ${color.white.bold(
          'RapidAPI'
        )} for playlist ${color.white.bold(playlistId)}`
      )
    );

    try {
      while (true) {
        const options = this.createOptions('/playlist_tracks', {
          id: playlistId,
          limit: limit,
          offset: offset,
        });

        // Make the request directly, bypassing the queue for now
        const response = await axios.request(options);
        this.analytics.increaseCounter(
          'spotify_rapidapi',
          'getTracks_called',
          1
        );

        if (!response.data || !response.data.items) {
          // Stop if response format is unexpected or items are missing
          this.logger.log(
            color.yellow(
              `RapidAPI getTracks for ${playlistId} returned unexpected data at offset ${offset}.`
            )
          );
          break;
        }

        // Filter out null tracks if necessary (depends on API behavior)
        const validItems = response.data.items.filter(
          (item: any) => item && item.track
        );
        allItems = allItems.concat(validItems);

        // Check if the number of items returned is less than the limit, indicating the last page
        if (response.data.items.length < limit) {
          break;
        }

        // Prepare for the next page
        offset += limit;

        // Optional: Add a small delay to respect potential implicit rate limits
        await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms delay
      }

      return { success: true, data: { items: allItems } };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching RapidAPI tracks for ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' }; // Map 404
      }
      // Return a generic error for other issues
      return {
        success: false,
        error: `RapidAPI error fetching tracks: ${status || message}`,
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

    this.logger.log(
      color.blue.bold(
        `Searching ${color.white.bold(
          'RapidAPI'
        )} for tracks matching "${color.white.bold(
          searchTerm
        )}" with limit ${color.white.bold(limit)}`
      )
    );

    try {
      // Note: RapidAPI search endpoint might have different parameter names or structure. Adjust as needed.
      const options = this.createOptions('/search/', {
        q: searchTerm,
        type: 'tracks', // Assuming 'tracks' type parameter
        offset: offset.toString(),
        limit: limit.toString(),
        numberOfTopResults: '5', // Example parameter, adjust based on API
      });
      // Make the request directly
      const response = await axios.request(options);

      this.analytics.increaseCounter(
        'spotify_rapidapi',
        'searchTracks_called',
        1
      );

      // Check and return the response data
      if (!response.data) {
        this.logger.log(
          color.yellow(`RapidAPI searchTracks returned no data.`)
        );
        return { success: false, error: 'No results from RapidAPI' };
      }

      // Adapt this based on the actual RapidAPI response structure.
      // The RapidAPI search result has items nested under item.data,
      // and the structure of artists/album differs from the direct Spotify API.
      // We need to transform it to match the expected Spotify API structure
      // so that spotify.ts can process it correctly.

      if (response.data && response.data.tracks && Array.isArray(response.data.tracks.items)) {
        const transformedItems = response.data.tracks.items.map((apiItem: any) => {
          const trackDetails = apiItem.data;
          // Ensure trackDetails and its id exist, otherwise skip this item
          if (!trackDetails || !trackDetails.id) {
            return null;
          }

          // Artists: Map from RapidAPI structure (e.g., { items: [{ profile: { name: ... } }] }) to { name: string }[]
          const artists = trackDetails.artists?.items?.map((artistItem: any) => ({
            name: artistItem.profile?.name,
          })).filter((artist: any) => artist.name) || []; // Filter out artists without names

          // Album: Map from RapidAPI structure (e.g., { coverArt: { sources: [...] }, name: ... })
          // to { images: { url: string }[], name: string }
          const albumImages = trackDetails.albumOfTrack?.coverArt?.sources?.map((source: any) => ({
            url: source.url,
          })).filter((image: any) => image.url) || []; // Filter out images without URLs
          
          const album = {
            name: trackDetails.albumOfTrack?.name || 'Unknown Album',
            images: albumImages,
          };

          return {
            id: trackDetails.id,
            name: trackDetails.name,
            // Ensure artists array is not empty for compatibility with spotify.ts mapping (item.artists[0])
            artists: artists.length > 0 ? artists : [{ name: 'Unknown Artist' }],
            album: album, // Ensure album object with images array for spotify.ts mapping (item.album.images[0])
            // Other fields like external_urls, preview_url can be added if needed by spotify.ts
            // For example:
            // external_urls: { spotify: trackDetails.uri },
            // preview_url: trackDetails.playability?.playable ? trackDetails.uri : null, // Example, check actual structure
          };
        }).filter(track => track !== null); // Filter out any nulls resulting from invalid items

        // Ensure total is a number, fallback to items length if not present or not a number
        const total = typeof response.data.tracks.totalCount === 'number' 
          ? response.data.tracks.totalCount 
          : transformedItems.length;

        return {
          success: true,
          data: {
            tracks: {
              items: transformedItems,
              total: total, // spotify.ts expects 'total'
            },
          },
        };
      } else {
        // Handle cases where the structure is not as expected
        this.logger.log(
          color.yellow(
            `RapidAPI searchTracks returned no items or an unexpected data structure.`
          )
        );
        return {
          success: false,
          error: 'No items or unexpected data structure from RapidAPI search',
        };
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error searching RapidAPI tracks: ${status} - ${message}`
        )
      );

      // Return a generic error for search issues
      return {
        success: false,
        error: `RapidAPI error searching tracks: ${status || message}`,
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

export default SpotifyRapidApi;
