import { Track } from './interfaces/Track';
import { color } from 'console-log-colors';
import Logger from './logger';
import { Prisma, genre as GenrePrismaModel } from '@prisma/client';
import slugify from 'slugify';
import PrismaInstance from './prisma';
import crypto from 'crypto';
import { CronJob } from 'cron';
import { ApiResult } from './interfaces/ApiResult';
import { promises as fs } from 'fs';
import path from 'path';
import spotifyToYTMusic from 'spotify-to-ytmusic';

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
import cluster from 'cluster';
import { Music } from './music';
import PushoverClient from './pushover';
import { ChatGPT } from './chatgpt';
import YTMusic from 'ytmusic-api';
import axios, { AxiosInstance } from 'axios';
import Spotify from './spotify';

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
  private axiosInstance: AxiosInstance;

  private ytmusic: YTMusic;

  public async getYouTubeLink(
    artist: string,
    name: string
  ): Promise<string | null> {
    return null;
    try {
      // First try YouTube Music API
      const ytMusicOptions = {
        method: 'GET',
        url: 'https://youtube-music-api-yt.p.rapidapi.com/search-songs',
        params: {
          q: `${artist} ${name}`,
        },
        headers: {
          'x-rapidapi-key': process.env['RAPID_API_KEY'],
          'x-rapidapi-host': 'youtube-music-api-yt.p.rapidapi.com',
        },
      };

      const ytMusicResponse = await this.axiosInstance.request(ytMusicOptions);

      if (ytMusicResponse.data && ytMusicResponse.data.length > 0) {
        // Try to find exact match with artist and title
        const matchingVideo = ytMusicResponse.data.find((video: any) => {
          const videoArtist = video.artist?.name?.toLowerCase() || '';
          const videoTitle = video.name?.toLowerCase() || '';
          return (
            videoArtist.includes(artist.toLowerCase()) &&
            videoTitle.includes(name.toLowerCase())
          );
        });

        if (matchingVideo) {
          this.logger.log(
            color.blue.bold(
              `Found YouTube Music link for '${color.white.bold(
                artist
              )} - ${color.white.bold(
                name
              )}' using YT Music API: ${color.white.bold(
                'https://music.youtube.com/watch?v=' + matchingVideo.videoId
              )}`
            )
          );
          return matchingVideo.videoId;
        }
      }

      // Fall back to original search if no match found
      const searchOptions = {
        method: 'GET',
        url: 'https://yt-search-and-download-mp3.p.rapidapi.com/search',
        params: {
          q: `${artist} - ${name}`,
          limit: 10,
        },
        headers: {
          'x-rapidapi-key': process.env['RAPID_API_KEY'],
          'x-rapidapi-host': 'yt-search-and-download-mp3.p.rapidapi.com',
        },
      };

      const response = await this.axiosInstance.request(searchOptions);

      if (
        response.data &&
        response.data.videos &&
        response.data.videos.length > 0
      ) {
        // Find first video where both artist and name appear in the video title
        const matchingVideo = response.data.videos.find(
          (video: any) =>
            video.name.toLowerCase().includes(artist.toLowerCase()) &&
            video.name.toLowerCase().includes(name.toLowerCase())
        );

        if (matchingVideo) {
          this.logger.log(
            color.blue.bold(
              `Found YouTube Movie link for '${color.white.bold(
                artist
              )} - ${color.white.bold(name)}': ${color.white.bold(
                'https://music.youtube.com/watch?v=' + matchingVideo.id
              )}`
            )
          );
          return matchingVideo.id;
        } else {
          this.logger.log(
            color.yellow.bold(
              `No exact match found for '${color.white.bold(
                artist
              )} - ${color.white.bold(name)}'`
            )
          );
        }
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
    }
    return null;
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
        const youtubeId = await this.getYouTubeLink(track.artist, track.name);

        if (youtubeId) {
          await this.prisma.track.update({
            where: { id: track.id },
            data: { youtubeLink: youtubeId },
          });
          processed++;
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
    this.axiosInstance = axios.create();
    // ... rest of constructor
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.createSiteMap();
          await this.prefillLinkCache();
          // Schedule hourly cache refresh
          const job = new CronJob('0 * * * *', async () => {
            await this.prefillLinkCache();
          });
          const genreJob = new CronJob('30 1 * * *', async () => {
            await this.translateGenres();
          });
          job.start();
          genreJob.start();
        }
      });
    }
  }

  private async prefillLinkCache(): Promise<void> {
    const tracks = await this.prisma.track.findMany({
      select: {
        id: true,
        spotifyLink: true,
        youtubeLink: true,
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
        const data = {
          link: track.spotifyLink,
          youtubeLink: track.youtubeLink,
        };
        await this.cache.set(`track_links:${track.id}`, JSON.stringify(data));
        cacheCount++;
      }
    }
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
    // Get all available locales from Translation class
    const locales = this.translate.allLocales;

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

    // Get active blogs with non-empty slugs for all locales
    const activeBlogs = await this.prisma.blog.findMany({
      where: {
        active: true,
        OR: locales.map((locale) => ({
          [`slug_${locale}`]: {
            not: null,
          },
        })),
      },
      select: {
        ...Object.fromEntries(
          locales.map((locale) => [`slug_${locale}`, true])
        ),
        updatedAt: true,
      },
    });

    // Define standard paths with default values
    const standardPaths = [
      '/faq',
      '/pricing',
      '/reviews',
      '/giftcard',
      '/examples',
      '/generate/playlist',
      '/contact',
      '/privacy-policy',
      '/terms-and-conditions',
      '/playlists',
    ];

    // Get current date in YYYY-MM-DD format for lastmod
    const currentDate = new Date().toISOString().split('T')[0];

    // Create sitemap index file that references language-specific sitemaps
    const sitemapIndexContent = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${locales
    .map(
      (locale) => `
  <sitemap>
    <loc>${process.env['FRONTEND_URI']}/sitemap_${locale}.xml</loc>
    <lastmod>${currentDate}</lastmod>
  </sitemap>`
    )
    .join('')}
</sitemapindex>`;

    const sitemapIndexPath = path.join(
      process.env['FRONTEND_ROOT']!,
      '/sitemap.xml'
    );

    await fs.writeFile(sitemapIndexPath, sitemapIndexContent, 'utf8');

    // Create language-specific sitemaps
    for (const locale of locales) {
      // Create paths with default properties for this locale
      const paths = [
        // Homepage has special properties
        {
          loc: `/${locale}`,
          lastmod: currentDate,
          changefreq: 'daily',
          priority: '1.0',
        },
        // Standard pages with common properties
        ...standardPaths.map((pagePath) => ({
          loc: `/${locale}${pagePath}`,
          lastmod: currentDate,
          changefreq: 'monthly',
          priority: '0.8',
        })),
        // Add product pages for featured playlists
        ...featuredPlaylists.map((playlist) => ({
          loc: `/${locale}/product/${playlist.slug}`,
          lastmod: playlist.updatedAt.toISOString().split('T')[0],
          changefreq: 'daily',
          priority: '0.9',
        })),
        // Add blog pages for this locale
        ...activeBlogs
          .filter((blog) => blog[`slug_${locale}` as keyof typeof blog])
          .map((blog) => ({
            loc: `/${locale}/blog/${
              blog[`slug_${locale}` as keyof typeof blog]
            }`,
            lastmod: blog.updatedAt.toISOString().split('T')[0],
            changefreq: 'weekly',
            priority: '0.7',
          })),
      ];

      const localeSitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
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

      const localeSitemapPath = path.join(
        process.env['FRONTEND_ROOT']!,
        `/sitemap_${locale}.xml`
      );

      await fs.writeFile(localeSitemapPath, localeSitemapContent, 'utf8');
    }

    this.logger.log(
      color.blue.bold(
        `Generated sitemap index with ${color.white.bold(
          locales.length
        )} language-specific sitemaps`
      )
    );
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

    const phpIds = ipInfoList
      .map((ipInfoJson: any) => {
        const ipInfo = JSON.parse(ipInfoJson);
        return ipInfo.php ? parseInt(ipInfo.php) : null;
      })
      .filter((phpId: number | null) => phpId !== null);

    // Fetch tracks
    const tracks = await this.prisma.track.findMany({
      where: { id: { in: trackIds } },
      select: { id: true, name: true, artist: true },
    });

    // Fetch payment_has_playlist data with playlist names and user display names in a single query
    const phpData =
      phpIds.length > 0
        ? await this.prisma.paymentHasPlaylist.findMany({
            where: { id: { in: phpIds } },
            select: {
              id: true,
              playlist: {
                select: {
                  name: true,
                },
              },
              payment: {
                select: {
                  user: {
                    select: {
                      displayName: true,
                    },
                  },
                },
              },
            },
          })
        : [];

    const trackMap = new Map(tracks.map((track) => [track.id, track]));
    const phpMap = new Map(phpData.map((php) => [php.id, php]));

    const lastPlays = ipInfoList
      .map((ipInfoJson: any) => {
        const ipInfo = JSON.parse(ipInfoJson);
        const track = trackMap.get(parseInt(ipInfo.trackId));

        if (track) {
          const result: any = {
            title: track.name,
            artist: track.artist,
            city: ipInfo.city,
            region: ipInfo.region,
            country: ipInfo.country,
            latitude: ipInfo.latitude,
            longitude: ipInfo.longitude,
            timestamp: ipInfo.timestamp,
          };

          // Add playlist and user info if php is available
          if (ipInfo.php) {
            const phpInfo = phpMap.get(parseInt(ipInfo.php));
            if (phpInfo) {
              result.playlistName = phpInfo.playlist.name;
              result.displayName = phpInfo.payment.user?.displayName || null;
            }
          }

          return result;
        }
      })
      .filter(Boolean);

    return lastPlays;
  }

  public euCountryCodes: string[] = [
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
          locale: userParams.locale,
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
        payment_has_playlist.background,
        payment_has_playlist.logo,
        payment_has_playlist.doubleSided,
        payment_has_playlist.eco,
        payment_has_playlist.qrColor,
        payment_has_playlist.hideCircle,
        payment_has_playlist.hideDomain,
        payment_has_playlist.subType,
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

    // Check if locale is valid, otherwise default to English
    if (!this.translate.isValidLocale(locale)) {
      locale = 'en';
    }

    const cacheKey = `featuredPlaylists_${today}_${locale}`;
    const cachedPlaylists = await this.cache.get(cacheKey);

    if (!cachedPlaylists) {
      // Base query
      let query = `
      SELECT 
        playlists.id,
        playlists.playlistId,
        playlists.name,
        playlists.slug,
        playlists.image,
        playlists.score,
        playlists.price,
        playlists.priceDigital,
        playlists.priceSheets,
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
        playlists.decadePercentage0,
        playlists.genreId,
        playlists.description_${locale} as description,
        g.name_${locale} as genreName
      FROM 
        playlists
      LEFT JOIN
        genres g ON playlists.genreId = g.id
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
        ORDER BY score DESC
      `;
      }

      returnList = await this.prisma.$queryRawUnsafe(query);

      returnList = returnList.map((playlist) => {
        // Ensure description is available, fallback to English if not
        if (!playlist.description && locale !== 'en') {
          const descriptionField = `description_en`;
          playlist.description = playlist[descriptionField];
        }

        // Ensure genre name is available, fallback to English if not
        if (!playlist.genreName && playlist.genreId && locale !== 'en') {
          // We'll need to fetch this separately since we're already in the map function
          // This is a fallback scenario
          playlist.genreName = playlist.genreName || 'Unknown';
        }

        return {
          ...playlist,
        };
      });

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
                    payment_has_playlist.subType,
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

  public async getTracks(playlistId: number, userId: number = 0): Promise<any> {
    // Note: COALESCE(NULLIF(tei.column, ''), tracks.column) is used for string fields
    // to handle cases where extra info might be an empty string instead of NULL.
    // For numeric fields like year, COALESCE(tei.year, tracks.year) is sufficient.
    const tracks = await this.prisma.$queryRaw`
        SELECT
            tracks.id,
            tracks.trackId,
            COALESCE(NULLIF(tei.artist, ''), tracks.artist) as artist,
            COALESCE(tei.year, tracks.year) as year,
            COALESCE(NULLIF(tei.name, ''), tracks.name) as name,
            tei.extraNameAttribute,
            tei.extraArtistAttribute,
            (
                SELECT php.id
                FROM payment_has_playlist php
                INNER JOIN payments p ON php.paymentId = p.id
                WHERE
                    php.playlistId = playlist_has_tracks.playlistId
                    AND (${userId} > 0 AND p.userId = ${userId} OR ${userId} = 0)
                LIMIT 1
            ) as paymentHasPlaylistId
        FROM tracks
        INNER JOIN playlist_has_tracks ON tracks.id = playlist_has_tracks.trackId
        LEFT JOIN trackextrainfo tei ON tei.trackId = tracks.id AND tei.playlistId = ${playlistId}
        WHERE playlist_has_tracks.playlistId = ${playlistId}`;

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
    // Use a single optimized query to get both the track and count
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT 
        (SELECT COUNT(*) FROM tracks WHERE manuallyChecked = false AND year > 0) as totalUnchecked,
        t.id, t.name, t.spotifyLink, t.artist, t.year, t.yearSource, 
        t.certainty, t.reasoning, t.spotifyYear, t.discogsYear, t.aiYear, 
        t.musicBrainzYear, t.openPerplexYear, t.standardDeviation, t.googleResults
      FROM tracks t
      WHERE t.manuallyChecked = false AND t.year > 0
      ORDER BY t.id ASC
      LIMIT 1
    `;

    if (result.length === 0) {
      return { track: null, totalUnchecked: 0 };
    }

    const { totalUnchecked, ...track } = result[0];
    return {
      track,
      totalUnchecked: Number(totalUnchecked),
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

  public async logLink(
    trackId: number,
    clientIp: string,
    php?: number
  ): Promise<void> {
    const ipInfo = await this.utils.lookupIp(clientIp);
    const ipInfoWithTrackId = {
      ...ipInfo,
      trackId,
      timestamp: new Date().toISOString(),
      php,
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

  /**
   * Get a link for a track, logging IP, trackId, and user agent.
   * @param trackId
   * @param clientIp
   * @param useCache
   * @param userAgent (optional) - pass user agent string if available
   */
  public async getLink(
    trackId: number,
    clientIp: string,
    useCache: boolean = true,
    userAgent?: string,
    php?: number
  ): Promise<ApiResult> {
    this.analytics.increaseCounter('songs', 'played');
    this.logLink(trackId, clientIp, php);

    // Log IP, trackId, and user agent
    this.logger.log(
      color.blue.bold(
        `Link called for track ${color.white.bold(
          trackId
        )} and, ip=${color.white.bold(clientIp)}, userAgent=${color.white.bold(
          userAgent || 'unknown'
        )}`
      )
    );

    const cacheKey = `track_links:${trackId}`;
    const cachedData = await this.cache.get(cacheKey);

    if (cachedData && useCache) {
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

      if (data.link && data.youtubeLink) {
        await this.cache.set(cacheKey, JSON.stringify(data));
      }

      if (!useCache) {
        this.logger.log(
          color.blue.bold(
            `Refreshed cache for track ${color.white.bold(
              trackId
            )}: ${color.white.bold(data.link)}`
          )
        );
      }

      return {
        success: true,
        data,
      };
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

      // Then get YouTube links for all new tracks (async, fire-and-forget for the whole loop)
      // (async () => {
      //   for (const track of newTracks) {
      //     try {
      //       const youtubeId = await this.getYouTubeLink(
      //         track.artist,
      //         track.name
      //       );
      //       if (youtubeId) {
      //         await this.prisma.track.update({
      //           where: { trackId: track.id },
      //           data: { youtubeLink: youtubeId },
      //         });
      //       }
      //     } catch (err) {
      //       this.logger.log(
      //         color.yellow.bold(
      //           `Failed to update YouTube link for track '${color.white.bold(
      //             track.artist
      //           )} - ${color.white.bold(track.name)}': ${err}`
      //         )
      //       );
      //     }
      //   }
      // })();
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
        // if (!existingTrack?.youtubeLink) {
        //   const ytMusicUrl = await this.getYouTubeLink(
        //     track.artist,
        //     track.name
        //   );
        //   if (ytMusicUrl) {
        //     updateData.youtubeLink = ytMusicUrl;
        //   }
        // }

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

    this.logger.log(
      color.blue.bold(
        `Updating years for playlist ${color.white.bold(playlistId)}`
      )
    );

    await this.updateTrackYear(providedTrackIds, tracks);
  }

  public async updateTrackYear(
    trackIds: string[],
    tracks: Track[]
  ): Promise<void> {
    // Maximum number of concurrent getReleaseDate calls
    const MAX_CONCURRENT_RELEASE_DATE = 2;

    // Fetch tracks that need year update
    const tracksNeedingYearUpdate = await this.prisma.$queryRaw<
      TrackNeedingYearUpdate[]
    >`
      SELECT id, isrc, trackId, name, artist
      FROM tracks
      WHERE year IS NULL AND trackId IN (${Prisma.join(trackIds)})
    `;

    let updateCounter = 1;

    // Helper to process a single track
    const processTrack = async (track: TrackNeedingYearUpdate) => {
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
              )}' using data from another track with matching ISRC (${color.white.bold(
                updateCounter
              )} / ${color.white.bold(tracksNeedingYearUpdate.length)})`
            )
          );
        } else {
          this.logger.log(
            color.blue.bold(
              `Updated year for track '${color.white.bold(
                track.artist
              )} - ${color.white.bold(
                track.name
              )}' using data from another track with matching artist and title (${color.white.bold(
                updateCounter
              )} / ${color.white.bold(tracksNeedingYearUpdate.length)})`
            )
          );
        }
        updateCounter++;
        return;
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
            )} (${color.white.bold(updateCounter)} / ${color.white.bold(
              tracksNeedingYearUpdate.length
            )})`
          )
        );
      } else {
        this.logger.log(
          color.yellow.bold(
            `Could not determine final year for named '${color.white.bold(
              track.artist
            )} - ${color.white.bold(track.name)}' with year ${color.white.bold(
              result.year
            )} (${color.white.bold(updateCounter)} / ${color.white.bold(
              tracksNeedingYearUpdate.length
            )})`
          )
        );
      }
      updateCounter++;
    };

    // Rolling concurrency implementation
    const queue = [...tracksNeedingYearUpdate];
    let inFlight = 0;
    let nextIndex = 0;

    return new Promise<void>((resolve, reject) => {
      if (queue.length === 0) {
        resolve();
        return;
      }

      const launchNext = () => {
        if (nextIndex >= queue.length && inFlight === 0) {
          resolve();
          return;
        }
        while (
          inFlight < MAX_CONCURRENT_RELEASE_DATE &&
          nextIndex < queue.length
        ) {
          const track = queue[nextIndex++];
          inFlight++;
          processTrack(track)
            .catch((err) => {
              this.logger.log(
                color.red.bold(
                  `Error updating year for track '${color.white.bold(
                    track.artist
                  )} - ${color.white.bold(track.name)}': ${err}`
                )
              );
            })
            .finally(() => {
              inFlight--;
              launchNext();
            });
        }
      };

      launchNext();
    });
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
      AND (t.manuallyChecked = false OR t.spotifyLink IS NULL)
    `;

    this.logger.log(
      color.blue.bold(
        `Payment ${color.white.bold(paymentId)} has ${color.white.bold(
          result[0].uncheckedCount
        )} unchecked tracks left`
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

  public async searchTracks(
    searchTerm: string,
    missingYouTubeLink: boolean = false
  ): Promise<any[]> {
    const tracks = await this.prisma.$queryRaw<any[]>`
      SELECT id, artist, name, year, youtubeLink, spotifyLink
      FROM tracks 
      WHERE (
        LOWER(artist) LIKE LOWER(${`%${searchTerm}%`})
        OR LOWER(name) LIKE LOWER(${`%${searchTerm}%`})
      )
      ${
        missingYouTubeLink
          ? Prisma.sql`AND (youtubeLink IS NULL OR youtubeLink = '')`
          : Prisma.sql``
      }
      LIMIT 10000
    `;
    return tracks;
  }

  public async updateTrack(
    id: number,
    artist: string,
    name: string,
    year: number,
    spotifyLink: string,
    youtubeLink: string,
    clientIp: string
  ): Promise<boolean> {
    try {
      await this.prisma.track.update({
        where: { id },
        data: {
          artist,
          name,
          year,
          spotifyLink,
          youtubeLink,
          manuallyCorrected: true,
        },
      });
      // Get the link again, but without the cache
      await this.getLink(id, clientIp, false);
      await this.checkUnfinalizedPayments();
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

  public async updatePaymentHasPlaylist(
    paymentHasPlaylistId: number,
    eco: boolean,
    doubleSided: boolean
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.prisma.paymentHasPlaylist.update({
        where: { id: paymentHasPlaylistId },
        data: {
          eco: eco,
          doubleSided: doubleSided,
        },
      });
      this.logger.log(
        color.blue.bold(
          `Updated playlist data for ${color.white.bold(paymentHasPlaylistId)}`
        )
      );
      return { success: true };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Error updating PaymentHasPlaylist ${color.white.bold(
            paymentHasPlaylistId
          )}: ${error.message}`
        )
      );
      return { success: false, error: error.message };
    }
  }

  public async translateGenres(): Promise<{
    processed: number;
    updated: number;
    errors: number;
  }> {
    this.logger.log(color.blue.bold('Starting genre translation process...'));
    const allLocales = new Translation().allLocales;
    const genres = await this.prisma.genre.findMany();

    let processedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    for (const genre of genres) {
      processedCount++;
      if (!genre.name_en || genre.name_en.trim() === '') {
        this.logger.log(
          color.yellow.bold(
            `Skipping genre ID ${genre.id} (${color.white.bold(
              genre.slug || 'no-slug'
            )}) as English name (name_en) is missing.`
          )
        );
        continue;
      }

      const localesToTranslate: string[] = [];
      const updateData: Prisma.genreUpdateInput = {};

      for (const locale of allLocales) {
        if (locale === 'en') continue; // Skip English itself

        const localeFieldName = `name_${locale}` as keyof GenrePrismaModel;
        // Check if the property exists on the genre object and if it's null or empty
        if (
          !(localeFieldName in genre) || // Property might not exist if schema changed
          (genre as any)[localeFieldName] === null ||
          ((genre as any)[localeFieldName] as string)?.trim() === ''
        ) {
          localesToTranslate.push(locale);
        }
      }

      if (localesToTranslate.length > 0) {
        this.logger.log(
          color.blue.bold(
            `Genre ID ${color.white.bold(genre.id)} ("${color.white.bold(
              genre.name_en
            )}") needs translation for: ${color.white.bold(
              localesToTranslate.join(', ')
            )}`
          )
        );
        try {
          const translations = await this.openai.translateGenreNames(
            genre.name_en,
            localesToTranslate
          );

          let translationsFound = false;
          for (const locale of localesToTranslate) {
            if (translations[locale] && translations[locale].trim() !== '') {
              const localeFieldName =
                `name_${locale}` as keyof Prisma.genreUpdateInput;
              (updateData as any)[localeFieldName] = translations[locale];
              translationsFound = true;
            } else {
              this.logger.log(
                color.yellow.bold(
                  `No valid translation received for genre ID ${color.white.bold(
                    genre.id
                  )} ("${color.white.bold(
                    genre.name_en
                  )}") in locale ${color.white.bold(locale)}.`
                )
              );
            }
          }

          if (translationsFound) {
            await this.prisma.genre.update({
              where: { id: genre.id },
              data: updateData,
            });
            updatedCount++;
            this.logger.log(
              color.blue.bold(
                `Successfully updated translations for genre ID ${color.white.bold(
                  genre.id
                )} ("${color.white.bold(genre.name_en)}").`
              )
            );
          }
        } catch (error) {
          errorCount++;
          this.logger.log(
            color.red.bold(
              `Error translating genre ID ${color.white.bold(
                genre.id
              )} ("${color.white.bold(genre.name_en)}"): ${
                (error as Error).message
              }`
            )
          );
          console.error(error);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        this.logger.log(
          color.blue.bold(
            `Genre ID ${color.white.bold(genre.id)} ("${color.white.bold(
              genre.name_en
            )}") is already fully translated.`
          )
        );
      }
    }

    this.logger.log(
      color.blue.bold(
        `Genre translation process finished. Processed: ${processedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`
      )
    );
    return {
      processed: processedCount,
      updated: updatedCount,
      errors: errorCount,
    };
  }
}

export default Data;
