import Log from './logger';
import PrismaInstance from './prisma';
import Cache from './cache';
import { ApiResult } from './interfaces/ApiResult';
import cluster from 'cluster';
import Utils from './utils';
import { CronJob } from 'cron';
import { color, blue, white } from 'console-log-colors';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import PrintAPI from './printers/printapi';
import PrintEnBind from './printers/printenbind';
import Spotify from './spotify';

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
  private spotify = new Spotify();
  private logger = new Log();
  //private printer = PrintAPI.getInstance();
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
      await fs.access(pdfPath);
    } catch (error) {
      throw new Error('Invoice not found');
    }

    return pdfPath;
  }

  public async updateFeaturedPlaylists(): Promise<void> {
    this.logger.log(
      color.blue.bold(
        'Refreshing cache and updating featured playlists with decade percentages'
      )
    );

    try {
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

      for (const playlist of featuredPlaylists) {
        // Get fresh data from Spotify
        await this.spotify.getPlaylist(
          playlist.slug,
          false,
          '',
          false,
          true,
          true
        );
        await this.spotify.getTracks(playlist.slug, false, '', false, true);

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

          await this.prisma.playlist.update({
            where: { id: playlist.id },
            data: Object.fromEntries(
              decades.map((decade) => [
                `decadePercentage${decade}`,
                Math.round((decadeCounts[decade] / totalTracks) * 100),
              ])
            ),
          });
        }

        this.logger.log(
          color.magenta(
            `Reloaded playlist ${white.bold(
              playlist.name
            )} into cache with decade percentages`
          )
        );
      }

      this.logger.log(
        color.blue.bold(
          'Featured playlists updated successfully with decade percentages'
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
    new CronJob('0 0 * * *', async () => {
      await this.updateFeaturedPlaylists();
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

  public async calculateShippingCosts() {
    return await this.printer.calculateShippingCosts();
  }

  public async createOrder(
    payment: any,
    playlists: any[],
    productType: string
  ): Promise<any> {
    return await this.printer.createOrder(payment, playlists, productType);
  }

  public async createInvoice(payment: any): Promise<string> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const invoiceUrl = `${process.env['API_URI']}/invoice/${payment.paymentId}`;

    this.logger.log(blue.bold(`Invoice URL: ${white.bold(invoiceUrl)}`));

    await page.goto(invoiceUrl, { waitUntil: 'networkidle0' });

    const pdfPath = `${process.env['PRIVATE_DIR']}/invoice/${payment.paymentId}.pdf`;

    try {
      // Check if the file exists
      await fs.access(pdfPath);
    } catch (error) {
      // If the file doesn't exist, create it
      await page.pdf({ path: pdfPath, format: 'A4' });
    }
    await browser.close();

    this.logger.log(blue.bold(`Invoice created at: ${white.bold(pdfPath)}`));

    return pdfPath;
  }
}

export default Order;
