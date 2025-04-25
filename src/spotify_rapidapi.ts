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
      headers: { // Only include necessary headers
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
            this.logger.log(color.green(`RapidAPI request for ${functionName} successful.`));
            break; // Exit loop if request is successful
          } catch (error: any) {
            const axiosError = error as AxiosError;
            if (axiosError.response && axiosError.response.status === 404) {
              this.logger.log(color.yellow(`RapidAPI request for ${functionName} resulted in 404.`));
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
                 this.logger.log(color.red.bold(`RapidAPI request for ${functionName} failed after ${maxAttempts} attempts.`));
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
   * @returns {Promise<ApiResult>} Indicates success/failure of *enqueueing*.
   */
  public async getPlaylist(playlistId: string): Promise<ApiResult> {
    try {
      const options = this.createOptions('/playlist', { id: playlistId });
      await this.rapidAPIQueue.enqueue(options);
      // We don't await processQueue here, assuming it runs elsewhere or is triggered.
      // The return value indicates enqueue success, not API call success.
      this.analytics.increaseCounter('spotify_rapidapi', 'getPlaylist_enqueued', 1);
      // Removed 'message' property
      return { success: true };
    } catch (error) {
        this.logger.log(color.red.bold(`Error enqueueing getPlaylist request: ${error}`));
        return { success: false, error: 'Failed to enqueue request' };
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

    try {
      while (true) {
        const options = this.createOptions('/playlist_tracks', {
          id: playlistId,
          limit: limit,
          offset: offset,
        });

        // Make the request directly, bypassing the queue for now
        const response = await axios.request(options);
        this.analytics.increaseCounter('spotify_rapidapi', 'getTracks_called', 1);

        if (!response.data || !response.data.items) {
          // Stop if response format is unexpected or items are missing
          this.logger.log(color.yellow(`RapidAPI getTracks for ${playlistId} returned unexpected data at offset ${offset}.`));
          break;
        }

        // Filter out null tracks if necessary (depends on API behavior)
        const validItems = response.data.items.filter((item: any) => item && item.track);
        allItems = allItems.concat(validItems);

        // Check if the number of items returned is less than the limit, indicating the last page
        if (response.data.items.length < limit) {
          break;
        }

        // Prepare for the next page
        offset += limit;

        // Optional: Add a small delay to respect potential implicit rate limits
        await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay
      }

      return { success: true, data: { items: allItems } };

    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(color.red.bold(`Error fetching RapidAPI tracks for ${playlistId}: ${status} - ${message}`));

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' }; // Map 404
      }
      // Return a generic error for other issues
      return { success: false, error: `RapidAPI error fetching tracks: ${status || message}` };
    }
  }

  /**
   * Enqueues a request to fetch details for multiple tracks by ID from RapidAPI.
   * @param trackIds Array of Spotify track IDs.
   * @returns {Promise<ApiResult>} Indicates success/failure of *enqueueing*.
   */
  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    if (!trackIds || trackIds.length === 0) {
        return { success: false, error: 'No track IDs provided' };
    }
    // Note: Check RapidAPI documentation for limits on number of IDs per request.
    // This implementation doesn't chunk requests.
    try {
      const options = this.createOptions('/tracks/', { ids: trackIds.join(',') });
      await this.rapidAPIQueue.enqueue(options);
      this.analytics.increaseCounter('spotify_rapidapi', 'getTracksByIds_enqueued', 1);
      // Removed 'message' property
      return { success: true };
    } catch (error) {
        this.logger.log(color.red.bold(`Error enqueueing getTracksByIds request: ${error}`));
        return { success: false, error: 'Failed to enqueue request' };
    }
  }

  /**
   * Enqueues a request to search for tracks on RapidAPI.
   * @param searchTerm The search query.
   * @param limit Max number of results.
   * @param offset Offset for pagination.
   * @returns {Promise<ApiResult>} Indicates success/failure of *enqueueing*.
   */
  public async searchTracks(searchTerm: string, limit: number = 10, offset: number = 0): Promise<ApiResult> {
     if (!searchTerm) {
      return { success: false, error: 'Search term is required' };
    }
    try {
      // Note: RapidAPI search endpoint might have different parameter names or structure. Adjust as needed.
      const options = this.createOptions('/search/', {
        q: searchTerm,
        type: 'tracks', // Assuming 'tracks' type parameter
        offset: offset.toString(),
        limit: limit.toString(),
        numberOfTopResults: '5', // Example parameter, adjust based on API
      });
      await this.rapidAPIQueue.enqueue(options);
      this.analytics.increaseCounter('spotify_rapidapi', 'searchTracks_enqueued', 1);
      // Removed 'message' property
      return { success: true };
    } catch (error) {
        this.logger.log(color.red.bold(`Error enqueueing searchTracks request: ${error}`));
        return { success: false, error: 'Failed to enqueue request' };
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
