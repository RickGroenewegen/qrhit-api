import { format } from 'date-fns';
import { MAX_CARDS } from './config/constants';
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

class RapidAPIQueue {
  private cache: Cache;
  private static instance: RapidAPIQueue;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();

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
    await this.enqueueRapidAPIRequest(JSON.stringify(request));
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

      if (timeSinceLastRequest < 250) {
        // 250ms = 4 requests per second
        await new Promise((resolve) =>
          setTimeout(resolve, 250 - timeSinceLastRequest)
        );
      }

      const request = await this.dequeueRapidAPIRequest();
      if (request) {
        const requestConfig = JSON.parse(request);
        let attempt = 0;
        const maxAttempts = 3;
        const functionName = requestConfig.url.includes('playlist_tracks')
          ? 'getTracks'
          : 'getPlaylist';
        while (attempt < maxAttempts) {
          try {
            await axios(requestConfig);
            await this.setLastRequestTimestamp(Date.now());
            break; // Exit loop if request is successful
          } catch (error) {
            attempt++;
            this.logger.log(
              color.red.bold(
                `Error in ${functionName}, attempt ${attempt} / ${maxAttempts}. Retrying in 1 second...`
              )
            );
            if (attempt < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
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

class Spotify {
  private cache = Cache.getInstance();
  private data = new Data();
  private utils = new Utils();
  private analytics = AnalyticsClient.getInstance();
  private rapidAPIQueue = RapidAPIQueue.getInstance();
  private prisma = PrismaInstance.getInstance();

  // create a refresh token method
  public async refreshAccessToken(refreshToken: string): Promise<ApiResult> {
    try {
      const response = await axios({
        method: 'post',
        url: 'https://accounts.spotify.com/api/token',
        data: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env['SPOTIFY_CLIENT_ID']}:${process.env['SPOTIFY_CLIENT_SECRET']}`
          ).toString('base64')}`,
        },
      });

      return {
        success: true,
        data: {
          accessToken: response.data.access_token,
          expiresIn: response.data.expires_in,
        },
      };
    } catch (e) {}

    return {
      success: false,
      error: 'Error refreshing access token',
    };
  }

  public async getTokens(code: string): Promise<ApiResult> {
    try {
      const response = await axios({
        method: 'post',
        url: 'https://accounts.spotify.com/api/token',
        data: new URLSearchParams({
          code: code,
          redirect_uri: process.env['SPOTIFY_REDIRECT_URI']!,
          grant_type: 'authorization_code',
        }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env['SPOTIFY_CLIENT_ID']}:${process.env['SPOTIFY_CLIENT_SECRET']}`
          ).toString('base64')}`,
        },
      });

      // outout status
      const profile = await this.getUserProfile(response.data.access_token);

      this.cache.set(
        `refreshtoken_${response.data.access_token}`,
        response.data.refresh_token
      );

      return {
        success: true,
        data: {
          userId: profile.data.userId,
          email: profile.data.email,
          displayName: profile.data.displayName,
          accessToken: response.data.access_token,
          //refreshToken: response.data.refresh_token,
          expiresIn: response.data.expires_in,
        },
      };
    } catch (e) {}

    return {
      success: false,
      error: 'Error getting tokens',
    };
  }

  public async getUserProfile(accessToken: string): Promise<ApiResult> {
    try {
      const response = await axios.get('https://api.spotify.com/v1/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      // Assuming the ApiResult and User interface are set to handle this:
      return {
        success: true,
        data: {
          userId: response.data.id,
          email: response.data.email,
          displayName: response.data.display_name,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to retrieve user profile',
      };
    }
  }

  public async getPlaylists(headers: any): Promise<ApiResult> {
    try {
      const response = await axios.get(
        'https://api.spotify.com/v1/me/playlists',
        {
          headers: {
            Authorization: `Bearer ${headers.authorization}`,
          },
        }
      );

      const playlists: Playlist[] = response.data.items.map((playlist: any) => {
        return {
          id: playlist.id,
          name: playlist.name,
          numberOfTracks: playlist.tracks.total,
        };
      });

      return {
        success: true,
        data: playlists,
      };
    } catch (e: any) {
      // check for 401 error
      const result = this.checkRefreshToken(e, headers);

      return { success: false, error: 'Error getting playlists' };
    }
  }

  private async checkRefreshToken(e: any, headers: any) {
    if (e.response.status === 401) {
      const refreshToken = await this.cache.get(
        `refreshtoken_${headers.authorization}`
      );
      const tokens = await this.refreshAccessToken(refreshToken!);
    }
  }

  public async getPlaylistTrackCount(
    playlistId: string,
    cache: boolean = true
  ): Promise<number> {
    let cacheKeyCount = `trackcount_${playlistId}`;

    const cacheResult = await this.cache.get(cacheKeyCount);

    if (cacheResult) {
      return parseInt(cacheResult);
    }

    const tracks = await this.getTracks(playlistId, cache);

    if (!tracks.success) {
      throw new Error('Error getting playlist track count');
    }

    return tracks.data.totalTracks;
  }

  public async getPlaylist(
    playlistId: string,
    cache: boolean = true
  ): Promise<ApiResult> {
    let playlist: Playlist | null = null;

    try {
      const cacheKey = `playlist_${playlistId}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (!cacheResult || !cache) {
        const options = {
          method: 'GET',
          url: 'https://spotify23.p.rapidapi.com/playlist',
          params: {
            id: playlistId,
          },
          headers: {
            'x-rapidapi-key': process.env['RAPID_API_KEY'],
            'x-rapidapi-host': 'spotify23.p.rapidapi.com',
          },
        };

        await this.rapidAPIQueue.enqueue(options);
        await this.rapidAPIQueue.processQueue();
        const response = await axios.request(options);

        this.analytics.increaseCounter('spotify', 'playlist', 1);

        let image = '';
        if (response.data.images.length > 0) {
          image = response.data.images[0].url;
        }
        playlist = {
          id: playlistId,
          playlistId: playlistId,
          name: response.data.name,
          numberOfTracks: response.data.tracks.total,
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
    } catch (e) {
      console.log(123, e);
      return { success: false, error: 'Error getting playlist' };
    }
  }

  public async getTracks(
    playlistId: string,
    cache: boolean = true
  ): Promise<ApiResult> {
    try {
      let cacheKey = `tracks_${playlistId}`;
      let cacheKeyCount = `trackcount_${playlistId}`;
      const cacheResult = await this.cache.get(cacheKey);
      let allTracks: Track[] = [];
      const uniqueTrackIds = new Set<string>();
      let offset = 0;
      const limit = 100;
      let maxReached = false;

      if (!cacheResult || !cache) {
        while (true) {
          const options = {
            method: 'GET',
            url: 'https://spotify23.p.rapidapi.com/playlist_tracks',
            params: {
              id: playlistId,
              limit,
              offset,
            },
            headers: {
              'x-rapidapi-key': process.env['RAPID_API_KEY'],
              'x-rapidapi-host': 'spotify23.p.rapidapi.com',
            },
          };

          await this.rapidAPIQueue.enqueue(options);
          await this.rapidAPIQueue.processQueue();
          const response = await axios.request(options);

          this.analytics.increaseCounter('spotify', 'tracks', 1);

          // Get all track IDs from this batch
          const trackIds = response.data.items
            .filter((item: any) => item.track)
            .map((item: any) => item.track.id);

          // Get years for all tracks in one query
          const yearResults = await this.prisma.$queryRaw<
            { trackId: string; year: number }[]
          >`
            SELECT trackId, year 
            FROM tracks 
            WHERE trackId IN (${Prisma.join(trackIds)})
          `;

          // Create a map of trackId to year for quick lookup
          const yearMap = new Map(yearResults.map((r) => [r.trackId, r.year]));

          // Cache all years at once, only for tracks that have a year
          await Promise.all(
            yearResults
              .filter((r) => r.year !== null)
              .map((r) =>
                this.cache.set(`year_${r.trackId}`, r.year.toString())
              )
          );

          const tracks: Track[] = await Promise.all(
            response.data.items
              .filter((item: any) => item.track)
              .map(async (item: any) => {
                const trackId = item.track.id;
                let trueYear: number | undefined;

                // Check cache first
                const cachedYear = await this.cache.get(`year_${trackId}`);
                if (cachedYear) {
                  trueYear = parseInt(cachedYear);
                } else {
                  trueYear = yearMap.get(trackId);
                }
                return {
                  id: trackId,
                  name: this.utils.cleanTrackName(item.track.name),
                  artist: item.track.artists[0].name,
                  link: item.track.external_urls.spotify,
                  isrc: item.track.external_ids.isrc,
                  image:
                    item.track.album.images.length > 0
                      ? item.track.album.images[1].url
                      : null,
                  releaseDate: format(
                    new Date(item.track.album.release_date),
                    'yyyy-MM-dd'
                  ),
                  trueYear,
                };
              })
          );

          // remove all items that do not have an artist or image
          const filteredTracks = tracks.filter(
            (track) => track.artist && track.image
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
            if (allTracks.length >= MAX_CARDS) {
              maxReached = true;
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
          totalTracks: allTracks.length,
          tracks: allTracks,
        },
      };

      this.cache.set(cacheKeyCount, allTracks.length.toString());
      this.cache.set(cacheKey, JSON.stringify(result));
      return result;
    } catch (e) {
      console.log(111, e);

      return { success: false, error: 'Error getting tracks' };
    }
  }
}

export default Spotify;
