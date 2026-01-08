import axios, { AxiosInstance, AxiosError } from 'axios';
import Bottleneck from 'bottleneck';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';

export interface MusicLinks {
  spotifyLink?: string | null;
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
  rateLimited?: boolean;
}

export interface BulkProcessResult {
  totalProcessed: number;
  successful: number;
  failed: number;
  skipped: number;
  errors: Array<{ trackId: number; error: string }>;
}

// Rate limit: requests per minute (MusicFetch plan allows 6/min, we use 5 to be safe)
const RATE_LIMIT_PER_MINUTE = 5;

// Map of link field names to MusicFetch service names
const LINK_FIELD_TO_SERVICE: Record<string, string> = {
  spotifyLink: 'spotify',
  deezerLink: 'deezer',
  youtubeMusicLink: 'youtubeMusic',
  appleMusicLink: 'appleMusic',
  amazonMusicLink: 'amazonMusic',
  tidalLink: 'tidal',
};

// All music link fields in order of preference for source lookup
const MUSIC_LINK_FIELDS = [
  'spotifyLink',
  'youtubeMusicLink',
  'deezerLink',
  'appleMusicLink',
  'amazonMusicLink',
  'tidalLink',
] as const;

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

    // Initialize rate limiter based on RATE_LIMIT_PER_MINUTE constant
    const minTimeBetweenRequests = Math.ceil(60000 / RATE_LIMIT_PER_MINUTE);
    this.limiter = new Bottleneck({
      minTime: minTimeBetweenRequests,
      maxConcurrent: 1,
      reservoir: RATE_LIMIT_PER_MINUTE,
      reservoirRefreshAmount: RATE_LIMIT_PER_MINUTE,
      reservoirRefreshInterval: 60 * 1000,
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
   * Fetch music platform links for a track using any available music service URL
   * @param sourceUrl - URL from any supported music service (Spotify, YouTube Music, Deezer, etc.)
   * @param sourceField - The field name this URL came from (to exclude from results)
   */
  public async fetchLinksForTrack(
    sourceUrl: string,
    sourceField?: string
  ): Promise<MusicFetchResponse> {
    if (!process.env['MUSICFETCH_API_KEY']) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const response = await this.limiter.schedule(() =>
        this.axiosInstance.get('/url', {
          params: {
            url: sourceUrl,
            services: 'spotify,deezer,youtubeMusic,appleMusic,amazonMusic,tidal',
          },
        })
      );

      // Check if we have result.services in the response
      if (
        response.data &&
        response.data.result &&
        response.data.result.services
      ) {
        const services = response.data.result.services;
        const links: MusicLinks = {
          spotifyLink: services.spotify?.link || null,
          deezerLink: services.deezer?.link || null,
          youtubeMusicLink: services.youtubeMusic?.link || null,
          appleMusicLink: services.appleMusic?.link || null,
          amazonMusicLink: services.amazonMusic?.link || null,
          tidalLink: services.tidal?.link || null,
        };

        // Don't overwrite the source link field (we already have it)
        if (sourceField && sourceField in links) {
          delete links[sourceField as keyof MusicLinks];
        }

        return { success: true, links };
      }

      return { success: false, error: 'No services in response' };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        // Handle 404 - track not found
        if (axiosError.response?.status === 404) {
          return { success: true, notFound: true, links: {} };
        }

        // Handle 429 - rate limit
        if (axiosError.response?.status === 429) {
          this.logger.log(
            color.red.bold('[MusicFetch] Rate limit exceeded, will retry later')
          );
          return { success: false, error: 'Rate limit exceeded', rateLimited: true };
        }

        return {
          success: false,
          error: axiosError.message || 'API request failed',
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Find the first available music link from a track
   * Returns the link URL and the field name it came from
   */
  private findAvailableLink(track: Record<string, any>): { url: string; field: string } | null {
    for (const field of MUSIC_LINK_FIELDS) {
      if (track[field]) {
        return { url: track[field], field };
      }
    }
    return null;
  }

  /**
   * Check which link fields are missing from a track
   */
  private getMissingLinkFields(track: Record<string, any>): string[] {
    return MUSIC_LINK_FIELDS.filter(field => !track[field]);
  }

  /**
   * Update a single track with MusicFetch links using any available source link
   */
  public async updateTrackWithLinks(trackId: number): Promise<boolean> {
    try {
      // Get track with all link fields
      const track = await this.prisma.track.findUnique({
        where: { id: trackId },
        select: {
          name: true,
          artist: true,
          musicFetchAttempts: true,
          spotifyLink: true,
          youtubeMusicLink: true,
          deezerLink: true,
          appleMusicLink: true,
          amazonMusicLink: true,
          tidalLink: true,
        },
      });

      if (!track) {
        return false;
      }

      if (track.musicFetchAttempts >= this.MAX_ATTEMPTS) {
        return false;
      }

      // Find any available link to use as source
      const sourceLink = this.findAvailableLink(track);
      if (!sourceLink) {
        return false;
      }

      // Fetch links from MusicFetch API using the available source
      const result = await this.fetchLinksForTrack(sourceLink.url, sourceLink.field);

      // If rate limited, don't increment attempts - just return false
      if (result.rateLimited) {
        return false;
      }

      // Build update data - only update fields that are currently null and have new values
      const updateData: Record<string, any> = {
        musicFetchLastAttempt: new Date(),
        musicFetchAttempts: { increment: 1 },
      };

      const newLinksAdded: string[] = [];

      if (result.links) {
        // Only set links that we don't already have
        if (!track.spotifyLink && result.links.spotifyLink) {
          updateData.spotifyLink = result.links.spotifyLink;
          newLinksAdded.push('spotifyLink');
        }
        if (!track.deezerLink && result.links.deezerLink) {
          updateData.deezerLink = result.links.deezerLink;
          newLinksAdded.push('deezerLink');
        }
        if (!track.youtubeMusicLink && result.links.youtubeMusicLink) {
          updateData.youtubeMusicLink = result.links.youtubeMusicLink;
          newLinksAdded.push('youtubeMusicLink');
        }
        if (!track.appleMusicLink && result.links.appleMusicLink) {
          updateData.appleMusicLink = result.links.appleMusicLink;
          newLinksAdded.push('appleMusicLink');
        }
        if (!track.amazonMusicLink && result.links.amazonMusicLink) {
          updateData.amazonMusicLink = result.links.amazonMusicLink;
          newLinksAdded.push('amazonMusicLink');
        }
        if (!track.tidalLink && result.links.tidalLink) {
          updateData.tidalLink = result.links.tidalLink;
          newLinksAdded.push('tidalLink');
        }
      }

      // Update track in database
      await this.prisma.track.update({
        where: { id: trackId },
        data: updateData,
      });

      // Only log if we actually added new links
      if (newLinksAdded.length > 0) {
        this.logger.log(
          color.green.bold(
            `[MusicFetch] Updated "${white.bold(track.artist)} - ${white.bold(track.name)}" with ${white.bold(newLinksAdded.length.toString())} new links: ${white.bold(newLinksAdded.join(', '))}`
          )
        );
      }

      return result.success;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `[MusicFetch] Error updating track ${white.bold(
            trackId.toString()
          )}: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
      return false;
    }
  }

  /**
   * Process all tracks in a playlist asynchronously
   * Works with any available music link (Spotify, YouTube Music, Deezer, etc.)
   */
  public async processPlaylistTracks(playlistId: number): Promise<void> {
    try {
      // Get all tracks from the playlist with all link fields
      const playlistTracks = await this.prisma.playlistHasTrack.findMany({
        where: { playlistId },
        include: {
          track: {
            select: {
              id: true,
              name: true,
              artist: true,
              spotifyLink: true,
              youtubeMusicLink: true,
              deezerLink: true,
              appleMusicLink: true,
              amazonMusicLink: true,
              tidalLink: true,
              musicFetchAttempts: true,
            },
          },
        },
      });

      // Filter tracks that need processing:
      // - Must have at least one link (as source)
      // - Must be missing at least one link
      // - Must not have exceeded max attempts
      const tracksToProcess = playlistTracks.filter((pt) => {
        const track = pt.track;
        const hasSourceLink = this.findAvailableLink(track) !== null;
        const hasMissingLinks = this.getMissingLinkFields(track).length > 0;
        return (
          hasSourceLink &&
          hasMissingLinks &&
          track.musicFetchAttempts < this.MAX_ATTEMPTS
        );
      });

      if (tracksToProcess.length === 0) {
        return;
      }

      this.logger.log(
        color.blue.bold(
          `[MusicFetch] Processing ${white.bold(tracksToProcess.length.toString())} tracks for playlist ${white.bold(playlistId.toString())}`
        )
      );

      // Process tracks sequentially with rate limiting
      let successCount = 0;
      for (const playlistTrack of tracksToProcess) {
        const success = await this.updateTrackWithLinks(playlistTrack.track.id);
        if (success) successCount++;
      }

      if (successCount > 0) {
        this.logger.log(
          color.green.bold(
            `[MusicFetch] Playlist ${white.bold(playlistId.toString())} complete: ${white.bold(successCount.toString())}/${white.bold(tracksToProcess.length.toString())} tracks updated`
          )
        );
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `[MusicFetch] Error processing playlist ${white.bold(
            playlistId.toString()
          )}: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
    }
  }

  /**
   * Process multiple tracks for bulk action in chunks
   * Works with any available music link (Spotify, YouTube Music, Deezer, etc.)
   */
  public async processBulkTracks(
    trackIds?: number[]
  ): Promise<BulkProcessResult> {
    this.logger.log(color.blue.bold('Starting MusicFetch bulk processing'));

    const result: BulkProcessResult = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    try {
      let hasMore = true;
      let chunkNumber = 0;

      while (hasMore) {
        chunkNumber++;
        let tracksToProcess;

        if (trackIds && trackIds.length > 0) {
          // Process specific tracks (single batch)
          // Track must have at least one link to use as source
          tracksToProcess = await this.prisma.track.findMany({
            where: {
              id: { in: trackIds },
              OR: [
                { spotifyLink: { not: null } },
                { youtubeMusicLink: { not: null } },
                { deezerLink: { not: null } },
                { appleMusicLink: { not: null } },
                { amazonMusicLink: { not: null } },
                { tidalLink: { not: null } },
              ],
            },
            select: {
              id: true,
              spotifyLink: true,
              youtubeMusicLink: true,
              deezerLink: true,
              appleMusicLink: true,
              amazonMusicLink: true,
              tidalLink: true,
              musicFetchAttempts: true,
              name: true,
              artist: true,
            },
          });
          hasMore = false; // Only one batch for specific tracks
        } else {
          // Process all tracks that have at least one link but are missing others
          tracksToProcess = await this.prisma.track.findMany({
            where: {
              musicFetchAttempts: { lt: this.MAX_ATTEMPTS },
              // Must have at least one link
              OR: [
                { spotifyLink: { not: null } },
                { youtubeMusicLink: { not: null } },
                { deezerLink: { not: null } },
                { appleMusicLink: { not: null } },
                { amazonMusicLink: { not: null } },
                { tidalLink: { not: null } },
              ],
              // Must be missing at least one link
              AND: [
                {
                  OR: [
                    { spotifyLink: null },
                    { deezerLink: null },
                    { youtubeMusicLink: null },
                    { appleMusicLink: null },
                    { amazonMusicLink: null },
                    { tidalLink: null },
                  ],
                },
              ],
            },
            select: {
              id: true,
              spotifyLink: true,
              youtubeMusicLink: true,
              deezerLink: true,
              appleMusicLink: true,
              amazonMusicLink: true,
              tidalLink: true,
              musicFetchAttempts: true,
              name: true,
              artist: true,
            },
            take: 1000, // Process 1000 tracks per chunk
          });

          // If we got less than 1000, this is the last batch
          if (tracksToProcess.length < 1000) {
            hasMore = false;
          }
        }

        if (tracksToProcess.length === 0) {
          this.logger.log(
            color.blue.bold(
              'No more tracks found to process - all tracks have links or max attempts reached'
            )
          );
          break;
        }

        this.logger.log(
          color.blue.bold(
            `Processing chunk ${white.bold(
              chunkNumber.toString()
            )}: ${white.bold(tracksToProcess.length.toString())} tracks`
          )
        );

        // Process tracks sequentially with rate limiting
        for (const track of tracksToProcess) {
          // Skip if no source link available
          if (!this.findAvailableLink(track)) {
            result.skipped++;
            continue;
          }

          if (track.musicFetchAttempts >= this.MAX_ATTEMPTS) {
            result.skipped++;
            continue;
          }

          const success = await this.updateTrackWithLinks(track.id);

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

        result.totalProcessed += tracksToProcess.length;

        this.logger.log(
          color.green.bold(
            `Chunk ${white.bold(chunkNumber.toString())} complete: ${white.bold(
              result.successful.toString()
            )} successful, ${white.bold(
              result.failed.toString()
            )} failed, ${white.bold(
              result.skipped.toString()
            )} skipped (Total processed: ${white.bold(
              result.totalProcessed.toString()
            )})`
          )
        );
      }

      this.logger.log(
        color.green.bold(
          `All bulk processing complete: ${white.bold(
            result.successful.toString()
          )} successful, ${white.bold(
            result.failed.toString()
          )} failed, ${white.bold(
            result.skipped.toString()
          )} skipped across ${white.bold(
            result.totalProcessed.toString()
          )} total tracks`
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
