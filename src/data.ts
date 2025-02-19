import { Track } from './interfaces/Track';
import { color } from 'console-log-colors';
import Logger from './logger';
import { Prisma } from '@prisma/client';
import slugify from 'slugify';
import PrismaInstance from './prisma';
import crypto from 'crypto';
import { CronJob } from 'cron';
import { ApiResult } from './interfaces/ApiResult';
import { promises as fs } from 'fs';
import path from 'path';

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
import cluster from 'cluster';
import { Music } from './music';
import PushoverClient from './pushover';
import { ChatGPT } from './chatgpt';
import YTMusic from 'ytmusic-api';

class Data {
  private static instance: Data;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private translate = new Translation();
  private utils = new Utils();
  private music = new Music();
  private openai = new ChatGPT();
  private analytics = AnalyticsClient.getInstance();
  private pushover = new PushoverClient();

  private ytmusic: YTMusic;

  public async getYouTubeLink(
    artist: string,
    name: string
  ): Promise<string | null> {
    try {
      const searchResults = await this.ytmusic.searchSongs(`${name} ${artist}`);
      const matchingTrack = searchResults.filter(
        (song) => song?.artist?.name === artist
      )[0];

      if (matchingTrack) {
        return `https://music.youtube.com/watch?v=${matchingTrack.videoId}`;
      }
      return null;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error getting YouTube link for track ${color.white.bold(
            artist
          )} - ${color.white.bold(name)}`
        )
      );
      console.log(error);
      return null;
    }
  }

  public async addSpotifyLinks(): Promise<number> {
    let processed = 0;

    // Get all tracks without youtube links
    const tracks = await this.prisma.track.findMany({
      where: {
        youtubeLink: null,
        spotifyLink: {
          not: null,
        },
      },
      select: {
        id: true,
        artist: true,
        name: true,
        spotifyLink: true,
      },
    });

    this.logger.log(
      color.blue.bold(
        `Found ${color.white.bold(tracks.length)} tracks without YouTube links`
      )
    );

    for (const track of tracks) {
      try {
        // Extract Spotify track ID from link
        const spotifyId = track.spotifyLink!.split('/').pop()!;

        // Get YouTube Music URL
        const ytMusicUrl = await this.getYouTubeLink(track.artist, track.name);

        if (ytMusicUrl) {
          await this.prisma.track.update({
            where: { id: track.id },
            data: { youtubeLink: ytMusicUrl },
          });
          processed++;

          this.logger.log(
            color.blue.bold(
              `Added YouTube Music link for '${color.white.bold(
                track.artist
              )} - ${color.white.bold(track.name)}': ${color.white.bold(
                ytMusicUrl
              )}`
            )
          );
        }
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error processing track '${color.white.bold(
              track.artist
            )} - ${color.white.bold(track.name)}': ${error}`
          )
        );
      }

      // Add a small delay to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return processed;
  }

  private constructor() {
    this.ytmusic = new YTMusic();
    this.ytmusic.initialize();
    // ... rest of constructor
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.createSiteMap();
          await this.prefillLinkCache();

          // Schedule hourly cache refresh
          const job = new CronJob('0 * * * *', async () => {
            this.logger.log(
              color.blue.bold('Running scheduled link cache refresh')
            );
            await this.prefillLinkCache();
          });
          job.start();
        }
      });
    }
  }

  private async prefillLinkCache(): Promise<void> {
    const tracks = await this.prisma.track.findMany({
      select: {
        id: true,
        spotifyLink: true,
      },
      where: {
        spotifyLink: {
          not: '',
        },
      },
    });

    let cacheCount = 0;
    for (const track of tracks) {
      if (track.spotifyLink) {
        await this.cache.set('link' + track.id, track.spotifyLink);
        cacheCount++;
      }
    }

    this.logger.log(
      color.blue.bold(`Cached ${color.white.bold(cacheCount)} track links`)
    );
  }

  public async verifyPayment(paymentId: string) {
    // Get all the playlist IDs (The real spotify one) for the checked payments
    const playlists = await this.prisma.$queryRaw<any[]>`
      SELECT pl.playlistId, p.userId
      FROM payments p
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      WHERE p.paymentId = ${paymentId}
    `;

    // Loop through all the playlist IDs and verify them
    for (const playlist of playlists) {
      await this.openai.verifyList(playlist.userId, playlist.playlistId);
    }
  }

  private async createSiteMap(): Promise<void> {
    // Get featured playlists with non-empty slugs
    const featuredPlaylists = await this.prisma.playlist.findMany({
      where: {
        featured: true,
        slug: {
          not: '',
        },
      },
      select: {
        slug: true,
        updatedAt: true,
      },
    });

    const paths = [
      { loc: '/', lastmod: '2024-09-16', changefreq: 'daily', priority: '1.0' },
      {
        loc: '/faq',
        lastmod: '2024-09-15',
        changefreq: 'monthly',
        priority: '0.8',
      },
      {
        loc: '/pricing',
        lastmod: '2024-09-15',
        changefreq: 'monthly',
        priority: '0.8',
      },
      {
        loc: '/generate',
        lastmod: '2024-09-15',
        changefreq: 'monthly',
        priority: '0.8',
      },
      {
        loc: '/contact',
        lastmod: '2024-09-15',
        changefreq: 'monthly',
        priority: '0.8',
      },
      // Add product pages for featured playlists
      ...featuredPlaylists.map((playlist) => ({
        loc: `/product/${playlist.slug}`,
        lastmod: playlist.updatedAt.toISOString().split('T')[0],
        changefreq: 'daily',
        priority: '0.9',
      })),
    ];

    const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${paths
    .map(
      (path) => `
  <url>
    <loc>${process.env['FRONTEND_URI']}${path.loc}</loc>
    <lastmod>${path.lastmod}</lastmod>
    <changefreq>${path.changefreq}</changefreq>
    <priority>${path.priority}</priority>
  </url>`
    )
    .join('')}
</urlset>`;

    const sitemapPath = path.join(
      process.env['FRONTEND_ROOT']!,
      '/sitemap.xml'
    );

    await fs.writeFile(sitemapPath, sitemapContent, 'utf8');
  }

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
        php.filenameDigitalDoubleSided,
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

  public async getLastPlays(): Promise<any[]> {
    const ipInfoListKey = 'ipInfoList';
    const ipInfoList = await this.cache.executeCommand(
      'lrange',
      ipInfoListKey,
      0,
      -1
    );

    const trackIds = ipInfoList
      .map((ipInfoJson: any) => {
        const ipInfo = JSON.parse(ipInfoJson);
        return parseInt(ipInfo.trackId);
      })
      .filter((trackId: number) => !isNaN(trackId));

    const tracks = await this.prisma.track.findMany({
      where: { id: { in: trackIds } },
      select: { id: true, name: true, artist: true },
    });

    const trackMap = new Map(tracks.map((track) => [track.id, track]));

    const lastPlays = ipInfoList
      .map((ipInfoJson: any) => {
        const ipInfo = JSON.parse(ipInfoJson);
        const track = trackMap.get(parseInt(ipInfo.trackId));

        if (track) {
          return {
            title: track.name,
            artist: track.artist,
            city: ipInfo.city,
            region: ipInfo.region,
            country: ipInfo.country,
            latitude: ipInfo.latitude,
            longitude: ipInfo.longitude,
            timestamp: ipInfo.timestamp,
          };
        }
      })
      .filter(Boolean);

    return lastPlays;
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
      // Update the display name. Since they might have been created with a temporary name in the newsletter
      await this.prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          displayName: userParams.displayName,
        },
      });
      userDatabaseId = user.id;
    }
    return userDatabaseId;
  }

  public async getPlaylistsByPaymentId(
    paymentId: string,
    playlistId: string | null = null
  ): Promise<any[]> {
    let query = `
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
        payment_has_playlist.emoji,
        payment_has_playlist.doubleSided,
        payment_has_playlist.eco,
        playlists.numberOfTracks,
        payment_has_playlist.type AS orderType
      FROM 
        payment_has_playlist
      INNER JOIN 
        playlists ON payment_has_playlist.playlistId = playlists.id
      INNER JOIN 
        payments ON payment_has_playlist.paymentId = payments.id
      WHERE 
        payments.paymentId = ?`;

    const params: any[] = [paymentId];

    if (playlistId) {
      query += ` AND playlists.playlistId = ?`;
      params.push(playlistId);
    }

    const playlists = await this.prisma.$queryRawUnsafe<any[]>(
      query,
      ...params
    );

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
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cacheKey = `featuredPlaylists_${today}_${locale}`;
    const cachedPlaylists = await this.cache.get(cacheKey);

    //test
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
        playlists.slug,
        playlists.image,
        playlists.price,
        playlists.numberOfTracks,
        playlists.featuredLocale,
        playlists.decadePercentage2020,
        playlists.decadePercentage2010,
        playlists.decadePercentage2000,
        playlists.decadePercentage1990,
        playlists.decadePercentage1980,
        playlists.decadePercentage1970,
        playlists.decadePercentage1960,
        playlists.decadePercentage1950,
        playlists.decadePercentage1900,
        playlists.decadePercentage0
      FROM 
        playlists
      WHERE 
        playlists.featured = 1
    `;

      // Add locale condition
      if (locale) {
        query += ` AND (FIND_IN_SET('${locale}', playlists.featuredLocale) > 0 OR playlists.featuredLocale IS NULL)`;
      } else {
        query += ` AND playlists.featuredLocale IS NULL`;
      }

      // Add ordering if locale is provided
      if (locale) {
        query += `
        ORDER BY 
          CASE 
            WHEN FIND_IN_SET('${locale}', playlists.featuredLocale) > 0 THEN 0 
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

      let usePlaylistId = cartItem.playlistId;
      if (cartItem.isSlug) {
        const dbPlaylist = await this.prisma.playlist.findFirst({
          where: { slug: cartItem.playlistId },
        });
        usePlaylistId = dbPlaylist!.playlistId;
      }

      // Check if the playlist exists. If not, create it
      const playlist = await this.prisma.playlist.findUnique({
        where: {
          playlistId: usePlaylistId,
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

        const slug = slugify(cartItem.playlistName, {
          lower: true,
          strict: true,
        });

        const playlistCreate = await this.prisma.playlist.create({
          data: {
            playlistId: usePlaylistId,
            name: cartItem.playlistName,
            slug,
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
                    payments.housenumber,
                    payments.city,
                    payments.zipcode,
                    payments.countryCode,
                    payments.status,
                    payments.differentInvoiceAddress,
                    payments.invoiceAddress,
                    payments.invoiceHousenumber,
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

  public async getTracks(playlistId: number, userId: number): Promise<any> {
    const tracks = await this.prisma.$queryRaw`
        SELECT      tracks.id, 
                   tracks.trackId, 
                   tracks.artist, 
                   tracks.year, 
                   tracks.name,
                   tei.extraNameAttribute,
                   tei.extraArtistAttribute
        FROM       tracks
        INNER JOIN playlist_has_tracks ON tracks.id = playlist_has_tracks.trackId
        LEFT JOIN  trackextrainfo tei ON tei.trackId = tracks.id AND tei.playlistId = ${playlistId}
        WHERE      playlist_has_tracks.playlistId = ${playlistId}`;

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

  public async getFirstUncheckedTrack(): Promise<{
    track: any;
    totalUnchecked: number;
  }> {
    const [track, totalCount] = await Promise.all([
      this.prisma.track.findFirst({
        where: {
          manuallyChecked: false,
          year: {
            gt: 0,
          },
        },
        select: {
          id: true,
          name: true,
          spotifyLink: true,
          artist: true,
          year: true,
          yearSource: true,
          certainty: true,
          reasoning: true,
          spotifyYear: true,
          discogsYear: true,
          aiYear: true,
          musicBrainzYear: true,
          openPerplexYear: true,
          standardDeviation: true,
          googleResults: true,
        },
        orderBy: {
          id: 'asc',
        },
      }),
      this.prisma.track.count({
        where: {
          manuallyChecked: false,
          year: {
            gt: 0,
          },
        },
      }),
    ]);

    return {
      track,
      totalUnchecked: totalCount,
    };
  }

  public async updateTrackCheck(
    trackId: number,
    year: number
  ): Promise<{ success: boolean; checkedPaymentIds?: string[] }> {
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

      const checkedPaymentIds = await this.checkUnfinalizedPayments();

      return {
        success: true,
        checkedPaymentIds,
      };
    } catch (error) {
      return {
        success: false,
      };
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

  private async findAndUpdateTrackByISRC(
    isrc: string,
    trackId: number
  ): Promise<{ wasUpdated: boolean; method: string }> {
    if (!isrc) return { wasUpdated: false, method: '' };

    // First try finding a track with matching ISRC
    const existingTrackByISRC = await this.prisma.track.findFirst({
      where: {
        isrc: isrc,
        year: {
          not: null,
        },
        manuallyChecked: true,
      },
      select: {
        id: true,
        year: true,
        yearSource: true,
        certainty: true,
        reasoning: true,
      },
    });

    if (existingTrackByISRC) {
      await this.prisma.track.update({
        where: { id: trackId },
        data: {
          year: existingTrackByISRC.year,
          yearSource: 'otherTrack_' + existingTrackByISRC.yearSource,
          certainty: existingTrackByISRC.certainty,
          reasoning: existingTrackByISRC.reasoning,
          manuallyChecked: true,
        },
      });
      return { wasUpdated: true, method: 'isrc' };
    }

    // If no ISRC match, try finding tracks with matching artist and title
    const currentTrack = await this.prisma.track.findUnique({
      where: { id: trackId },
      select: { artist: true, name: true },
    });

    if (currentTrack) {
      const existingTracksByMetadata = await this.prisma.track.findMany({
        where: {
          artist: currentTrack.artist,
          name: currentTrack.name,
          year: {
            not: null,
          },
          manuallyChecked: true,
          id: {
            not: trackId, // Exclude the current track
          },
        },
        select: {
          id: true,
          artist: true,
          name: true,
          year: true,
          yearSource: true,
          certainty: true,
          reasoning: true,
        },
      });

      if (existingTracksByMetadata.length === 1) {
        // If only one match found, use it
        const track = existingTracksByMetadata[0];
        await this.prisma.track.update({
          where: { id: trackId },
          data: {
            year: track.year,
            yearSource: 'otherTrack_metadata_' + track.yearSource,
            certainty: track.certainty,
            reasoning: track.reasoning,
            manuallyChecked: true,
          },
        });
        return { wasUpdated: true, method: 'artistTitle' };
      } else if (existingTracksByMetadata.length > 1) {
        // Check if all matches have the same year
        const years = new Set(existingTracksByMetadata.map((t) => t.year));
        if (years.size === 1) {
          // All matches have the same year, use the first one
          const track = existingTracksByMetadata[0];
          await this.prisma.track.update({
            where: { id: trackId },
            data: {
              year: track.year,
              yearSource: 'otherTrack_metadata_multiple_' + track.yearSource,
              certainty: track.certainty,
              reasoning: track.reasoning,
              manuallyChecked: true,
            },
          });
          return { wasUpdated: true, method: 'artistTitle_multiple' };
        } else {
          // Multiple matches with different years - don't update but notify
          const firstTrack = existingTracksByMetadata[0];
          this.logger.log(
            color.yellow.bold(
              `Same track with different years found (${color.white.bold(
                firstTrack.artist
              )} - ${color.white.bold(firstTrack.name)}).`
            )
          );
          console.log(existingTracksByMetadata);
        }
      }
    }

    return { wasUpdated: false, method: '' };
  }

  public async logLink(trackId: number, clientIp: string): Promise<void> {
    const ipInfo = await this.utils.lookupIp(clientIp);
    const ipInfoWithTrackId = {
      ...ipInfo,
      trackId,
      timestamp: new Date().toISOString(),
    };
    // Store the IP info in a list and maintain only the last 100 entries
    const ipInfoListKey = 'ipInfoList';
    await this.cache.executeCommand(
      'lpush',
      ipInfoListKey,
      JSON.stringify(ipInfoWithTrackId)
    );
    await this.cache.executeCommand('ltrim', ipInfoListKey, 0, 999); // Keep only the last 100 entries
  }

  public async getLink(trackId: number, clientIp: string): Promise<ApiResult> {
    this.analytics.increaseCounter('songs', 'played');
    this.logLink(trackId, clientIp);

    const cacheKey = `track_links:${trackId}`;
    const cachedData = await this.cache.get(cacheKey);

    if (cachedData) {
      return {
        success: true,
        data: JSON.parse(cachedData),
      };
    }

    const linkQuery: any[] = await this.prisma.$queryRaw`
      SELECT spotifyLink, youtubeLink
      FROM tracks
      WHERE id = ${trackId}`;

    if (linkQuery.length > 0) {
      const data = {
        link: linkQuery[0].spotifyLink,
        youtubeLink: linkQuery[0].youtubeLink,
      };

      if (data.link) {
        await this.cache.set(cacheKey, JSON.stringify(data));
        return {
          success: true,
          data,
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
        album: true,
        preview: true,
        manuallyCorrected: true,
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
          existingTrack.album !== this.utils.cleanTrackName(track.album) ||
          existingTrack.preview !== track.preview ||
          existingTrack.artist !== track.artist ||
          existingTrack.spotifyLink !== track.link
        ) {
          if (!existingTrack.manuallyCorrected) {
            tracksToUpdate.push(track);
          }
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
      // First create the tracks
      await this.prisma.track.createMany({
        data: newTracks.map((track) => ({
          trackId: track.id,
          name: this.utils.cleanTrackName(track.name),
          isrc: track.isrc,
          artist: track.artist,
          spotifyLink: track.link,
          album: this.utils.cleanTrackName(track.album),
          preview: track.preview,
        })),
        skipDuplicates: true,
      });

      // Then get YouTube links for all new tracks
      for (const track of newTracks) {
        const ytMusicUrl = await this.getYouTubeLink(track.artist, track.name);
        if (ytMusicUrl) {
          await this.prisma.track.update({
            where: { trackId: track.id },
            data: { youtubeLink: ytMusicUrl },
          });
        }
      }
    }

    this.logger.log(
      color.blue.bold(
        `Updating tracks: ${color.white.bold(tracksToUpdate.length)}`
      )
    );

    // Update existing tracks
    for (const track of tracksToUpdate) {
      if (!track.manuallyCorrected) {
        const existingTrack = await this.prisma.track.findUnique({
          where: { trackId: track.id },
          select: { youtubeLink: true },
        });

        const updateData: any = {
          name: this.utils.cleanTrackName(track.name),
          isrc: track.isrc,
          artist: track.artist,
          spotifyLink: track.link,
          album: this.utils.cleanTrackName(track.album),
          preview: track.preview,
        };

        // Only get YouTube link if it doesn't exist yet
        if (!existingTrack?.youtubeLink) {
          const ytMusicUrl = await this.getYouTubeLink(
            track.artist,
            track.name
          );
          if (ytMusicUrl) {
            updateData.youtubeLink = ytMusicUrl;
          }
        }

        await this.prisma.track.update({
          where: { trackId: track.id },
          data: updateData,
        });
      }
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
      WHERE year IS NULL AND trackId IN (${Prisma.join(providedTrackIds)})
    `;

    this.logger.log(
      color.blue.bold(
        `Updating years for playlist ${color.white.bold(playlistId)}`
      )
    );

    // Update years for tracks
    for (const track of tracksNeedingYearUpdate) {
      // Check for existing track with same ISRC and update if found
      const { wasUpdated, method } = await this.findAndUpdateTrackByISRC(
        track.isrc ?? '',
        track.id
      );
      if (wasUpdated) {
        if (method == 'isrc') {
          this.logger.log(
            color.blue.bold(
              `Updated year for track '${color.white.bold(
                track.artist
              )} - ${color.white.bold(
                track.name
              )}' using data from another track with matching ISRC`
            )
          );
        } else {
          this.logger.log(
            color.blue.bold(
              `Updated year for track '${color.white.bold(
                track.artist
              )} - ${color.white.bold(
                track.name
              )}' using data from another track with matching artist and title`
            )
          );
        }
        continue;
      }

      let spotifyYear = 0;
      const spotifyTrack = tracks.find((t: any) => t.id === track.trackId);
      if (spotifyTrack && spotifyTrack.releaseDate) {
        spotifyYear = parseInt(spotifyTrack.releaseDate.split('-')[0]);
      }

      const result = await this.music.getReleaseDate(
        track.id,
        track.isrc ?? '',
        track.artist,
        track.name,
        spotifyYear
      );

      await this.prisma.$executeRaw`
          UPDATE  tracks
          SET     year = ${result.year},
                  spotifyYear = ${result.sources.spotify},
                  discogsYear = ${result.sources.discogs},
                  aiYear = ${result.sources.ai},
                  musicBrainzYear = ${result.sources.mb},
                  openPerplexYear = ${result.sources.openPerplex},
                  googleResults = ${result.googleResults},
                  standardDeviation = ${result.standardDeviation}
          WHERE   id = ${track.id}`;

      if (result.standardDeviation <= 1) {
        // Update the year with perplexYear and set manuallyChecked to true
        await this.prisma.$executeRaw`
            UPDATE  tracks
            SET     manuallyChecked = true
            WHERE   id = ${track.id}
          `;

        this.logger.log(
          color.green.bold(
            `Determined final year for named '${color.white.bold(
              track.artist
            )} - ${color.white.bold(track.name)}' with year ${color.white.bold(
              result.year
            )}`
          )
        );
      }
    }
  }

  public async areAllTracksManuallyChecked(
    paymentId: string
  ): Promise<boolean> {
    const result = await this.prisma.$queryRaw<[{ uncheckedCount: bigint }]>`
      SELECT COUNT(*) as uncheckedCount
      FROM payments p
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
      JOIN tracks t ON t.id = pht.trackId
      WHERE p.paymentId = ${paymentId}
      AND t.manuallyChecked = false
    `;

    this.logger.log(
      color.blue.bold(
        `Payment ${color.white.bold(paymentId)} has ${color.white.bold(
          result[0].uncheckedCount
        )} unchecked tracks`
      )
    );

    const uncheckedCount = Number(result[0].uncheckedCount);
    const allChecked = uncheckedCount === 0;

    return allChecked;
  }

  public async checkUnfinalizedPayments(): Promise<string[]> {
    const unfinalizedPayments = await this.prisma.payment.findMany({
      where: {
        finalized: false,
        status: 'paid',
      },
      select: {
        id: true,
        paymentId: true,
      },
    });

    this.logger.log(
      color.blue.bold(
        `Found ${color.white.bold(
          unfinalizedPayments.length
        )} unfinalized payments`
      )
    );

    const checkedPaymentIds: string[] = [];

    for (const payment of unfinalizedPayments) {
      const allChecked = await this.areAllTracksManuallyChecked(
        payment.paymentId
      );

      if (allChecked) {
        checkedPaymentIds.push(payment.paymentId);
        this.logger.log(
          color.green.bold(
            `Payment ${color.white.bold(
              payment.paymentId
            )} has all tracks manually checked`
          )
        );
      }
    }

    this.logger.log(
      color.blue.bold(
        `Found ${color.white.bold(
          checkedPaymentIds.length
        )} payments with all tracks checked`
      )
    );

    // Get all the playlist IDs (The real spotify one) for the checked payments
    const playlistIds = await this.prisma.$queryRaw<string[]>`
      SELECT pl.playlistId
      FROM payments p
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      WHERE p.paymentId IN (${Prisma.join(checkedPaymentIds)})
    `;

    // Clear cache for each playlist
    for (const playlistId of playlistIds) {
      await this.cache.del('tracks_' + playlistId);
      await this.cache.del('trackcount_' + playlistId);
    }

    return checkedPaymentIds;
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
            // First get the track to find its ISRC
            const track = await this.prisma.track.findUnique({
              where: { id: trackId },
              select: { isrc: true },
            });

            // // Update the original track
            await this.prisma.track.update({
              where: { id: trackId },
              data: {
                year: newYear,
                yearSource: 'manual',
                manuallyChecked: true,
              },
            });

            // Update all other tracks with matching ISRC
            await this.prisma.track.updateMany({
              where: {
                isrc: track!.isrc,
                id: { not: trackId }, // Exclude the original track
              },
              data: {
                year: newYear,
                yearSource: 'manual_other',
                manuallyChecked: true,
              },
            });

            // Get count of updated tracks
            const updatedCount = await this.prisma.track.count({
              where: {
                isrc: track!.isrc,
                id: { not: trackId },
              },
            });
          }
        }
      }
    } catch (error) {
      this.logger.log(`Error reading Excel file: ${error}`);
    }
  }
  public async searchTracks(searchTerm: string): Promise<any[]> {
    const tracks = await this.prisma.$queryRaw<any[]>`
      SELECT id, artist, name, year 
      FROM tracks 
      WHERE LOWER(artist) LIKE LOWER(${`%${searchTerm}%`})
      OR LOWER(name) LIKE LOWER(${`%${searchTerm}%`})
      LIMIT 25
    `;
    return tracks;
  }

  public async updateTrack(
    id: number,
    artist: string,
    name: string,
    year: number
  ): Promise<boolean> {
    try {
      await this.prisma.track.update({
        where: { id },
        data: {
          artist,
          name,
          year,
          manuallyCorrected: true,
        },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  public static getInstance(): Data {
    if (!Data.instance) {
      Data.instance = new Data();
    }
    return Data.instance;
  }
}

export default Data;
