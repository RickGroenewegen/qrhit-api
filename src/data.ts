import { color } from 'console-log-colors';
import Logger from './logger';
import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import MusicBrainz from './musicbrainz';
import crypto from 'crypto';
import { ApiResult } from './interfaces/ApiResult';

interface TrackNeedingYearUpdate {
  id: number;
  isrc: string | null;
  trackId: string;
}
import Cache from './cache';
import Translation from './translation';
import Utils from './utils';
import { CartItem } from './interfaces/CartItem';

class Data {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private musicBrainz = new MusicBrainz();
  private cache = Cache.getInstance();
  private translate = new Translation();
  private utils = new Utils();

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
    countryCode: string,
    date: Date = new Date()
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

  public async getFeaturedPlaylists(locale: string): Promise<any> {
    let returnList: any[] = [];
    const cacheKey = 'featuredPlaylists_' + locale;
    const cachedPlaylists = await this.cache.get(cacheKey);

    if (!this.translate.isValidLocale(locale)) {
      return [];
    }

    if (!cachedPlaylists) {
      // Base query
      let query = `
      SELECT 
        playlists.id,
        playlists.playlistId,
        playlists.name,
        playlists.image,
        playlists.price,
        playlists.numberOfTracks
      FROM 
        playlists
      WHERE 
        playlists.featured = 1
    `;

      // Add locale condition
      if (locale) {
        query += ` AND (playlists.featuredLocale = '${locale}' OR playlists.featuredLocale IS NULL)`;
      } else {
        query += ` AND playlists.featuredLocale IS NULL`;
      }

      // Add ordering if locale is provided
      if (locale) {
        query += `
        ORDER BY 
          CASE 
            WHEN playlists.featuredLocale = '${locale}' THEN 0 
            ELSE 1 
          END
      `;
      }

      returnList = await this.prisma.$queryRawUnsafe(query);

      returnList = returnList.map((playlist) => ({
        ...playlist,
      }));

      this.cache.set(cacheKey, JSON.stringify(returnList));
    } else {
      returnList = JSON.parse(cachedPlaylists);
    }
    return returnList;
  }

  public async storePlaylists(
    userDatabaseId: number,
    cartItems: CartItem[],
    resetCache: boolean = false
  ): Promise<number[]> {
    const playlistDatabaseIds: number[] = [];

    for (const cartItem of cartItems) {
      let playlistDatabaseId: number = 0;

      // Check if the playlist exists. If not, create it
      const playlist = await this.prisma.playlist.findUnique({
        where: {
          playlistId: cartItem.playlistId,
        },
      });

      if (!playlist) {
        // create the playlist
        const playlistCreate = await this.prisma.playlist.create({
          data: {
            playlistId: cartItem.playlistId,
            name: cartItem.playlistName,
            image: '', // Assuming image is not provided in CartItem
            price: cartItem.price,
            numberOfTracks: cartItem.amountOfTracks,
          },
        });
        playlistDatabaseId = playlistCreate.id;
      } else {
        playlistDatabaseId = playlist.id;

        let doResetCache = false;
        if (!playlist.featured && resetCache) {
          doResetCache = true;
        }

        await this.prisma.playlist.update({
          where: {
            id: playlistDatabaseId,
          },
          data: {
            price: cartItem.price,
            numberOfTracks: cartItem.amountOfTracks,
            name: cartItem.playlistName,
            resetCache: doResetCache,
          },
        });
      }

      await this.prisma.$executeRaw`
      INSERT INTO   user_has_playlists (userId, playlistId)
      VALUES        (${userDatabaseId}, ${playlistDatabaseId})
      ON DUPLICATE KEY UPDATE userId = userId;`;

      playlistDatabaseIds.push(playlistDatabaseId);
    }

    return playlistDatabaseIds;
  }

  public async getPayment(paymentId: string, playlistId: string): Promise<any> {
    const payment: any[] = await this.prisma.$queryRaw`
        SELECT      payments.orderId,
                    payments.createdAt,
                    payments.fullname,
                    payments.email,
                    payments.address,
                    payments.city,
                    payments.zipcode,
                    payments.countryCode,
                    payments.status,
                    payments.differentInvoiceAddress,
                    payments.invoiceAddress,
                    payments.invoiceCity,
                    payments.invoiceZipcode,
                    payments.invoiceCountrycode,
                    CASE 
                      WHEN EXISTS (
                        SELECT 1 
                        FROM payment_has_playlist 
                        WHERE payment_has_playlist.paymentId = payments.id 
                        AND payment_has_playlist.type = 'physical'
                      ) THEN 'physical'
                      ELSE 'digital'
                    END AS orderType
        FROM        payments
        INNER JOIN  payment_has_playlist ON payments.id = payment_has_playlist.paymentId
        WHERE       payments.paymentId = ${paymentId}
        AND         payment_has_playlist.playlistId = ${playlistId}`;

    console.log(111, payment);

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
    playlistDatabaseId: number,
    tracks: any
  ): Promise<any> {
    const providedTrackIds = tracks.map((track: any) => track.id);

    // Remove tracks that are no longer in the provided tracks list
    await this.prisma.$executeRaw`
      DELETE FROM playlist_has_tracks
      WHERE playlistId = ${playlistDatabaseId}
      AND trackId NOT IN (
        SELECT id FROM tracks
        WHERE trackId IN (${Prisma.join(providedTrackIds)})
      )
    `;

    // Bulk upsert tracks
    if (tracks.length > 0) {
      const values = tracks.map(
        (track: {
          id: string;
          name: string;
          isrc: string | null;
          artist: string;
          link: string;
        }) => ({
          trackId: track.id,
          name: this.utils.cleanTrackName(track.name),
          isrc: track.isrc,
          artist: track.artist,
          spotifyLink: track.link,
        })
      );

      await this.prisma.track.createMany({
        data: values,
        skipDuplicates: true,
      });

      // Update existing tracks
      for (const track of values) {
        await this.prisma.track.update({
          where: { trackId: track.trackId },
          data: {
            name: track.name,
            isrc: track.isrc,
            artist: track.artist,
            spotifyLink: track.spotifyLink,
          },
        });
      }
    }

    // Bulk insert playlist_has_tracks
    await this.prisma.$executeRaw`
      INSERT IGNORE INTO playlist_has_tracks (playlistId, trackId)
      SELECT ${playlistDatabaseId}, id
      FROM tracks
      WHERE trackId IN (${Prisma.join(providedTrackIds)})
    `;

    // Fetch tracks that need year update
    const tracksNeedingYearUpdate = await this.prisma.$queryRaw<
      TrackNeedingYearUpdate[]
    >`
      SELECT id, isrc, trackId
      FROM tracks
      WHERE year IS NULL AND trackId IN (${Prisma.join(providedTrackIds)})
    `;

    // Update years for tracks
    for (const track of tracksNeedingYearUpdate) {
      let releaseDate = await this.musicBrainz.getReleaseDate(track.isrc ?? '');
      if (!releaseDate) {
        const spotifyTrack = tracks.find((t: any) => t.id === track.trackId);
        if (spotifyTrack && spotifyTrack.releaseDate) {
          releaseDate = parseInt(spotifyTrack.releaseDate.split('-')[0]);
        }
      }
      if (releaseDate > 0) {
        await this.prisma.$executeRaw`
          UPDATE tracks
          SET year = ${releaseDate}
          WHERE id = ${track.id}
        `;
      } else {
        this.logger.log(
          color.red(`No release dates found for track ID: ${track.id}`)
        );
      }
    }
  }
}

export default Data;
