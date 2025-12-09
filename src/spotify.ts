import { format, set } from 'date-fns';
import { MAX_CARDS, MAX_CARDS_PHYSICAL } from './config/constants';
import { color, white } from 'console-log-colors';
import axios, { AxiosRequestConfig } from 'axios';
import { ApiResult } from './interfaces/ApiResult';
import { Playlist } from './interfaces/Playlist';
import { Track } from './interfaces/Track';
import Cache from './cache';
import Data from './data';
import Utils from './utils';
import AnalyticsClient from './analytics';
import Logger from './logger';
import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import Translation from './translation';
import SpotifyApi from './spotify_api';
import SpotifyRapidApi from './spotify_rapidapi';
import SpotifyScraper from './spotify_scraper';
import SpotifyRapidApi2 from './spotify_rapidapi2';
import RateLimitManager from './rate_limit_manager';
import cluster from 'cluster';
import crypto from 'crypto';
import { CronJob } from 'cron';

// Spotify Cache Key Prefixes
export const CACHE_KEY_PLAYLIST = 'playlist2_';
export const CACHE_KEY_PLAYLIST_FETCH_LOCK = 'playlist_fetch_';
export const CACHE_KEY_PLAYLIST_DB = 'playlistdb2_';
export const CACHE_KEY_TRACKS = 'tracks2_';
export const CACHE_KEY_TRACK_COUNT = 'trackcount2_';
export const CACHE_KEY_TRACK_INFO = 'trackInfo_';
export const CACHE_KEY_TRACKS_BY_IDS = 'tracksbyids_';
export const CACHE_KEY_SEARCH = 'search_';

// Track enrichment data structure
interface EnrichmentData {
  year: number;
  name: string;
  artist: string;
  extraNameAttribute?: string;
  extraArtistAttribute?: string;
}

// Skipped track information for API response
export type SkipReason = 'unavailable' | 'localFile' | 'podcast' | 'duplicate';

export interface SkippedTrack {
  position: number;           // Original playlist position (1-indexed)
  reason: SkipReason;
  name?: string;              // Track name if available
  artist?: string;            // Artist name if available
  duplicateOf?: number;       // Position of first occurrence (for duplicates)
}

export interface SkipSummary {
  unavailable: number;        // Track removed/unavailable
  localFiles: number;         // Local files can't be imported
  podcasts: number;           // Podcast episodes filtered
  duplicates: number;         // Same artist+title duplicates
}

export interface SkippedTracksInfo {
  total: number;
  summary: SkipSummary;
  details: SkippedTrack[];
}

class Spotify {
  private static instance: Spotify;
  private cache = Cache.getInstance();
  private data = Data.getInstance(); // Keep Data instance if needed elsewhere
  private utils = new Utils();
  private analytics = AnalyticsClient.getInstance();
  private prisma = PrismaInstance.getInstance();
  private translate = new Translation();
  private logger = new Logger(); // Add logger instance
  private spotifyApi = new SpotifyApi(); // Instantiate SpotifyApi
  private spotifyRapidApi = new SpotifyRapidApi(); // Instantiate SpotifyRapidApi
  private spotifyScraper = new SpotifyScraper(); // Instantiate SpotifyScraper if needed
  private spotifyRapidApi2 = new SpotifyRapidApi2(); // Instantiate SpotifyRapidApi for fallback
  private rateLimitManager = RateLimitManager.getInstance(); // Add rate limit manager

  private api = this.spotifyApi; // Default to SpotifyApi
  private apiFallback = this.spotifyRapidApi; // Default to SpotifyApi

  // Jumbo card mapping: key = '[set_sku]_[cardnumber]', value = spotify id
  private jumboCardMap: { [key: string]: string } = {};
  // Country card mapping: key = country code (e.g., 'de'), value = { cardNumber -> spotifyId }
  private countryCardMaps: { [countryCode: string]: { [cardNumber: string]: string } } = {};
  // MusicMatch mapping: key = 'playlistId_trackId', value = spotify track id
  private musicMatchMap: { [key: string]: string } = {};
  // Domain blacklist: URLs from these domains will not be resolved
  private domainBlacklist: string[] = ['q.me-qr.com', 'qrto.org'];

  // Track enrichment maps for fast in-memory lookups
  private trackEnrichmentByTrackId: Map<string, EnrichmentData> = new Map();
  private trackEnrichmentByIsrc: Map<string, EnrichmentData> = new Map();
  private trackEnrichmentByArtistTitleHash: Map<string, EnrichmentData> = new Map();

