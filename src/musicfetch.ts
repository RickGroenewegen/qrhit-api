import axios, { AxiosInstance, AxiosError } from 'axios';
import Bottleneck from 'bottleneck';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';

export interface MusicLinks {
  deezerLink?: string | null;
  youtubeMusicLink?: string | null;
  appleMusicLink?: string | null;
  amazonMusicLink?: string | null;
  tidalLink?: string | null;
}

export interface MusicFetchResponse {
  success: boolean;
  links?: MusicLinks;
  error?: string;
  notFound?: boolean;
}

export interface BulkProcessResult {
  totalProcessed: number;
  successful: number;
  failed: number;
  skipped: number;
  errors: Array<{ trackId: number; error: string }>;
}

class MusicFetch {
  private static instance: MusicFetch;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private axiosInstance: AxiosInstance;
  private limiter: Bottleneck;
  private readonly API_BASE_URL = 'https://api.musicfetch.io';
  private readonly MAX_ATTEMPTS = 3;

  private constructor() {
    // Initialize axios instance
    this.axiosInstance = axios.create({
      baseURL: this.API_BASE_URL,
      timeout: 30000,
      headers: {
        'x-token': process.env['MUSICFETCH_API_KEY'] || '',
      },
    });

    // Initialize rate limiter: 30 requests per minute
    // That's 1 request every 2 seconds
    this.limiter = new Bottleneck({
      minTime: 2000, // 2 seconds between requests
      maxConcurrent: 1, // Process one at a time
      reservoir: 30, // Start with 30 tokens
      reservoirRefreshAmount: 30, // Refresh to 30 tokens
      reservoirRefreshInterval: 60 * 1000, // Every 60 seconds
    });

    this.logger.log(
      color.blue.bold('MusicFetch service initialized with rate limiting')
    );
  }

  public static getInstance(): MusicFetch {
    if (!MusicFetch.instance) {
      MusicFetch.instance = new MusicFetch();
    }
    return MusicFetch.instance;
  }

