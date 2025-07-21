import axios, { AxiosRequestConfig, AxiosError } from 'axios';
import Logger from './logger';
import Cache from './cache'; // Needed for queue implementation details
import AnalyticsClient from './analytics';
import { color } from 'console-log-colors';
import { ApiResult } from './interfaces/ApiResult'; // Assuming ApiResult interface exists

// --- RapidAPI Queue (Copied from spotify_rapidapi.ts for encapsulation) ---
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

class SpotifyRapidApi2 {
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

  public async getPlaylist(playlistId: string): Promise<ApiResult> {
    try {
      const options = this.createOptions('/playlist', { id: playlistId });
      const response = await axios.request(options);
      this.analytics.increaseCounter(
        'spotify_rapidapi2',
        'getPlaylist_called',
        1
      );

      if (!response.data) {
        this.logger.log(
          color.yellow(
            `RapidAPI2 getPlaylist for ${playlistId} returned unexpected data.`
          )
        );
        return { success: false, error: 'Unexpected response from RapidAPI2' };
      }

      return { success: true, data: response.data };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching RapidAPI2 playlist ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      return {
        success: false,
        error: `RapidAPI2 error fetching playlist: ${status || message}`,
      };
    }
  }

  public async getTracks(playlistId: string): Promise<ApiResult> {
    let allItems: any[] = [];
    let offset = 0;
    const limit = 100;

    this.logger.log(
      color.blue.bold(
        `Fetching tracks in ${color.white.bold(
          'RapidAPI2'
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

        const response = await axios.request(options);
        this.analytics.increaseCounter(
          'spotify_rapidapi2',
          'getTracks_called',
          1
        );

        if (!response.data || !response.data.items) {
          this.logger.log(
            color.yellow(
              `RapidAPI2 getTracks for ${playlistId} returned unexpected data at offset ${offset}.`
            )
          );
          break;
        }

        const validItems = response.data.items.filter(
          (item: any) => item && item.track
        );
        allItems = allItems.concat(validItems);

        if (response.data.items.length < limit) {
          break;
        }

        offset += limit;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return { success: true, data: { items: allItems } };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching RapidAPI2 tracks for ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      return {
        success: false,
        error: `RapidAPI2 error fetching tracks: ${status || message}`,
      };
    }
  }

  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    if (!trackIds || trackIds.length === 0) {
      return { success: false, error: 'No track IDs provided' };
    }
    try {
      const options = this.createOptions('/tracks/', {
        ids: trackIds.join(','),
      });
      const response = await axios.request(options);
      this.analytics.increaseCounter(
        'spotify_rapidapi2',
        'getTracksByIds_called',
        1
      );

      if (!response.data || !response.data.tracks) {
        this.logger.log(
          color.yellow(`RapidAPI2 getTracksByIds returned unexpected data.`)
        );
        return { success: false, error: 'Unexpected response from RapidAPI2' };
      }

      return { success: true, data: { tracks: response.data.tracks } };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching RapidAPI2 tracks by IDs: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return {
          success: false,
          error:
            'RapidAPI2 resource not found (one or more track IDs might be invalid)',
        };
      }
      return {
        success: false,
        error: `RapidAPI2 error fetching tracks by IDs: ${status || message}`,
      };
    }
  }

  /**
   * Search for tracks using the new endpoint.
   * POST to https://spotify-scraper2.p.rapidapi.com/search_all
   * Form data: query, type='tracks', limit=10
   * Returns: { tracks: { items: [...] } }
   */
  public async searchTracks(
    searchTerm: string,
    limit: number = 10,
    offset: number = 0
  ): Promise<ApiResult> {
    if (!searchTerm) {
      return { success: false, error: 'Search term is required' };
    }

    try {
      if (!this.rapidApiKey) {
        throw new Error('RAPID_API_KEY environment variable is not defined');
      }

      // Prepare form data as multipart/form-data using FormData
      // Note: 'type' should be 'track' (not 'tracks') per your working request
      // and limit can be set to 30 for parity with your example
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('query', searchTerm);
      formData.append('type', 'track');
      formData.append('limit', limit.toString());

      const response = await axios.post(
        'https://spotify-scraper2.p.rapidapi.com/search_all',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'x-rapidapi-key': this.rapidApiKey,
            'x-rapidapi-host': 'spotify-scraper2.p.rapidapi.com',
            'accept': 'application/json',
          },
        }
      );

      this.analytics.increaseCounter(
        'spotify_rapidapi2',
        'searchTracks_called',
        1
      );

      if (
        !response.data ||
        !response.data.tracks ||
        !Array.isArray(response.data.tracks.items)
      ) {
        return {
          success: false,
          error: 'No items or unexpected data structure from RapidAPI2 search',
        };
      }

      // Transform the response to the format expected by the frontend/caller
      // The structure is: { tracks: { items: [...] } }
      // Each item is a track object with album, artists, etc.
      const transformedItems = response.data.tracks.items.map((item: any) => {
        return {
          id: item.id,
          name: item.track_name || item.name,
          artists: item.artists || [],
          album: item.album || {},
          external_urls: item.external_urls || {},
          preview_url: item.preview_url || null,
        };
      });

      const total =
        typeof response.data.tracks.total === 'number'
          ? response.data.tracks.total
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
    } catch (error) {
      console.log(error);

      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      return {
        success: false,
        error: `RapidAPI2 error searching tracks: ${status || message}`,
      };
    }
  }

  public async processApiQueue(): Promise<void> {
    this.logger.log(color.blue('Starting RapidAPI2 queue processing...'));
    await this.rapidAPIQueue.processQueue();
    this.logger.log(color.blue('RapidAPI2 queue processing finished.'));
  }
}

export default SpotifyRapidApi2;
