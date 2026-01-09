import axios, { AxiosInstance, AxiosError } from 'axios';
import Bottleneck from 'bottleneck';
import crypto from 'crypto';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Cache from './cache';
import ExternalCardService from './externalCardService';

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
const RATE_LIMIT_PER_MINUTE = 19;

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
  private cache = Cache.getInstance();
  private externalCardService = ExternalCardService.getInstance();
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
   * Clear Redis cache and update in-memory cache for external cards with a given spotifyId
   * Called after MusicFetch updates links for external cards
   */
  private async clearExternalCardCaches(
    spotifyId: string,
    newLinks: Partial<{
      appleMusicLink: string | null;
      tidalLink: string | null;
      youtubeMusicLink: string | null;
      deezerLink: string | null;
      amazonMusicLink: string | null;
    }>
  ): Promise<void> {
    try {
      // Get all external cards with this spotifyId to find their URLs
      const cards = await this.prisma.externalCard.findMany({
        where: { spotifyId },
        select: {
          cardType: true,
          sku: true,
          countryCode: true,
          playlistId: true,
          cardNumber: true,
        },
      });

      // Clear Redis cache for each card's possible URL patterns
      for (const card of cards) {
        const urls: string[] = [];

        if (card.cardType === 'jumbo' && card.sku) {
          // Hitster Jumbo URLs: https://hitstergame.com/{locale}/{sku}/{cardNumber}
          // We need to cover various locales
          const locales = ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl'];
          for (const locale of locales) {
            urls.push(`https://hitstergame.com/${locale}/${card.sku}/${card.cardNumber}`);
          }
        } else if (card.cardType === 'country' && card.countryCode) {
          // Hitster Country URLs: https://hitstergame.com/{locale}/{countryCode}/{cardNumber}
          const locales = ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl'];
          for (const locale of locales) {
            urls.push(`https://hitstergame.com/${locale}/${card.countryCode}/${card.cardNumber}`);
          }
        } else if (card.cardType === 'musicmatch' && card.playlistId) {
          // MusicMatch URLs: https://api.musicmatchgame.com/{playlistId}/{cardNumber}
          urls.push(`https://api.musicmatchgame.com/${card.playlistId}/${card.cardNumber}`);
        }

        // Delete each URL's cache entry
        for (const url of urls) {
          const cacheKey = `qrlink2_unknown_result_${crypto
            .createHash('md5')
            .update(url)
            .digest('hex')}`;
          await this.cache.del(cacheKey);
        }
      }

      // Update in-memory cache in ExternalCardService
      await this.externalCardService.updateCardsWithSpotifyIdInCache(spotifyId, newLinks);

      this.logger.log(
        color.blue.bold(
          `[${white.bold('MusicFetch')}] Cleared caches for ${white.bold(cards.length.toString())} card(s) with spotifyId ${white.bold(spotifyId)}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `[${white.bold('MusicFetch')}] Warning: Failed to clear caches for spotifyId ${white.bold(spotifyId)}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
    }
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
            country: 'NL'
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
            color.red.bold(`[${white.bold('MusicFetch')}] Rate limit exceeded, will retry later`)
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
   * @param trackId - The track ID to process
   * @param forceUpdate - If true, bypasses the max attempts check (for manual fetches)
   */
  public async updateTrackWithLinks(trackId: number, forceUpdate: boolean = false): Promise<boolean> {
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

      if (!forceUpdate && track.musicFetchAttempts >= this.MAX_ATTEMPTS) {
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
            `[${white.bold('MusicFetch')}] Updated "${white.bold(track.artist)} - ${white.bold(track.name)}" with ${white.bold(newLinksAdded.length.toString())} new links: ${white.bold(newLinksAdded.join(', '))}`
          )
        );
      }

      return result.success;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `[${white.bold('MusicFetch')}] Error updating track ${white.bold(
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
          `[${white.bold('MusicFetch')}] Processing ${white.bold(tracksToProcess.length.toString())} tracks for playlist ${white.bold(playlistId.toString())}`
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
            `[${white.bold('MusicFetch')}] Playlist ${white.bold(playlistId.toString())} complete: ${white.bold(successCount.toString())}/${white.bold(tracksToProcess.length.toString())} tracks updated`
          )
        );
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `[${white.bold('MusicFetch')}] Error processing playlist ${white.bold(
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

  /**
   * Process a single external card and return detailed results
   * Used by the admin UI for single-card MusicFetch action
   * Updates ALL external cards with the same spotifyId
   */
  public async processSingleExternalCard(
    card: {
      id: number;
      spotifyId: string | null;
      spotifyLink: string | null;
      appleMusicLink: string | null;
      tidalLink: string | null;
      youtubeMusicLink: string | null;
      deezerLink: string | null;
      amazonMusicLink: string | null;
    }
  ): Promise<{ success: boolean; linksAdded: string[]; cardsUpdated: number; error?: string }> {
    try {
      // Need a spotify link as source
      const sourceUrl = card.spotifyLink || (card.spotifyId ? `https://open.spotify.com/track/${card.spotifyId}` : null);
      if (!sourceUrl) {
        return { success: false, linksAdded: [], cardsUpdated: 0, error: 'No Spotify source available' };
      }

      // Fetch links from MusicFetch API
      const result = await this.fetchLinksForTrack(sourceUrl, 'spotifyLink');

      if (result.rateLimited) {
        return { success: false, linksAdded: [], cardsUpdated: 0, error: 'Rate limited, please try again later' };
      }

      if (!result.success || !result.links) {
        return { success: false, linksAdded: [], cardsUpdated: 0, error: 'No links found' };
      }

      // Build update data - only include non-empty values
      const linksToUpdate: Record<string, string> = {};
      const linksAdded: string[] = [];

      if (result.links.deezerLink) {
        linksToUpdate.deezerLink = result.links.deezerLink;
        linksAdded.push('Deezer');
      }
      if (result.links.youtubeMusicLink) {
        linksToUpdate.youtubeMusicLink = result.links.youtubeMusicLink;
        linksAdded.push('YouTube Music');
      }
      if (result.links.appleMusicLink) {
        linksToUpdate.appleMusicLink = result.links.appleMusicLink;
        linksAdded.push('Apple Music');
      }
      if (result.links.amazonMusicLink) {
        linksToUpdate.amazonMusicLink = result.links.amazonMusicLink;
        linksAdded.push('Amazon Music');
      }
      if (result.links.tidalLink) {
        linksToUpdate.tidalLink = result.links.tidalLink;
        linksAdded.push('Tidal');
      }

      if (Object.keys(linksToUpdate).length === 0) {
        return {
          success: false,
          linksAdded: [],
          cardsUpdated: 0,
          error: 'No links found from MusicFetch',
        };
      }

      // Find all external cards with the same spotifyId
      const cardsToUpdate = await this.prisma.externalCard.findMany({
        where: { spotifyId: card.spotifyId },
        select: {
          id: true,
          deezerLink: true,
          youtubeMusicLink: true,
          appleMusicLink: true,
          amazonMusicLink: true,
          tidalLink: true,
        },
      });

      let cardsUpdated = 0;

      // Update each card, only filling in null/empty fields
      for (const cardToUpdate of cardsToUpdate) {
        const updateData: Record<string, any> = {
          musicFetchLastAttempt: new Date(),
          musicFetchAttempts: { increment: 1 },
        };

        // Only update fields that are currently null/empty AND we have a value for
        if (!cardToUpdate.deezerLink && linksToUpdate.deezerLink) {
          updateData.deezerLink = linksToUpdate.deezerLink;
        }
        if (!cardToUpdate.youtubeMusicLink && linksToUpdate.youtubeMusicLink) {
          updateData.youtubeMusicLink = linksToUpdate.youtubeMusicLink;
        }
        if (!cardToUpdate.appleMusicLink && linksToUpdate.appleMusicLink) {
          updateData.appleMusicLink = linksToUpdate.appleMusicLink;
        }
        if (!cardToUpdate.amazonMusicLink && linksToUpdate.amazonMusicLink) {
          updateData.amazonMusicLink = linksToUpdate.amazonMusicLink;
        }
        if (!cardToUpdate.tidalLink && linksToUpdate.tidalLink) {
          updateData.tidalLink = linksToUpdate.tidalLink;
        }

        // Only update if there's something new to add
        if (Object.keys(updateData).length > 2) { // More than just the timestamp fields
          await this.prisma.externalCard.update({
            where: { id: cardToUpdate.id },
            data: updateData,
          });
          cardsUpdated++;
        }
      }

      if (cardsUpdated > 0) {
        this.logger.log(
          color.green.bold(
            `[${white.bold('MusicFetch')}] Updated ${white.bold(cardsUpdated.toString())} external card(s) with spotifyId ${white.bold(card.spotifyId || 'unknown')} - links: ${white.bold(linksAdded.join(', '))}`
          )
        );

        // Clear Redis cache and update in-memory cache
        if (card.spotifyId) {
          await this.clearExternalCardCaches(card.spotifyId, linksToUpdate);
        }
      }

      return {
        success: cardsUpdated > 0,
        linksAdded,
        cardsUpdated,
        error: cardsUpdated === 0 ? 'No new links found (all services already linked or unavailable)' : undefined,
      };
    } catch (error) {
      return {
        success: false,
        linksAdded: [],
        cardsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update external cards with MusicFetch links using Spotify as source
   * Updates ALL cards with the same spotifyId, only filling in null/empty fields
   * @param cardId - The external card ID to process (used to get spotifyId)
   * @param forceUpdate - If true, bypasses the max attempts check
   */
  public async updateExternalCardWithLinks(cardId: number, forceUpdate: boolean = false): Promise<boolean> {
    try {
      const card = await this.prisma.externalCard.findUnique({
        where: { id: cardId },
        select: {
          spotifyLink: true,
          spotifyId: true,
          musicFetchAttempts: true,
        },
      });

      if (!card) {
        return false;
      }

      if (!forceUpdate && card.musicFetchAttempts >= this.MAX_ATTEMPTS) {
        return false;
      }

      // Need a spotify link as source
      const sourceUrl = card.spotifyLink || (card.spotifyId ? `https://open.spotify.com/track/${card.spotifyId}` : null);
      if (!sourceUrl || !card.spotifyId) {
        return false;
      }

      // Fetch links from MusicFetch API
      const result = await this.fetchLinksForTrack(sourceUrl, 'spotifyLink');

      // If rate limited, don't increment attempts
      if (result.rateLimited) {
        return false;
      }

      // Build links to update - only include non-empty values
      const linksToUpdate: Record<string, string> = {};
      const newLinksAdded: string[] = [];

      if (result.links) {
        if (result.links.deezerLink) {
          linksToUpdate.deezerLink = result.links.deezerLink;
          newLinksAdded.push('deezerLink');
        }
        if (result.links.youtubeMusicLink) {
          linksToUpdate.youtubeMusicLink = result.links.youtubeMusicLink;
          newLinksAdded.push('youtubeMusicLink');
        }
        if (result.links.appleMusicLink) {
          linksToUpdate.appleMusicLink = result.links.appleMusicLink;
          newLinksAdded.push('appleMusicLink');
        }
        if (result.links.amazonMusicLink) {
          linksToUpdate.amazonMusicLink = result.links.amazonMusicLink;
          newLinksAdded.push('amazonMusicLink');
        }
        if (result.links.tidalLink) {
          linksToUpdate.tidalLink = result.links.tidalLink;
          newLinksAdded.push('tidalLink');
        }
      }

      // Find all external cards with the same spotifyId
      const cardsToUpdate = await this.prisma.externalCard.findMany({
        where: { spotifyId: card.spotifyId },
        select: {
          id: true,
          deezerLink: true,
          youtubeMusicLink: true,
          appleMusicLink: true,
          amazonMusicLink: true,
          tidalLink: true,
        },
      });

      let cardsUpdated = 0;

      // Update each card, only filling in null/empty fields
      for (const cardToUpdate of cardsToUpdate) {
        const updateData: Record<string, any> = {
          musicFetchLastAttempt: new Date(),
          musicFetchAttempts: { increment: 1 },
        };

        // Only update fields that are currently null/empty AND we have a value for
        if (!cardToUpdate.deezerLink && linksToUpdate.deezerLink) {
          updateData.deezerLink = linksToUpdate.deezerLink;
        }
        if (!cardToUpdate.youtubeMusicLink && linksToUpdate.youtubeMusicLink) {
          updateData.youtubeMusicLink = linksToUpdate.youtubeMusicLink;
        }
        if (!cardToUpdate.appleMusicLink && linksToUpdate.appleMusicLink) {
          updateData.appleMusicLink = linksToUpdate.appleMusicLink;
        }
        if (!cardToUpdate.amazonMusicLink && linksToUpdate.amazonMusicLink) {
          updateData.amazonMusicLink = linksToUpdate.amazonMusicLink;
        }
        if (!cardToUpdate.tidalLink && linksToUpdate.tidalLink) {
          updateData.tidalLink = linksToUpdate.tidalLink;
        }

        await this.prisma.externalCard.update({
          where: { id: cardToUpdate.id },
          data: updateData,
        });

        // Count if we actually added new links (more than just timestamp fields)
        if (Object.keys(updateData).length > 2) {
          cardsUpdated++;
        }
      }

      // Log if we updated any cards with new links
      if (cardsUpdated > 0 && newLinksAdded.length > 0) {
        this.logger.log(
          color.green.bold(
            `[${white.bold('MusicFetch')}] Updated ${white.bold(cardsUpdated.toString())} card(s) with spotifyId ${white.bold(card.spotifyId)} - links: ${white.bold(newLinksAdded.join(', '))}`
          )
        );

        // Clear Redis cache and update in-memory cache
        if (card.spotifyId) {
          await this.clearExternalCardCaches(card.spotifyId, linksToUpdate);
        }
      }

      return result.success;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `[${white.bold('MusicFetch')}] Error updating external card ${white.bold(
            cardId.toString()
          )}: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
      return false;
    }
  }

  /**
   * Process external cards to fetch missing music links
   * Similar to processBulkTracks but works with ExternalCard table
   */
  public async processExternalCards(cardIds?: number[]): Promise<BulkProcessResult> {
    this.logger.log(color.blue.bold('Starting MusicFetch bulk processing for external cards'));

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
        let cardsToProcess;

        if (cardIds && cardIds.length > 0) {
          // Process specific cards (single batch)
          cardsToProcess = await this.prisma.externalCard.findMany({
            where: {
              id: { in: cardIds },
              // Must have a spotify link/id as source
              OR: [
                { spotifyLink: { not: null } },
                { spotifyId: { not: null } },
              ],
            },
            select: {
              id: true,
              spotifyLink: true,
              spotifyId: true,
              deezerLink: true,
              youtubeMusicLink: true,
              appleMusicLink: true,
              amazonMusicLink: true,
              tidalLink: true,
              musicFetchAttempts: true,
            },
          });
          hasMore = false;
        } else {
          // Process all external cards with spotify but missing other links
          cardsToProcess = await this.prisma.externalCard.findMany({
            where: {
              musicFetchAttempts: { lt: this.MAX_ATTEMPTS },
              // Must have spotify link
              OR: [
                { spotifyLink: { not: null } },
                { spotifyId: { not: null } },
              ],
              // Must be missing at least one other link
              AND: [
                {
                  OR: [
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
              spotifyId: true,
              deezerLink: true,
              youtubeMusicLink: true,
              appleMusicLink: true,
              amazonMusicLink: true,
              tidalLink: true,
              musicFetchAttempts: true,
            },
            take: 1000,
          });

          if (cardsToProcess.length < 1000) {
            hasMore = false;
          }
        }

        if (cardsToProcess.length === 0) {
          this.logger.log(
            color.blue.bold(
              'No more external cards found to process - all cards have links or max attempts reached'
            )
          );
          break;
        }

        this.logger.log(
          color.blue.bold(
            `Processing external card chunk ${white.bold(
              chunkNumber.toString()
            )}: ${white.bold(cardsToProcess.length.toString())} cards`
          )
        );

        // Process cards sequentially with rate limiting
        for (const card of cardsToProcess) {
          // Skip if no spotify source
          if (!card.spotifyLink && !card.spotifyId) {
            result.skipped++;
            continue;
          }

          if (card.musicFetchAttempts >= this.MAX_ATTEMPTS) {
            result.skipped++;
            continue;
          }

          const success = await this.updateExternalCardWithLinks(card.id);

          if (success) {
            result.successful++;
          } else {
            result.failed++;
            result.errors.push({
              trackId: card.id,
              error: 'Failed to fetch or update links',
            });
          }
        }

        result.totalProcessed += cardsToProcess.length;

        this.logger.log(
          color.green.bold(
            `External card chunk ${white.bold(chunkNumber.toString())} complete: ${white.bold(
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
          `External card bulk processing complete: ${white.bold(
            result.successful.toString()
          )} successful, ${white.bold(
            result.failed.toString()
          )} failed, ${white.bold(
            result.skipped.toString()
          )} skipped across ${white.bold(
            result.totalProcessed.toString()
          )} total cards`
        )
      );

      return result;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error during external card bulk processing: ${white.bold(
            error instanceof Error ? error.message : 'Unknown error'
          )}`
        )
      );
      return result;
    }
  }
}

export default MusicFetch;
