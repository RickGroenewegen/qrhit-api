import { color, white } from 'console-log-colors';
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
  name: string;
  artist: string;
}
import Cache from './cache';
import Translation from './translation';
import Utils from './utils';
import { CartItem } from './interfaces/CartItem';
import AnalyticsClient from './analytics';
import * as XLSX from 'xlsx';

class Data {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private musicBrainz = new MusicBrainz();
  private cache = Cache.getInstance();
  private translate = new Translation();
  private utils = new Utils();
  private analytics = AnalyticsClient.getInstance();

  public async getPDFFilepath(
    clientIp: string,
    paymentId: string,
    userHash: string,
    playlistId: string,
    type: string
  ): Promise<{ fileName: string; filePath: string } | null> {
    if (type == 'printer' && !this.utils.isTrustedIp(clientIp)) {
      return null;
    }

    const cacheKey = `pdfFilePath:${paymentId}:${playlistId}:${type}`;
    const cachedFilePath = await this.cache.get(cacheKey);

    if (cachedFilePath) {
      return JSON.parse(cachedFilePath);
    }

    const result: any[] = await this.prisma.$queryRaw`
      SELECT 
        php.filename,
        php.filenameDigital,
        pl.name
      FROM 
        payment_has_playlist php
      INNER JOIN 
        payments pm ON php.paymentId = pm.id
      INNER JOIN 
        playlists pl ON php.playlistId = pl.id
      INNER JOIN 
        users u ON pm.userid = u.id
      WHERE 
        pm.paymentId = ${paymentId} 
      AND 
        pl.playlistId = ${playlistId} 
      AND
        u.hash = ${userHash}
      AND 
        pm.status = 'paid' 
    `;

    if (result.length === 0) {
      return null;
    }

    const paymentHasPlaylist = result[0];
    let filename = '';
    let sanitizedFileName = this.utils.generateFilename(
      paymentHasPlaylist.name
    );

    if (type == 'printer') {
      filename = paymentHasPlaylist.filename!;
      sanitizedFileName = `printer_${sanitizedFileName}`;
    } else {
      filename = paymentHasPlaylist.filenameDigital!;
    }

    const filePath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
    const finalResult = {
      fileName: sanitizedFileName + '.pdf',
      filePath: filePath,
    };
    await this.cache.set(cacheKey, JSON.stringify(finalResult));
    return finalResult;
  }

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
          sync: true,
        },
      });
      userDatabaseId = userCreate.id;
    } else {
      userDatabaseId = user.id;
    }
    return userDatabaseId;
  }

  public async getPlaylistsByPaymentId(paymentId: string): Promise<any[]> {
    const playlists = await this.prisma.$queryRaw<any[]>`
      SELECT 
        playlists.id,
        playlists.playlistId,
        playlists.name,
        playlists.type AS productType,
        playlists.giftcardAmount,
        playlists.giftcardFrom,
        playlists.giftcardMessage,
        payment_has_playlist.id AS paymentHasPlaylistId,
        payment_has_playlist.price,
        payment_has_playlist.priceWithoutVAT,
        payment_has_playlist.priceVAT,
        payment_has_playlist.amount,
        playlists.numberOfTracks,
        payment_has_playlist.type AS orderType
      FROM 
        payment_has_playlist
      INNER JOIN 
        playlists ON payment_has_playlist.playlistId = playlists.id
      INNER JOIN 
        payments ON payment_has_playlist.paymentId = payments.id
      WHERE 
        payments.paymentId = ${paymentId}`;

    return playlists;
  }

  public async getTaxRate(
    countryCode: string,
    date: Date = new Date()
  ): Promise<number | null> {
    if (!this.euCountryCodes.includes(countryCode)) {
      return 0; // Default NL
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
        let extraPrice = 0;

        // Extra protection. Messing the other way around will increase the price
        if (cartItem.price < 0) {
          extraPrice = 0;
        }

        let giftcardAmount = 0;
        let giftcardFrom = '';
        let giftcardMessage = '';

        if (cartItem.productType == 'giftcard') {
          if (cartItem.type == 'physical') {
            extraPrice = cartItem.extraPrice!;
          }

          giftcardAmount = cartItem.price - extraPrice;
          giftcardFrom = cartItem.fromName!;
          giftcardMessage = cartItem.personalMessage!;
        }

        const playlistCreate = await this.prisma.playlist.create({
          data: {
            playlistId: cartItem.playlistId,
            name: cartItem.playlistName,
            image: cartItem.image,
            price: cartItem.price,
            numberOfTracks: cartItem.numberOfTracks,
            type: cartItem.productType,
            giftcardAmount,
            giftcardFrom,
            giftcardMessage,
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
            numberOfTracks: cartItem.numberOfTracks,
            name: cartItem.playlistName,
            resetCache: doResetCache,
          },
        });
      }

      playlistDatabaseIds.push(playlistDatabaseId);
    }

    return playlistDatabaseIds;
  }

  public async getPayment(paymentId: string, playlistId: string): Promise<any> {
    const paymentDetails: any[] = await this.prisma.$queryRaw`
        SELECT      payments.id,
                    payments.orderId,
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
        WHERE       payments.paymentId = ${paymentId}`;

    const connectedPlaylists: any[] = await this.prisma.$queryRaw`
        SELECT      playlists.id,
                    playlists.playlistId,
                    playlists.numberOfTracks,
                    payment_has_playlist.amount,
                    payment_has_playlist.type,
                    playlists.name AS playlistName,
                    playlists.type AS productType,
                    playlists.giftcardAmount
        FROM        payment_has_playlist
        INNER JOIN  playlists ON payment_has_playlist.playlistId = playlists.id
        WHERE       payment_has_playlist.paymentId = ${paymentDetails[0].id}`;

    return {
      payment: paymentDetails[0],
      playlists: connectedPlaylists,
    };
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

  public async getFirstUncheckedTrack(): Promise<any> {
    const track = await this.prisma.track.findFirst({
      where: {
        manuallyChecked: false,
      },
      select: {
        id: true,
        name: true,
        artist: true,
        year: true,
        yearSource: true,
        certainty: true,
        reasoning: true,
      },
      orderBy: {
        id: 'asc',
      },
    });

    console.log(111, track);

    return track;
  }

  public async updateTrackCheck(
    trackId: number,
    year: number
  ): Promise<boolean> {
    try {
      await this.prisma.track.update({
        where: {
          id: trackId,
        },
        data: {
          manuallyChecked: true,
          year,
        },
      });
      return true;
    } catch (error) {
      return false;
    }
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
    this.analytics.increaseCounter('songs', 'played');
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
    playlistId: string,
    tracks: any
  ): Promise<any> {
    const providedTrackIds = tracks.map((track: any) => track.id);

    this.logger.log(
      color.blue.bold(
        `Deleting removed tracks from playlist ${color.white.bold(playlistId)}`
      )
    );

    // Remove tracks that are no longer in the provided tracks list
    await this.prisma.$executeRaw`
      DELETE FROM playlist_has_tracks
      WHERE playlistId = ${playlistDatabaseId}
      AND trackId NOT IN (
        SELECT id FROM tracks
        WHERE trackId IN (${Prisma.join(providedTrackIds)})
      )
    `;

    this.logger.log(
      color.blue.bold(
        `Bulk upsert tracks for playlist ${color.white.bold(playlistId)}`
      )
    );

    // Step 1: Identify existing tracks with full data
    const existingTracks = await this.prisma.track.findMany({
      where: {
        trackId: { in: providedTrackIds },
      },
      select: {
        trackId: true,
        name: true,
        isrc: true,
        artist: true,
        spotifyLink: true,
      },
    });

    this.logger.log(
      color.blue.bold(
        `Existing tracks: ${color.white.bold(existingTracks.length)}`
      )
    );

    // Convert existing tracks to a Map for quick lookup
    const existingTrackMap = new Map(
      existingTracks.map((track) => [track.trackId, track])
    );

    // Step 2: Separate new and existing tracks, and check for changes
    const newTracks = [];
    const tracksToUpdate = [];

    for (const track of tracks) {
      const existingTrack = existingTrackMap.get(track.id);
      if (existingTrack) {
        // Check if any data has changed
        if (
          existingTrack.name !== this.utils.cleanTrackName(track.name) ||
          existingTrack.isrc !== track.isrc ||
          existingTrack.artist !== track.artist ||
          existingTrack.spotifyLink !== track.link
        ) {
          tracksToUpdate.push(track);
        }
      } else {
        newTracks.push(track);
      }
    }

    this.logger.log(
      color.blue.bold(
        `Inserting new tracks: ${color.white.bold(newTracks.length)}`
      )
    );

    // Step 3: Insert new tracks
    if (newTracks.length > 0) {
      await this.prisma.track.createMany({
        data: newTracks.map((track) => ({
          trackId: track.id,
          name: this.utils.cleanTrackName(track.name),
          isrc: track.isrc,
          artist: track.artist,
          spotifyLink: track.link,
        })),
        skipDuplicates: true,
      });
    }

    this.logger.log(
      color.blue.bold(
        `Updating tracks: ${color.white.bold(tracksToUpdate.length)}`
      )
    );

    // Update existing tracks
    for (const track of tracksToUpdate) {
      await this.prisma.track.update({
        where: { trackId: track.id },
        data: {
          name: this.utils.cleanTrackName(track.name),
          isrc: track.isrc,
          artist: track.artist,
          spotifyLink: track.link,
        },
      });
    }

    this.logger.log(
      color.blue.bold(
        `Creating playlist_has_tracks records for playlist ${color.white.bold(
          playlistId
        )}`
      )
    );

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
      SELECT id, isrc, trackId, name, artist
      FROM tracks
      WHERE (year IS NULL OR yearSource IS NULL) AND trackId IN (${Prisma.join(
        providedTrackIds
      )})
    `;

    this.logger.log(
      color.blue.bold(
        `Updating years for playlist ${color.white.bold(playlistId)}`
      )
    );

    // Update years for tracks
    for (const track of tracksNeedingYearUpdate) {
      let { year, source, certainty, reasoning } =
        await this.musicBrainz.getReleaseDate(
          track.isrc ?? '',
          track.artist,
          track.name
        );
      if (!year) {
        const spotifyTrack = tracks.find((t: any) => t.id === track.trackId);
        if (spotifyTrack && spotifyTrack.releaseDate) {
          year = parseInt(spotifyTrack.releaseDate.split('-')[0]);
          source = 'spotify';
        }
      }
      if (year > 0) {
        if (source == 'ai') {
          this.logger.log(
            color.blue.bold(
              `AI claims year for '${white.bold(track.artist)} - ${white.bold(
                track.name
              )}' is ${white.bold(year)} because ${white.bold(reasoning)}`
            )
          );
        }

        await this.prisma.$executeRaw`
          UPDATE tracks
          SET year        = ${year},
              yearSource  = ${source},
              certainty   = ${certainty},
              reasoning   = ${reasoning}
          WHERE id = ${track.id}
        `;
      } else {
        this.logger.log(
          color.red(`No release dates found for track ID: ${track.id}`)
        );
      }
    }
  }

  public async updateAllTrackYears(): Promise<void> {
    const tracks = await this.prisma.track.findMany({
      select: {
        id: true,
        isrc: true,
        artist: true,
        name: true,
        year: true,
      },
      where: {
        yearSource: {
          in: ['ai', 'api'],
        },
      },
    });

    this.logger.log(
      color.blue.bold(
        `Updating years for ${color.white.bold(tracks.length)} tracks`
      )
    );

    for (const track of tracks) {
      try {
        let { year, source, certainty, reasoning } =
          await this.musicBrainz.getReleaseDate(
            track.isrc ?? '',
            track.artist,
            track.name,
            true
          );
        if (year > 0) {
          if (track.year !== year) {
            await this.prisma.track.update({
              where: { id: track.id },
              data: {
                year: year,
                yearSource: source,
                reasoning,
                certainty,
              },
            });

            this.logger.log(
              color.blue.bold(
                `Updated track ID ${color.white.bold(
                  track.id
                )} named '${color.white.bold(
                  track.artist
                )} - ${color.white.bold(
                  track.name
                )}' with year ${color.white.bold(year)} from ${color.white.bold(
                  source
                )} (Old year: ${color.white.bold(track.year)})`
              )
            );
          } else {
            this.logger.log(
              color.yellow(
                `Track ID ${color.white.bold(
                  track.id
                )} named '${color.white.bold(
                  track.artist
                )} - ${color.white.bold(
                  track.name
                )}' already has year ${color.white.bold(
                  year
                )} from ${color.white.bold(source)}`
              )
            );
          }
        } else {
          this.logger.log(
            color.yellow(
              `No release date found for track ID: ${color.white.bold(
                track.id
              )}`
            )
          );
        }
      } catch (error) {
        console.log(error);

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.log(
          color.red(
            `Error updating track ID ${color.white.bold(
              track.id
            )}: ${color.white.bold(errorMessage)}`
          )
        );
      }
    }

    this.logger.log(color.blue.bold('Finished updating all track years'));
  }

  public async fixYears(): Promise<void> {
    try {
      const workbook = XLSX.readFile(
        `${process.env['APP_ROOT']}/../docs/tracks_to_check.xlsx`
      );
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1 });

      // Start from row 2 (index 1) to skip header
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as string[];
        // Check if column E (index 4) has data
        if (row && row[4]) {
          const trackId = parseInt(row[0]);
          const newYear = parseInt(row[4]);

          if (!isNaN(trackId) && !isNaN(newYear)) {
            await this.prisma.track.update({
              where: { id: trackId },
              data: {
                year: newYear,
                yearSource: 'manual',
                manuallyChecked: true,
              },
            });

            this.logger.log(
              color.magenta(
                `Updated track ${color.white.bold(trackId)} (${color.white.bold(
                  row[1]
                )} - ${color.white.bold(row[2])}) with year ${color.white.bold(
                  newYear
                )}`
              )
            );
          }
        }
      }
    } catch (error) {
      this.logger.log(`Error reading Excel file: ${error}`);
    }
  }
}

export default Data;
