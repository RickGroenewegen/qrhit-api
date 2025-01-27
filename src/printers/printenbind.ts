import Log from '../logger';
import { MAX_CARDS } from '../config/constants';
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
  private APIcacheToken: string = `printapi_auth_token_${process.env['PRINT_API_CLIENTID']}`;
  private pricingCacheToken: string = `printapi_pricing_token_${process.env['PRINT_API_CLIENTID']}`;
  private cache = Cache.getInstance();
  private utils = new Utils();
  private logger = new Log();
  private mail = Mail.getInstance();
  private data = Data.getInstance();
  private spotify = new Spotify();
  private pdf = new PDF();
  private printApiSizes = [
    { pages: 1, cost: 1, price: 2 },
    { pages: 3, cost: 2, price: 4 },
    { pages: 9, cost: 3, price: 3 },
    { pages: 13, cost: 5, price: 5 },
    { pages: 17, cost: 7, price: 14 },
    { pages: 25, cost: 10, price: 20 },
    { pages: 34, cost: 15, price: 39 },
    { pages: 42, cost: 20, price: 40 },
    { pages: 50, cost: 25, price: 50 },
    { pages: 59, cost: 30, price: 60 },
    { pages: 67, cost: 35, price: 70 },
    { pages: 75, cost: 40, price: 80 },
    { pages: 84, cost: 50, price: 100 },
  ];

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
   * Calculates the optimal order for printing cards.
   * @param cards Number of cards to print.
   * @returns An object containing the products to order and the start and end index of the sheets (double-sided).
   */
  public async calculateOptimalPrintOrder(cards: number): Promise<{
    order: { pages: number; cost: number; price: number }[];
    sheetRanges: { start: number; end: number }[];
    totalCost: number;
    totalPrice: number;
  }> {
    const sheetsNeeded = Math.ceil(cards / 6); // Calculate required sheets (6 cards per sheet)
    const products = [...this.printApiSizes].sort((a, b) => b.pages - a.pages); // Sort products in descending order
    const order: { pages: number; cost: number; price: number }[] = [];
    const sheetRanges: { start: number; end: number }[] = [];
    let totalCost = 0;
    let totalPrice = 0;

    let remainingSheets = sheetsNeeded;
    let currentStart = 1;

    for (const product of products) {
      while (remainingSheets >= product.pages) {
        order.push(product);
        const end = currentStart + product.pages * 2 - 1; // Double-sided sheets
        sheetRanges.push({ start: currentStart, end });
        currentStart = end + 1;
        remainingSheets -= product.pages;
        totalCost += product.cost;
        totalPrice += product.price;
      }
    }

    // If there are still sheets needed and no exact match, order the smallest product
    if (remainingSheets > 0) {
      const smallestProduct = products[products.length - 1];
      order.push(smallestProduct);
      const end = currentStart + smallestProduct.pages * 2 - 1; // Double-sided sheets
      sheetRanges.push({ start: currentStart, end });
      totalCost += smallestProduct.cost;
      totalPrice += smallestProduct.price;
    }

    return { order, sheetRanges, totalCost, totalPrice };
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

  public async processPrintApiWebhook(printApiOrderId: string) {
    this.logger.log(
      color.blue.bold(
        `Processing Print API webhook for order ${color.white.bold(
          printApiOrderId
        )}`
      )
    );

    // Get the payment based on the printApiOrderId
    const whereClause = {
      printApiOrderId: printApiOrderId,
      printApiShipped: false,
    };

    const payment = await this.prisma.payment.findFirst({
      where: whereClause,
    });

    if (payment) {
      // Process the webhook
      this.logger.log(
        color.blue.bold(
          `Retrieving order ${color.white.bold(
            payment.printApiOrderId
          )} from PrintAPI`
        )
      );

      try {
        let trackingLink = '';
        const url = `${process.env['PRINTENBIND_API_URL']}/v2/orders/${payment.printApiOrderId}`;
        const authToken = await this.getAuthToken();

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
              )} is: ${white.bold(response.data.status)}`
            )
          );

          console.log(111, response.data);

          if (response.data.trackingUrl?.length > 0) {
            trackingLink = response.data.trackingUrl;
            const pdfPath = await this.createInvoice(response.data, payment);
            this.mail.sendTrackingEmail(payment, trackingLink, pdfPath);
            this.logger.log(
              magenta(
                `Sent tracking e-mail for ${white.bold(
                  payment.printApiOrderId
                )}`
              )
            );
          }

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
        } else {
          if (response.data.status !== payment.printApiStatus) {
            await this.prisma.payment.update({
              where: {
                id: payment.id,
              },
              data: {
                printApiStatus: response.data.status,
              },
            });
            this.logger.log(
              magenta(
                `Status of order ${white.bold(
                  payment.printApiOrderId
                )} changed to: ${white.bold(response.data.status)}`
              )
            );
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
        console.log(999, e);
      }
    }
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

  public static getInstance(): PrintEnBind {
    if (!PrintEnBind.instance) {
      PrintEnBind.instance = new PrintEnBind();
    }
    return PrintEnBind.instance;
  }

  public startCron(): void {
    new CronJob('*/10 * * * *', async () => {
      await this.getAuthToken(true);
    }).start();
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
    type: string = 'cards'
  ) {
    let orderType = null;
    let digitalInt = digital ? '1' : '0';
    if (numberOfTracks > MAX_CARDS) {
      numberOfTracks = MAX_CARDS;
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

    orderType.discountPercentage = 0;
    orderType.pricePerCard = 0;

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
      } else {
        const orderInfo = await this.calculateOptimalPrintOrder(numberOfTracks);
        orderType.amountWithMargin = orderInfo.totalPrice;
      }
    }

    return orderType;
  }

  public async calculateOrder(params: any): Promise<ApiResult> {
    try {
      const cartItems = params.cart.items;
      const authToken = await this.getAuthToken();

      // Create a new order with articles
      const orderItems = [];

      for (const item of cartItems) {
        if (item.productType === 'cards') {
          const numberOfTracks = await this.spotify.getPlaylistTrackCount(
            item.playlistId,
            true,
            item.isSlug
          );

          orderItems.push({
            product: 'kaart',
            add_file_method: 'url',
            file_url: `${process.env.API_URI}/public/pdf/${item.filename}`,
            file_overwrite: true,
            size: 'a5',
            copies: item.amount,
            papertype: '350',
            printside: 'double',
            borderless: '1',
            number: numberOfTracks * 2,
            check_doc: 'standard',
          });
        }
      }

      // Make API request to create articles
      const response = await axios({
        method: 'post',
        url: `${process.env['PRINTENBIND_API_URL']}/v1/orders/articles`,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        data: orderItems[0], // Start with first article
      });

      console.log(111, response);

      // Add remaining articles to the order
      const orderId = response.headers.location.split('/')[1];
      for (let i = 1; i < orderItems.length; i++) {
        await axios({
          method: 'post',
          url: `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}/articles`,
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          data: orderItems[i],
        });
      }

      // Get full order details
      const orderResponse = await axios({
        method: 'get',
        url: `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}/articles`,
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      console.log(999, orderResponse.data);

      return { success: false, error: 'Not implemented' };

      //   const articles = orderResponse.data;
      //   let total = 0;
      //   let totalTax = 0;

      //   articles.forEach((article: any) => {
      //     total += article.price_total;
      //     totalTax += article.total_tax;
      //   });

      //   return {
      //     success: true,
      //     data: {
      //       total: total + totalTax,
      //       price: total,
      //       taxRate: (totalTax / total) * 100,
      //       articles: articles,
      //     },
      //   };
    } catch (error) {
      console.log(error);

      this.logger.log(color.red.bold(`Error calculating order: ${error}`));
      return {
        success: false,
        error: `Error calculating order: ${error}`,
      };
    }
  }

  public async testOrder() {
    const authToken = await this.getAuthToken();
    const pdfURL = `${process.env.API_URI}/assets/pdf/example_digital.pdf`;

    const body = {
      email: 'west14@gmail.com',
      items: [
        {
          productId: 'kaarten_enkel_a5_lig_8st_indv',
          pageCount: 16,
          quantity: 1,
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
        url: `${process.env['PRINTENBIND_API_URL']}/v2/orders`,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        data: body,
      });

      const url1 = responseOrder.data.items[0].files.content.uploadUrl;
      // const url2 = responseOrder.data.items[1].files.content.uploadUrl;
      // const url3 = responseOrder.data.items[2].files.content.uploadUrl;
      // const url4 = responseOrder.data.items[3].files.content.uploadUrl;
      // const url5 = responseOrder.data.items[4].files.content.uploadUrl;

      console.log(111, url1);
      // console.log(222, url2);
      // console.log(333, url3);
      // console.log(444, url4);
      // console.log(555, url5);

      // console.log(333, JSON.stringify(responseOrder.data, null, 2));
      const pdfURL1 = `${process.env.API_URI}/public/pdf/a5.pdf`;

      console.log(222, pdfURL1);

      const pdfFile1 = await axios.get(pdfURL1, {
        responseType: 'arraybuffer',
      });

      console.log(333);

      const pdfBuffer1 = Buffer.from(pdfFile1.data, 'binary');

      console.log(444);

      const uploadResult = await axios.post(url1, pdfBuffer1, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/pdf',
        },
      });

      console.log(555, JSON.stringify(uploadResult.data, null, 2));

      console.log('PDF file uploaded successfully');
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        console.log(e);

        ///console.log(999, JSON.stringify(e.response.data, null, 2));
      } else {
        console.error('Error:', e);
      }
    }
  }

  private async getAuthToken(force: boolean = false): Promise<string | null> {
    return process.env['PRINTENBIND_API_KEY']!;
  }

  public async createOrder(
    payment: any,
    playlists: any[],
    productType: string
  ): Promise<any> {
    const authToken = await this.getAuthToken();
    let response: string = '';

    let itemsToSend = [];

    for (var i = 0; i < playlists.length; i++) {
      const playlist = playlists[i];

      const orderType = await this.getOrderType(
        playlist.playlist.numberOfTracks,
        false,
        productType
      );

      let pageCount = 2;

      if (orderType != 'giftcard') {
        pageCount = await this.pdf.countPDFPages(
          `${process.env['PUBLIC_DIR']}/pdf/${playlist.filename}`
        );

        const orderInfo = await this.calculateOptimalPrintOrder(
          playlist.playlist.numberOfTracks
        );

        // Loop through the orderInfo and add the items to the itemsToSend array
        for (const order of orderInfo.order) {
          itemsToSend.push({
            productId: `kaarten_enkel_a5_lig_${order.pages}st_indv`,
            pageCount: order.pages * 2,
            metadata: JSON.stringify({
              filename: playlist.filename,
              id: playlist.playlist.paymentHasPlaylistId,
            }),
            quantity: playlist.playlist.amount,
          });
        }
      } else {
        itemsToSend.push({
          productId: orderType.printApiProductId,
          pageCount, //TODO: Replace with this pageCount,
          metadata: JSON.stringify({
            filename: playlist.filename,
            id: playlist.playlist.paymentHasPlaylistId,
          }),
          quantity: playlist.playlist.amount,
        });
      }
    }

    const body = {
      email: payment.email,
      items: itemsToSend,
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

    // try {
    //   const responseOrder = await axios({
    //     method: 'post',
    //     url: `${process.env['PRINTENBIND_API_URL']}/v2/orders`,
    //     headers: {
    //       Authorization: `Bearer ${authToken}`,
    //       'Content-Type': 'application/json',
    //     },
    //     data: body,
    //   });
    //   response = responseOrder.data;

    //   for (var i = 0; i < responseOrder.data.items.length; i++) {
    //     const item = responseOrder.data.items[i];
    //     const metadata = JSON.parse(item.metadata);
    //     const filename = metadata.filename;
    //     const uploadURL = item.files.content.uploadUrl;
    //     const pdfPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

    //     const dimensions = await this.pdf.getPageDimensions(pdfPath);

    //     const width = dimensions.width.toFixed(2);
    //     const height = dimensions.height.toFixed(2);

    //     this.logger.log(
    //       blue.bold(
    //         `Uploading PDF file (${color.white(width)} x ${color.white(
    //           height
    //         )} mm) ${white.bold(filename)} to URL ${white.bold(uploadURL)}`
    //       )
    //     );

    //     // read the file into pdf buffer
    //     const pdfBuffer = await fs.readFile(pdfPath);

    //     let uploadSuccess = false;
    //     let uploadResponse = '';
    //     try {
    //       const uploadResult = await axios.post(uploadURL, pdfBuffer, {
    //         headers: {
    //           Authorization: `Bearer ${authToken}`,
    //           'Content-Type': 'application/pdf',
    //         },
    //       });

    //       this.logger.log(
    //         blue.bold(
    //           `PDF file uploaded successfully for ${white.bold(filename)}`
    //         )
    //       );

    //       uploadSuccess = true;
    //       uploadResponse = uploadResult.data;
    //     } catch (e) {
    //       if (axios.isAxiosError(e) && e.response) {
    //         uploadResponse = e.response.data;
    //       }

    //       this.logger.log(
    //         color.red.bold(
    //           `Error uploading PDF file for ${white.bold(filename)}`
    //         )
    //       );
    //     }
    //     // Update the paymentHasPlaylist with the filenames
    //     await this.prisma.paymentHasPlaylist.update({
    //       where: {
    //         id: metadata.id,
    //       },
    //       data: {
    //         printApiUploaded: uploadSuccess,
    //         printApiUploadResponse: JSON.stringify(uploadResponse),
    //       },
    //     });
    //   }
    // } catch (e) {
    //   if (axios.isAxiosError(e) && e.response) {
    //     response = e.response.data;
    //   }
    // }

    // Fully output the response with console.log
    //console.log(999, JSON.stringify(response, null, 2));

    return {
      request: body,
      response: response,
    };
  }

  private async createInvoice(order: any, payment: any): Promise<string> {
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

export default PrintEnBind;
