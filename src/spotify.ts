import { format } from 'date-fns';
import { white } from 'console-log-colors';
import axios from 'axios';
import { ApiResult } from './interfaces/ApiResult';
import { Playlist } from './interfaces/Playlist';
import { Track } from './interfaces/Track';
import Cache from './cache';

class Spotify {
  private cache = Cache.getInstance();

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
    } catch (e) {
      console.log(111, e);
    }

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
    } catch (e) {
      console.log(111, e);
    }

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
      console.log(123, e.response.data.error);
      console.log(444, tokens);
    }
  }

  public async getPlaylist(
    headers: any,
    playlistId: string
  ): Promise<ApiResult> {
    try {
      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}`,
        {
          headers: {
            Authorization: `Bearer ${headers.authorization}`,
          },
        }
      );

      const playlist: Playlist = {
        id: response.data.id,
        name: response.data.name,
        numberOfTracks: response.data.tracks.total,
      };

      return {
        success: true,
        data: playlist,
      };
    } catch (e) {
      return { success: false, error: 'Error getting playlist' };
    }
  }

  public async getTracks(headers: any, playlistId: string): Promise<ApiResult> {
    try {
      let allTracks: Track[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const response = await axios.get(
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          {
            headers: {
              Authorization: `Bearer ${headers.authorization}`,
            },
            params: {
              limit,
              offset,
            },
          }
        );

        const tracks: Track[] = response.data.items.map((item: any) => ({
          id: item.track.id,
          name: item.track.name,
          artist: item.track.artists[0].name,
          link: item.track.external_urls.spotify,
          image:
            item.track.album.images.length > 0
              ? item.track.album.images[0].url
              : null,
          releaseDate: format(
            new Date(item.track.album.release_date),
            'yyyy-MM-dd'
          ),
          isrc: item.track.external_ids.isrc,
        }));

        allTracks = allTracks.concat(tracks);

        // Check if there are more tracks to fetch
        if (response.data.items.length < limit) {
          break;
        }

        offset += limit;
      }

      return {
        success: true,
        data: allTracks,
      };
    } catch (e) {
      console.error(e);

      return { success: false, error: 'Error getting tracks' };
    }
  }
}

export default Spotify;