  constructor() {
    this.getJumboData();
    this.loadMusicMatchData();
    this.loadCountryData();
    this.loadTrackEnrichmentMaps();

    // Set up hourly cron job to refresh track enrichment maps
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          const enrichmentRefreshJob = new CronJob('0 * * * *', async () => {
            await this.refreshTrackEnrichmentMaps();
          });
          enrichmentRefreshJob.start();
          this.logger.log(
            color.green.bold('Track enrichment refresh cron job scheduled (hourly)')
          );
        }
      });
    }
  }

  public static getInstance(): Spotify {
    if (!Spotify.instance) {
      Spotify.instance = new Spotify();
    }
    return Spotify.instance;
  }

  /**
   * Fetches Jumbo gameset data and populates the jumboCardMap.
   */
  private async getJumboData(): Promise<void> {
    const isPrimary = cluster.isPrimary;

    try {
      const url =
        'https://hitster.jumboplay.com/hitster-assets/gameset_database.json';
      const response = await axios.get(url, { timeout: 10000 });
      const data = response.data;
      if (data && Array.isArray(data.gamesets)) {
        for (const gameset of data.gamesets) {
          const sku = gameset.sku;
          const cards = gameset.gameset_data?.cards;
          if (sku && Array.isArray(cards)) {
            for (const card of cards) {
              const cardNumber = card.CardNumber;
              const spotifyId = card.Spotify;
              if (cardNumber && spotifyId) {
                const key = `${sku}_${cardNumber}`;
                this.jumboCardMap[key] = spotifyId;
              }
            }
          }
        }
        if (isPrimary) {
          this.utils.isMainServer().then(async (isMainServer) => {
            if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
              this.logger.log(
                color.green.bold(
                  `Jumbo gameset data loaded: ${color.white.bold(
                    Object.keys(this.jumboCardMap).length
                  )} cards mapped`
                )
              );
            }
          });
        }
      } else {
        this.logger.log(
          color.yellow.bold('Jumbo gameset data: No gamesets found in response')
        );
      }
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`Failed to fetch Jumbo gameset data: ${e.message || e}`)
      );
    }
  }

  /**
   * Loads MusicMatch data from the JSON file and populates the musicMatchMap.
   */
  private async loadMusicMatchData(): Promise<void> {
    const isPrimary = cluster.isPrimary;

    try {
      // Import the musicmatch.json file
      const fs = require('fs').promises;
      const path = require('path');
      const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');
      const filePath = path.join(appRoot, '_data', 'musicmatch.json');

      const fileContent = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(fileContent);

      if (data && data.p && Array.isArray(data.p)) {
        for (const playlist of data.p) {
          const playlistId = playlist.i;
          if (playlistId && Array.isArray(playlist.t)) {
            for (const track of playlist.t) {
              const trackId = track.i;
              const spotifyId = track.l;
              if (trackId && spotifyId) {
                const key = `${playlistId}_${trackId}`;
                this.musicMatchMap[key] = spotifyId;
              }
            }
          }
        }

        if (isPrimary) {
          this.utils.isMainServer().then(async (isMainServer) => {
            if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
              this.logger.log(
                color.green.bold(
                  `MusicMatch data loaded: ${color.white.bold(
                    Object.keys(this.musicMatchMap).length
                  )} tracks mapped`
                )
              );
            }
          });
        }
      } else {
        this.logger.log(
          color.yellow.bold('MusicMatch data: No playlists found in file')
        );
      }
    } catch (e: any) {
      this.logger.log(
        color.yellow.bold(`Failed to load MusicMatch data: ${e.message || e}`)
      );
    }
  }

  /**
   * Loads country card data from JSON files in the _data/jumbo/ directory.
   * Each file should have structure: { name: "de", cards: { "00001": "spotifyId", ... } }
   */
  private async loadCountryData(): Promise<void> {
    const isPrimary = cluster.isPrimary;

    try {
      const fs = require('fs').promises;
      const path = require('path');
      const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');
      const dirPath = path.join(appRoot, '_data', 'jumbo');

      // Check if directory exists
      try {
        await fs.access(dirPath);
      } catch {
        this.logger.log(
          color.yellow.bold('Country card data directory not found: ' + dirPath)
        );
        return;
      }

      // Read all files in the directory
      const files = await fs.readdir(dirPath);
      const jsonFiles = files.filter((file: string) => file.endsWith('.json'));

      let totalCards = 0;
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(dirPath, file);
          const fileContent = await fs.readFile(filePath, 'utf8');
          const data = JSON.parse(fileContent);

          if (data && data.name && data.cards && typeof data.cards === 'object') {
            const countryCode = data.name.toLowerCase();
            this.countryCardMaps[countryCode] = data.cards;

            const cardCount = Object.keys(data.cards).length;
            totalCards += cardCount;

            if (isPrimary) {
              this.utils.isMainServer().then(async (isMainServer) => {
                if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
                  this.logger.log(
                    color.green.bold(
                      `Country card data loaded for ${color.white.bold(
                        countryCode
                      )}: ${color.white.bold(cardCount)} cards`
                    )
                  );
                }
              });
            }
          } else {
            this.logger.log(
              color.yellow.bold(
                `Invalid country card data format in ${file}: missing name or cards`
              )
            );
          }
        } catch (e: any) {
          this.logger.log(
            color.yellow.bold(
              `Failed to load country card data from ${file}: ${e.message || e}`
            )
          );
        }
      }

      if (isPrimary && jsonFiles.length > 0) {
        this.utils.isMainServer().then(async (isMainServer) => {
          if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
            this.logger.log(
              color.green.bold(
                `Country card data loaded: ${color.white.bold(
                  jsonFiles.length
                )} countries, ${color.white.bold(totalCards)} total cards`
              )
            );
          }
        });
      }
    } catch (e: any) {
      this.logger.log(
        color.yellow.bold(`Failed to load country card data: ${e.message || e}`)
      );
    }
  }

  /**
   * Loads track enrichment data from database into in-memory maps.
   * This eliminates expensive database queries with 1,500+ OR conditions.
   */
  private async loadTrackEnrichmentMaps(): Promise<void> {
    const isPrimary = cluster.isPrimary;

    try {
      // Query all manually-checked tracks from database
      const tracks = await this.prisma.track.findMany({
        where: { manuallyChecked: true },
        select: {
          trackId: true,
          isrc: true,
          year: true,
          name: true,
          artist: true,
        },
      });

      // Clear existing maps
      this.trackEnrichmentByTrackId.clear();
      this.trackEnrichmentByIsrc.clear();
      this.trackEnrichmentByArtistTitleHash.clear();

      // Populate all three maps
      for (const track of tracks) {
        if (!track.year || !track.name || !track.artist) {
          continue; // Skip tracks without required data
        }

        const enrichmentData: EnrichmentData = {
          year: track.year,
          name: track.name,
          artist: track.artist,
        };

        // Map 1: By trackId
        if (track.trackId) {
          this.trackEnrichmentByTrackId.set(track.trackId, enrichmentData);
        }

        // Map 2: By ISRC
        if (track.isrc) {
          this.trackEnrichmentByIsrc.set(track.isrc, enrichmentData);
        }

        // Map 3: By artist+title hash (normalized, case-insensitive)
        const artistTitleKey = `${track.artist.toLowerCase().trim()}|||${track.name.toLowerCase().trim()}`;
        const hash = this.createSimpleHash(artistTitleKey);
        this.trackEnrichmentByArtistTitleHash.set(hash, enrichmentData);
      }

      if (isPrimary) {
        this.utils.isMainServer().then(async (isMainServer) => {
          if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
            this.logger.log(
              color.green.bold(
                `Track enrichment maps loaded: ${color.white.bold(
                  this.trackEnrichmentByTrackId.size
                )} by trackId, ${color.white.bold(
                  this.trackEnrichmentByIsrc.size
                )} by ISRC, ${color.white.bold(
                  this.trackEnrichmentByArtistTitleHash.size
                )} by artist+title`
              )
            );
          }
        });
      }
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`Failed to load track enrichment maps: ${e.message || e}`)
      );
    }
  }

  /**
   * Public method to refresh track enrichment maps.
   * Called by cron job to keep maps up-to-date.
   */
  public async refreshTrackEnrichmentMaps(): Promise<void> {
    this.logger.log(color.blue.bold('Refreshing track enrichment maps...'));
    await this.loadTrackEnrichmentMaps();
  }

  public async getPlaylist(
    playlistId: string,
    cache: boolean = true,
    captchaToken: string = '',
    checkCaptcha: boolean,
    featured: boolean = false,
    isSlug: boolean = false,
    locale: string = 'en',
    clientIp: string = '',
    userAgent: string = ''
  ): Promise<ApiResult> {
    let playlist: Playlist | null = null;

    if (!this.translate.isValidLocale(locale)) {
      locale = 'en';
    }

    // if (checkCaptcha) {
    //   // Verify reCAPTCHA token
    //   const isHuman = await this.utils.verifyRecaptcha(captchaToken);
    //
    //   if (!isHuman) {
    //     throw new Error('reCAPTCHA verification failed');
    //   }
    // }

    try {
      // Remove locale from cache key - cache all descriptions together
      const cacheKey = `${CACHE_KEY_PLAYLIST}${playlistId}`;
      const lockKey = `${CACHE_KEY_PLAYLIST_FETCH_LOCK}${playlistId}`;
      const dbCacheKey = `${CACHE_KEY_PLAYLIST_DB}${playlistId}`;

      // Try to get from cache first
      let cacheResult = await this.cache.get(cacheKey);
      const dbCacheResult = await this.cache.get(dbCacheKey);

      if (!cacheResult || !cache) {
        // Try to acquire lock for this playlist
        const lockAcquired = await this.cache.acquireLock(lockKey, 30); // 30 second TTL

        if (!lockAcquired) {
          // Poll cache every 100ms for up to 10 seconds
          const maxAttempts = 100;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            cacheResult = await this.cache.get(cacheKey);
            if (cacheResult) {
              break;
            }
          }

          // If still no cache result after waiting, return error
          if (!cacheResult) {
            return {
              success: false,
              error: 'Timeout waiting for playlist data',
            };
          }
        } else {
          // We acquired the lock, fetch the playlist
          try {
            const ipInfo = clientIp
              ? ` from IP ${color.white.bold(clientIp)}`
              : '';
            const uaInfo = userAgent
              ? ` with User-Agent: ${color.white.bold(userAgent)}`
              : '';

            let checkPlaylistId = playlistId;

            if (isSlug) {
              if (!dbCacheResult || !cache) {
                const dbPlaylist = await this.prisma.playlist.findFirst({
                  where: { slug: playlistId, featured: true },
                });
                if (!dbPlaylist) {
                  // Cache the failure so other waiting requests don't timeout
                  const failureResult = JSON.stringify({
                    error: 'playlistNotFound',
                  });
                  await this.cache.set(cacheKey, failureResult, 60); // Cache for 1 minute
                  await this.cache.releaseLock(lockKey);
                  return { success: false, error: 'playlistNotFound' };
                }
                checkPlaylistId = dbPlaylist.playlistId;
                this.cache.set(dbCacheKey, checkPlaylistId);
              } else {
                checkPlaylistId = dbCacheResult;
              }
            }

            this.logger.log(
              color.blue.bold(
                `Fetching playlist from API for ${color.white.bold(
                  playlistId
                )}${ipInfo}${uaInfo}`
              )
            );

            // Use rate limit manager for automatic fallback on 429 errors
            const result = await this.rateLimitManager.executeWithFallback(
              'getPlaylist',
              [checkPlaylistId],
              this.api,
              this.apiFallback
            );

            if (!result.success) {
              // Cache the failure so other waiting requests don't timeout
              const errorToCache =
                result.error === 'Spotify resource not found'
                  ? 'playlistNotFound'
                  : result.error || 'Error getting playlist from API';

              const failureResult = JSON.stringify({
                error: errorToCache,
                needsReAuth: result.needsReAuth,
              });

              // Cache errors for a shorter time (1 minute) since they might be transient
              await this.cache.set(cacheKey, failureResult, 60);
              await this.cache.releaseLock(lockKey);

              // Check if the error indicates a need for re-authentication
              if (result.needsReAuth) {
                return {
                  success: false,
                  error: result.error,
                  needsReAuth: true,
                };
              }
              if (
                result.error === 'Spotify resource not found' ||
                result.error === 'playlistNotFound'
              ) {
                return { success: false, error: 'playlistNotFound' };
              }
              return {
                success: false,
                error: result.error || 'Error getting playlist from API',
              };
            }

            const playlistData = result.data;

            // Add check to ensure playlistData exists before accessing its properties
            if (!playlistData) {
              // Cache the failure so other waiting requests don't timeout
              const failureResult = JSON.stringify({
                error: 'Error getting playlist data from API',
              });
              await this.cache.set(cacheKey, failureResult, 60);
              await this.cache.releaseLock(lockKey);

              this.logger.log(
                color.red.bold(
                  `Playlist data missing from API response for ${checkPlaylistId}`
                )
              );
              return {
                success: false,
                error: 'Error getting playlist data from API',
              };
            }

            let image = '';
            // Now it's safe to access playlistData properties
            if (playlistData.images && playlistData.images.length > 0) {
              image = playlistData.images[0].url;
            }

            let playlistName = playlistData.name;
            let playlistDescription = playlistData.description;
            let allDescriptions: Record<string, string | null> = {};
            let playlistDesign: any = null;

            if (featured) {
              // Build select object dynamically based on available locales
              const selectFields: any = { name: true, design: true };
              for (const lang of this.translate.allLocales) {
                selectFields[`description_${lang}`] = true;
              }

              const dbPlaylist = await this.prisma.playlist.findFirst({
                where: { slug: playlistId, featured: true },
                select: selectFields,
              });

              if (dbPlaylist) {
                playlistName = dbPlaylist.name || playlistName;
                playlistDesign = dbPlaylist.design || null;

                // Collect all descriptions dynamically
                for (const lang of this.translate.allLocales) {
                  const descField =
                    `description_${lang}` as keyof typeof dbPlaylist;
                  const descValue = dbPlaylist[descField];
                  if (descValue && typeof descValue === 'string') {
                    allDescriptions[lang] = descValue;
                  }
                }
              }
            }

            // Cache the full playlist data with all descriptions
            const cachedPlaylistData = {
              id: playlistId,
              playlistId: checkPlaylistId,
              name: playlistName,
              description: playlistDescription, // Default Spotify description
              descriptions: allDescriptions, // All language descriptions
              numberOfTracks: playlistData.tracks?.total || 0,
              image,
              design: playlistDesign,
            };

            this.cache.set(cacheKey, JSON.stringify(cachedPlaylistData));

            // If this was a slug lookup, also cache with the actual playlist ID
            if (isSlug && checkPlaylistId !== playlistId) {
              const actualCacheKey = `${CACHE_KEY_PLAYLIST}${checkPlaylistId}`;
              this.cache.set(
                actualCacheKey,
                JSON.stringify(cachedPlaylistData)
              );
            }

            // Release the lock after successful caching
            await this.cache.releaseLock(lockKey);

            // Extract the appropriate description for the requested locale
            playlist = {
              id: playlistId,
              playlistId: checkPlaylistId,
              name: playlistName,
              description: allDescriptions[locale] || playlistDescription,
              numberOfTracks: cachedPlaylistData.numberOfTracks,
              image,
              design: playlistDesign,
            };
          } catch (error) {
            // Make sure to release lock in case of any error
            await this.cache.releaseLock(lockKey);
            throw error;
          }
        }
      }

      if (!playlist && cacheResult) {
        // Parse cached data and check if it's an error result
        const cachedData = JSON.parse(cacheResult);

        // If the cached result is an error, return it immediately
        if (cachedData.error) {
          return { success: false, error: cachedData.error };
        }

        // Otherwise extract appropriate description
        playlist = {
          id: cachedData.id,
          playlistId: cachedData.playlistId,
          name: cachedData.name,
          description:
            (cachedData.descriptions && cachedData.descriptions[locale]) ||
            cachedData.description,
          numberOfTracks: cachedData.numberOfTracks,
          image: cachedData.image,
          design: cachedData.design || null,
        };
      }

      // Track analytics for playlist retrieval
      this.analytics.increaseCounter('spotify', 'playlist', 1);

      return {
        success: true,
        data: playlist,
      };
    } catch (e: any) {
      console.log(e);
      if (e.response && e.response.status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      return { success: false, error: 'Error getting playlist' };
    }
  }

  /**
   * Helper: Build track matching queries for database enrichment
   * Extracts trackIds, ISRCs, and artist+title pairs from Spotify track data
   */
  private buildTrackMatchingQueries(trackItems: any[]): {
    trackIds: string[];
    isrcs: string[];
    artistTitlePairs: Array<{ artist: string; title: string; trackId: string }>;
  } {
    const trackIds: string[] = [];
    const isrcs: string[] = [];
    const artistTitlePairs: Array<{ artist: string; title: string; trackId: string }> = [];

    trackItems
      .filter((item: any) => item?.track?.id)
      .forEach((item: any) => {
        const trackData = item.track;
        const trackId = trackData.id;

        // Collect track ID
        trackIds.push(trackId);

        // Collect ISRC if available
        if (trackData.external_ids?.isrc) {
          isrcs.push(trackData.external_ids.isrc);
        }

        // Collect artist + title for exact matching
        if (trackData.name && trackData.artists && trackData.artists.length > 0) {
          const artist = trackData.artists[0].name; // Use primary artist
          const title = this.utils.cleanTrackName(trackData.name);
          if(artist && title){
            artistTitlePairs.push({
              artist: artist.toLowerCase().trim(),
              title: title.toLowerCase().trim(),
              trackId,
            });
          }
        }
      });

    return { trackIds, isrcs, artistTitlePairs };
  }

  /**
   * Helper: Execute database enrichment query with multiple matching strategies
   * Returns lookup maps for trackId, ISRC, and artist+title matching
   */
  private async executeTrackEnrichment(
    checkPlaylistId: string,
    trackIds: string[],
    isrcs: string[],
    artistTitlePairs: Array<{ artist: string; title: string; trackId: string }>
  ): Promise<{
    byTrackId: Map<string, any>;
    byIsrc: Map<string, any>;
    byArtistTitle: Map<string, any>;
  }> {
    if (trackIds.length === 0) {
      return {
        byTrackId: new Map(),
        byIsrc: new Map(),
        byArtistTitle: new Map(),
      };
    }

    // Get the playlist ID from the database
    const dbPlaylist = await this.prisma.playlist.findFirst({
      where: { playlistId: checkPlaylistId },
      select: { id: true },
    });

    let yearResults: {
      trackId: string;
      isrc: string | null;
      year: number;
      name: string;
      artist: string;
      extraNameAttribute?: string;
      extraArtistAttribute?: string;
      overwriteYear?: number;
      overwriteName?: string;
      overwriteArtist?: string;
    }[] = [];

    // For large artist+title pairs, we need to split into multiple queries
    // to avoid creating SQL queries with thousands of OR conditions which hang
    const MAX_ARTIST_TITLE_CONDITIONS = 100;

    if (artistTitlePairs.length > MAX_ARTIST_TITLE_CONDITIONS) {
      // Split into separate queries: one for trackIds/ISRCs, then batched artist+title queries

      // Query 1: TrackIds and ISRCs only
      const whereParts1: any[] = [];
      if (trackIds.length > 0) {
        whereParts1.push(Prisma.sql`t.trackId IN (${Prisma.join(trackIds)})`);
      }
      if (isrcs.length > 0) {
        whereParts1.push(Prisma.sql`t.isrc IN (${Prisma.join(isrcs)})`);
      }

      if (whereParts1.length > 0) {
        const whereClause1 = Prisma.join(whereParts1, ' OR ');
        const results1 = await this.executeEnrichmentQuery(dbPlaylist, whereClause1);
        yearResults.push(...results1);
      }

      // Query 2+: Artist+Title in batches
      for (let i = 0; i < artistTitlePairs.length; i += MAX_ARTIST_TITLE_CONDITIONS) {
        const batch = artistTitlePairs.slice(i, i + MAX_ARTIST_TITLE_CONDITIONS);
        const artistTitleConditions = batch.map((pair) => {
          return Prisma.sql`(LOWER(TRIM(t.artist)) = ${pair.artist} AND LOWER(TRIM(t.name)) = ${pair.title})`;
        });
        const whereClause2 = Prisma.sql`(${Prisma.join(artistTitleConditions, ' OR ')})`;
        const results2 = await this.executeEnrichmentQuery(dbPlaylist, whereClause2);
        yearResults.push(...results2);
      }
    } else {
      // Small query - use original single-query approach
      const whereParts: any[] = [];

      // Track ID matching (priority 1)
      if (trackIds.length > 0) {
        whereParts.push(Prisma.sql`t.trackId IN (${Prisma.join(trackIds)})`);
      }

      // ISRC matching (priority 2)
      if (isrcs.length > 0) {
        whereParts.push(Prisma.sql`t.isrc IN (${Prisma.join(isrcs)})`);
      }

      // Artist + Title matching (priority 3)
      if (artistTitlePairs.length > 0) {
        const artistTitleConditions = artistTitlePairs.map((pair) => {
          return Prisma.sql`(LOWER(TRIM(t.artist)) = ${pair.artist} AND LOWER(TRIM(t.name)) = ${pair.title})`;
        });
        whereParts.push(Prisma.sql`(${Prisma.join(artistTitleConditions, ' OR ')})`);
      }

      // Join all WHERE parts with OR
      const whereClause = Prisma.join(whereParts, ' OR ');
      yearResults = await this.executeEnrichmentQuery(dbPlaylist, whereClause);
    }

    // Build three lookup maps
    const byTrackId = new Map();
    const byIsrc = new Map();
    const byArtistTitle = new Map();

    yearResults.forEach((r) => {
      const enrichmentData = {
        year: r.overwriteYear || r.year,
        name: r.overwriteName || r.name,
        artist: r.overwriteArtist || r.artist,
        extraNameAttribute: r.extraNameAttribute,
        extraArtistAttribute: r.extraArtistAttribute,
      };

      // Map by trackId
      if (r.trackId) {
        byTrackId.set(r.trackId, enrichmentData);
      }

      // Map by ISRC
      if (r.isrc) {
        byIsrc.set(r.isrc, enrichmentData);
      }

      // Map by artist + title (lowercase for matching)
      const key = `${r.artist.toLowerCase().trim()}|||${r.name.toLowerCase().trim()}`;
      byArtistTitle.set(key, enrichmentData);
    });

    return { byTrackId, byIsrc, byArtistTitle };
  }

  /**
   * Helper: Execute enrichment query (extracted for reuse in batching)
   */
  private async executeEnrichmentQuery(
    dbPlaylist: { id: number } | null,
    whereClause: any
  ): Promise<{
    trackId: string;
    isrc: string | null;
    year: number;
    name: string;
    artist: string;
    extraNameAttribute?: string;
    extraArtistAttribute?: string;
    overwriteYear?: number;
    overwriteName?: string;
    overwriteArtist?: string;
  }[]> {
    if (dbPlaylist) {
      return await this.prisma.$queryRaw<
        {
          trackId: string;
          isrc: string | null;
          year: number;
          name: string;
          artist: string;
          extraNameAttribute?: string;
          extraArtistAttribute?: string;
          overwriteYear?: number;
          overwriteName?: string;
          overwriteArtist?: string;
        }[]
      >`
        SELECT
          t.trackId,
          t.isrc,
          t.year,
          t.artist,
          t.name,
          tei.extraNameAttribute,
          tei.extraArtistAttribute,
          tei.artist AS overwriteArtist,
          tei.name AS overwriteName,
          tei.year AS overwriteYear
        FROM
          tracks t
        LEFT JOIN
          (SELECT * FROM trackextrainfo WHERE playlistId = ${dbPlaylist.id}) tei
          ON t.id = tei.trackId
        WHERE
          (${whereClause})
          AND t.manuallyChecked = 1
      `;
    } else {
      return await this.prisma.$queryRaw<
        {
          trackId: string;
          isrc: string | null;
          year: number;
          name: string;
          artist: string;
          extraNameAttribute?: string;
          extraArtistAttribute?: string;
        }[]
      >`
        SELECT
          t.trackId,
          t.isrc,
          t.year,
          t.artist,
          t.name,
          NULL as extraNameAttribute,
          NULL as extraArtistAttribute,
          NULL as overwriteArtist,
          NULL as overwriteName,
          NULL as overwriteYear
        FROM
          tracks t
        WHERE
          (${whereClause})
          AND t.manuallyChecked = 1
      `;
    }
  }

  /**
   * Helper: Match track using waterfall strategy
   * Priority: 1) trackId, 2) ISRC, 3) artist+title, 4) cache fallback
   */
  private async matchTrackByStrategy(
    spotifyTrackId: string,
    spotifyIsrc: string | undefined,
    spotifyArtist: string,
    spotifyTitle: string,
    byTrackId: Map<string, any>,
    byIsrc: Map<string, any>,
    byArtistTitle: Map<string, any>
  ): Promise<{
    enrichmentData: any | null;
    matchType: 'trackId' | 'isrc' | 'artistTitle' | 'cache' | 'none';
    cacheKey?: string;
  }> {
    // Priority 1: Exact trackId match
    if (byTrackId.has(spotifyTrackId)) {
      return {
        enrichmentData: byTrackId.get(spotifyTrackId),
        matchType: 'trackId',
        cacheKey: `${CACHE_KEY_TRACK_INFO}${spotifyTrackId}`,
      };
    }

    // Priority 2: ISRC match
    if (spotifyIsrc && byIsrc.has(spotifyIsrc)) {
      return {
        enrichmentData: byIsrc.get(spotifyIsrc),
        matchType: 'isrc',
        cacheKey: `${CACHE_KEY_TRACK_INFO}isrc_${spotifyIsrc}`,
      };
    }

    // Priority 3: Artist + Title exact match (case-insensitive)
    const artistTitleKey = `${spotifyArtist.toLowerCase().trim()}|||${spotifyTitle.toLowerCase().trim()}`;
    if (byArtistTitle.has(artistTitleKey)) {
      // Create a hash for the cache key (to keep it reasonable length)
      const hash = this.createSimpleHash(artistTitleKey);
      return {
        enrichmentData: byArtistTitle.get(artistTitleKey),
        matchType: 'artistTitle',
        cacheKey: `${CACHE_KEY_TRACK_INFO}artitle_${hash}`,
      };
    }

    // Priority 4: Check cache (for previously matched tracks)
    const cachedTrackInfo = await this.cache.get(`${CACHE_KEY_TRACK_INFO}${spotifyTrackId}`);
    if (cachedTrackInfo) {
      return {
        enrichmentData: JSON.parse(cachedTrackInfo),
        matchType: 'cache',
      };
    }

    // No match found
    return {
      enrichmentData: null,
      matchType: 'none',
    };
  }

  /**
   * Helper: Create a simple hash for cache keys
   */
  private createSimpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Helper: Format enriched track object
   */
  private formatEnrichedTrack(
    trackData: any,
    enrichmentData: any | null,
    spotifyArtists: any[]
  ): Track | null {
    const trackId = trackData.id;

    if (!trackData.name || !spotifyArtists || spotifyArtists.length === 0) {
      return null;
    }

    // Filter out podcast episodes (they have /episode/ in URL instead of /track/)
    const spotifyUrl = trackData.external_urls?.spotify || '';
    if (spotifyUrl.includes('/episode/')) {
      return null;
    }

    let trueYear: number | undefined;
    let extraNameAttribute: string | undefined;
    let extraArtistAttribute: string | undefined;
    let trueName: string;
    let trueArtist: string;

    // Format Spotify artist(s) as fallback
    let spotifyArtist: string;
    if (spotifyArtists.length === 1) {
      spotifyArtist = spotifyArtists[0].name;
    } else {
      const limitedArtists = spotifyArtists.slice(0, 3);
      const artistNames = limitedArtists.map((artist: { name: string }) => artist.name);
      const lastArtist = artistNames.pop();
      spotifyArtist = artistNames.join(', ') + ' & ' + lastArtist;
    }

    if (enrichmentData) {
      trueYear = enrichmentData.year;
      trueName = enrichmentData.name || trackData.name;
      // Fall back to Spotify artist if enrichment data has null/undefined artist
      trueArtist = enrichmentData.artist || spotifyArtist;
      extraNameAttribute = enrichmentData.extraNameAttribute;
      extraArtistAttribute = enrichmentData.extraArtistAttribute;
    } else {
      // Fallback to Spotify data
      trueName = trackData.name;
      trueArtist = spotifyArtist;
    }

    // Final safety check: reject tracks with no valid artist
    if (!trueArtist) {
      return null;
    }

    const imageUrl =
      trackData.album?.images?.length > 1
        ? trackData.album.images[1].url
        : trackData.album?.images?.length > 0
        ? trackData.album.images[0].url
        : null;

    if (!imageUrl) {
      return null;
    }

    return {
      id: trackId,
      name: this.utils.cleanTrackName(trueName),
      album: this.utils.cleanTrackName(trackData.album?.name || ''),
      preview: trackData.preview_url || '',
      artist: trueArtist,
      link: trackData.external_urls?.spotify || '',
      spotifyLink: trackData.external_urls?.spotify || '',
      isrc: trackData.external_ids?.isrc,
      image: imageUrl,
      releaseDate: trackData.album?.release_date
        ? format(new Date(trackData.album.release_date), 'yyyy-MM-dd')
        : '',
      trueYear,
      extraNameAttribute,
      extraArtistAttribute,
    };
  }

  /**
   * Helper: Cache track matches with multiple strategies
   */
  private async cacheTrackMatches(
    matches: Array<{
      spotifyTrackId: string;
      enrichmentData: any;
      matchType: 'trackId' | 'isrc' | 'artistTitle' | 'cache' | 'none';
      cacheKey?: string;
    }>
  ): Promise<void> {
    const cachePromises = matches
      .filter((m) => m.enrichmentData && m.cacheKey && m.matchType !== 'cache')
      .map((m) =>
        this.cache.set(
          m.cacheKey!,
          JSON.stringify({
            year: m.enrichmentData.year,
            name: m.enrichmentData.name,
            artist: m.enrichmentData.artist,
            extraNameAttribute: m.enrichmentData.extraNameAttribute,
            extraArtistAttribute: m.enrichmentData.extraArtistAttribute,
          })
        )
      );

    // Also cache by primary trackId for backwards compatibility
    const trackIdCachePromises = matches
      .filter(
        (m) =>
          m.enrichmentData &&
          m.matchType !== 'trackId' &&
          m.matchType !== 'cache'
      )
      .map((m) =>
        this.cache.set(
          `${CACHE_KEY_TRACK_INFO}${m.spotifyTrackId}`,
          JSON.stringify({
            year: m.enrichmentData.year,
            name: m.enrichmentData.name,
            artist: m.enrichmentData.artist,
            extraNameAttribute: m.enrichmentData.extraNameAttribute,
            extraArtistAttribute: m.enrichmentData.extraArtistAttribute,
          })
        )
      );

    await Promise.all([...cachePromises, ...trackIdCachePromises]);
  }

  // New function using this.api.getTracks
  public async getTracks(
    playlistId: string,
    cache: boolean = true,
    captchaToken: string = '',
    checkCaptcha: boolean,
    isSlug: boolean = false,
    clientIp: string = '',
    userAgent: string = ''
  ): Promise<ApiResult> {
    try {

      let cacheKey = `${CACHE_KEY_TRACKS}${playlistId}`; // Use different prefix for cache key
      let cacheKeyCount = `${CACHE_KEY_TRACK_COUNT}${playlistId}`;
      let allFormattedTracks: Track[] = []; // Renamed for clarity
      const uniqueTrackIds = new Set<string>();
      let maxReached = false;
      let maxReachedPhysical = false;
      let skippedTracksInfo: SkippedTracksInfo = {
        total: 0,
        summary: { unavailable: 0, localFiles: 0, podcasts: 0, duplicates: 0 },
        details: [],
      };

      // Get playlist details first (handles slug, gets track count for cache key)
      const playlistResult = await this.getPlaylist(
        playlistId,
        isSlug ? true : false, // Use cache for slug-based playlists, not for regular ones
        '', // Captcha token (not used here)
        false, // Check captcha (not used here)
        isSlug, // Pass featured flag (derived from isSlug for simplicity here, adjust if needed)
        isSlug, // Pass isSlug flag
        'en', // Default locale, adjust if needed
        clientIp,
        userAgent
      );

      if (!playlistResult.success || !playlistResult.data) {
        return {
          success: false,
          error: playlistResult.error || 'Failed to get playlist details',
        };
      }
      const playlistData = playlistResult.data;
      let checkPlaylistId = playlistData.playlistId;

      // Update cache keys with actual ID and track count
      cacheKey = `${CACHE_KEY_TRACKS}${checkPlaylistId}_${playlistData.numberOfTracks}`;
      cacheKeyCount = `${CACHE_KEY_TRACK_COUNT}${checkPlaylistId}_${playlistData.numberOfTracks}`;

      const cacheResult = await this.cache.get(cacheKey);

      if (!cacheResult || !cache) {
        const ipInfo = clientIp ? ` from IP ${color.white.bold(clientIp)}` : '';
        const uaInfo = userAgent
          ? ` with User-Agent: ${color.white.bold(userAgent)}`
          : '';
        this.logger.log(
          color.blue.bold(
            `Fetching tracks from API for playlist ${color.white.bold(
              playlistId
            )} (${color.white.bold(playlistData.name)})${ipInfo}${uaInfo}`
          )
        );

        if (isSlug) {
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: { slug: playlistId, featured: true },
          });
          if (!dbPlaylist) {
            return { success: false, error: 'playlistNotFound' };
          }
          checkPlaylistId = dbPlaylist.playlistId;
        }


        // Use rate limit manager for automatic fallback on 429 errors
        const result = await this.rateLimitManager.executeWithFallback(
          'getTracks',
          [checkPlaylistId],
          this.api,
          this.apiFallback
        );

        if (!result.success) {
          // Handle errors, including potential re-authentication needs
          if (result.needsReAuth) {
            return { success: false, error: result.error, needsReAuth: true };
          }
          if (
            result.error === 'Spotify resource not found' ||
            result.error === 'playlistNotFound' // Assuming getTracks might return this
          ) {
            return { success: false, error: 'playlistNotFound' };
          }
          return {
            success: false,
            error: result.error || 'Error getting tracks from API',
          };
        }

        // API call successful, process the items
        const trackItems = result.data?.items || [];
        this.analytics.increaseCounter(
          'spotify',
          'tracks_fetched_api',
          trackItems.length
        ); // Analytics for raw items fetched

        // Collect skip info for API response (user-actionable reasons only)
        const skippedDetails: SkippedTrack[] = [];
        const skipSummary: SkipSummary = {
          unavailable: 0,
          localFiles: 0,
          podcasts: 0,
          duplicates: 0,
        };

        // Track artist+title combinations to detect duplicates (like frontend was doing)
        const artistTitleFirstPosition: Map<string, number> = new Map();

        // Pre-scan to collect skipped tracks info
        trackItems.forEach((item: any, index: number) => {
          const position = index + 1;
          if (!item) {
            skipSummary.unavailable++;
            skippedDetails.push({ position, reason: 'unavailable' });
          } else if (!item.track) {
            // Null track could be local file or unavailable - check if it's marked as local
            const isLocal = item.is_local === true;
            if (isLocal) {
              skipSummary.localFiles++;
              skippedDetails.push({ position, reason: 'localFile' });
            } else {
              skipSummary.unavailable++;
              skippedDetails.push({ position, reason: 'unavailable' });
            }
          } else if (!item.track.id) {
            const name = item.track.name || undefined;
            const artist = item.track.artists?.[0]?.name || undefined;
            skipSummary.unavailable++;
            skippedDetails.push({ position, reason: 'unavailable', name, artist });
          } else if (!item.track.name || !item.track.artists || item.track.artists.length === 0) {
            skipSummary.unavailable++;
            skippedDetails.push({ position, reason: 'unavailable' });
          } else {
            // Check for podcast
            const spotifyUrl = item.track.external_urls?.spotify || '';
            const name = item.track.name;
            const artist = item.track.artists[0]?.name;

            if (spotifyUrl.includes('/episode/')) {
              skipSummary.podcasts++;
              skippedDetails.push({ position, reason: 'podcast', name, artist });
            } else {
              // Check for image
              const hasImage = item.track.album?.images?.length > 0;
              if (!hasImage) {
                skipSummary.unavailable++;
                skippedDetails.push({ position, reason: 'unavailable', name, artist });
              } else {
                // Track is valid - check for artist+title duplicates
                const artistTitleKey = `${artist.toLowerCase().trim()}|||${name.toLowerCase().trim()}`;
                if (artistTitleFirstPosition.has(artistTitleKey)) {
                  const firstPosition = artistTitleFirstPosition.get(artistTitleKey)!;
                  skipSummary.duplicates++;
                  skippedDetails.push({ position, reason: 'duplicate', name, artist, duplicateOf: firstPosition });
                } else {
                  artistTitleFirstPosition.set(artistTitleKey, position);
                }
              }
            }
          }
        });

        // Track which positions are duplicates so we can skip them during formatting
        const duplicatePositions = new Set(
          skippedDetails
            .filter(s => s.reason === 'duplicate')
            .map(s => s.position)
        );

        // --- Query playlist-specific overrides (trackextrainfo) ---
        // This is a small, fast query filtered by playlistId
        const dbPlaylist = await this.prisma.playlist.findFirst({
          where: { playlistId: checkPlaylistId },
          select: { id: true },
        });

        let trackExtraInfoMap = new Map<string, any>();
        if (dbPlaylist) {
          const extraInfoRecords = await this.prisma.trackExtraInfo.findMany({
            where: { playlistId: dbPlaylist.id },
            select: {
              track: { select: { trackId: true } },
              name: true,
              artist: true,
              year: true,
              extraNameAttribute: true,
              extraArtistAttribute: true,
            },
          });

          // Build map of trackId -> override data
          extraInfoRecords.forEach((record) => {
            if (record.track?.trackId) {
              trackExtraInfoMap.set(record.track.trackId, {
                overwriteName: record.name,
                overwriteArtist: record.artist,
                overwriteYear: record.year,
                extraNameAttribute: record.extraNameAttribute,
                extraArtistAttribute: record.extraArtistAttribute,
              });
            }
          });
        }

        // --- Format Tracks with In-Memory Map Lookups ---
        // Filter out items that were already marked as skipped (including duplicates)
        const formattedTracksPromises = trackItems
          .map((item: any, index: number) => ({ item, position: index + 1 }))
          .filter(({ item, position }: { item: any; position: number }) => item?.track?.id && !duplicatePositions.has(position))
          .map(async ({ item }: { item: any; position: number }): Promise<Track | null> => {
            const trackData = item.track;
            const trackId = trackData.id;

            if (
              !trackData.name ||
              !trackData.artists ||
              trackData.artists.length === 0
            ) {
              return null;
            }

            // Waterfall matching using in-memory maps
            let enrichmentData: EnrichmentData | undefined = undefined;

            // Priority 1: Exact trackId match
            if (this.trackEnrichmentByTrackId.has(trackId)) {
              enrichmentData = this.trackEnrichmentByTrackId.get(trackId);
            }

            // Priority 2: ISRC match
            if (!enrichmentData && trackData.external_ids?.isrc) {
              const isrc = trackData.external_ids.isrc;
              if (this.trackEnrichmentByIsrc.has(isrc)) {
                enrichmentData = this.trackEnrichmentByIsrc.get(isrc);
              }
            }

            // Priority 3: Artist + Title match
            if (!enrichmentData && trackData.artists[0]?.name) {
              const artist = trackData.artists[0].name.toLowerCase().trim();
              const title = trackData.name.toLowerCase().trim();
              const artistTitleKey = `${artist}|||${title}`;
              const hash = this.createSimpleHash(artistTitleKey);
              if (this.trackEnrichmentByArtistTitleHash.has(hash)) {
                enrichmentData = this.trackEnrichmentByArtistTitleHash.get(hash);
              }
            }

            // Priority 4: Check for playlist-specific overrides
            const overrideData = trackExtraInfoMap.get(trackId);
            if (overrideData) {
              // Merge override data with enrichment data
              if (enrichmentData) {
                enrichmentData = {
                  year: overrideData.overwriteYear || enrichmentData.year,
                  name: overrideData.overwriteName || enrichmentData.name,
                  artist: overrideData.overwriteArtist || enrichmentData.artist,
                  extraNameAttribute: overrideData.extraNameAttribute || enrichmentData.extraNameAttribute,
                  extraArtistAttribute: overrideData.extraArtistAttribute || enrichmentData.extraArtistAttribute,
                };
              } else {
                // If no base enrichment, use override data as-is
                enrichmentData = {
                  year: overrideData.overwriteYear,
                  name: overrideData.overwriteName,
                  artist: overrideData.overwriteArtist,
                  extraNameAttribute: overrideData.extraNameAttribute,
                  extraArtistAttribute: overrideData.extraArtistAttribute,
                };
              }
            }

            // Format the track using enrichment data (if found)
            return this.formatEnrichedTrack(
              trackData,
              enrichmentData,
              trackData.artists
            );
          });

        // Wait for all formatting promises and filter out nulls
        const formattedTracksNullable = await Promise.all(
          formattedTracksPromises
        );
        const validFormattedTracks = formattedTracksNullable.filter(
          (track): track is Track => track !== null
        );

        // Remove duplicates based on ID and add to the final list
        // (artist+title duplicates are already filtered, this catches any remaining ID duplicates)
        validFormattedTracks.forEach((track) => {
          if (!uniqueTrackIds.has(track.id)) {
            uniqueTrackIds.add(track.id);
            allFormattedTracks.push(track);
          }
        });

        // Build skipped tracks info for API response
        const totalSkipped = skipSummary.unavailable + skipSummary.localFiles + skipSummary.podcasts + skipSummary.duplicates;
        skippedTracksInfo = {
          total: totalSkipped,
          summary: skipSummary,
          details: skippedDetails,
        };

        // Check limits after processing all tracks
        if (allFormattedTracks.length > MAX_CARDS) {
          maxReached = true;
        }
        if (allFormattedTracks.length > MAX_CARDS_PHYSICAL) {
          maxReachedPhysical = true;
        }

        // Limit the tracks to MAX_CARDS if we have more
        allFormattedTracks = allFormattedTracks.slice(0, MAX_CARDS);
      } else {
        // Use cached result
        const cachedResult = JSON.parse(cacheResult);
        // Assuming cache stores the final processed result object directly
        return cachedResult; // Return directly if valid cache hit
      }

      // --- Prepare and Cache Final Result ---
      const finalResult = {
        success: true,
        data: {
          maxReached,
          maxReachedPhysical,
          totalTracks: allFormattedTracks.length,
          tracks: allFormattedTracks,
          skippedTracks: skippedTracksInfo,
        },
      };

      // Clear old cache entries and set new ones using the correct playlist ID
      this.cache.delPattern(`${CACHE_KEY_TRACKS}${checkPlaylistId}*`);
      this.cache.delPattern(`${CACHE_KEY_TRACK_COUNT}${checkPlaylistId}*`);

      this.cache.set(cacheKeyCount, allFormattedTracks.length.toString());
      this.cache.set(cacheKey, JSON.stringify(finalResult)); // Cache the final processed result

      // Track analytics for tracks retrieval
      this.analytics.increaseCounter(
        'spotify',
        'tracks',
        allFormattedTracks.length
      );

      return finalResult; // Return the processed result
    } catch (e: any) {
      // Keep existing generic error handling
      if (e.response && e.response.status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      this.logger.log(
        color.red.bold(`Error in getTracks2 for ${playlistId}: ${e.message}`)
      );
      return { success: false, error: 'Error getting tracks' };
    }
  }

  /**
   * Get detailed information for multiple tracks by their Spotify IDs
   * @param trackIds Array of Spotify track IDs
   * @returns ApiResult containing track information
   */
  public async getTracksByIds(trackIds: string[]): Promise<ApiResult> {
    try {
      if (!trackIds || trackIds.length === 0) {
        return { success: false, error: 'No track IDs provided' };
      }

      // Use a consistent cache key format
      const cacheKey = `${CACHE_KEY_TRACKS_BY_IDS}${trackIds.sort().join('_')}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult) {
        return JSON.parse(cacheResult);
      }

      this.logger.log(
        color.blue.bold(
          `Fetching tracks by ID from API for ${color.white.bold(
            trackIds.length
          )} tracks`
        )
      );

      // Use rate limit manager for automatic fallback on 429 errors
      const result = await this.rateLimitManager.executeWithFallback(
        'getTracksByIds',
        [trackIds],
        this.api,
        this.apiFallback
      );

      if (!result.success) {
        // Handle errors, including potential re-authentication needs
        if (result.needsReAuth) {
          return { success: false, error: result.error, needsReAuth: true };
        }
        return {
          success: false,
          error: result.error || 'Error getting tracks by IDs from API',
        };
      }

      // API call successful, process the items
      // Assuming the API implementation returns tracks in result.data.tracks
      const rawTracks = result.data?.tracks || [];
      this.analytics.increaseCounter(
        'spotify',
        'tracks_by_ids_fetched_api',
        rawTracks.length
      );

      // Filter out any null or undefined tracks and format them
      const validFormattedTracks = rawTracks
        .filter((track: any) => track !== null && track !== undefined)
        .map((track: any) => {
          // Basic formatting, adjust if API returns different structure
          const artist =
            track.artists && track.artists.length > 0
              ? track.artists[0].name // Assuming first artist is primary
              : '';

          const imageUrl =
            track.album && track.album.images && track.album.images.length > 0
              ? track.album.images[0].url // Assuming first image is suitable
              : '';

          // Note: This formatting might differ slightly from getTracks formatting.
          // Consider creating a shared track formatting utility if consistency is critical.
          return {
            id: track.id || '',
            trackId: track.id || '', // Keep for potential compatibility
            name: this.utils.cleanTrackName(track.name || ''),
            artist: artist,
            album: track.album?.name || '',
            image: imageUrl,
            preview: track.preview_url || '',
            link: track.external_urls?.spotify || '',
            spotifyLink: track.external_urls?.spotify || '', // Ensure required field is present
            isrc: track.external_ids?.isrc || '',
            releaseDate: track.album?.release_date || '',
            // Add other fields from Track interface if available and needed
            // trueYear: undefined, // Needs enrichment if required
            // explicit: track.explicit || false, // Example if API provides it
          };
        })
        .filter((track: any) => track.name && track.artist); // Filter out tracks with empty name or artist

      const finalResult = {
        success: true,
        data: validFormattedTracks, // Return the formatted tracks
      };

      // Cache the final processed result for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(finalResult));

      return finalResult;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`Error in getTracksByIds: ${error.message}`)
      );
      return {
        success: false,
        error: 'Internal error fetching tracks by IDs',
      };
    }
  }

  // Track which API was used last for round-robin fallback
  private lastSearchApi: 'scraper' | 'rapidapi' = 'scraper';

  public async searchTracks(
    searchTerm: string,
    limit: number = 10,
    offset: number = 0
  ): Promise<ApiResult> {
    try {
      if (!searchTerm || searchTerm.length < 2) {
        return { success: false, error: 'Search term too short' };
      }

      const cacheKey = `${CACHE_KEY_SEARCH}${searchTerm}_${limit}_${offset}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult) {
        return JSON.parse(cacheResult);
      }

      // Use rate limit manager for automatic fallback on 429 errors
      const result = await this.rateLimitManager.executeWithFallback(
        'searchTracks',
        [searchTerm, limit, offset],
        this.api,
        this.apiFallback
      );

      // Determine which API was used for logging
      const rateLimitStatus = await this.rateLimitManager.getRateLimitStatus();
      let apiUsed = 'SpotifyAPI';
      if (
        rateLimitStatus.spotifyApi.limited &&
        !rateLimitStatus.spotifyScraper.limited
      ) {
        apiUsed = 'ScraperAPI';
      }

      // Determine items found for logging
      let itemsFoundForLog: number;
      if (result.success) {
        // Use total from the result if available, otherwise count items
        itemsFoundForLog =
          result.data?.tracks?.total !== undefined
            ? result.data.tracks.total
            : result.data?.tracks?.items?.length || 0;
      } else {
        itemsFoundForLog = -1;
      }

      this.logger.log(
        color.blue.bold(
          `Searching ${color.white.bold(
            apiUsed
          )} for tracks matching "${color.white.bold(
            searchTerm
          )}" with limit ${color.white.bold(limit)}. Found ${color.white.bold(
            itemsFoundForLog
          )} items.`
        )
      );

      // Process the result (either from this.api or from spotifyRapidApi fallback)
      if (!result.success) {
        // This block handles errors from:
        // 1. The primary SpotifyApi attempt (if not a 429, or if it was 429 and RapidAPI fallback was not triggered/successful).
        // 2. The fallback SpotifyRapidApi attempt if it also failed.
        return {
          success: false,
          error: result.error || 'Error searching tracks from API',
          needsReAuth: result.needsReAuth,
          retryAfter: result.retryAfter,
        };
      }

      // API call successful (either primary or fallback), process the items
      const searchData = result.data;
      // Access items correctly based on Spotify API structure { tracks: { items: [...] } }
      const rawItems = searchData?.tracks?.items || [];
      // Access total correctly based on Spotify API structure { tracks: { total: ... } }
      const totalCount = searchData?.tracks?.total || 0; // Use .total

      this.analytics.increaseCounter('spotify', 'search_api', 1); // Keep analytics

      // Transform the response to the format expected by the frontend/caller
      const formattedTracks = rawItems
        .filter((item: any) => item && item.id) // Filter out null items or items without an ID (Spotify API structure)
        .map((item: any) => {
          // Access properties directly from the item (Spotify API structure)

          // Adapt formatting based on the structure returned by SpotifyApi searchTracks
          const artist = item.artists?.[0]?.name || ''; // Access artist name directly

          const imageUrl = item.album?.images?.[0]?.url || ''; // Access image URL directly (use first image)

          const trackName = this.utils.cleanTrackName(item.name || ''); // Access track name directly

          // Return a simplified structure matching the previous format
          return {
            id: item.id || '', // Use item.id
            trackId: item.id || '', // Use item.id
            name: trackName,
            artist: artist,
            image: imageUrl,
            // Add other fields if needed and available from the API response
            // e.g., preview_url, external_urls.spotify
          };
        })
        .filter(
          (track: any) => track.name?.length > 0 && track.artist?.length > 0
        ); // Filter out tracks with empty name or artist

      const finalResult = {
        success: true,
        data: {
          tracks: formattedTracks,
          totalCount: totalCount,
          offset: offset,
          limit: limit,
          hasMore: offset + limit < totalCount,
        },
      };

      // Cache the final processed result for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(finalResult), 3600);

      return finalResult;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`Error in searchTracks: ${error.message}`)
      );
      return {
        success: false,
        error: 'Internal error searching tracks',
      };
    }
  }

  public async getPlaylistTrackCount(
    playlistId: string,
    cache: boolean = true,
    isSlug: boolean = false
  ): Promise<number> {
    let cacheKeyCount = `trackcount_${playlistId}`;

    const cacheResult = await this.cache.get(cacheKeyCount);

    if (cacheResult) {
      return parseInt(cacheResult);
    }

    const tracks = await this.getTracks(playlistId, cache, '', false, isSlug);

    if (!tracks.success) {
      throw new Error('Error getting playlist track count');
    }

    return tracks.data.totalTracks;
  }

  /**
   * Public method to create or update a Spotify playlist.
   * Delegates to the appropriate API implementation (SpotifyApi or SpotifyRapidApi).
   * @param playlistName The desired name of the playlist.
   * @param trackIds An array of Spotify track IDs.
   * @returns {Promise<ApiResult>} Contains the playlist data or error info.
   */
  public async createOrUpdatePlaylist(
    playlistName: string,
    trackIds: string[]
  ): Promise<ApiResult> {
    // Delegate to the currently selected API implementation
    // Note: SpotifyRapidApi's implementation might return an error if not supported.
    // Use the specific implementation instance directly
    return this.spotifyApi.createOrUpdatePlaylist(playlistName, trackIds);
  }

  /**
   * Public method to delete (unfollow) a Spotify playlist.
   * Delegates to the SpotifyApi instance.
   * @param playlistId The Spotify playlist ID to delete/unfollow.
   * @returns {Promise<ApiResult>} Result of the deletion operation.
   */
  public async deletePlaylist(playlistId: string): Promise<ApiResult> {
    return this.spotifyApi.deletePlaylist(playlistId);
  }

  /**
   * Public method to exchange an authorization code for tokens.
   * Delegates to the SpotifyApi instance.
   * @param authCode The authorization code from Spotify callback.
   * @returns {Promise<string | null>} The access token or null.
   */
  public async getTokensFromAuthCode(authCode: string): Promise<string | null> {
    // Delegate to the SpotifyApi instance
    return this.spotifyApi.getTokensFromAuthCode(authCode);
  }

  /**
   * Public method to get the Spotify authorization URL.
   * Delegates to the SpotifyApi instance.
   * @returns {string | null} The authorization URL or null.
   */
  public getAuthorizationUrl(): string | null {
    // Delegate to the SpotifyApi instance
    return this.spotifyApi.getAuthorizationUrl();
  }

  /**
   * Attempts to resolve a Spotify URI from a given URL by following all known redirect mechanisms.
   * @param url The URL to resolve.
   * @returns {Promise<{ success: boolean, spotifyUri?: string, error?: string, cached?: boolean }>}
   */
  public async resolveSpotifyUrl(url: string): Promise<{
    success: boolean;
    spotifyUri?: string;
    error?: string;
    cached?: boolean;
  }> {
    // Add https:// if missing to normalize URL for domain checking
    let normalizedUrl = url;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    // Calculate cache key outside try block so it's accessible in catch
    const cacheKey = `qrlink2_unknown_result_${crypto
      .createHash('md5')
      .update(normalizedUrl)
      .digest('hex')}`;

    try {
      // Check if the URL's domain is in the blacklist
      try {
        const urlObj = new URL(normalizedUrl);
        const hostname = urlObj.hostname.toLowerCase();

        if (
          this.domainBlacklist.some(
            (domain) =>
              hostname === domain.toLowerCase() ||
              hostname.endsWith('.' + domain.toLowerCase())
          )
        ) {
          return {
            success: false,
            error: 'Domain is blacklisted and cannot be resolved',
          };
        }
      } catch (e) {
        // If URL parsing fails, continue with original logic
      }

      // Check if it's a MusicMatch Game URL pattern first (https://api.musicmatchgame.com/paymentHasPlaylistId/trackId)
      const musicMatchGamePattern =
        /^https?:\/\/api\.musicmatchgame\.com\/(\d+)\/(\d+)$/;
      const musicMatchGameMatch = normalizedUrl.match(musicMatchGamePattern);
      if (musicMatchGameMatch) {
        const paymentHasPlaylistId = musicMatchGameMatch[1];
        const trackId = musicMatchGameMatch[2];
        const key = `${paymentHasPlaylistId}_${trackId}`;
        const spotifyId = this.musicMatchMap[key];

        if (spotifyId) {
          const result = {
            success: true,
            spotifyUri: `spotify:track:${spotifyId}`,
          };
          await this.cache.set(cacheKey, JSON.stringify(result));
          return { ...result, cached: false };
        } else {
          const result = {
            success: false,
            error: `No MusicMatch mapping found for payment_has_playlist ${paymentHasPlaylistId}, track ${trackId}`,
          };
          await this.cache.set(cacheKey, JSON.stringify(result));
          return { ...result, cached: false };
        }
      }

      const cached = await this.cache.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return { ...parsed, cached: true };
        } catch (e) {
          // ignore parse error, continue to resolve
        }
      }

      // Special handling for hitstergame.com links
      if (normalizedUrl.includes('hitstergame.com')) {
        // Try to extract the set_sku and cardnumber from the URL
        // Example: https://hitstergame.com/nl/aaaa0027/00153 (Jumbo SKU with locale)
        // Example: https://hitstergame.com/nl/de/00054 (Country code with locale)
        // Example: https://hitstergame.com/de/00075 (Country code without locale)
        const match = normalizedUrl.match(
          /hitstergame\.com\/(?:[^/]+\/)?([a-zA-Z0-9]+)\/([0-9]+)/
        );
        if (match) {
          const setSku = match[1];
          const cardNumber = match[2];

          // Check if setSku is a pure alphabetic country code (e.g., 'de', 'en', 'nl')
          const isCountryCode = /^[a-z]+$/i.test(setSku);

          if (isCountryCode) {
            // Look up in country card maps
            const countryCode = setSku.toLowerCase();
            const countryMap = this.countryCardMaps[countryCode];

            if (countryMap) {
              const spotifyId = countryMap[cardNumber];
              if (spotifyId) {
                const result = {
                  success: true,
                  spotifyUri: `spotify:track:${spotifyId}`,
                };
                await this.cache.set(cacheKey, JSON.stringify(result));
                return { ...result, cached: false };
              } else {
                const result = {
                  success: false,
                  error: `No mapping found for country ${countryCode}, card ${cardNumber}`,
                };
                await this.cache.set(cacheKey, JSON.stringify(result));
                return { ...result, cached: false };
              }
            } else {
              const result = {
                success: false,
                error: `No country mapping found for ${countryCode}`,
              };
              await this.cache.set(cacheKey, JSON.stringify(result));
              return { ...result, cached: false };
            }
          } else {
            // Use existing Jumbo SKU logic
            const key = `${setSku}_${cardNumber}`;
            const spotifyId = this.jumboCardMap[key];
            if (spotifyId) {
              const result = {
                success: true,
                spotifyUri: `spotify:track:${spotifyId}`,
              };
              await this.cache.set(cacheKey, JSON.stringify(result));
              return { ...result, cached: false };
            } else {
              const result = {
                success: false,
                error: `No mapping found for ${key}`,
              };
              await this.cache.set(cacheKey, JSON.stringify(result));
              return { ...result, cached: false };
            }
          }
        }
      }

      // 1. Follow HTTP redirects (301/302/other 3xx)
      let currentUrl = normalizedUrl;
      let lastLocation = normalizedUrl;
      let maxRedirects = 5;
      let response;

      for (let i = 0; i < maxRedirects; i++) {
        response = await axios
          .get(currentUrl, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; SpotifyResolver/1.0)',
            },
          })
          .catch((err) => err.response);

        // Check for redirect headers
        if (
          response &&
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.location
        ) {
          lastLocation = response.headers.location;
          // Absolute or relative
          if (!/^https?:\/\//.test(lastLocation)) {
            // Relative redirect
            const base = new URL(currentUrl);
            lastLocation = new URL(lastLocation, base).toString();
          }
          // Check if the redirect location is a Spotify URL/URI
          const spotifyUri = this.extractSpotifyUri(lastLocation);
          if (spotifyUri) {
            const result = { success: true, spotifyUri };
            await this.cache.set(cacheKey, JSON.stringify(result));
            return { ...result, cached: false };
          }
          currentUrl = lastLocation;
        } else {
          // Not a redirect, break and check content
          break;
        }
      }

      // 2. Check if the final URL is a Spotify URL/URI
      if (lastLocation) {
        const spotifyUri = this.extractSpotifyUri(lastLocation);
        if (spotifyUri) {
          const result = { success: true, spotifyUri };
          await this.cache.set(cacheKey, JSON.stringify(result));
          return { ...result, cached: false };
        }
      }

      // 3. Look for META redirect or JS location.href in the HTML using RegExp
      if (response && response.data) {
        const html = response.data;

        // Check for <meta http-equiv="refresh" content="0; url=...">
        const metaRefreshMatch = html.match(
          /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?([^"'>]+)["']?[^>]*>/i
        );
        if (metaRefreshMatch && metaRefreshMatch[1]) {
          const content = metaRefreshMatch[1];
          const urlMatch = content.match(/url=(.+)$/i);
          if (urlMatch && urlMatch[1]) {
            const metaUrl = urlMatch[1].trim().replace(/['"]/g, '');
            const spotifyUri = this.extractSpotifyUri(metaUrl);
            if (spotifyUri) {
              const result = { success: true, spotifyUri };
              await this.cache.set(cacheKey, JSON.stringify(result));
              return { ...result, cached: false };
            }
          }
        }

        // Check for JS location.href or window.location
        const jsRedirectMatch =
          html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
          html.match(/window\.location\s*=\s*['"]([^'"]+)['"]/i);
        if (jsRedirectMatch && jsRedirectMatch[1]) {
          const jsUrl = jsRedirectMatch[1];
          const spotifyUri = this.extractSpotifyUri(jsUrl);
          if (spotifyUri) {
            const result = { success: true, spotifyUri };
            await this.cache.set(cacheKey, JSON.stringify(result));
            return { ...result, cached: false };
          }
        }
      }

      const result = {
        success: false,
        error: 'No Spotify URI found via redirects or page content.',
      };
      await this.cache.set(cacheKey, JSON.stringify(result));
      return { ...result, cached: false };
    } catch (e: any) {
      const result = {
        success: false,
        error: e.message || 'Error resolving Spotify URL',
      };
      // Cache errors as well, but for a shorter time
      await this.cache.set(cacheKey, JSON.stringify(result), 600);
      return { ...result, cached: false };
    }
  }

  /**
   * Resolves a Spotify shortlink by following HTTP redirects.
   * @param url The shortlink URL to resolve (e.g., https://spotify.link/...)
   * @returns {Promise<{ success: boolean, url?: string, error?: string }>}
   */
  public async resolveShortlink(url: string): Promise<{
    success: boolean;
    url?: string;
    error?: string;
  }> {
    try {
      let currentUrl = url;
      let redirectCount = 0;
      const maxRedirects = 5;
      let lastResponse: any = null;

      // Manually follow redirects to ensure we get the final URL
      while (redirectCount < maxRedirects) {
        const response = await axios.get(currentUrl, {
          maxRedirects: 0, // Don't follow redirects automatically
          validateStatus: (status) => status < 400, // Accept 2xx and 3xx
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
        });

        lastResponse = response;

        // Check if this is a redirect (3xx status code)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers['location'];

          if (location) {
            // Handle relative URLs
            if (location.startsWith('http')) {
              currentUrl = location;
            } else {
              const baseUrl = new URL(currentUrl);
              currentUrl = new URL(location, baseUrl.origin).toString();
            }
            redirectCount++;
            continue;
          } else {
            // 3xx without location header, stop here
            break;
          }
        } else {
          // 2xx response, we've reached the final destination
          currentUrl = response.request.res.responseUrl || currentUrl;
          break;
        }
      }

      // Check if the final URL is already a Spotify playlist URL
      if (currentUrl && currentUrl.includes('open.spotify.com/playlist/')) {
        this.logger.log(
          color.blue.bold(
            `Shortlink resolved: ` +
              color.white.bold(`url="${url}"`) +
              color.blue.bold(' -> ') +
              color.white.bold(`finalUrl="${currentUrl}"`)
          )
        );
        return { success: true, url: currentUrl };
      }

      // If we didn't get a direct Spotify URL, try to extract it from the HTML
      if (
        lastResponse &&
        lastResponse.data &&
        typeof lastResponse.data === 'string'
      ) {
        const html = lastResponse.data;

        // Find all occurrences of Spotify playlist URLs in the HTML
        const urlPattern =
          /https:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)[^\s"'<>]*/gi;
        const matches = html.match(urlPattern);

        if (matches && matches.length > 0) {
          // Count occurrences of each unique URL (cleaned without query params)
          const urlCounts: { [key: string]: number } = {};

          matches.forEach((url: string) => {
            // Clean URL by removing query parameters
            const cleanUrl = url.split('?')[0];
            urlCounts[cleanUrl] = (urlCounts[cleanUrl] || 0) + 1;
          });

          // Find the URL with the most occurrences
          let mostCommonUrl: string | null = null;
          let maxCount = 0;

          for (const [url, count] of Object.entries(urlCounts)) {
            if (count > maxCount) {
              maxCount = count;
              mostCommonUrl = url;
            }
          }

          if (mostCommonUrl) {
            this.logger.log(
              color.blue.bold(
                `Shortlink resolved via HTML parsing (${color.white.bold(
                  maxCount
                )} occurrences): ` +
                  color.white.bold(`url="${url}"`) +
                  color.blue.bold(' -> ') +
                  color.white.bold(`finalUrl="${mostCommonUrl}"`)
              )
            );
            return { success: true, url: mostCommonUrl };
          }
        }
      }

      this.logger.log(
        color.red.bold(
          `Failed to resolve shortlink: ` +
            color.white.bold(`url="${url}"`) +
            color.red.bold(' - No Spotify playlist URL found in response')
        )
      );
      return {
        success: false,
        error: 'URL did not resolve to a Spotify playlist',
      };
    } catch (e: any) {
      this.logger.log(
        color.red.bold(
          `Error resolving shortlink: ` +
            color.white.bold(`url="${url}"`) +
            color.red.bold(`, error=${e.message || e}`)
        )
      );
      return {
        success: false,
        error: e.message || 'Internal error',
      };
    }
  }

  /**
   * Extracts a Spotify URI from a given string (URL or URI).
   * @param input
   * @returns string | null
   */
  private extractSpotifyUri(input: string): string | null {
    if (!input) return null;
    // Match spotify track URIs only (spotify:track:...)
    const uriMatch = input.match(/spotify:track:[a-zA-Z0-9]+/);
    if (uriMatch) return uriMatch[0];

    // Match Spotify API URLs (https://api.spotify.com/v1/tracks/...)
    const apiMatch = input.match(
      /https?:\/\/api\.spotify\.com\/v\d+\/tracks\/([a-zA-Z0-9]+)/
    );
    if (apiMatch) {
      return `spotify:track:${apiMatch[1]}`;
    }

    // Match Spotify web track URLs with optional locale and query params
    // Supports: /track/, /intl-xx/track/, and query parameters like ?si=...
    const urlMatch = input.match(
      /https?:\/\/open\.spotify\.com(?:\/intl-[a-z]{2})?\/track\/([a-zA-Z0-9]+)(?:\?.*)?/
    );
    if (urlMatch) {
      return `spotify:track:${urlMatch[1]}`;
    }

    // Match spotify:// track URLs and convert to URI
    const spotifyUrlMatch = input.match(/spotify:\/\/track\/([a-zA-Z0-9]+)/);
    if (spotifyUrlMatch) {
      return `spotify:track:${spotifyUrlMatch[1]}`;
    }

    return null;
  }
}

export default Spotify;