  /**
   * Fetch music platform links for a track using its Spotify URL
   */
  public async fetchLinksForTrack(
    spotifyUrl: string
  ): Promise<MusicFetchResponse> {
    if (!process.env['MUSICFETCH_API_KEY']) {
      this.logger.log(
        color.yellow.bold('MusicFetch API key not configured, skipping')
      );
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await this.limiter.schedule(() =>
        this.axiosInstance.get('/url', {
          params: {
            url: spotifyUrl,
            services: 'deezer,youtubeMusic,appleMusic,amazonMusic,tidal',
          },
        })
      );

      // Check if we have result.services in the response
      if (response.data && response.data.result && response.data.result.services) {
        const services = response.data.result.services;
        const links: MusicLinks = {
          deezerLink: services.deezer?.link || null,
          youtubeMusicLink: services.youtubeMusic?.link || null,
          appleMusicLink: services.appleMusic?.link || null,
          amazonMusicLink: services.amazonMusic?.link || null,
          tidalLink: services.tidal?.link || null,
        };

        this.logger.log(
          color.green.bold(
            `Successfully fetched music links for: ${white.bold(spotifyUrl)}`
          )
        );

        return { success: true, links };
      }

      this.logger.log(
        color.red.bold(
          `No services found in response for: ${white.bold(
            spotifyUrl
          )} - Response: ${white.bold(JSON.stringify(response.data))}`
        )
      );

      return { success: false, error: 'No services in response' };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        // Handle 404 - track not found
        if (axiosError.response?.status === 404) {
          this.logger.log(
            color.yellow.bold(
              `Track not found in MusicFetch: ${white.bold(spotifyUrl)}`
            )
          );
          return { success: true, notFound: true, links: {} };
        }

        // Handle 429 - rate limit
        if (axiosError.response?.status === 429) {
          this.logger.log(
            color.red.bold('MusicFetch rate limit exceeded, will retry later')
          );
          return { success: false, error: 'Rate limit exceeded' };
        }

        this.logger.log(
          color.red.bold(
            `MusicFetch API error: ${white.bold(
              axiosError.message
            )} for ${white.bold(spotifyUrl)}`
          )
        );
        return {
          success: false,
          error: axiosError.message || 'API request failed',
        };
      }

      this.logger.log(
        color.red.bold(
          `Error fetching music links: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update a single track with MusicFetch links
   */
  public async updateTrackWithLinks(
    trackId: number,
    spotifyUrl: string
  ): Promise<boolean> {
    try {
      // Check if we should skip this track (too many attempts)
      const track = await this.prisma.track.findUnique({
        where: { id: trackId },
        select: { musicFetchAttempts: true },
      });

      if (!track) {
        this.logger.log(
          color.red.bold(
            `Track with ID ${white.bold(
              trackId.toString()
            )} not found in database`
          )
        );
        return false;
      }

      if (track.musicFetchAttempts >= this.MAX_ATTEMPTS) {
        this.logger.log(
          color.yellow.bold(
            `Skipping track ${white.bold(
              trackId.toString()
            )} - max attempts (${white.bold(
              this.MAX_ATTEMPTS.toString()
            )}) reached`
          )
        );
        return false;
      }

      // Fetch links from MusicFetch API
      const result = await this.fetchLinksForTrack(spotifyUrl);

      // Update track in database
      await this.prisma.track.update({
        where: { id: trackId },
        data: {
          deezerLink: result.links?.deezerLink,
          youtubeMusicLink: result.links?.youtubeMusicLink,
          appleMusicLink: result.links?.appleMusicLink,
          amazonMusicLink: result.links?.amazonMusicLink,
          tidalLink: result.links?.tidalLink,
          musicFetchLastAttempt: new Date(),
          musicFetchAttempts: { increment: 1 },
        },
      });

      if (result.success) {
        this.logger.log(
          color.green.bold(
            `Updated track ${white.bold(
              trackId.toString()
            )} with MusicFetch links`
          )
        );
        return true;
      } else {
        this.logger.log(
          color.yellow.bold(
            `Failed to fetch links for track ${white.bold(
              trackId.toString()
            )}: ${white.bold(result.error || 'Unknown error')}`
          )
        );
        return false;
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error updating track ${white.bold(
            trackId.toString()
          )} with MusicFetch links: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
      return false;
    }
  }

  /**
   * Process all tracks in a playlist asynchronously
   */
  public async processPlaylistTracks(playlistId: number): Promise<void> {
    this.logger.log(
      color.blue.bold(
        `Starting MusicFetch processing for playlist: ${white.bold(
          playlistId.toString()
        )}`
      )
    );

    try {
      // Get all tracks from the playlist that have a Spotify link
      const playlistTracks = await this.prisma.playlistHasTrack.findMany({
        where: { playlistId },
        include: {
          track: {
            select: {
              id: true,
              spotifyLink: true,
              musicFetchAttempts: true,
              deezerLink: true,
              youtubeMusicLink: true,
              appleMusicLink: true,
              amazonMusicLink: true,
              tidalLink: true,
            },
          },
        },
      });

      // Filter tracks that need processing
      const tracksToProcess = playlistTracks.filter((pt) => {
        const track = pt.track;
        return (
          track.spotifyLink &&
          track.musicFetchAttempts < this.MAX_ATTEMPTS &&
          (!track.deezerLink ||
            !track.youtubeMusicLink ||
            !track.appleMusicLink ||
            !track.amazonMusicLink ||
            !track.tidalLink)
        );
      });

      this.logger.log(
        color.blue.bold(
          `Found ${white.bold(
            tracksToProcess.length.toString()
          )} tracks to process in playlist ${white.bold(
            playlistId.toString()
          )}`
        )
      );

      // Process tracks sequentially with rate limiting
      for (const playlistTrack of tracksToProcess) {
        const track = playlistTrack.track;
        if (track.spotifyLink) {
          await this.updateTrackWithLinks(track.id, track.spotifyLink);
        }
      }

      this.logger.log(
        color.green.bold(
          `Completed MusicFetch processing for playlist: ${white.bold(
            playlistId.toString()
          )}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error processing playlist ${white.bold(
            playlistId.toString()
          )} with MusicFetch: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
    }
  }

  /**
   * Process multiple tracks for bulk action
   */
  public async processBulkTracks(
    trackIds?: number[]
  ): Promise<BulkProcessResult> {
    this.logger.log(
      color.blue.bold('Starting MusicFetch bulk processing')
    );

    const result: BulkProcessResult = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    try {
      let tracksToProcess;

      if (trackIds && trackIds.length > 0) {
        // Process specific tracks
        tracksToProcess = await this.prisma.track.findMany({
          where: {
            id: { in: trackIds },
            spotifyLink: { not: null },
          },
          select: {
            id: true,
            spotifyLink: true,
            musicFetchAttempts: true,
            name: true,
            artist: true,
          },
        });
      } else {
        // Process all tracks missing at least one link
        tracksToProcess = await this.prisma.track.findMany({
          where: {
            spotifyLink: { not: null },
            musicFetchAttempts: { lt: this.MAX_ATTEMPTS },
            OR: [
              { deezerLink: null },
              { youtubeMusicLink: null },
              { appleMusicLink: null },
              { amazonMusicLink: null },
              { tidalLink: null },
            ],
          },
          select: {
            id: true,
            spotifyLink: true,
            musicFetchAttempts: true,
            name: true,
            artist: true,
          },
          take: 100, // Limit to 100 tracks per bulk operation
        });
      }

      this.logger.log(
        color.blue.bold(
          `Found ${white.bold(
            tracksToProcess.length.toString()
          )} tracks to process`
        )
      );

      result.totalProcessed = tracksToProcess.length;

      // Process tracks sequentially with rate limiting
      for (const track of tracksToProcess) {
        if (!track.spotifyLink) {
          result.skipped++;
          continue;
        }

        if (track.musicFetchAttempts >= this.MAX_ATTEMPTS) {
          result.skipped++;
          continue;
        }

        const success = await this.updateTrackWithLinks(
          track.id,
          track.spotifyLink
        );

        if (success) {
          result.successful++;
        } else {
          result.failed++;
          result.errors.push({
            trackId: track.id,
            error: 'Failed to fetch or update links',
          });
        }
      }

      this.logger.log(
        color.green.bold(
          `Bulk processing complete: ${white.bold(
            result.successful.toString()
          )} successful, ${white.bold(
            result.failed.toString()
          )} failed, ${white.bold(result.skipped.toString())} skipped`
        )
      );

      return result;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error during bulk processing: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
      return result;
    }
  }
}

export default MusicFetch;
