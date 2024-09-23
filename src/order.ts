import Log from './logger';
import PrismaInstance from './prisma';
import axios from 'axios';
import Cache from './cache';
import { ApiResult } from './interfaces/ApiResult';
import cluster from 'cluster';
import Utils from './utils';
import { CronJob } from 'cron';
import { color, blue, white, magenta } from 'console-log-colors';
import Mail from './mail';
import puppeteer from 'puppeteer';
import fs from 'fs';
import Data from './data';
import crypto from 'crypto';

class Order {
  private static instance: Order;
  private prisma = PrismaInstance.getInstance();
  private APIcacheToken: string = 'printapi_auth_token';
  private pricingCacheToken: string = 'printapi_pricing_token';
  private cache = Cache.getInstance();
  private utils = new Utils();
  private logger = new Log();
  private mail = new Mail();
  private data = new Data();

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then((isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.startCron();
        }
      });
    }
  }

  public async updateFeaturedPlaylists(): Promise<void> {
    try {
      // Get all featured playlists
      const featuredPlaylists = await this.prisma.playlist.findMany({
        where: { featured: true },
      });

      for (const playlist of featuredPlaylists) {
        // Get the order type based on the number of tracks
        const orderType = await this.getOrderType(playlist.numberOfTracks);

        if (orderType) {
          // Update the playlist's price with the order type's amount
          await this.prisma.playlist.update({
            where: { id: playlist.id },
            data: { price: orderType.amountWithMargin },
          });

          this.logger.log(
            color.magenta(
              `Updated price for playlist ${white.bold(
                playlist.name
              )} to: ${white.bold(orderType.amountWithMargin)}`
            )
          );
        } else {
          this.logger.log(
            color.red.bold(
              `No suitable order type found for playlist ${white.bold(
                playlist.name
              )} with ${white.bold(playlist.numberOfTracks)} tracks`
            )
          );
        }
      }

      this.logger.log(
        color.magenta('Featured playlists prices updated successfully')
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
    new CronJob('*/10 * * * *', async () => {
      await this.getAuthToken(true);
      this.logger.log(color.blue.bold(`Refreshed Print API token`));
    }).start();
    new CronJob(process.env['CRON_PATTERN_TRACKING']!, async () => {
      await this.checkForShipment();
    }).start();
    new CronJob('0 0 * * *', async () => {
      await this.updateFeaturedPlaylists();
      this.logger.log(color.blue.bold(`Updated featured playlists prices`));
    }).start();
  }

  public async getOrderTypes() {
    let orderTypes = null;
    let cacheKey = `orderTypes`;
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

  public async getOrderType(numberOfTracks: number, digital: boolean = false) {
    let orderType = null;
    let digitalInt = digital ? '1' : '0';
    if (numberOfTracks > 500) {
      numberOfTracks = 500;
    }
    let cacheKey = `orderType_${numberOfTracks}_${digitalInt}`;
    const cachedOrderType = await this.cache.get(cacheKey);

    if (cachedOrderType) {
      orderType = JSON.parse(cachedOrderType);
    } else {
      orderType = await this.prisma.orderType.findFirst({
        where: {
          maxCards: {
            gte: numberOfTracks,
          },
          digital: digital,
        },
        orderBy: [
          {
            maxCards: 'asc',
          },
        ],
      });
      this.cache.set(cacheKey, JSON.stringify(orderType));
    }
    return orderType;
  }

  public async calculateOrder(params: any): Promise<ApiResult> {
    const cartItems = params.cart.items;
    const itemsForApi: any[] = [];

    console.log(111, JSON.stringify(params, null, 2));

    let total = 0;
    const minimumAmount = 25;
    const maximumAmount = 500;

    for (const item of cartItems) {
      let numberOfTracks = item.amountOfTracks;

      if (isNaN(numberOfTracks)) {
        return {
          success: false,
          error: `Invalid number of tracks for item ${item.playlistName}`,
        };
      }

      numberOfTracks = Math.min(Math.max(numberOfTracks, minimumAmount), maximumAmount);
      const orderType = await this.getOrderType(
        numberOfTracks,
        item.type === 'digital'
      );

      if (orderType) {
        const itemPrice = parseFloat(
          (orderType.amountWithMargin * item.amount).toFixed(2)
        );
        total += itemPrice;

        itemsForApi.push({
          productId: orderType.printApiProductId,
          quantity: item.amount,
          pageCount: 25, // TODO: Get this from somewhere
        });
      } else {
        return {
          success: false,
          error: `Order type not found for item ${item.playlistName}`,
        };
      }
    }

    let minimumAmount = 25;
    let maximumAmount = 500;
    let returnData: any = {};

    if (!params.countrycode) {
      params.countrycode = 'NL';
    }

    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(cartItems));
    const cacheToken = `${this.pricingCacheToken}_${hash.digest('hex')}`;

    const cachedPrice = await this.cache.get(cacheToken);

    if (cachedPrice) {
      try {
        const cachedData = JSON.parse(cachedPrice);
        if (cachedData.success) {
          return cachedData;
        }
      } catch (e) {
        this.cache.del(cacheToken);
      }
    }

    let numberOfTracks = parseInt(params.numberOfTracks);

    if (numberOfTracks < minimumAmount) {
      numberOfTracks = minimumAmount;
    }

    if (numberOfTracks > maximumAmount) {
      numberOfTracks = maximumAmount;
    }

    if (isNaN(numberOfTracks)) {
      return {
        success: false,
        error: 'Invalid number of cards',
      };
    }

    const taxRate = await this.data.getTaxRate(params.countrycode);

    if (itemsForApi.length > 0) {
      const authToken = await this.getAuthToken();

      let response = await axios({
        method: 'post',
        url: `${process.env['PRINT_API_URL']}/v2/shipping/quote`,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        data: {
          country: params.countrycode || 'NL',
          items: itemsForApi,
        },
      });

      total += response.data.payment;
      total = parseFloat(total.toFixed(2));

      returnData = {
        success: true,
        data: {
          total,
          shipping: response.data.shipping,
          handling: response.data.handling,
          taxRateShipping: response.data.taxRate * 100,
          taxRate,
          payment: response.data.payment,
        },
      };

      this.cache.set(cacheToken, JSON.stringify(returnData));
      return returnData;
    } else {
      return {
        success: false,
        error: 'No valid items found for order',
      };
    }
  }

  public async testOrder() {
    const authToken = await this.getAuthToken();
    const pdfURL = `${process.env.API_URI}/assets/pdf/example_digital.pdf`;

    console.log(111, pdfURL);

    const body = {
      email: 'west14@gmail.com',
      items: [
        {
          productId: 'kaarten_dubbel_10x10_9st',
          pageCount: 2, //payment.printerPageCount,
          quantity: 1,
          files: {
            content: pdfURL,
          },
        },
      ],
      shipping: {
        address: {
          name: 'Rick Groenewegen',
          line1: 'Prinsenhof 1',
          postCode: '2171XZ',
          city: 'Sassenheim',
          country: 'NL',
        },
      },
    };

    console.log(222, JSON.stringify(body, null, 2));

    try {
      const responseOrder = await axios({
        method: 'post',
        url: `${process.env['PRINT_API_URL']}/v2/orders`,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        data: body,
      });
      console.log(333, JSON.stringify(responseOrder.data, null, 2));
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        console.log(999, JSON.stringify(e.response.data, null, 2));
      }
    }
  }

  private async getAuthToken(force: boolean = false): Promise<string | null> {
    let authToken: string | null = '';
    authToken = await this.cache.get(this.APIcacheToken);
    if (!authToken || force) {
      const response = await axios({
        method: 'post',
        url: `${process.env['PRINT_API_URL']}/v2/oauth`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: {
          grant_type: 'client_credentials',
          client_id: process.env['PRINT_API_CLIENTID']!,
          client_secret: process.env['PRINT_API_SECRET']!,
        },
      });
      authToken = response.data.access_token;
      this.cache.set(this.APIcacheToken, response.data.access_token, 7200);
    }
    return authToken;
  }

  public async createOrder(payment: any, filename: string): Promise<any> {
    const authToken = await this.getAuthToken();
    let response: string = '';

    const body = {
      email: payment.user.email,
      items: [
        {
          productId: payment.orderType.printApiProductId,
          pageCount: 32, //payment.printerPageCount,
          quantity: 1,
          files: {
            content: `${process.env.API_URI}/public/pdf/${filename}`,
            cover: `${process.env.API_URI}/public/pdf/${filename}`,
          },
        },
      ],
      shipping: {
        address: {
          name: payment.fullname,
          line1: payment.address,
          postCode: payment.zipcode,
          city: payment.city,
          country: payment.countrycode,
        },
      },
    };

    try {
      const responseOrder = await axios({
        method: 'post',
        url: `${process.env['PRINT_API_URL']}/v2/orders`,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        data: body,
      });
      response = responseOrder.data;
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        response = e.response.data;
      }
    }

    return {
      request: body,
      response: response,
    };
  }

  public async checkForShipment(): Promise<void> {
    const authToken = await this.getAuthToken();

    // Get all payments that have a printApiOrderId and the printApiStatus is not 'Shipped' or 'Cancelled'
    const payments = await this.prisma.payment.findMany({
      where: {
        printApiOrderId: {
          not: undefined,
        },
        printApiShipped: false,
        printApiStatus: {
          notIn: ['Shipped', 'Cancelled'],
        },
      },
    });

    // Loop through the payments and check the status
    for (const payment of payments) {
      if (payment.printApiOrderId?.length > 0) {
        try {
          let trackingLink = '';
          const url = `${process.env['PRINT_API_URL']}/v2/orders/${payment.printApiOrderId}`;

          const response = await axios({
            method: 'get',
            url,
            headers: {
              Authorization: `Bearer ${authToken}`,
              'Content-Type': 'application/json',
            },
          });

          if (response.data.status === 'Shipped') {
            this.logger.log(
              magenta(
                `Status of order ${white.bold(
                  payment.printApiOrderId
                )} is shipped`
              )
            );

            if (response.data.trackingUrl?.length > 0) {
              trackingLink = response.data.trackingUrl;
              const pdfPath = await this.createInvoice(response.data, payment);

              this.mail.sendTrackingEmail(payment, trackingLink, pdfPath);

              // Update the payment with the printApiShipped flag
              await this.prisma.payment.update({
                where: {
                  id: payment.id,
                },
                data: {
                  printApiShipped: true,
                  printApiStatus: response.data.status,
                  printApiTrackingLink: trackingLink,
                },
              });
            }
          }
        } catch (e) {
          this.logger.log(
            color.red.bold(
              `Error retrieving Print API order status for order: ${color.white.bold(
                payment.printApiOrderId
              )}`
            )
          );
        }
      }
    }
  }

  private async createInvoice(order: any, payment: any): Promise<string> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const invoiceUrl = `${process.env['API_URI']}/invoice/${payment.paymentId}`;
    await page.goto(invoiceUrl, { waitUntil: 'networkidle0' });

    const pdfPath = `${process.env['PRIVATE_DIR']}/invoice/${payment.paymentId}.pdf`;

    // Only write if pdf does not exist
    if (!fs.existsSync(pdfPath)) {
      await page.pdf({ path: pdfPath, format: 'A4' });
    }
    await browser.close();

    this.logger.log(blue.bold(`Invoice created at: ${white.bold(pdfPath)}`));

    return pdfPath;
  }
}

export default Order;
