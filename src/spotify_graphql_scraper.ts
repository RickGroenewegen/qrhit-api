import axios, { AxiosError } from 'axios';
import Logger from './logger';
import { color } from 'console-log-colors';
import { ApiResult } from './interfaces/ApiResult';
import { ProgressCallback } from './interfaces/IMusicProvider';

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
    this.logger.log(
      color.blue.bold(
        `Fetching playlist in ${color.white.bold('GraphQL Scraper')} for ${color.white.bold(playlistId)}`
      )
    );

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

        this.logger.log(
          color.green(`GraphQL Scraper getPlaylist: "${d.name}" — ${d.totalSongs} tracks`)
        );

        return { success: true, data: transformedData };
      }

      const errorMessage = response.data?.error || 'Unexpected response from GraphQL Scraper';
      this.logger.log(
        color.yellow(`GraphQL Scraper getPlaylist for ${playlistId} failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching GraphQL Scraper playlist ${playlistId}: ${status} - ${message}`
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
    this.logger.log(
      color.blue.bold(
        `Fetching tracks in ${color.white.bold('GraphQL Scraper')} for playlist ${color.white.bold(playlistId)}`
      )
    );

    try {
      const response = await axios.post(
        `${this.baseUrl}/playlist/tracks`,
        { playlistId },
        { headers: this.headers, timeout: 60000 }
      );

      if (response.data?.success && response.data?.data) {
        const d = response.data.data;
        const tracks = d.tracks || [];

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
          color.green(
            `GraphQL Scraper getTracks: "${d.name}" — ${transformedItems.length}/${d.totalSongs} tracks`
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
        color.yellow(`GraphQL Scraper getTracks for ${playlistId} failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error fetching GraphQL Scraper tracks for ${playlistId}: ${status} - ${message}`
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
   * Not supported by GraphQL Scraper — returns failure.
   */
  public async getTracksByIds(_trackIds: string[]): Promise<ApiResult> {
    return { success: false, error: 'getTracksByIds not supported by GraphQL Scraper' };
  }

  /**
   * Search for tracks via the GraphQL Scraper.
   */
  public async searchTracks(
    searchTerm: string,
    limit: number = 10,
    offset: number = 0
  ): Promise<ApiResult> {
    this.logger.log(
      color.blue.bold(
        `Searching tracks in ${color.white.bold('GraphQL Scraper')} for ${color.white.bold(`"${searchTerm}"`)}`
      )
    );

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
            `GraphQL Scraper search: ${color.white.bold(`"${searchTerm}"`)} — ${color.white.bold(`${transformedItems.length}/${total}`)} results`
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
        color.yellow.bold(`GraphQL Scraper searchTracks for "${searchTerm}" failed: ${errorMessage}`)
      );
      return { success: false, error: `GraphQL Scraper error: ${errorMessage}` };
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message;
      this.logger.log(
        color.red.bold(
          `Error searching GraphQL Scraper for "${searchTerm}": ${status} - ${message}`
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
