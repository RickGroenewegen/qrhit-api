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
import SpotifyApi from './spotify_api'; // Import the new class
import SpotifyRapidApi from './spotify_rapidapi'; // Import the new class

class Spotify {
  private cache = Cache.getInstance();
  private data = Data.getInstance(); // Keep Data instance if needed elsewhere
  private utils = new Utils();
  private analytics = AnalyticsClient.getInstance();
  private prisma = PrismaInstance.getInstance();
  private translate = new Translation();
  private logger = new Logger(); // Add logger instance
  private spotifyApi = new SpotifyApi(); // Instantiate SpotifyApi
  private spotifyRapidApi = new SpotifyRapidApi(); // Instantiate SpotifyRapidApi

  private api = this.spotifyRapidApi; // Default to SpotifyApi

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
              where: { slug: playlistId },
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

        let image = '';
        if (playlistData.images && playlistData.images.length > 0) {
          image = playlistData.images[0].url;
        }

        let playlistName = playlistData.name;
        let playlistDescription = playlistData.description;

        if (featured) {
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: { slug: playlistId },
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

      console.log(111);

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

      console.log(222, playlistResult);

      if (!playlistResult.success || !playlistResult.data) {
        return {
          success: false,
          error: playlistResult.error || 'Failed to get playlist details',
        };
      }
      const playlistData = playlistResult.data;
      const checkPlaylistId = playlistData.playlistId;

      // Update cache keys with actual ID and track count
      cacheKey = `tracks2_${checkPlaylistId}_${playlistData.numberOfTracks}`;
      cacheKeyCount = `trackcount2_${checkPlaylistId}_${playlistData.numberOfTracks}`;

      const cacheResult = await this.cache.get(cacheKey);

      if (!cacheResult || !cache) {
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
                tei.extraArtistAttribute
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
                NULL as extraArtistAttribute
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
              year: r.year,
              name: r.name,
              artist: r.artist,
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
                `trackInfo2_${r.trackId}`, // Use consistent trackInfo cache key
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
              `trackInfo2_${trackId}` // Use consistent trackInfo cache key
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

      // Call the abstracted API method
      const result = await this.api.searchTracks(searchTerm, limit, offset);

      if (!result.success) {
        // Handle errors, including potential re-authentication needs
        if (result.needsReAuth) {
          return { success: false, error: result.error, needsReAuth: true };
        }
        return {
          success: false,
          error: result.error || 'Error searching tracks from API',
        };
      }

      // API call successful, process the items
      // Assuming the API implementation returns search results in result.data
      const searchData = result.data;
      const rawItems = searchData?.tracks?.items || []; // Adjust based on actual API response structure
      const totalCount = searchData?.tracks?.total || 0;

      this.analytics.increaseCounter('spotify', 'search_api', 1); // Keep analytics

      // Transform the response to the format expected by the frontend/caller
      const formattedTracks = rawItems
        .filter((item: any) => item) // Filter out null items
        .map((track: any) => {
          // Adapt formatting based on the structure returned by SpotifyApi/SpotifyRapidApi searchTracks
          // This example assumes a structure similar to the official Spotify API search response
          const artist =
            track.artists && track.artists.length > 0
              ? track.artists[0].name // Assuming first artist
              : '';

          const imageUrl =
            track.album && track.album.images && track.album.images.length > 0
              ? track.album.images[0].url // Assuming first image
              : '';

          const trackName = this.utils.cleanTrackName(track.name || '');

          // Return a simplified structure matching the previous RapidAPI format
          return {
            id: track.id || '',
            trackId: track.id || '', // Keep for compatibility if needed
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
}

export default Spotify;
