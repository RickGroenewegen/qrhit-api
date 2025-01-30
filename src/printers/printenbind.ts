import Log from '../logger';
import { MAX_CARDS, MAX_CARDS_PHYSICAL } from '../config/constants';
import PrismaInstance from '../prisma';
import axios from 'axios';
import Cache from '../cache';
import { ApiResult } from '../interfaces/ApiResult';
import cluster from 'cluster';
import Utils from '../utils';
import { CronJob } from 'cron';
import { color, blue, white, magenta } from 'console-log-colors';
import Mail from '../mail';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import Data from '../data';
import crypto from 'crypto';
import Spotify from '../spotify';
import PDF from '../pdf';

interface PriceResult {
  totalPrice: number;
  pricePerCard: number;
  discountPercentage: number;
}

class PrintEnBind {
  private static instance: PrintEnBind;
  private prisma = PrismaInstance.getInstance();
  private cache = Cache.getInstance();
  private logger = new Log();
  private mail = Mail.getInstance();
  private data = Data.getInstance();
  private spotify = new Spotify();
  private utils = new Utils();

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          // Schedule hourly cache refresh
          const job = new CronJob('15 * * * *', async () => {
            await this.handleTrackingMails();
          });
          job.start();
        }
      });
    }
  }

  public async calculateCardPrice(
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

  public async getInvoice(invoiceId: string): Promise<string> {
    const pdfPath = `${process.env['PRIVATE_DIR']}/invoice/${invoiceId}.pdf`;

    try {
      await fs.access(pdfPath);
    } catch (error) {
      throw new Error('Invoice not found');
    }

    return pdfPath;
  }

  public static getInstance(): PrintEnBind {
    if (!PrintEnBind.instance) {
      PrintEnBind.instance = new PrintEnBind();
    }
    return PrintEnBind.instance;
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
    type: string = 'cards'
  ) {
    let orderType = null;
    let digitalInt = digital ? '1' : '0';
    let maxCards = digital ? MAX_CARDS : MAX_CARDS_PHYSICAL;

    if (numberOfTracks > maxCards) {
      numberOfTracks = maxCards;
    }

    let cacheKey = `orderType_${numberOfTracks}_${digitalInt}_${type}`;
    if (digital) {
      // There is just one digital product
      cacheKey = `orderType_${digitalInt}_${type}`;
    }

    const cachedOrderType = await this.cache.get(cacheKey);

    if (cachedOrderType) {
      orderType = JSON.parse(cachedOrderType);
    } else {
      orderType = await this.prisma.orderType.findFirst({
        where: {
          type,
          ...(digital
            ? {}
            : {
                maxCards: {
                  gte: numberOfTracks,
                },
              }),
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

    // If it's digital we calculate the true price
    if (orderType) {
      if (digital) {
        const price = await this.calculateCardPrice(
          orderType.amountWithMargin,
          numberOfTracks
        );

        orderType = {
          ...orderType,
          discountPercentage: price.discountPercentage,
          pricePerCard: price.pricePerCard,
        };
        orderType.amountWithMargin = price.totalPrice;
        orderType.discountPercentage = price.discountPercentage;
        orderType.pricePerCard = price.pricePerCard;
      }
    }

    return orderType;
  }

  private generateOrderHash(items: any[], countrycode: string): string {
    const orderData = {
      items,
      countrycode,
    };

    return crypto
      .createHash('md5')
      .update(JSON.stringify(orderData))
      .digest('hex');
  }

  private async processOrderRequest(
    items: any[],
    customerInfo: {
      fullname?: string;
      email: string;
      address?: string;
      housenumber?: string;
      zipcode?: string;
      city?: string;
      countrycode: string;
    },
    logging: boolean = false,
    cache: boolean = true
  ): Promise<
    ApiResult & {
      apiCalls?: Array<{
        method: string;
        url: string;
        body?: any;
        statusCode: number;
        responseBody: any;
      }>;
    }
  > {
    const orderHash = this.generateOrderHash(items, customerInfo.countrycode);
    const cacheKey = `order_request_${orderHash}`;

    let supplier = 0;
    let total = 0;
    let shipping = 0;
    let handling = 0;
    let price = 0;
    let payment = 0;
    let totalProductPriceWithoutVAT = 0;
    let apiCalls: Array<{
      method: string;
      url: string;
      body?: any;
      statusCode: number;
      responseBody: any;
    }> = [];

    // Check cache first
    const cachedResult = await this.cache.get(cacheKey);
    if (cachedResult && cache) {
      return JSON.parse(cachedResult);
    }

    const authToken = await this.getAuthToken();
    const taxRate = (await this.data.getTaxRate(customerInfo.countrycode))!;
    let physicalOrderCreated: boolean = false;
    let orderId = null;

    // Add remaining articles
    for (let i = 0; i < items.length; i++) {
      if (items[i].type == 'physical' && !physicalOrderCreated) {
        if (items[i].type == 'physical') {
          const orderType = await this.getOrderType(
            parseInt(items[i].copies) / 2,
            false,
            'cards'
          );

          const productPriceWithoutVAT = parseFloat(
            (orderType.amountWithMargin / (1 + (taxRate ?? 0) / 100)).toFixed(2)
          );

          totalProductPriceWithoutVAT += productPriceWithoutVAT;
        }

        // Create initial order with first article
        const response = await fetch(
          `${process.env['PRINTENBIND_API_URL']}/v1/orders/articles`,
          {
            method: 'POST',
            headers: {
              Authorization: authToken!,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(items[i]),
          }
        );
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const firstResponse = await response.clone().json();

        console.log(111, firstResponse);

        if (logging) {
          apiCalls.push({
            method: 'POST',
            url: `${process.env['PRINTENBIND_API_URL']}/v1/orders/articles`,
            body: items[i],
            statusCode: response.status,
            responseBody: firstResponse,
          });
        }

        orderId = response.headers.get('location')?.split('/')[1];

        if (!orderId) {
          throw 'Unable to create initial PrinterAPI order';
        }

        physicalOrderCreated = true;

        if (logging) {
          this.logger.log(
            color.blue.bold(
              `Created order: ${color.white.bold(
                orderId
              )} and added first article`
            )
          );
        }

        if (!orderId) {
          return {
            success: false,
            error: 'No order ID received in response',
          };
        }
      } else if (items[i].type == 'physical' && physicalOrderCreated) {
        const articleResponse = await fetch(
          `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}/articles`,
          {
            method: 'POST',
            headers: {
              Authorization: authToken!,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(items[i]),
          }
        );

        if (!articleResponse.ok) {
          throw new Error(`HTTP error! status: ${articleResponse.status}`);
        }

        if (logging) {
          apiCalls.push({
            method: 'POST',
            url: `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}/articles`,
            body: items[i],
            statusCode: articleResponse.status,
            responseBody: await articleResponse.clone().json(),
          });
        }

        if (logging) {
          this.logger.log(
            color.blue.bold(
              `Added article ${i + 1} to order ${color.white.bold(orderId)}`
            )
          );
        }

        if (!articleResponse.ok) {
          throw new Error(`Failed to add article ${i + 1}`);
        }
      } else if (items[i].type == 'digital') {
        const orderType = await this.getOrderType(
          items[i].numberOfTracks,
          true,
          items[i].productType
        );

        if (orderType) {
          let itemPrice = 0;

          if (items[i].productType === 'cards') {
            itemPrice = parseFloat(
              (orderType.amountWithMargin * items[i].amount).toFixed(2)
            );
          } else if (items[i].productType === 'giftcard') {
            itemPrice = parseFloat(items[i].price.toFixed(2));
          }

          const productPriceWithoutVAT = parseFloat(
            (itemPrice / (1 + (taxRate ?? 0) / 100)).toFixed(2)
          );

          totalProductPriceWithoutVAT += productPriceWithoutVAT;
          total += itemPrice;
        }
      }
    }

    if (physicalOrderCreated) {
      // Set up delivery
      const deliveryMethod =
        customerInfo.countrycode === 'NL' ? 'post' : 'international';
      const deliveryOption =
        customerInfo.countrycode === 'NL' ? 'standard' : '';

      const deliveryData = {
        name_contact: customerInfo.fullname || 'John Doe',
        street: customerInfo.address || 'Some lane',
        city: customerInfo.city || 'Amsterdam',
        streetnumber: customerInfo.housenumber || '1',
        zipcode: customerInfo.zipcode || '1234AB',
        country: customerInfo.countrycode,
        delivery_method: deliveryMethod,
        delivery_option:
          customerInfo.countrycode === 'NL' ? 'standard' : undefined,
        blanco: '1',
        email: customerInfo.email || 'john@doe.com',
      };

      const addDeliveryResult = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/delivery/${orderId}`,
        {
          method: 'POST',
          headers: {
            Authorization: authToken!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(deliveryData),
        }
      );

      if (!addDeliveryResult.ok) {
        throw new Error(`HTTP error! status: ${addDeliveryResult.status}`);
      }

      const addDelivery = await addDeliveryResult.json();

      if (logging) {
        apiCalls.push({
          method: 'POST',
          url: `${process.env['PRINTENBIND_API_URL']}/v1/delivery/${orderId}`,
          body: deliveryData,
          statusCode: addDeliveryResult.status,
          responseBody: addDelivery,
        });
      }

      if (logging) {
        this.logger.log(
          color.blue.bold(
            `Added delivery data to order ${color.white.bold(orderId)}`
          )
        );
      }
      // Get final order details
      const [orderResponse, deliveryResponse] = await Promise.all([
        fetch(`${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}`, {
          method: 'GET',
          headers: { Authorization: authToken! },
        }),
        fetch(`${process.env['PRINTENBIND_API_URL']}/v1/delivery/${orderId}`, {
          method: 'GET',
          headers: { Authorization: authToken! },
        }),
      ]);

      if (logging) {
        this.logger.log(
          color.blue.bold(
            `Retrieved order & delivery details for order ${color.white.bold(
              orderId
            )}`
          )
        );
      }

      const order: any = await orderResponse.json();
      const delivery: any = await deliveryResponse.json();
      const taxModifier = 1 + taxRate / 100;

      supplier += parseFloat(
        (parseFloat(order.amount) * taxModifier).toFixed(2)
      );

      total += parseFloat(
        (
          (totalProductPriceWithoutVAT +
            parseFloat(delivery.amount) +
            parseFloat(order.price_startup)) *
          taxModifier
        ).toFixed(2)
      );

      shipping += parseFloat(
        (parseFloat(delivery.amount) * taxModifier).toFixed(2)
      );

      handling += parseFloat(
        (parseFloat(order.price_startup) * taxModifier).toFixed(2)
      );

      price += parseFloat(
        (totalProductPriceWithoutVAT * taxModifier).toFixed(2)
      );

      payment = parseFloat(
        (
          (parseFloat(delivery.amount) + parseFloat(order.price_startup)) *
          taxModifier
        ).toFixed(2)
      );
    }

    const result = {
      success: true,
      data: {
        orderId,
        total,
        shipping,
        handling,
        taxRateShipping: taxRate,
        taxRate,
        price,
        payment,
      },
      ...(logging ? { apiCalls } : {}),
    };

    // Cache the successful result for 1 hour (3600 seconds)
    await this.cache.set(cacheKey, JSON.stringify(result), 3600);

    return result;
  }

  private async createOrderItem(
    numberOfTracks: number,
    fileUrl: string = '',
    item: any
  ): Promise<any> {
    let numberOfPages = numberOfTracks * 2;

    if (numberOfPages > 2000) {
      numberOfPages = 2000;
    }

    let oddPages = Array.from(
      { length: numberOfPages },
      (_, i) => i + 1
    ).filter((page) => page % 2 !== 0);

    // 50 items max
    if (oddPages.length > 50) {
      oddPages = oddPages.slice(0, 50);
    }

    if (item.type == 'digital') {
      return item;
    } else {
      return {
        type: 'physical',
        amount: item.amount,
        product: 'losbldadig',
        number: '1',
        copies: numberOfPages.toString(),
        color: 'custom',
        color_custom_pages: oddPages.join(','),
        size: 'custom',
        printside: 'double',
        finishing: 'loose',
        papertype: 'card',
        size_custom_width: '60',
        size_custom_height: '60',
        check_doc: 'standard',
        delivery_method: 'post',
        add_file_method: 'url',
        file_url: fileUrl,
      };
    }
  }

  public async calculateOrder(params: any): Promise<any> {
    if (!params.countrycode) {
      params.countrycode = 'NL';
    }

    try {
      const orderItems = [];

      for (const item of params.cart.items) {
        if (item.productType === 'cards') {
          const numberOfTracks = await this.spotify.getPlaylistTrackCount(
            item.playlistId,
            true,
            item.isSlug
          );

          const orderItem = await this.createOrderItem(
            numberOfTracks,
            '',
            item
          );
          orderItems.push(orderItem);
        }
      }

      return await this.processOrderRequest(orderItems, {
        email: params.email,
        countrycode: params.countrycode,
      });
    } catch (error) {
      this.logger.log(color.red.bold(`Error calculating order: ${error}`));
      return {
        success: false,
        error: `Error calculating order: ${error}`,
      };
    }
  }

  public async testOrder() {
    const authToken = await this.getAuthToken();
  }

  private async getAuthToken(force: boolean = false): Promise<string | null> {
    return process.env['PRINTENBIND_API_KEY']!;
  }

  public async finishOrder(
    orderId: string,
    apiCalls?: Array<{
      method: string;
      url: string;
      body?: any;
      statusCode: number;
      responseBody: any;
    }>
  ): Promise<
    ApiResult & {
      apiCalls?: Array<{
        method: string;
        url: string;
        body?: any;
        statusCode: number;
        responseBody: any;
      }>;
    }
  > {
    try {
      const authToken = await this.getAuthToken();
      const finishApiCalls: Array<{
        method: string;
        url: string;
        body?: any;
        statusCode: number;
        responseBody: any;
      }> = [];

      const response = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}/finish`,
        {
          method: 'POST',
          headers: {
            Authorization: authToken!,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const responseBody = await response
        .clone()
        .json()
        .catch(() => null);

      finishApiCalls.push({
        method: 'POST',
        url: `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}/finish`,
        statusCode: response.status,
        responseBody,
      });

      this.logger.log(
        color.green.bold(
          `Print&Bind order ${color.white.bold(orderId)} finished successfully`
        )
      );

      return {
        success: true,
        data: {
          orderId,
        },
        apiCalls: [...(apiCalls || []), ...finishApiCalls],
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error finishing order ${orderId}: ${error}`)
      );
      return {
        success: false,
        error: `Error finishing order: ${error}`,
      };
    }
  }

  public async createOrder(
    payment: any,
    playlists: any[],
    productType: string
  ): Promise<any> {
    const authToken = await this.getAuthToken();
    const orderItems = [];

    for (const playlistItem of playlists) {
      const playlist = playlistItem.playlist;
      const filename = playlistItem.filename;

      this.logger.log(
        color.blue.bold(
          `Creating Print&Bind order for playlist: ${color.white(
            playlist.name
          )}`
        )
      );

      const fileUrl = `${process.env['API_URI']}/public/pdf/${filename}`;

      const orderItem = await this.createOrderItem(
        playlist.numberOfTracks,
        fileUrl,
        playlist
      );
      orderItems.push(orderItem);
    }

    const result = await this.processOrderRequest(
      orderItems,
      {
        fullname: payment.fullname,
        email: payment.email,
        address: payment.address,
        housenumber: payment.housenumber,
        zipcode: payment.zipcode,
        city: payment.city,
        countrycode: payment.countrycode,
      },
      true,
      false
    );

    let finalApiCalls = result.apiCalls || [];

    if (
      (process.env['PRINTENBIND_API_URL']!.indexOf('sandbox') == -1 &&
        process.env['ENVIRONMENT'] === 'production') ||
      (process.env['PRINTENBIND_API_URL']!.indexOf('sandbox') > -1 &&
        process.env['ENVIRONMENT'] === 'development')
    ) {
      // const finishResult = await this.finishOrder(
      //   result.data.orderId,
      //   finalApiCalls
      // );
      // finalApiCalls = finishResult.apiCalls || [];
      this.logger.log(
        color.blue.bold(
          `Finished order ${color.white.bold(result.data.orderId)}`
        )
      );
    }

    const deliveryResponse = await fetch(
      `${process.env['PRINTENBIND_API_URL']}/v1/delivery/${result.data.orderId}`,
      {
        method: 'GET',
        headers: { Authorization: authToken! },
      }
    );

    const delivery = await deliveryResponse.json();

    const trackingLink = delivery.tracktrace || '';

    this.logger.log(
      color.blue.bold(
        `Tracking link for order ${color.white.bold(
          result.data.orderId
        )} is: ${color.white.bold(trackingLink)}`
      )
    );

    if (trackingLink.length > 0) {
      // Update printApiTrackingLink
      await this.prisma.payment.update({
        where: { id: payment.paymentId },
        data: {
          printApiTrackingLink: trackingLink,
        },
      });
    }

    return {
      request: '',
      response: {
        apiCalls: finalApiCalls,
        id: result.data.orderId,
      },
    };
  }

  private async createInvoice(payment: any): Promise<string> {
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

  public async processPrintApiWebhook(printApiOrderId: string) {}

  private async getOrderStatus(orderId: string): Promise<any> {
    try {
      const authToken = await this.getAuthToken();
      const response = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}`,
        {
          method: 'GET',
          headers: { Authorization: authToken! },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get order status: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting order status: ${error}`));
      return null;
    }
  }

  public async handleTrackingMails(): Promise<void> {
    try {
      const unshippedOrders = await this.prisma.payment.findMany({
        where: {
          printApiStatus: 'Created',
          printApiShipped: false,
          printApiOrderId: {
            notIn: [''],
          },
        },
        select: {
          id: true,
          paymentId: true,
          printApiOrderId: true,
          fullname: true,
          email: true,
          createdAt: true,
        },
      });

      if (unshippedOrders.length > 0) {
        this.logger.log(
          color.blue.bold(
            `Found ${color.white.bold(
              unshippedOrders.length.toString()
            )} unshipped orders`
          )
        );

        for (const order of unshippedOrders) {
          const payment = await this.prisma.payment.findUnique({
            where: { paymentId: order.paymentId },
          });

          if (payment) {
            const orderStatus = await this.getOrderStatus(
              order.printApiOrderId
            );

            if (orderStatus.status == 'Verzonden' || true) {
              this.logger.log(
                color.blue.bold(
                  `Order ${color.white.bold(
                    order.printApiOrderId
                  )} has been shipped`
                )
              );

              // Update order status
              await this.prisma.payment.update({
                where: { id: order.id },
                data: {
                  printApiShipped: true,
                  printApiStatus: 'Shipped',
                },
              });

              if (
                (payment.printApiTrackingLink &&
                  payment.printApiTrackingLink!.length > 0) ||
                true
              ) {
                const pdfPath = await this.createInvoice(payment);
                this.mail.sendTrackingEmail(
                  payment,
                  payment.printApiTrackingLink!,
                  pdfPath
                );
                this.logger.log(
                  color.blue.bold(
                    `Sent tracking email for order ${color.white.bold(
                      order.printApiOrderId
                    )} (${color.white.bold(payment.printApiTrackingLink)})`
                  )
                );
              }
            }
          }
        }
      } else {
        this.logger.log(color.blue.bold('No unshipped orders found'));
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error retrieving unshipped orders: ${error}`)
      );
    }
  }
}

export default PrintEnBind;
