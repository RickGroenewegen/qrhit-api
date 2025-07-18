import { format } from 'date-fns';
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
import cluster from 'cluster';
import crypto from 'crypto';

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
  private SpotifyRapidApi2 = new SpotifyRapidApi2(); // Instantiate SpotifyRapidApi for fallback

  private api = this.spotifyApi; // Default to SpotifyScraper

  // Jumbo card mapping: key = '[set_sku]_[cardnumber]', value = spotify id
  private jumboCardMap: { [key: string]: string } = {};

  constructor() {
    this.getJumboData();
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

  public async getPlaylist(
    playlistId: string,
    cache: boolean = true,
    captchaToken: string = '',
    checkCaptcha: boolean,
    featured: boolean = false,
    isSlug: boolean = false,
    locale: string = 'en'
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
      const cacheKey = `playlist_${playlistId}_${locale}`;
      const cacheResult = await this.cache.get(cacheKey);
      const dbCacheKey = `playlistdb_${playlistId}`;
      const dbCacheResult = await this.cache.get(dbCacheKey);

      if (!cacheResult || !cache) {
        let checkPlaylistId = playlistId;

        if (isSlug) {
          if (!dbCacheResult || !cache) {
            const dbPlaylist = await this.prisma.playlist.findFirst({
              where: { slug: playlistId, featured: true },
            });
            if (!dbPlaylist) {
              return { success: false, error: 'playlistNotFound' };
            }
            checkPlaylistId = dbPlaylist.playlistId;
            this.cache.set(dbCacheKey, checkPlaylistId);
          } else {
            checkPlaylistId = dbCacheResult;
          }
        }

        // Access token handling is now done within the specific API implementation (e.g., SpotifyApi)
        const result = await this.api.getPlaylist(checkPlaylistId);

        if (!result.success) {
          // Check if the error indicates a need for re-authentication
          if (result.needsReAuth) {
            return { success: false, error: result.error, needsReAuth: true };
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

        if (featured) {
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: { slug: playlistId, featured: true },
          });

          playlistName = dbPlaylist?.name || playlistName;
          playlistDescription =
            (dbPlaylist
              ? dbPlaylist[`description_${locale}` as keyof typeof dbPlaylist]
              : null) || playlistDescription;
        }

        playlist = {
          id: playlistId,
          playlistId: playlistId,
          name: playlistName,
          description: playlistDescription,
          numberOfTracks: playlistData.tracks?.total || 0,
          image,
        };

        this.cache.set(cacheKey, JSON.stringify(playlist), 3600);
      } else {
        playlist = JSON.parse(cacheResult);
      }
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

  // New function using this.api.getTracks
  public async getTracks(
    playlistId: string,
    cache: boolean = true,
    captchaToken: string = '',
    checkCaptcha: boolean,
    isSlug: boolean = false
  ): Promise<ApiResult> {
    try {
      let cacheKey = `tracks2_${playlistId}`; // Use different prefix for cache key
      let cacheKeyCount = `trackcount2_${playlistId}`;
      let allFormattedTracks: Track[] = []; // Renamed for clarity
      const uniqueTrackIds = new Set<string>();
      let maxReached = false;
      let maxReachedPhysical = false;

      // Get playlist details first (handles slug, gets track count for cache key)
      const playlistResult = await this.getPlaylist(
        playlistId,
        false, // Use cache for playlist info
        '', // Captcha token (not used here)
        false, // Check captcha (not used here)
        isSlug, // Pass featured flag (derived from isSlug for simplicity here, adjust if needed)
        isSlug, // Pass isSlug flag
        'en' // Default locale, adjust if needed
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
      cacheKey = `tracks2_${checkPlaylistId}_${playlistData.numberOfTracks}`;
      cacheKeyCount = `trackcount2_${checkPlaylistId}_${playlistData.numberOfTracks}`;

      const cacheResult = await this.cache.get(cacheKey);

      if (!cacheResult || !cache) {
        if (isSlug) {
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: { slug: playlistId, featured: true },
          });
          if (!dbPlaylist) {
            return { success: false, error: 'playlistNotFound' };
          }
          checkPlaylistId = dbPlaylist.playlistId;
        }

        // Fetch all track items using the appropriate API implementation
        const result = await this.api.getTracks(checkPlaylistId);

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

        // Get all track IDs from the result
        const trackIds = trackItems
          .filter((item: any) => item?.track?.id) // Ensure item and track exist
          .map((item: any) => item.track.id);

        // --- Database Enrichment ---
        let yearResults: {
          trackId: string;
          year: number;
          name: string;
          artist: string;
          extraNameAttribute?: string;
          extraArtistAttribute?: string;
          overwriteYear?: number;
          overwriteName?: string;
          overwriteArtist?: string;
        }[] = [];

        if (trackIds.length > 0) {
          // Get the playlist ID from the database using the actual Spotify ID
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: { playlistId: checkPlaylistId }, // Use actual Spotify ID
            select: { id: true },
          });

          if (dbPlaylist) {
            yearResults = await this.prisma.$queryRaw<
              {
                trackId: string;
                year: number;
                name: string;
                artist: string;
                originalName: string; // Keep original columns if needed by query
                originalArtist: string; // Keep original columns if needed by query
                extraNameAttribute?: string;
                extraArtistAttribute?: string;
              }[]
            >`
              SELECT
                t.trackId,
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
                (SELECT * FROM trackextrainfo WHERE playlistId = ${
                  dbPlaylist.id
                }) tei
                ON t.id = tei.trackId
              WHERE
                t.trackId IN (${Prisma.join(trackIds)})
                AND t.manuallyChecked = 1
            `;
          } else {
            // If playlist not found in DB, just get the track info without extras
            yearResults = await this.prisma.$queryRaw<
              {
                trackId: string;
                year: number;
                name: string;
                artist: string;
                originalName: string; // Keep original columns if needed by query
                originalArtist: string; // Keep original columns if needed by query
                extraNameAttribute?: string;
                extraArtistAttribute?: string;
              }[]
            >`
              SELECT
                t.trackId,
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
                t.trackId IN (${Prisma.join(trackIds)})
                AND t.manuallyChecked = 1
            `;
          }
        }

        // Create a map for quick lookup
        const trackMap = new Map(
          yearResults.map((r) => [
            r.trackId,
            {
              year: r.overwriteYear || r.year,
              name: r.overwriteName || r.name,
              artist: r.overwriteArtist || r.artist,
              extraNameAttribute: r.extraNameAttribute,
              extraArtistAttribute: r.extraArtistAttribute,
            },
          ])
        );

        // Cache all track info at once
        await Promise.all(
          yearResults
            .filter((r) => r.year !== null)
            .map((r) =>
              this.cache.set(
                `trackInfo_${r.trackId}`, // Use consistent trackInfo cache key
                JSON.stringify({
                  year: r.year,
                  name: r.name,
                  artist: r.artist,
                  extraNameAttribute: r.extraNameAttribute,
                  extraArtistAttribute: r.extraArtistAttribute,
                })
              )
            )
        );

        // --- Format Tracks ---
        const formattedTracksPromises = trackItems
          .filter((item: any) => item?.track?.id) // Filter out items without a track or id
          .map(async (item: any): Promise<Track | null> => {
            // Return Track or null
            const trackData = item.track; // Simplify access
            const trackId = trackData.id;

            if (
              !trackData.name ||
              !trackData.artists ||
              trackData.artists.length === 0
            ) {
              // Skip tracks with missing essential info from Spotify
              return null;
            }

            let trueYear: number | undefined;
            let extraNameAttribute: string | undefined;
            let extraArtistAttribute: string | undefined;
            let trueName: string | undefined;
            let trueArtist: string | undefined;

            // Check cache first
            const cachedTrackInfo = await this.cache.get(
              `trackInfo_${trackId}` // Use consistent trackInfo cache key
            );
            if (cachedTrackInfo) {
              const trackInfo = JSON.parse(cachedTrackInfo);
              trueYear = trackInfo.year;
              trueName = trackInfo.name;
              trueArtist = trackInfo.artist;
              extraNameAttribute = trackInfo.extraNameAttribute;
              extraArtistAttribute = trackInfo.extraArtistAttribute;
            } else {
              // Check DB map
              const trackInfo = trackMap.get(trackId);
              if (trackInfo) {
                trueYear = trackInfo.year;
                trueName = trackInfo.name;
                trueArtist = trackInfo.artist;
                extraNameAttribute = trackInfo.extraNameAttribute;
                extraArtistAttribute = trackInfo.extraArtistAttribute;
              } else {
                // Fallback to Spotify data
                trueName = trackData.name;
                // Format multiple artists
                if (trackData.artists.length === 1) {
                  trueArtist = trackData.artists[0].name;
                } else {
                  const limitedArtists = trackData.artists.slice(0, 3);
                  const artistNames = limitedArtists.map(
                    (artist: { name: string }) => artist.name
                  );
                  const lastArtist = artistNames.pop();
                  trueArtist = artistNames.join(', ') + ' & ' + lastArtist;
                }
              }
            }

            // Ensure essential fields are present after enrichment attempt
            if (!trueName || !trueArtist) {
              return null; // Skip if name or artist couldn't be determined
            }

            const imageUrl =
              trackData.album?.images?.length > 1
                ? trackData.album.images[1].url // Prefer second image if available
                : trackData.album?.images?.length > 0
                ? trackData.album.images[0].url // Fallback to first image
                : null;

            // Skip if no image is found
            if (!imageUrl) {
              return null;
            }

            return {
              id: trackId,
              name: this.utils.cleanTrackName(trueName),
              album: this.utils.cleanTrackName(trackData.album?.name || ''),
              preview: trackData.preview_url || '',
              artist: trueArtist,
              link: trackData.external_urls?.spotify || '', // Ensure string
              spotifyLink: trackData.external_urls?.spotify || '', // Add missing required property
              isrc: trackData.external_ids?.isrc,
              image: imageUrl,
              releaseDate: trackData.album?.release_date
                ? format(new Date(trackData.album.release_date), 'yyyy-MM-dd')
                : '', // Default to empty string if date is missing
              trueYear,
              extraNameAttribute,
              extraArtistAttribute,
            };
          });

        // Wait for all formatting promises and filter out nulls
        const formattedTracksNullable = await Promise.all(
          formattedTracksPromises
        );
        const validFormattedTracks = formattedTracksNullable.filter(
          (track): track is Track => track !== null
        );

        // Remove duplicates based on ID and add to the final list
        validFormattedTracks.forEach((track) => {
          if (!uniqueTrackIds.has(track.id)) {
            uniqueTrackIds.add(track.id);
            allFormattedTracks.push(track);
          }
        });

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
        },
      };

      // Clear old cache entries and set new ones using the correct playlist ID
      this.cache.delPattern(`tracks2_${checkPlaylistId}*`);
      this.cache.delPattern(`trackcount2_${checkPlaylistId}*`);

      this.cache.set(cacheKeyCount, allFormattedTracks.length.toString());
      this.cache.set(cacheKey, JSON.stringify(finalResult)); // Cache the final processed result

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
      const cacheKey = `tracksbyids_${trackIds.sort().join('_')}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult) {
        return JSON.parse(cacheResult);
      }

      // Call the abstracted API method
      const result = await this.api.getTracksByIds(trackIds);

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
      await this.cache.set(cacheKey, JSON.stringify(finalResult), 3600);

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

      const cacheKey = `search_${searchTerm}_${limit}_${offset}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult) {
        return JSON.parse(cacheResult);
      }

      let result = await this.api.searchTracks(searchTerm, limit, offset);
      let apiUsed = 'SpotifyAPI';

      // If the primary API call fails due to rate limiting (429)
      // use round-robin between SpotifyScraper and SpotifyRapidApi
      if (
        !result.success &&
        (result.error?.includes('429') || result.retryAfter !== undefined)
      ) {
        // Toggle between APIs for round-robin load balancing
        this.lastSearchApi =
          this.lastSearchApi === 'scraper' ? 'rapidapi' : 'scraper';

        if (this.lastSearchApi === 'rapidapi') {
          apiUsed = 'RapidAPI';
          result = await this.spotifyRapidApi.searchTracks(
            searchTerm,
            limit,
            offset
          );
        } else {
          apiUsed = 'ScraperAPI';
          result = await this.spotifyScraper.searchTracks(
            searchTerm,
            limit,
            offset
          );
        }

        // If the first fallback also fails with 429, try the other API as a last resort
        if (
          !result.success &&
          (result.error?.includes('429') || result.retryAfter !== undefined)
        ) {
          // Use the API we didn't just try
          if (this.lastSearchApi === 'rapidapi') {
            apiUsed = 'ScraperAPI (last resort)';
            result = await this.spotifyScraper.searchTracks(
              searchTerm,
              limit,
              offset
            );
          } else {
            apiUsed = 'RapidAPI (last resort)';
            result = await this.spotifyRapidApi.searchTracks(
              searchTerm,
              limit,
              offset
            );
          }
        }
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
    // Check cache first for all URLs
    const cacheKey = `qrlink_unknown_result_${crypto
      .createHash('md5')
      .update(url)
      .digest('hex')}`;

    try {
      // Add https:// if missing
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
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
      if (url.includes('hitstergame.com')) {
        // Try to extract the set_sku and cardnumber from the URL
        // Example: https://hitstergame.com/nl/aaaa0027/00153
        const match = url.match(
          /hitstergame\.com\/[^/]+\/([a-zA-Z0-9]+)\/([0-9]+)/
        );
        if (match) {
          const setSku = match[1];
          const cardNumber = match[2];
          const key = `${setSku}_${cardNumber}`;
          const spotifyId = this.jumboCardMap[key];
          if (spotifyId) {
            const result = {
              success: true,
              spotifyUri: `spotify:track:${spotifyId}`,
            };
            await this.cache.set(cacheKey, JSON.stringify(result), 3600);
            return { ...result, cached: false };
          } else {
            const result = {
              success: false,
              error: `No mapping found for ${key}`,
            };
            await this.cache.set(cacheKey, JSON.stringify(result), 600);
            return { ...result, cached: false };
          }
        }
      }

      // 1. Follow HTTP redirects (301/302/other 3xx)
      let currentUrl = url;
      let lastLocation = url;
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
            await this.cache.set(cacheKey, JSON.stringify(result), 3600);
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
          await this.cache.set(cacheKey, JSON.stringify(result), 3600);
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
              await this.cache.set(cacheKey, JSON.stringify(result), 3600);
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
            await this.cache.set(cacheKey, JSON.stringify(result), 3600);
            return { ...result, cached: false };
          }
        }
      }

      const result = {
        success: false,
        error: 'No Spotify URI found via redirects or page content.',
      };
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);
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
   * Extracts a Spotify URI from a given string (URL or URI).
   * @param input
   * @returns string | null
   */
  private extractSpotifyUri(input: string): string | null {
    if (!input) return null;
    // Match spotify track URIs only (spotify:track:...)
    const uriMatch = input.match(/spotify:track:[a-zA-Z0-9]+/);
    if (uriMatch) return uriMatch[0];

    // Match Spotify web track URLs and convert to URI
    const urlMatch = input.match(
      /https?:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/
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
