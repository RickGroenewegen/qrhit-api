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
  private spotifyApi = new SpotifyApi(); // Instantiate SpotifyApi
  private spotifyRapidApi = new SpotifyRapidApi(); // Instantiate SpotifyRapidApi

  private api = this.spotifyApi; // Default to SpotifyApi

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
      if (e.response && e.response.status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      return { success: false, error: 'Error getting playlist' };
    }
  }

  public async getTracks(
    playlistId: string,
    cache: boolean = true,
    captchaToken: string = '',
    checkCaptcha: boolean,
    isSlug: boolean = false
  ): Promise<ApiResult> {
    try {
      let cacheKey = `tracks_${playlistId}`;
      let cacheKeyCount = `trackcount_${playlistId}`;
      // dbCacheKey seems unused after refactor, removing: let dbCacheKey = `tracksdb_${playlistId}`;
      let allFormattedTracks: Track[] = []; // Renamed from allTracks
      const uniqueTrackIds = new Set<string>(); // Still needed to avoid duplicates if API returns them
      let maxReached = false;
      let maxReachedPhysical = false;

      // if (checkCaptcha) {
      //   // Verify reCAPTCHA token
      //   const isHuman = await this.utils.verifyRecaptcha(captchaToken);

      //   if (!isHuman) {
      //     throw new Error('reCAPTCHA verification failed');
      //   }
      // }

      const playlist = await this.getPlaylist(
        playlistId,
        true,
        '',
        false,
        isSlug,
        isSlug
      );

      cacheKey = `tracks_${playlistId}_${playlist.data.numberOfTracks}`;
      // Use playlistId obtained from getPlaylist which handles slugs
      const checkPlaylistId = playlist.data.playlistId; // Use the actual Spotify ID
      cacheKey = `tracks_${checkPlaylistId}_${playlist.data.numberOfTracks}`; // Use actual ID in cache key
      cacheKeyCount = `trackcount_${checkPlaylistId}_${playlist.data.numberOfTracks}`;

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
        this.analytics.increaseCounter('spotify', 'tracks_fetched_api', trackItems.length); // Analytics for raw items fetched

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
                `trackInfo2_${r.trackId}`,
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
          .map(async (item: any): Promise<Track | null> => { // Return Track or null
            const trackData = item.track; // Simplify access
            const trackId = trackData.id;

            if (!trackData.name || !trackData.artists || trackData.artists.length === 0) {
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
              `trackInfo2_${trackId}`
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

            const imageUrl = trackData.album?.images?.length > 1
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
              link: trackData.external_urls?.spotify,
              isrc: trackData.external_ids?.isrc,
              image: imageUrl,
              releaseDate: trackData.album?.release_date
                ? format(new Date(trackData.album.release_date), 'yyyy-MM-dd')
                : undefined, // Handle potentially invalid date
              trueYear,
              extraNameAttribute,
              extraArtistAttribute,
            };
          });

        // Wait for all formatting promises and filter out nulls
        const formattedTracksNullable = await Promise.all(formattedTracksPromises);
        const validFormattedTracks = formattedTracksNullable.filter((track): track is Track => track !== null);

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
        // Need to ensure cached structure matches expected structure
        // Assuming cache stores the final result object directly
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

      // Clear old cache entries and set new ones
      this.cache.delPattern(`tracks_${checkPlaylistId}*`);
      this.cache.delPattern(`trackcount_${checkPlaylistId}*`);

      this.cache.set(cacheKeyCount, allFormattedTracks.length.toString());
      this.cache.set(cacheKey, JSON.stringify(finalResult)); // Cache the final processed result

      return finalResult; // Return the processed result

    } catch (e: any) {
      // Keep existing generic error handling
      if (e.response && e.response.status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      this.logger.log(color.red.bold(`Error in getTracks for ${playlistId}: ${e.message}`));
      return { success: false, error: 'Error getting tracks' };
    }
  }
/* >>>>>>> REPLACED CODE STARTS HERE */
      // Use playlistId obtained from getPlaylist which handles slugs
      const checkPlaylistId = playlist.data.playlistId; // Use the actual Spotify ID
      cacheKey = `tracks_${checkPlaylistId}_${playlist.data.numberOfTracks}`; // Use actual ID in cache key
      cacheKeyCount = `trackcount_${checkPlaylistId}_${playlist.data.numberOfTracks}`;

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
        this.analytics.increaseCounter('spotify', 'tracks_fetched_api', trackItems.length); // Analytics for raw items fetched

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
                `trackInfo2_${r.trackId}`,
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
          .map(async (item: any): Promise<Track | null> => { // Return Track or null
            const trackData = item.track; // Simplify access
            const trackId = trackData.id;

            if (!trackData.name || !trackData.artists || trackData.artists.length === 0) {
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
              `trackInfo2_${trackId}`
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

            const imageUrl = trackData.album?.images?.length > 1
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
              link: trackData.external_urls?.spotify,
              isrc: trackData.external_ids?.isrc,
              image: imageUrl,
              releaseDate: trackData.album?.release_date
                ? format(new Date(trackData.album.release_date), 'yyyy-MM-dd')
                : undefined, // Handle potentially invalid date
              trueYear,
              extraNameAttribute,
              extraArtistAttribute,
            };
          });

        // Wait for all formatting promises and filter out nulls
        const formattedTracksNullable = await Promise.all(formattedTracksPromises);
        const validFormattedTracks = formattedTracksNullable.filter((track): track is Track => track !== null);

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
        // Need to ensure cached structure matches expected structure
        // Assuming cache stores the final result object directly
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

      // Clear old cache entries and set new ones
      this.cache.delPattern(`tracks_${checkPlaylistId}*`);
      this.cache.delPattern(`trackcount_${checkPlaylistId}*`);

      this.cache.set(cacheKeyCount, allFormattedTracks.length.toString());
      this.cache.set(cacheKey, JSON.stringify(finalResult)); // Cache the final processed result

      return finalResult; // Return the processed result

    } catch (e: any) {
      // Keep existing generic error handling
      if (e.response && e.response.status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
      this.logger.log(color.red.bold(`Error in getTracks for ${playlistId}: ${e.message}`));
      return { success: false, error: 'Error getting tracks' };
    }
  }
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: { slug: playlistId },
          });
          if (!dbPlaylist) {
            return { success: false, error: 'playlistNotFound' };
          }
          checkPlaylistId = dbPlaylist.playlistId;
        }

        while (true) {
          const options = {
            method: 'GET',
            url: 'https://spotify23.p.rapidapi.com/playlist_tracks',
            params: {
              id: checkPlaylistId,
              limit,
              offset,
            },
            headers: {
              'x-rapidapi-key': process.env['RAPID_API_KEY'],
              'x-rapidapi-host': 'spotify23.p.rapidapi.com',
            },
          };

          // Directly make the request instead of using the queue
          const response = await axios.request(options);

          this.analytics.increaseCounter('spotify', 'tracks', 1); // Keep analytics

          // Get all track IDs from this batch
          const trackIds = response.data.items
            .filter((item: any) => item.track)
            .map((item: any) => item.track.id);

          // Get years for all tracks in one query
          let yearResults: {
            trackId: string;
            year: number;
            name: string;
            artist: string;
            extraNameAttribute?: string;
            extraArtistAttribute?: string;
          }[] = [];
          if (trackIds.length > 0) {
            // First, get the playlist ID from the database
            const dbPlaylist = await this.prisma.playlist.findFirst({
              where: { playlistId: checkPlaylistId },
              select: { id: true },
            });

            if (dbPlaylist) {
              yearResults = await this.prisma.$queryRaw<
                {
                  trackId: string;
                  year: number;
                  name: string;
                  artist: string;
                  originalName: string;
                  originalArtist: string;
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
                  originalName: string;
                  originalArtist: string;
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

          // Debug logging removed

          // Create a map of trackId to year for quick lookup
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
                  `trackInfo2_${r.trackId}`,
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

          const tracks: Track[] = await Promise.all(
            response.data.items
              .filter((item: any) => item.track && item.track.track)
              .map(async (item: any) => {
                const trackId = item.track.id;
                let trueYear: number | undefined;
                let extraNameAttribute: string | undefined;
                let extraArtistAttribute: string | undefined;
                let trueName: string | undefined;
                let trueArtist: string | undefined;

                // Check cache first
                const cachedTrackInfo = await this.cache.get(
                  `trackInfo2_${trackId}`
                );
                if (cachedTrackInfo) {
                  const trackInfo = JSON.parse(cachedTrackInfo);

                  trueYear = trackInfo.year;
                  trueName = trackInfo.name;
                  trueArtist = trackInfo.artist;
                  extraNameAttribute = trackInfo.extraNameAttribute;
                  extraArtistAttribute = trackInfo.extraArtistAttribute;
                } else {
                  const trackInfo = trackMap.get(trackId);
                  if (trackInfo) {
                    trueYear = trackInfo.year;
                    trueName = trackInfo.name;
                    trueArtist = trackInfo.artist;
                    extraNameAttribute = trackInfo.extraNameAttribute;
                    extraArtistAttribute = trackInfo.extraArtistAttribute;
                  } else {
                    trueName = item.track.name;
                    if (item.track.artists?.length > 0) {
                      // Format multiple artists as "Artist 1, Artist 2 & Artist 3"
                      if (item.track.artists.length === 1) {
                        trueArtist = item.track.artists[0].name;
                      } else {
                        // Max. 3 artist for now
                        const limitedArtists = item.track.artists.slice(0, 3);
                        const artistNames = limitedArtists.map(
                          (artist: { name: string }) => artist.name
                        );
                        const lastArtist = artistNames.pop();
                        trueArtist =
                          artistNames.join(', ') + ' & ' + lastArtist;
                      }
                    }
                  }
                }

                return {
                  id: trackId,
                  name: this.utils.cleanTrackName(trueName!),
                  album: this.utils.cleanTrackName(
                    item.track.album?.name || ''
                  ),
                  preview: item.track.preview_url || '',
                  artist: trueArtist,
                  link: item.track.external_urls?.spotify,
                  isrc: item.track.external_ids?.isrc,
                  image:
                    item.track.album.images?.length > 0
                      ? item.track.album.images[1].url
                      : null,
                  releaseDate: format(
                    new Date(item.track.album.release_date),
                    'yyyy-MM-dd'
                  ),
                  trueYear,
                  extraNameAttribute,
                  extraArtistAttribute,
                };
              })
          );

          // remove all items that do not have an artist, name, or image
          const filteredTracks = tracks.filter(
            (track) => track.artist && track.name && track.image
          );

          filteredTracks.forEach((track) => {
            if (!uniqueTrackIds.has(track.id)) {
              uniqueTrackIds.add(track.id);
              allTracks.push(track);
            }
          });

          // Check if there are more tracks to fetch or if we reached the limit of MAX_CARDS tracks
          if (
            response.data.items.length < limit ||
            allTracks.length >= MAX_CARDS
          ) {
            if (allTracks.length > MAX_CARDS) {
              maxReached = true;
            }

            if (allTracks.length > MAX_CARDS_PHYSICAL) {
              maxReachedPhysical = true;
            }
            // Limit the tracks to MAX_CARDS if we have more
            allTracks = allTracks.slice(0, MAX_CARDS);
            break;
          }

          offset += limit;
        }
      } else {
        const cachedResult = JSON.parse(cacheResult);
        return cachedResult;
      }

      const result = {
        success: true,
        data: {
          maxReached,
          maxReachedPhysical,
          totalTracks: allTracks.length,
          tracks: allTracks,
        },
      };

      this.cache.delPattern(`tracks_${playlistId}*`);
      this.cache.delPattern(`trackcount_${playlistId}*`);

      this.cache.set(cacheKeyCount, allTracks.length.toString());
      this.cache.set(cacheKey, JSON.stringify(result));
      return result;
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        return { success: false, error: 'playlistNotFound' };
      }
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

      // Check if we have the tracks in cache
      const cacheKey = `tracks_by_ids_${trackIds.sort().join('_')}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult) {
        return JSON.parse(cacheResult);
      }

      const options = {
        method: 'GET',
        url: 'https://spotify23.p.rapidapi.com/tracks/',
        params: {
          ids: trackIds.join(','),
        },
        headers: {
          'x-rapidapi-key': process.env['RAPID_API_KEY'],
          'x-rapidapi-host': 'spotify23.p.rapidapi.com',
        },
      };

      // Directly make the request instead of using the queue
      const response = await axios.request(options);

      this.analytics.increaseCounter('spotify', 'tracks_by_ids', 1); // Keep analytics

      if (!response.data || !response.data.tracks) {
        return { success: false, error: 'No tracks found' };
      }

      // Filter out any null or undefined tracks
      const validTracks = response.data.tracks
        .filter((track: any) => track !== null && track !== undefined)
        .map((track: any) => {
          const artist =
            track.artists && track.artists.length > 0
              ? track.artists[0].name
              : '';

          const imageUrl =
            track.album && track.album.images && track.album.images.length > 0
              ? track.album.images[0].url
              : '';

          return {
            id: track.id,
            trackId: track.id,
            name: this.utils.cleanTrackName(track.name || ''),
            artist: artist,
            album: track.album?.name || '',
            image: imageUrl,
            preview: track.preview_url || '',
            link: track.external_urls?.spotify || '',
            isrc: track.external_ids?.isrc || '',
            releaseDate: track.album?.release_date || '',
            explicit: track.explicit || false,
          };
        })
        .filter((track: any) => track.name && track.artist); // Filter out tracks with empty name or artist

      const result = {
        success: true,
        data: validTracks,
      };

      // Cache the result for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);

      return result;
    } catch (error) {
      return {
        success: false,
        error: 'Error fetching tracks by IDs',
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

      const options = {
        method: 'GET',
        url: 'https://spotify23.p.rapidapi.com/search/',
        params: {
          q: searchTerm,
          type: 'tracks',
          offset: offset.toString(),
          limit: limit.toString(),
          numberOfTopResults: '5',
        },
        headers: {
          'x-rapidapi-key': process.env['RAPID_API_KEY'],
          'x-rapidapi-host': 'spotify23.p.rapidapi.com',
        },
      };

      // Directly make the request instead of using the queue
      const response = await axios.request(options);

      this.analytics.increaseCounter('spotify', 'search', 1); // Keep analytics

      if (
        !response.data ||
        !response.data.tracks ||
        !response.data.tracks.items
      ) {
        return { success: false, error: 'No tracks found' };
      }

      // Transform the response to a more usable format
      const tracks = response.data.tracks.items
        .filter((item: any) => item && item.data) // Filter out any null or undefined items
        .map((item: any) => {
          const track = item.data;

          // Add null checks for all properties
          const artist =
            track.artists &&
            track.artists.items &&
            track.artists.items.length > 0
              ? track.artists.items[0].profile?.name || ''
              : '';

          const imageUrl =
            track.albumOfTrack &&
            track.albumOfTrack.coverArt &&
            track.albumOfTrack.coverArt.sources &&
            track.albumOfTrack.coverArt.sources.length > 0
              ? track.albumOfTrack.coverArt.sources[0].url
              : '';

          const trackName = this.utils.cleanTrackName(track.name || '');

          return {
            id: track.id || '',
            trackId: track.id || '',
            name: trackName,
            artist: artist,
            image: imageUrl,
          };
        })
        .filter(
          (track: any) => track.name?.length > 0 && track.artist?.length > 0
        ); // Filter out tracks with empty name or artist

      const result = {
        success: true,
        data: {
          tracks,
          totalCount: response.data.tracks.totalCount,
          offset: offset,
          limit: limit,
          hasMore:
            response.data.tracks.pagingInfo &&
            offset + limit < response.data.tracks.totalCount,
        },
      };

      // Cache the result for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);

      return result;
    } catch (error) {
      console.error('Error searching tracks:', error);
      return {
        success: false,
        error: 'Error searching tracks',
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
