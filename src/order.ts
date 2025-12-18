import Log from './logger';
import PrismaInstance from './prisma';
import Cache from './cache';
import { ApiResult } from './interfaces/ApiResult';
import cluster from 'cluster';
import Utils from './utils';
import { CronJob } from 'cron';
import { color, blue, white } from 'console-log-colors';
import fs from 'fs/promises';
import PrintEnBind from './printers/printenbind';
import Spotify from './spotify';
import { ChatGPT } from './chatgpt';
import Translation from './translation';
import PDF from './pdf';

interface PriceResult {
  totalPrice: number;
  pricePerCard: number;
  discountPercentage: number;
}

class Order {
  private static instance: Order;
  private prisma = PrismaInstance.getInstance();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private spotify = Spotify.getInstance();
  private logger = new Log();
  private printer = PrintEnBind.getInstance();

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.startCron();
        }
      });
    }
  }

  /**
   * Calculate Wilson score with time decay for a playlist
   * @param downloads Number of downloads
   * @param createdAt Date when the playlist was created
   * @returns Wilson score adjusted with time decay
   */
  private calculateWilsonScore(downloads: number, createdAt: Date): number {
    // Wilson score calculation parameters
    const z = 1.96; // 95% confidence
    const n = Math.max(downloads, 1); // Total number of downloads (minimum 1 to avoid division by zero)

    // Calculate time decay factor (1 year = ~365.25 days)
    const daysSinceCreation = Math.max(
      1,
      (new Date().getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const yearsElapsed = daysSinceCreation / 365.25;
    const decayFactor = Math.exp(-0.5 * yearsElapsed); // Exponential decay with half-life of 1 year

    // Wilson score calculation
    const phat = n / n; // For downloads, we consider all as positive (proportion = 1)
    const numerator =
      phat +
      (z * z) / (2 * n) -
      z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
    const denominator = 1 + (z * z) / n;
    const wilsonScore = numerator / denominator;

    // Apply time decay to the Wilson score
    const adjustedScore = wilsonScore * decayFactor * 100; // Scale to 0-100 range

    return Math.round(adjustedScore);
  }

  /**
   * Get the number of downloads for a playlist
   * @param playlistId The Spotify playlist ID
   * @returns Number of times the playlist was downloaded
   */
  private async getPlaylistDownloads(playlistId: string): Promise<number> {
    // Count the number of times this playlist appears in payment_has_playlist
    const count = await this.prisma.paymentHasPlaylist.count({
      where: {
        playlist: {
          playlistId: playlistId,
        },
        payment: {
          status: 'paid',
        },
      },
    });

    return count;
  }

  public async calculateDigitalCardPrice(
    basePrice: number,
    quantity: number
  ): Promise<PriceResult> {
    // Constants
    const BASE_PRICE_PER_CARD = basePrice / 500; // €0.026 per card
    const MIN_QUANTITY_FOR_DISCOUNT = 500;
    const MAX_DISCOUNT_QUANTITY = 2500;
    const MAX_DISCOUNT_PERCENTAGE = 0.5; // 30%

    // Calculate discount percentage
    let discountPercentage = 0;

    if (quantity > MIN_QUANTITY_FOR_DISCOUNT) {
      if (quantity >= MAX_DISCOUNT_QUANTITY) {
        discountPercentage = MAX_DISCOUNT_PERCENTAGE;
      } else {
        // Linear interpolation formula:
        // discount = (quantity - minQuantity) * (maxDiscount / (maxQuantity - minQuantity))
        discountPercentage =
          (quantity - MIN_QUANTITY_FOR_DISCOUNT) *
          (MAX_DISCOUNT_PERCENTAGE /
            (MAX_DISCOUNT_QUANTITY - MIN_QUANTITY_FOR_DISCOUNT));
      }
    }

    // Calculate final price
    const pricePerCard = BASE_PRICE_PER_CARD * (1 - discountPercentage);
    const totalPrice = quantity * pricePerCard;

    let roundedTotalPrice = Math.ceil(totalPrice);

    if (roundedTotalPrice < basePrice) {
      roundedTotalPrice = basePrice;
    }

    return {
      totalPrice: roundedTotalPrice,
      pricePerCard: Number(pricePerCard.toFixed(4)),
      discountPercentage: Number((discountPercentage * 100).toFixed(2)),
    };
  }

  public async processPrintApiWebhook(printApiOrderId: string) {
    await this.printer.processPrintApiWebhook(printApiOrderId);
  }

  public async getInvoice(invoiceId: string): Promise<string> {
    const pdfPath = `${process.env['PRIVATE_DIR']}/invoice/${invoiceId}.pdf`;

    try {
      // Check if invoice already exists
      await fs.access(pdfPath);
      this.logger.log(
        blue.bold(`Invoice already exists at: ${white.bold(pdfPath)}`)
      );
    } catch (error) {
      // Invoice doesn't exist, generate it on-demand
      this.logger.log(
        blue.bold(`Invoice not found, generating for: ${white.bold(invoiceId)}`)
      );

      // Fetch payment data
      const payment = await this.prisma.payment.findUnique({
        where: { paymentId: invoiceId },
      });

      if (!payment) {
        throw new Error('Payment not found');
      }

      // Generate invoice
      await this.createInvoice(payment);
    }

    return pdfPath;
  }

  public async updateFeaturedPlaylists(
    clientIp: string = '',
    userAgent: string = ''
  ): Promise<void> {
    this.logger.log(
      color.blue.bold(
        'Refreshing cache and updating featured playlists with decade percentages and descriptions'
      )
    );

    try {
      this.logger.log(color.blue.bold('Retrieving featured playlists from DB'));

      // Get all featured playlists
      const featuredPlaylists = await this.prisma.playlist.findMany({
        where: { featured: true },
        include: {
          tracks: {
            include: {
              track: true,
            },
          },
        },
      });

      this.logger.log(
        color.blue.bold(
          `Found ${color.white.bold(
            featuredPlaylists.length
          )} featured playlists`
        )
      );

      for (const playlist of featuredPlaylists) {
        this.logger.log(
          color.blue.bold(
            `Reloading playlist: ${color.white.bold(playlist.name)}`
          )
        );

        // Get fresh data from Spotify
        await this.spotify.getPlaylist(
          playlist.slug,
          false,
          '',
          false,
          true,
          true,
          'en',
          clientIp,
          userAgent
        );

        this.logger.log(
          color.blue.bold(
            `Reloading tracks for playlist: ${color.white.bold(playlist.name)}`
          )
        );

        await this.spotify.getTracks(
          playlist.slug,
          false,
          '',
          false,
          true,
          clientIp,
          userAgent
        );

        // Calculate decade percentages
        const tracks = playlist.tracks
          .map((pt) => pt.track)
          .filter((t) => t.year);
        const totalTracks = tracks.length;

        if (totalTracks > 0) {
          const decades = [
            2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950, 1900, 0,
          ];
          const decadeCounts = Object.fromEntries(decades.map((d) => [d, 0]));

          tracks.forEach((track) => {
            const year = track.year || 0;
            const decade = decades.find((d) => year >= d) || 0;
            decadeCounts[decade]++;
          });

          // Determine which languages need descriptions
          const languagesToGenerate = [];
          const translation = new Translation();
          const descriptionFields = translation.allLocales.map(
            (locale) => `description_${locale}`
          );

          for (const field of descriptionFields) {
            const lang = field.split('_')[1];
            if (!(playlist as any)[field] || (playlist as any)[field] === '') {
              languagesToGenerate.push(lang);
            }
          }

          // Only generate descriptions if there are missing languages
          if (languagesToGenerate.length > 0) {
            const trackData = playlist.tracks.map((pt) => ({
              artist: pt.track.artist,
              name: pt.track.name,
            }));

            this.logger.log(
              color.blue.bold(
                `Generating descriptions for playlist: ${color.white.bold(
                  playlist.name
                )} in languages: ${color.white.bold(
                  languagesToGenerate.join(', ')
                )}`
              )
            );

            // Reuse the same ChatGPT instance for both operations
            const openai = new ChatGPT();
            const descriptions = await openai.generatePlaylistDescription(
              playlist.name,
              trackData,
              languagesToGenerate
            );

            // Log the generated descriptions for each language
            for (const lang of languagesToGenerate) {
              const fieldName =
                `description_${lang}` as keyof typeof descriptions;
              if (descriptions[fieldName]) {
                this.logger.log(
                  color.magenta(
                    `Generated ${color.white.bold(
                      lang
                    )} description for ${color.white.bold(playlist.name)}`
                  )
                );
              }
            }

            // Get all available genres
            const availableGenres = await this.prisma.genre.findMany({
              select: {
                id: true,
                slug: true,
              },
            });

            // Determine genre for the playlist
            const genreId = await openai.determineGenre(
              playlist.name,
              trackData,
              availableGenres
            );

            // Prepare update data with decade percentages and genre if applicable
            const updateData: Record<string, number | string> = {
              ...Object.fromEntries(
                decades.map((decade) => [
                  `decadePercentage${decade}`,
                  Math.round((decadeCounts[decade] / totalTracks) * 100),
                ])
              ),
            };

            // Only set genreId if a clear match was found
            if (genreId !== null) {
              updateData.genreId = genreId;
            }

            // Add only the generated descriptions to the update data
            for (const lang of languagesToGenerate) {
              const fieldName =
                `description_${lang}` as keyof typeof descriptions;
              if (descriptions[fieldName]) {
                updateData[fieldName] = descriptions[fieldName];
              }
            }

            // Calculate prices for different product types
            const numberOfTracks = playlist.tracks.length;

            // Get order types for different product variants
            const cardsOrderType = await this.getOrderType(
              numberOfTracks,
              false,
              'cards',
              playlist.playlistId,
              'none'
            );
            const digitalOrderType = await this.getOrderType(
              numberOfTracks,
              true,
              'cards',
              playlist.playlistId,
              'none'
            );
            const sheetsOrderType = await this.getOrderType(
              numberOfTracks,
              false,
              'cards',
              playlist.playlistId,
              'sheets'
            );

            // Update prices in the updateData object
            if (cardsOrderType && cardsOrderType.price) {
              updateData.price = cardsOrderType.price;
            }

            if (digitalOrderType && digitalOrderType.price) {
              updateData.priceDigital = digitalOrderType.price;
            }

            if (sheetsOrderType && sheetsOrderType.price) {
              updateData.priceSheets = sheetsOrderType.price;
            }

            // Get download count and calculate Wilson score
            const downloads = await this.getPlaylistDownloads(
              playlist.playlistId
            );
            const wilsonScore = this.calculateWilsonScore(
              downloads,
              playlist.createdAt
            );

            // Add downloads and score to update data
            updateData.downloads = downloads;
            updateData.score = wilsonScore;

            // Update playlist with decade percentages, new descriptions, prices, downloads and Wilson score
            await this.prisma.playlist.update({
              where: { id: playlist.id },
              data: updateData,
            });

            this.logger.log(
              color.cyan(
                `Updated playlist ${white.bold(
                  playlist.name
                )} with ${white.bold(
                  downloads.toString()
                )} downloads and Wilson score of ${white.bold(
                  wilsonScore.toString()
                )}`
              )
            );
          } else {
            // Calculate prices for different product types
            const numberOfTracks = playlist.tracks.length;

            // Get order types for different product variants
            const cardsOrderType = await this.getOrderType(
              numberOfTracks,
              false,
              'cards',
              playlist.playlistId,
              'none'
            );
            const digitalOrderType = await this.getOrderType(
              numberOfTracks,
              true,
              'cards',
              playlist.playlistId,
              'none'
            );
            const sheetsOrderType = await this.getOrderType(
              numberOfTracks,
              false,
              'cards',
              playlist.playlistId,
              'sheets'
            );

            // Create update data with decade percentages
            const updateData = {
              ...Object.fromEntries(
                decades.map((decade) => [
                  `decadePercentage${decade}`,
                  Math.round((decadeCounts[decade] / totalTracks) * 100),
                ])
              ),
            };

            // Add prices to the update data
            if (cardsOrderType && cardsOrderType.amount) {
              updateData.price = cardsOrderType.amount;
            }

            if (digitalOrderType && digitalOrderType.amount) {
              updateData.priceDigital = digitalOrderType.amount;
            }

            if (sheetsOrderType && sheetsOrderType.amount) {
              updateData.priceSheets = sheetsOrderType.amount;
            }

            // Get download count and calculate Wilson score
            const downloads = await this.getPlaylistDownloads(
              playlist.playlistId
            );
            const wilsonScore = this.calculateWilsonScore(
              downloads,
              playlist.createdAt
            );

            // Add downloads and score to update data
            updateData.downloads = downloads;
            updateData.score = wilsonScore;

            // Update playlist with decade percentages, prices, downloads and Wilson score
            await this.prisma.playlist.update({
              where: { id: playlist.id },
              data: updateData,
            });

            this.logger.log(
              color.cyan(
                `Updated playlist ${white.bold(
                  playlist.name
                )} with ${white.bold(
                  downloads.toString()
                )} downloads and Wilson score of ${white.bold(
                  wilsonScore.toString()
                )}`
              )
            );
          }
        }

        this.logger.log(
          color.magenta(
            `Reloaded playlist ${white.bold(
              playlist.name
            )} into cache with decade percentages and descriptions`
          )
        );
      }

      this.logger.log(
        color.blue.bold(
          'Featured playlists updated successfully with decade percentages and descriptions'
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error updating featured playlists prices: ${color.white.bold(error)}`
        )
      );
    }
  }

  public static getInstance(): Order {
    if (!Order.instance) {
      Order.instance = new Order();
    }
    return Order.instance;
  }

  public startCron(): void {
    new CronJob('0 2 * * *', async () => {
      //await this.updateFeaturedPlaylists();
    }).start();
  }

  public async getOrderTypes(type: string = 'cards') {
    let orderTypes = null;
    let cacheKey = `orderTypes_${type}`;
    const cachedOrderType = await this.cache.get(cacheKey);
    if (cachedOrderType) {
      orderTypes = JSON.parse(cachedOrderType);
    } else {
      orderTypes = await this.prisma.orderType.findMany({
        select: {
          id: true,
          name: true,
          maxCards: true,
          amountWithMargin: true,
        },
        where: {
          visible: true,
          type,
        },
        orderBy: [
          {
            digital: 'desc',
          },
          {
            maxCards: 'asc',
          },
        ],
      });
      this.cache.set(cacheKey, JSON.stringify(orderTypes));
    }

    return orderTypes;
  }

  public async getOrderType(
    numberOfTracks: number,
    digital: boolean = false,
    productType: string = 'cards',
    playlistId: string,
    subType: 'sheets' | 'none'
  ) {
    return this.printer.getOrderType(
      numberOfTracks,
      digital,
      productType,
      playlistId,
      subType
    );
  }

  public async calculateSingleItem(params: any) {
    // return await this.printer.calculateSingleItem(params);
  }

  public async calculateOrder(params: any): Promise<ApiResult> {
    return await this.printer.calculateOrder(params);
  }

  public async testOrder() {
    return await this.printer.testOrder();
  }

  public async calculateShippingCosts(countryCodes?: string[]) {
    return await this.printer.calculateShippingCosts(countryCodes);
  }

  public async createOrder(
    payment: any,
    playlists: any[],
    productType: string
  ): Promise<any> {
    return await this.printer.createOrder(payment, playlists, productType);
  }

  public async createInvoice(payment: any): Promise<string> {
    const invoiceUrl = `${process.env['API_URI']}/invoice/${payment.paymentId}`;
    const pdfPath = `${process.env['PRIVATE_DIR']}/invoice/${payment.paymentId}.pdf`;

    this.logger.log(blue.bold(`Invoice URL: ${white.bold(invoiceUrl)}`));

    try {
      // Check if the file exists
      await fs.access(pdfPath);
      this.logger.log(
        blue.bold(`Invoice already exists at: ${white.bold(pdfPath)}`)
      );
    } catch (error) {
      // If the file doesn't exist, create it using Lambda
      const pdfManager = new PDF();

      // Create the directory if it doesn't exist
      const dir = `${process.env['PRIVATE_DIR']}/invoice`;
      try {
        await fs.access(dir);
      } catch (error) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Generate PDF using Lambda
      await pdfManager.generateFromUrl(invoiceUrl, pdfPath, {
        format: 'a4',
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
      });

      // Ensure the PDF is properly sized
      await pdfManager.resizePDFPages(pdfPath, 210, 297); // A4 size in mm

      this.logger.log(blue.bold(`Invoice created at: ${white.bold(pdfPath)}`));
    }

    return pdfPath;
  }

  public async updatePaymentInfo(
    paymentId: string,
    data: {
      fullname?: string;
      email?: string;
      isBusinessOrder?: boolean;
      companyName?: string;
      vatId?: string;
      address?: string;
      housenumber?: string;
      city?: string;
      zipcode?: string;
      countrycode?: string;
      differentInvoiceAddress?: boolean;
      invoiceAddress?: string;
      invoiceHousenumber?: string;
      invoiceCity?: string;
      invoiceZipcode?: string;
      invoiceCountrycode?: string;
    }
  ): Promise<void> {
    this.logger.log(
      blue.bold(`Updating payment info for payment: ${white.bold(paymentId)}`)
    );

    // Update payment record
    await this.prisma.payment.update({
      where: { paymentId },
      data: {
        fullname: data.fullname,
        email: data.email,
        isBusinessOrder: data.isBusinessOrder,
        companyName: data.companyName || null,
        vatId: data.vatId || null,
        address: data.address || null,
        housenumber: data.housenumber || null,
        city: data.city || null,
        zipcode: data.zipcode || null,
        countrycode: data.countrycode || null,
        differentInvoiceAddress: data.differentInvoiceAddress,
        invoiceAddress: data.invoiceAddress || null,
        invoiceHousenumber: data.invoiceHousenumber || null,
        invoiceCity: data.invoiceCity || null,
        invoiceZipcode: data.invoiceZipcode || null,
        invoiceCountrycode: data.invoiceCountrycode || null,
      },
    });

    // Delete old invoice PDF so it gets regenerated with new info
    const pdfPath = `${process.env['PRIVATE_DIR']}/invoice/${paymentId}.pdf`;
    try {
      await fs.unlink(pdfPath);
      this.logger.log(
        blue.bold(`Deleted old invoice for regeneration: ${white.bold(pdfPath)}`)
      );
    } catch (error) {
      // File might not exist, that's okay
      this.logger.log(
        blue.bold(`No existing invoice to delete for: ${white.bold(paymentId)}`)
      );
    }

    // Regenerate invoice with updated info
    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
    });

    if (payment) {
      await this.createInvoice(payment);
      this.logger.log(
        blue.bold(`Invoice regenerated for: ${white.bold(paymentId)}`)
      );
    }
  }
}

export default Order;
