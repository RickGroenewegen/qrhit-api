import axios, { AxiosError } from 'axios';
import Logger from './logger';
import { color } from 'console-log-colors';
import { ApiResult } from './interfaces/ApiResult';
import { ProgressCallback } from './interfaces/IMusicProvider';

const TAG = `[${color.white.bold('spotify-graphql')}]`;

class SpotifyGraphqlScraper {
  private logger = new Logger();
  private baseUrl = process.env['SPOTIFY_SCRAPER_URL'] || 'http://localhost:3050';
  private apiKey = process.env['SPOTIFY_SCRAPER_API_KEY'] || '';

  private get headers() {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Fetch playlist metadata (first page of tracks only).
   */
  public async getPlaylist(playlistId: string): Promise<ApiResult> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/playlist`,
        { playlistId },
        { headers: this.headers, timeout: 30000 }
      );

      if (response.data?.success && response.data?.data) {
        const d = response.data.data;

        const playlistImage = d.imageUrl || '';

        const transformedData = {
          id: playlistId,
          playlistId,
          name: d.name || '',
          description: d.description || '',
          numberOfTracks: d.totalSongs || 0,
          images: playlistImage ? [{ url: playlistImage }] : [],
          tracks: { total: d.totalSongs || 0 },
        };

        return { success: true, data: transformedData };
      }

      const errorMessage = response.data?.error || 'Unexpected response from GraphQL Scraper';
      this.logger.log(
        color.yellow(`${TAG} getPlaylist for ${playlistId} failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `${TAG} Error fetching playlist ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      return {
        success: false,
        error: `GraphQL Scraper error fetching playlist: ${status || message}`,
      };
    }
  }

  /**
   * Fetch all tracks for a playlist (full pagination).
   * Transforms response to the { track: { id, name, artists, album, ... } } items format
   * expected by spotify.ts.
   */
  public async getTracks(playlistId: string, onProgress?: ProgressCallback): Promise<ApiResult> {
    try {
      const start = Date.now();
      const response = await axios.post(
        `${this.baseUrl}/playlist/tracks`,
        { playlistId },
        { headers: this.headers, timeout: 60000 }
      );

      if (response.data?.success && response.data?.data) {
        const d = response.data.data;
        const tracks = d.tracks || [];
        const elapsed = Date.now() - start;

        const transformedItems = tracks.map((t: any) => {
          return {
            track: {
              id: t.trackId,
              name: t.title,
              artists: (t.artists || []).map((a: any) => ({ name: a.name })),
              album: {
                name: t.album?.name || '',
                images: t.coverArt ? [{ url: t.coverArt }] : [],
              },
              external_urls: { spotify: `https://open.spotify.com/track/${t.trackId}` },
              preview_url: null,
              duration_ms: t.durationMs || 0,
            },
          };
        });

        if (onProgress) {
          const totalCount = d.totalSongs || transformedItems.length;
          onProgress({
            stage: 'fetching_metadata',
            current: transformedItems.length,
            total: totalCount,
            percentage: 99,
            message: 'progress.loaded',
          });
        }

        this.logger.log(
          color.blue.bold(
            `${TAG} Fetched ${color.white.bold(transformedItems.length)} tracks in ${color.white.bold(elapsed + 'ms')}`
          )
        );

        return {
          success: true,
          data: {
            items: transformedItems,
          },
        };
      }

      const errorMessage = response.data?.error || 'Unexpected response from GraphQL Scraper';
      this.logger.log(
        color.yellow(`${TAG} getTracks for ${playlistId} failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `${TAG} Error fetching tracks for ${playlistId}: ${status} - ${message}`
        )
      );

      if (status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      return {
        success: false,
        error: `GraphQL Scraper error fetching tracks: ${status || message}`,
      };
    }
  }

  /**
   * Fetch track details by IDs via the GraphQL Scraper.
   */
  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/tracks`,
        { trackIds },
        { headers: this.headers, timeout: 120000 }
      );

      if (response.data?.success && response.data?.data) {
        const d = response.data.data;
        const tracks = d.tracks || [];
        const failed = d.failed || [];

        const transformedTracks = tracks.map((t: any) => ({
          id: t.trackId,
          name: t.title,
          artists: (t.artists || []).map((a: any) => ({ name: a.name })),
          album: {
            name: t.album?.name || '',
            images: t.coverArt ? [{ url: t.coverArt }] : [],
            release_date: t.releaseDate || '',
          },
          external_urls: { spotify: t.shareUrl || `https://open.spotify.com/track/${t.trackId}` },
          duration_ms: t.durationMs || 0,
          explicit: t.explicit || false,
          popularity: t.playcount || 0,
        }));

        this.logger.log(
          color.blue.bold(
            `${TAG} getTracksByIds: ${color.white.bold(`${transformedTracks.length}/${trackIds.length}`)} succeeded, ${color.white.bold(`${failed.length}`)} failed`
          )
        );

        return {
          success: true,
          data: {
            tracks: transformedTracks,
            failed,
          },
        };
      }

      const errorMessage = response.data?.error || 'Unexpected response from GraphQL Scraper';
      this.logger.log(
        color.yellow.bold(`${TAG} getTracksByIds failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `${TAG} Error fetching tracks by IDs: ${color.white.bold(`${status} - ${message}`)}`
        )
      );
      return {
        success: false,
        error: `GraphQL Scraper error fetching tracks by IDs: ${status || message}`,
      };
    }
  }

  /**
   * Search for tracks via the GraphQL Scraper.
   */
  public async searchTracks(
    searchTerm: string,
    limit: number = 10,
    offset: number = 0
  ): Promise<ApiResult> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/search`,
        { query: searchTerm, limit, offset },
        { headers: this.headers, timeout: 30000 }
      );

      if (response.data?.success && response.data?.data) {
        const d = response.data.data;
        const tracks = d.tracks || [];

        const transformedItems = tracks.map((t: any) => ({
          id: t.trackId,
          name: t.title,
          artists: (t.artists || []).map((a: any) => ({ name: a.name })),
          album: {
            name: t.album?.name || '',
            images: t.coverArt ? [{ url: t.coverArt }] : [],
          },
        }));

        const total = d.totalCount || transformedItems.length;

        this.logger.log(
          color.blue.bold(
            `${TAG} Search ${color.white.bold(`"${searchTerm}"`)} — ${color.white.bold(`${transformedItems.length}/${total}`)} results`
          )
        );

        return {
          success: true,
          data: {
            tracks: {
              items: transformedItems,
              total,
            },
          },
        };
      }

      const errorMessage = response.data?.error || 'Unexpected response from GraphQL Scraper';
      this.logger.log(
        color.yellow.bold(`${TAG} searchTracks for "${searchTerm}" failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `${TAG} Error searching for "${searchTerm}": ${status} - ${message}`
        )
      );
      return {
        success: false,
        error: `GraphQL Scraper error searching tracks: ${status || message}`,
      };
    }
  }
}

export default SpotifyGraphqlScraper;
