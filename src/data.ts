import { color } from 'console-log-colors';
import Logger from './logger';
import { PrismaClient } from '@prisma/client';
import MusicBrainz from './musicbrainz';
import Progress from './progress';
import crypto from 'crypto';
import { ApiResult } from './interfaces/ApiResult';
import Cache from './cache';

class Data {
  private prisma = new PrismaClient();
  private logger = new Logger();
  private musicBrainz = new MusicBrainz();
  private progress = Progress.getInstance();
  private cache = Cache.getInstance();
  private euCountryCodes: string[] = [
    'AT', // Austria
    'BE', // Belgium
    'BG', // Bulgaria
    'HR', // Croatia
    'CY', // Cyprus
    'CZ', // Czech Republic
    'DK', // Denmark
    'EE', // Estonia
    'FI', // Finland
    'FR', // France
    'DE', // Germany
    'GR', // Greece
    'HU', // Hungary
    'IE', // Ireland
    'IT', // Italy
    'LV', // Latvia
    'LT', // Lithuania
    'LU', // Luxembourg
    'MT', // Malta
    'NL', // Netherlands
    'PL', // Poland
    'PT', // Portugal
    'RO', // Romania
    'SK', // Slovakia
    'SI', // Slovenia
    'ES', // Spain
    'SE', // Sweden
  ];

  public async storeUser(userParams: any): Promise<number> {
    let userDatabaseId: number = 0;

    // Check if the user exists. If not, create it
    const user = await this.prisma.user.findUnique({
      where: {
        email: userParams.email,
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

  public async getTaxRate(
    date: Date,
    countryCode: string
  ): Promise<number | null> {
    if (!this.euCountryCodes.includes(countryCode)) {
      return 0;
    }

    const taxRates = await this.prisma.taxRate.findMany({
      where: {
        OR: [
          {
            startDate: {
              lte: date,
            },
            endDate: {
              gte: date,
            },
          },
          {
            startDate: {
              lte: date,
            },
            endDate: null,
          },
          {
            startDate: null,
            endDate: {
              gte: date,
            },
          },
          {
            startDate: null,
            endDate: null,
          },
        ],
      },
      orderBy: {
        startDate: 'desc',
      },
    });

    if (taxRates.length === 0) {
      return null;
    }

    return taxRates[0].rate;
  }

  public async getFeaturedPlaylists() {
    let returnList: any[] = [];
    const cachedPlaylists = await this.cache.get('featuredPlaylists_5');

    if (!cachedPlaylists) {
      // Query the database for the featured playlists
      returnList = await this.prisma.$queryRaw`
        SELECT 
          playlists.id,
          playlists.playlistId,
          playlists.name,
          playlists.image,
          playlists.price,
          playlists.numberOfTracks
      FROM 
          playlists;
      `;
      returnList = returnList.map((playlist) => ({
        ...playlist,
      }));
      this.cache.set('featuredPlaylists_5', JSON.stringify(returnList));
    } else {
      returnList = JSON.parse(cachedPlaylists);
    }
    return returnList;
  }

  public async storePlaylist(
    userDatabaseId: number,
    playlistParams: any,
    price: number
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

      let name = playlistParams.name;

      // Remove [QRSong] from the name
      name = name.replace('[QRSong]', '').trim();

      const playlistCreate = await this.prisma.playlist.create({
        data: {
          playlistId: playlistParams.id,
          name: playlistParams.name,
          image: playlistParams.image,
          price: price,
        },
      });
      playlistDatabaseId = playlistCreate.id;
    } else {
      playlistDatabaseId = playlist.id;

      await this.prisma.playlist.update({
        where: {
          id: playlistDatabaseId,
        },
        data: {
          price: price,
          numberOfTracks: playlistParams.numberOfTracks,
        },
      });
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
        SELECT      *, (SELECT COUNT(1) FROM playlist_has_tracks WHERE playlist_has_tracks.playlistId = playlists.id) as numberOfTracks
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

  public async getUser(id: number): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: {
        id,
      },
    });
    return user;
  }

  public async getUserByUserId(userId: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: {
        userId,
      },
    });
    return user;
  }

  public async getLink(trackId: number): Promise<ApiResult> {
    let link = '';
    const cachedLink = await this.cache.get('link' + trackId);
    if (cachedLink) {
      return {
        success: true,
        data: { link: cachedLink },
      };
    } else {
      const linkQuery: any[] = await this.prisma.$queryRaw`
        SELECT      tracks.spotifyLink 
        FROM        tracks
        WHERE       tracks.id = ${trackId}`;

      if (linkQuery.length > 0) {
        link = linkQuery[0].spotifyLink;
        this.cache.set('link' + trackId, link);
      }

      if (link.length > 0) {
        return {
          success: true,
          data: { link: linkQuery[0].spotifyLink },
        };
      }
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
              isrc: track.isrc,
              artist: track.artist,
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
          `${track.artist} - ${track.name} (${counter} of ${tracks.length})`,
          track.image
        );
      }
      counter++;
    }
  }
}

export default Data;
