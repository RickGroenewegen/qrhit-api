import { format } from 'date-fns';
import { white } from 'console-log-colors';
import axios from 'axios';
import { ApiResult } from './interfaces/ApiResult';
import { Playlist } from './interfaces/Playlist';
import { Track } from './interfaces/Track';

class Spotify {
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

      return {
        success: true,
        data: {
          userId: profile.data.userId,
          email: profile.data.email,
          displayName: profile.data.displayName,
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token,
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
    } catch (e) {
      return { success: false, error: 'Error getting playlists' };
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
      console.log(e);

      return { success: false, error: 'Error getting playlist' };
    }
  }

  public async getTracks(headers: any, playlistId: string): Promise<ApiResult> {
    try {
      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        {
          headers: {
            Authorization: `Bearer ${headers.authorization}`,
          },
        }
      );

      const tracks: Track[] = response.data.items.map((track: any) => {
        return {
          id: track.track.id,
          name: track.track.name,
          artist: track.track.artists[0].name,
          releaseDate: format(
            new Date(track.track.album.release_date),
            'yyyy-MM-dd'
          ),
          isrc: track.track.external_ids.isrc,
        };
      });

      return {
        success: true,
        data: tracks,
      };
    } catch (e) {
      console.log(e);

      return { success: false, error: 'Error getting tracks' };
    }
  }
}

export default Spotify;
