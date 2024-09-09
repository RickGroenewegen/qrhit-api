import Log from './logger';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import Cache from './cache';
import { ApiResult } from './interfaces/ApiResult';
import cluster from 'cluster';
import Utils from './utils';
import { CronJob } from 'cron';
import { color, blue, white } from 'console-log-colors';
import Mail from './mail';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

class Order {
  private static instance: Order;
  private prisma = new PrismaClient();
  private APIcacheToken: string = 'printapi_auth_token';
  private pricingCacheToken: string = 'printapi_pricing_token';
  private cache = Cache.getInstance();
  private utils = new Utils();
  private logger = new Log();
  private mail = new Mail();

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then((isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.startCron();
        }
      });
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
        orderBy: {
          maxCards: 'asc',
        },
      });
      this.cache.set(cacheKey, JSON.stringify(orderTypes));
    }
    return orderTypes;
  }

  public async getOrderType(numberOfTracks: number) {
    let orderType = null;
    if (numberOfTracks > 500) {
      numberOfTracks = 500;
    }
    let cacheKey = `orderType_${numberOfTracks}`;
    const cachedOrderType = await this.cache.get(cacheKey);
    if (cachedOrderType) {
      orderType = JSON.parse(cachedOrderType);
    } else {
      orderType = await this.prisma.orderType.findFirst({
        where: {
          maxCards: {
            gte: numberOfTracks,
          },
        },
        orderBy: {
          maxCards: 'asc',
        },
      });
      this.cache.set(cacheKey, JSON.stringify(orderType));
    }
    return orderType;
  }

  public async calculateOrder(params: any): Promise<ApiResult> {
    let price = 0;
    let total = 0;
    let minimumAmount = 25;
    let maximumAmount = 500;

    let cacheToken = `${this.pricingCacheToken}_${params.orderType}_${params.amount}_${params.countrycode}`;

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

    const orderType = await this.getOrderType(numberOfTracks);

    if (orderType) {
      price = parseFloat(
        (orderType.amountWithMargin * parseInt(params.amount)).toFixed(2)
      );

      total += price;

      let response: any = {};

      if (params.orderType !== 'digital') {
        const authToken = await this.getAuthToken();

        response = await axios({
          method: 'post',
          url: `${process.env['PRINT_API_URL']}/v2/shipping/quote`,
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          data: {
            country: params.countrycode || 'NL',
            items: [
              {
                productId: orderType.printApiProductId,
                quantity: params.amount,
                pageCount: 25, // TODO: Get this from somewhere
              },
            ],
          },
        });

        total += response.data.payment;
      }

      total = parseFloat(total.toFixed(2));

      const returnData = {
        success: true,
        data: {
          price,
          total,
          ...response.data,
        },
      };

      this.cache.set(cacheToken, JSON.stringify(returnData));

      return returnData;
    } else {
      return {
        success: false,
        error: 'Order type not found',
      };
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

  public async createOrder(payment: any, filename: string): Promise<void> {
    const authToken = await this.getAuthToken();

    const responseOrder = await axios({
      method: 'post',
      url: `${process.env['PRINT_API_URL']}/v2/orders`,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        email: payment.user.email,
        items: [
          {
            productId: payment.orderType.printApiProductId,
            pageCount: 32,
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
      },
    });

    // Update the payment with the order id
    await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        printApiOrderId: responseOrder.data.id,
        filename: filename,
      },
    });
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
      try {
        let trackingLink = '';
        const response = await axios({
          method: 'get',
          url: `${process.env['PRINT_API_URL']}/v2/orders/${payment.printApiOrderId}`,
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (response.data.status === 'Shipped') {
          if (response.data.trackingUrl?.length > 0) {
            trackingLink = response.data.trackingUrl;
          }

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
            },
          });
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
