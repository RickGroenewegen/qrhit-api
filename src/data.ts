import { color } from 'console-log-colors';
import Logger from './logger';
import { PrismaClient } from '@prisma/client';
import MusicBrainz from './musicbrainz';

class Data {
  private prisma = new PrismaClient();
  private logger = new Logger();
  private musicBrainz = new MusicBrainz();

  public async storeUser(userParams: any): Promise<number> {
    let userDatabaseId: number = 0;

    // Check if the user exists. If not, create it
    const user = await this.prisma.user.findUnique({
      where: {
        userId: userParams.userId,
      },
    });

    if (!user) {
      // create the user
      const userCreate = await this.prisma.user.create({
        data: {
          userId: userParams.userId,
          email: userParams.email,
          displayName: userParams.displayName,
        },
      });
      userDatabaseId = userCreate.id;
    } else {
      userDatabaseId = user.id;
    }
    return userDatabaseId;
  }

  public async storePlaylist(
    userDatabaseId: number,
    playlistParams: any
  ): Promise<number> {
    let playlistDatabaseId: number = 0;

    // Check if the playlist exists. If not, create it
    const playlist = await this.prisma.playlist.findUnique({
      where: {
        playlistId: playlistParams.id,
      },
    });

    if (!playlist) {
      // create the playlist
      const playlistCreate = await this.prisma.playlist.create({
        data: {
          playlistId: playlistParams.id,
          name: playlistParams.name,
        },
      });
      playlistDatabaseId = playlistCreate.id;
    } else {
      playlistDatabaseId = playlist.id;
    }

    // Check if there is a user_has_playlist entry. If not, create it
    const userHasPlaylist = await this.prisma.userHasPlaylist.findFirst({
      where: {
        userId: userDatabaseId, // ID of the user
        playlistId: playlistDatabaseId, // ID of the playlist
      },
    });

    if (!userHasPlaylist) {
      // create the user_has_playlist entry
      await this.prisma.userHasPlaylist.create({
        data: {
          userId: userDatabaseId, // ID of the user
          playlistId: playlistDatabaseId, // ID of the playlist
        },
      });
    }
    return playlistDatabaseId;
  }

  public async getPlaylist(playlistId: string): Promise<any> {
    const playlist: any[] = await this.prisma.$queryRaw`
        SELECT      * 
        FROM        playlists
        WHERE       playlists.playlistId = ${playlistId}`;
    return playlist[0];
  }

  public async getTracks(playlistId: number): Promise<any> {
    const tracks = await this.prisma.$queryRaw`
        SELECT      tracks.trackId, tracks.artist, tracks.year, tracks.name FROM tracks
        INNER JOIN  playlist_has_tracks ON tracks.id = playlist_has_tracks.trackId
        WHERE       playlist_has_tracks.playlistId = ${playlistId}`;
    return tracks;
  }

  public async getUser(userId: number): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
    });
    return user;
  }

  public async storeTracks(
    playlistDatabaseId: number,
    tracks: any
  ): Promise<any> {
    let trackDatabaseId: number = 0;

    // Check if the tracks exist. If not, create them
    for (const track of tracks) {
      const trackDatabase = await this.prisma.track.findUnique({
        where: {
          trackId: track.id,
        },
      });

      trackDatabaseId = 0;
      let year = null;

      if (!trackDatabase) {
        // create the track
        const trackCreate = await this.prisma.track.create({
          data: {
            trackId: track.id,
            name: track.name,
            artist: track.artist,
            isrc: track.isrc,
          },
        });

        trackDatabaseId = trackCreate.id;
      } else {
        trackDatabaseId = trackDatabase.id;
        year = trackDatabase.year;
      }

      if (!year) {
        // We need to retrieve the year of the track from MusicBrainz
        let releaseDate = await this.musicBrainz.getReleaseDate(track.isrc);

        if (!releaseDate && track.releaseDate) {
          releaseDate = parseInt(track.releaseDate.split('-')[0]);
        }

        if (releaseDate > 0) {
          // Update the track with the release date
          await this.prisma.track.update({
            where: {
              id: trackDatabaseId,
            },
            data: {
              year: releaseDate,
            },
          });
        } else {
          this.logger.log(
            color.red(`No release dates found for: ${track.name}`)
          );
        }
      }

      // Check if there is a playlist_has_track entry. If not, create it
      const playlistHasTrack = await this.prisma.playlistHasTrack.findFirst({
        where: {
          playlistId: playlistDatabaseId, // ID of the playlist
          trackId: trackDatabaseId, // ID of the track
        },
      });

      if (!playlistHasTrack) {
        // create the playlist_has_track entry
        await this.prisma.playlistHasTrack.create({
          data: {
            playlistId: playlistDatabaseId, // ID of the playlist
            trackId: trackDatabaseId, // ID of the track
          },
        });
      }

      this.logger.log(
        color.blue.bold('Created track: ') +
          color.white.bold(track.name) +
          color.blue.bold(' by ') +
          color.white.bold(track.artist)
      );
    }
  }
}

export default Data;
