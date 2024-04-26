import { color } from 'console-log-colors';
import Logger from './logger';
import { PrismaClient } from '@prisma/client';
import MusicBrainz from './musicbrainz';
import Progress from './progress';
import { nanoid } from 'nanoid';
import crypto from 'crypto';
import { ApiResult } from './interfaces/ApiResult';

class Data {
  private prisma = new PrismaClient();
  private logger = new Logger();
  private musicBrainz = new MusicBrainz();
  private progress = Progress.getInstance();

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
      const hash = crypto.randomBytes(8).toString('hex').slice(0, 16);

      const userCreate = await this.prisma.user.create({
        data: {
          userId: userParams.userId,
          email: userParams.email,
          displayName: userParams.displayName,
          hash: hash,
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

    await this.prisma.$executeRaw`
    INSERT INTO   user_has_playlists (userId, playlistId)
    VALUES        (${userDatabaseId}, ${playlistDatabaseId})
    ON DUPLICATE KEY UPDATE userId = userId;`;

    return playlistDatabaseId;
  }

  public async getPayment(paymentId: string, playlistId: string): Promise<any> {
    const payment: any[] = await this.prisma.$queryRaw`
        SELECT      payments.* 
        FROM        payments
        INNER JOIN  playlists ON payments.playlistId = playlists.id
        INNER JOIN  user_has_playlists ON playlists.id = user_has_playlists.playlistId
        WHERE       payments.paymentId = ${paymentId}
        AND         playlists.playlistId = ${playlistId}
        AND         payments.userId = user_has_playlists.userId`;
    return payment[0];
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
        SELECT      tracks.id, tracks.trackId, tracks.artist, tracks.year, tracks.name FROM tracks
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

  public async getLink(userHash: string, trackId: number): Promise<ApiResult> {
    let link = '';

    const linkQuery: any[] = await this.prisma.$queryRaw`
        SELECT      tracks.spotifyLink 
        FROM        tracks
        INNER JOIN  playlist_has_tracks ON tracks.id = playlist_has_tracks.trackId
        INNER JOIN  user_has_playlists ON playlist_has_tracks.playlistId = user_has_playlists.playlistId
        INNER JOIN  users ON user_has_playlists.userId = users.id
        WHERE       users.hash = ${userHash}
        AND         tracks.id = ${trackId}`;

    console.log(111, linkQuery);

    if (linkQuery.length > 0) {
      return {
        success: true,
        data: { link: linkQuery[0].spotifyLink },
      };
    }

    return {
      success: false,
    };
  }

  public async storeTracks(
    paymentId: string,
    playlistDatabaseId: number,
    tracks: any
  ): Promise<any> {
    let trackDatabaseId: number = 0;
    let counter = 1;

    // Check if the tracks exist. If not, create them
    for (const track of tracks) {
      if (track.id) {
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
              spotifyLink: track.link,
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

        // Calculate the progress from 0-70% based on the number of tracks
        const progress = Math.round(
          (tracks.indexOf(track) / tracks.length) * 70
        );

        // Update the progress
        await this.progress.setProgress(
          paymentId,
          progress,
          `Processing track (${counter} of ${tracks.length}): ${track.name} (${track.artist})`,
          track.image
        );
      }
      counter++;
    }
  }
}

export default Data;
