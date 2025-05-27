import Log from '../logger';
import { MAX_CARDS, MAX_CARDS_PHYSICAL } from '../config/constants';
import PrismaInstance from '../prisma';
import Cache from '../cache';
import { ApiResult } from '../interfaces/ApiResult';
import { color, blue, white, magenta } from 'console-log-colors';
import Mail from '../mail';
import fs from 'fs/promises';
import Data from '../data';
import PDF from '../pdf';
import crypto from 'crypto';
import Spotify from '../spotify';
import Utils from '../utils';
import cluster from 'cluster';
import { CronJob } from 'cron';
import { SingleItemCalculation } from '../interfaces/SingleItemCalculation';

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
  private countryCodes: string[] = [
    'AF',
    'AX',
    'AL',
    'DZ',
    'AS',
    'AD',
    'AO',
    'AI',
    'AQ',
    'AG',
    'AR',
    'AM',
    'AW',
    'AU',
    'AT',
    'AZ',
    'BS',
    'BH',
    'BD',
    'BB',
    'BY',
    'BE',
    'BZ',
    'BJ',
    'BM',
    'BT',
    'BO',
    'BQ',
    'BA',
    'BW',
    'BV',
    'BR',
    'IO',
    'BN',
    'BG',
    'BF',
    'BI',
    'KH',
    'CM',
    'CA',
    'CV',
    'KY',
    'CF',
    'TD',
    'CL',
    'CN',
    'CX',
    'CC',
    'CO',
    'KM',
    'CG',
    'CD',
    'CK',
    'CR',
    'CI',
    'HR',
    'CW',
    'CY',
    'CZ',
    'DK',
    'DJ',
    'DM',
    'DO',
    'EC',
    'EG',
    'SV',
    'GQ',
    'ER',
    'EE',
    'ET',
    'FK',
    'FO',
    'FJ',
    'FI',
    'FR',
    'GF',
    'PF',
    'TF',
    'GA',
    'GM',
    'GE',
    'DE',
    'GH',
    'GI',
    'GR',
    'GL',
    'GD',
    'GP',
    'GU',
    'GT',
    'GG',
    'GN',
    'GW',
    'GY',
    'HT',
    'HM',
    'VA',
    'HN',
    'HK',
    'HU',
    'IS',
    'IN',
    'ID',
    'IQ',
    'IE',
    'IM',
    'IL',
    'IT',
    'JM',
    'JP',
    'JE',
    'JO',
    'KZ',
    'KE',
    'KI',
    'KR',
    'KW',
    'KG',
    'LA',
    'LV',
    'LB',
    'LS',
    'LR',
    'LY',
    'LI',
    'LT',
    'LU',
    'MO',
    'MK',
    'MG',
    'MW',
    'MY',
    'MV',
    'ML',
    'MT',
    'MH',
    'MQ',
    'MR',
    'MU',
    'YT',
    'MX',
    'FM',
    'MD',
    'MC',
    'MN',
    'ME',
    'MS',
    'MA',
    'MZ',
    'MM',
    'NA',
    'NR',
    'NP',
    'NL',
    'AN',
    'NC',
    'NZ',
    'NI',
    'NE',
    'NG',
    'NU',
    'NF',
    'MP',
    'NO',
    'OM',
    'PK',
    'PW',
    'PS',
    'PA',
    'PG',
    'PY',
    'PE',
    'PH',
    'PN',
    'PL',
    'PT',
    'PR',
    'QA',
    'RE',
    'RO',
    'RU',
    'RW',
    'BL',
    'SH',
    'KN',
    'LC',
    'MF',
    'PM',
    'VC',
    'WS',
    'SM',
    'ST',
    'SA',
    'SN',
    'RS',
    'SC',
    'SL',
    'SG',
    'SX',
    'SK',
    'SI',
    'SB',
    'SO',
    'ZA',
    'GS',
    'SS',
    'ES',
    'LK',
    'SR',
    'SJ',
    'SZ',
    'SE',
    'CH',
    'TW',
    'TJ',
    'TZ',
    'TH',
    'TL',
    'TG',
    'TK',
    'TO',
    'TT',
    'TN',
    'TR',
    'TM',
    'TC',
    'TV',
    'UG',
    'UA',
    'AE',
    'GB',
    'US',
    'UM',
    'UY',
    'UZ',
    'VU',
    'VE',
    'VN',
    'VG',
    'VI',
    'WF',
    'EH',
    'YE',
    'ZM',
    'ZW',
  ];

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          // Schedule hourly cache refresh
          const trackingJob = new CronJob('15 * * * *', async () => {
            await this.handleTrackingMails();
          });
          trackingJob.start();

          // Schedule monthly shipping costs update (1st day of month at 1 AM)
          const shippingJob = new CronJob('0 1 1 * *', async () => {
            await this.calculateShippingCosts();
          });
          shippingJob.start();
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
    productType: string = 'cards',
    playlistId: string,
    subType: 'sheets' | 'none' = 'none'
  ) {
    let orderType = null;
    let digitalInt = digital ? 1 : 0;
    let maxCards = digital ? MAX_CARDS : MAX_CARDS_PHYSICAL;
    let cacheKey = `orderType_${numberOfTracks}_${digitalInt}_${productType}`;
    if (digital) {
      // There is just one digital product
      cacheKey = `orderType_${digitalInt}_${productType}`;
    }

    const cachedOrderType = await this.cache.get(cacheKey);

    if (numberOfTracks > maxCards) {
      numberOfTracks = maxCards;
    }

    if (cachedOrderType) {
      orderType = JSON.parse(cachedOrderType);
    } else {
      orderType = await this.prisma.orderType.findFirst({
        where: {
          type: productType,
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

    if (numberOfTracks > maxCards) {
      numberOfTracks = maxCards;
    }

    if (orderType && productType == 'cards') {
      const singleCalculation = await this.calculateSingleItem({
        productType: 'cards',
        type: digital ? 'digital' : 'physical',
        quantity: numberOfTracks,
        alternatives: {},
        subType,
      });
      orderType.amount = singleCalculation.price;
      orderType.alternatives = singleCalculation.alternatives;
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
    let totalItems = items.length;
    let totalItemsSuccess = 0;

    // Add remaining articles
    for (let i = 0; i < items.length; i++) {
      if (items[i].type == 'physical' && !physicalOrderCreated) {
        if (items[i].type == 'physical') {
          const orderType = await this.getOrderType(
            parseInt(items[i].copies) / 2,
            false,
            'cards',
            items[i].playlistId
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

        const firstResponse = await response.clone().json();

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

        if (orderId) {
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
          totalItemsSuccess++;
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
              `Added article ${color.white.bold(
                i + 1
              )} to order ${color.white.bold(orderId)}`
            )
          );
        }

        totalItemsSuccess++;
      } else if (items[i].type == 'digital') {
        const orderType = await this.getOrderType(
          items[i].numberOfTracks,
          true,
          items[i].productType,
          items[i].playlistId
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

          //totalProductPriceWithoutVAT += productPriceWithoutVAT;
          total += itemPrice;
          price += parseFloat(productPriceWithoutVAT.toFixed(2));

          totalItemsSuccess++;
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
        name_contact: customerInfo.fullname?.trim() || 'John Doe',
        street: customerInfo.address?.trim() || 'Some lane',
        city: customerInfo.city?.trim() || 'Amsterdam',
        streetnumber: customerInfo.housenumber?.trim() || '1',
        zipcode: customerInfo.zipcode?.trim() || '1234AB',
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

    let result = {
      success: false,
      data: {},
      ...(logging ? { apiCalls } : {}),
    };

    if (totalItemsSuccess == totalItems) {
      result = {
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
    }

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

    if (item.type == 'digital') {
      return item;
    } else {
      let orderObj: any = {
        type: 'physical',
        amount: item.amount,
        product: 'losbladig',
        number: '1',
        copies: numberOfPages.toString(),
        color: 'all',
        size: 'custom',
        printside: 'double',
        finishing: 'loose',
        papertype: 'card',
        size_custom_width: '60',
        size_custom_height: '60',
        check_doc: 'standard',
        delivery_method: 'post',
        add_file_method: 'url',
        file_overwrite: true,
        file_url: fileUrl,
        comment: `Batch nummer op de kaartjes (rechts onderin op kant met titel/artiest/jaar) moet #${item.paymentHasPlaylistId} zijn`,
      };

      if (item.subType == 'sheets') {
        orderObj.copies = (Math.ceil(numberOfTracks / 12) * 2).toString();
        orderObj.size = 'a4';
        delete orderObj.size_custom_width;
        delete orderObj.size_custom_height;
        orderObj.comment =
          orderObj.comment +
          '. Deze bestelling is een A4 die door de klant zelf uitgeknipt zal gaan worden.';
      }

      return orderObj;
    }
  }

  public async calculateOrder(params: any): Promise<any> {
    let countrySelected = false;
    let totalNumberOfTracks = 0;

    for (const item of params.cart.items) {
      if (item.productType === 'cards') {
        totalNumberOfTracks += parseInt(item.numberOfTracks);
      }
    }

    if (!params.countrycode) {
      params.countrycode = 'NL';
    } else {
      countrySelected = true;
    }

    const taxRate = (await this.data.getTaxRate(params.countrycode))!;

    try {
      const orderItems = [];

      for (const item of params.cart.items) {
        if (item.productType === 'cards') {
          orderItems.push(item);
        } else if (item.productType == 'giftcard') {
          const orderItem = await this.createOrderItem(0, '', item);
          orderItems.push(orderItem);
        }
      }

      let subType: 'sheets' | 'none' = 'none';

      // If the params.cart.items only contains items with subType 'sheets', set subType to 'sheets'
      if (orderItems.every((item) => item.type === 'sheets')) {
        subType = 'sheets';
      }

      const shippingResult = await this.getShippingCosts(
        params.countrycode,
        totalNumberOfTracks,
        subType
      );

      // Count the number of physical items
      let physicalItems = 0;
      let totalPrice = 0;
      let totalProductPriceWithoutVAT = 0;

      for (const item of orderItems) {
        if (item.type == 'physical' || item.type == 'sheets') {
          physicalItems += parseInt(item.amount);
        }
        totalPrice += item.price * item.amount;
        const productPriceWithoutVAT = parseFloat(
          ((item.price * item.amount) / (1 + (taxRate ?? 0) / 100)).toFixed(2)
        );

        totalProductPriceWithoutVAT += productPriceWithoutVAT;
      }

      let freeShipping: boolean = false;
      let shipping = 0;
      let handling = 0;

      if (physicalItems > 0 && shippingResult) {
        shipping = shippingResult!.cost || 0;
        handling = 0;
        if (params.countrycode === 'NL') {
          if (totalPrice >= 50) {
            shipping = 0;
          } else {
            shipping = 2.99;
          }
        } else {
          shipping -= 3;
        }
      } else if (physicalItems > 0 && !shippingResult) {
        totalPrice = 0;
      }

      if (countrySelected) {
        totalPrice += shipping; // + handling;
      }

      const result = {
        success: true,
        data: {
          orderId: '',
          total: totalPrice,
          shipping,
          handling,
          taxRateShipping: taxRate,
          taxRate,
          price: totalProductPriceWithoutVAT,
          payment: shipping, // + handling,
        },
      };

      return result;
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

  public async calculateSingleItem(
    params: SingleItemCalculation,
    recurse: boolean = true
  ): Promise<{ price: number; alternatives: any }> {
    const taxRate = (await this.data.getTaxRate('NL'))!;
    let price = 0;
    let colorPrice = 0.018;
    let colorPriceA4 = 0.09;
    let paperPrice = 0.035;
    let paperPriceA4 = 0.104;
    let cardPrice = colorPrice * 2 + paperPrice;
    let A4Price = colorPriceA4 * 2 + paperPriceA4;
    let priceWithProfit = 0;
    let minimumCards = 50;
    let useCardAmount = params.quantity;
    let numberOfSheets = 0;

    if (useCardAmount < minimumCards) {
      useCardAmount = minimumCards;
    }

    numberOfSheets = Math.ceil(useCardAmount / 12);

    if (params.type == 'physical') {
      if (params.subType == 'sheets') {
        price = numberOfSheets * A4Price;
      } else {
        price = useCardAmount * cardPrice;
      }

      price += 1.8; // Handling
    } else {
      price = (await this.calculateCardPrice(13, useCardAmount)).totalPrice;
    }

    price = parseFloat(price.toFixed(2));

    if (params.type == 'physical') {
      // Smart profit scaling function
      const calculateProfit = (basePrice: number, quantity: number): number => {
        // Minimum profit we want to make
        const minProfit = 12;

        // Base margin starts at 50% (1.5)
        let margin = 1.5;

        // Scale down margin based on quantity
        if (quantity > 400) {
          // After 400 items, reduce margin more aggressively
          margin = 1.5 - (0.3 * (quantity - 400)) / 600;
          // Don't go below 1.2 (20% margin)
          margin = Math.max(margin, 1.2);
        } else if (quantity > 100) {
          // Between 100-400 items, reduce margin gradually
          margin = 1.5 - (0.1 * (quantity - 100)) / 300;
        }

        // Calculate price with margin
        let priceWithMargin = basePrice * margin;

        // Ensure minimum profit
        if (priceWithMargin - basePrice < minProfit) {
          priceWithMargin = basePrice + minProfit;
        }

        return priceWithMargin;
      };

      priceWithProfit = calculateProfit(price, useCardAmount);
      price = priceWithProfit * (1 + taxRate / 100);
    }

    price = Math.ceil(price);

    let alternatives = {};
    if (recurse) {
      const physical: number =
        (await this.calculateSingleItem({ ...params, type: 'physical' }, false))
          .price - price;

      const digital: number =
        (await this.calculateSingleItem({ ...params, type: 'digital' }, false))
          .price - price;

      // const cards: number =
      //   (await this.calculateSingleItem({ ...params, format: 'cards' }, false))
      //     .price - price;

      const sheets: number =
        (
          await this.calculateSingleItem(
            { ...params, type: 'physical', subType: 'sheets' },
            false
          )
        ).price - price;

      // const single: number =
      //   (await this.calculateSingleItem({ ...params, format: 'single' }, false))
      //     .price - price;

      // const double: number =
      //   (await this.calculateSingleItem({ ...params, format: 'double' }, false))
      //     .price - price;

      // const color: number =
      //   (
      //     await this.calculateSingleItem(
      //       { ...params, colorMode: 'color' },
      //       false
      //     )
      //   ).price - price;

      // const bw: number =
      //   (await this.calculateSingleItem({ ...params, colorMode: 'bw' }, false))
      //     .price - price;

      alternatives = {
        type: {
          physical: parseFloat(physical.toFixed(2)),
          digital: parseFloat(digital.toFixed(2)),
          // cards: parseFloat(cards.toFixed(2)),
          sheets: parseFloat(sheets.toFixed(2)),
          // single: parseFloat(single.toFixed(2)),
          // double: parseFloat(double.toFixed(2)),
          // color: parseFloat(color.toFixed(2)),
          // bw: parseFloat(bw.toFixed(2)),
        },
      };
    }
    return {
      price: parseFloat(price.toFixed(2)),
      alternatives,
    };
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

      const fileUrl = `${process.env['API_URI']}/public/pdf/${filename}`;

      // Add the playlist multiple times based on amount property
      const amount = playlist.amount || 1; // Default to 1 if amount not specified
      for (let i = 0; i < amount; i++) {
        const orderItem = await this.createOrderItem(
          playlist.numberOfTracks,
          fileUrl,
          playlist
        );

        orderItems.push(orderItem);
        this.logger.log(
          color.blue.bold(
            `Adding article to ${color.white.bold(
              'Print&Bind'
            )} order. Playlist: ${color.white(
              playlist.name
            )} (${color.white.bold(i + 1)}) with ${color.white.bold(
              playlist.numberOfTracks
            )} tracks`
          )
        );
      }
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

    if (result.success) {
      if (process.env['ENVIRONMENT'] === 'production') {
        const finishResult = await this.finishOrder(
          result.data.orderId,
          finalApiCalls
        );
        finalApiCalls = finishResult.apiCalls || [];
      }

      this.logger.log(
        color.blue.bold(
          `Finished order ${color.white.bold(result.data.orderId)}`
        )
      );

      const delivery = await this.getDeliveryInfo(result.data.orderId);
      const trackingLink = delivery?.tracktrace_url || '';

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
          where: { paymentId: payment.paymentId },
          data: {
            printApiTrackingLink: trackingLink,
          },
        });
      }

      this.setPaymentInfo(result.data.orderId, payment);

      return {
        success: true,
        request: '',
        response: {
          apiCalls: finalApiCalls,
          id: result.data.orderId,
        },
      };
    } else {
      return {
        success: false,
        request: '',
        response: {
          apiCalls: finalApiCalls,
        },
      };
    }
  }

  private async setPaymentInfo(
    printApiOrderId: string,
    payment: any
  ): Promise<void> {
    const authToken = await this.getAuthToken();
    const taxRate = (await this.data.getTaxRate(payment.countrycode))!;

    const totalPriceWithoutTax = parseFloat(
      (payment.totalPrice / (1 + (taxRate ?? 0) / 100)).toFixed(2)
    );

    let printApiPrice = 0;

    try {
      const orderResponse = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/orders/${printApiOrderId}`,
        {
          method: 'GET',
          headers: { Authorization: authToken! },
        }
      );

      const order = await orderResponse.json();

      printApiPrice = parseFloat(order.amount);

      const newProfit = totalPriceWithoutTax - printApiPrice;

      await this.prisma.payment.update({
        where: { paymentId: payment.paymentId },
        data: {
          printApiPrice,
          totalPriceWithoutTax,
          profit: newProfit,
          printApiStatus: 'Submitted',
        },
      });

      this.logger.log(
        color.blue.bold(
          `Payment info updated for order ${color.white.bold(
            printApiOrderId
          )} [TP: ${color.white.bold(
            payment.totalPrice.toFixed(2)
          )}] [TPWT: ${color.white.bold(
            totalPriceWithoutTax.toFixed(2)
          )}] [API: ${color.white.bold(
            printApiPrice.toFixed(2)
          )}] [PR: ${color.white.bold(newProfit.toFixed(2))}]`
        )
      );
    } catch (e) {
      console.log(123, e);
      // Nothing
    }
  }

  private async createInvoice(payment: any): Promise<string> {
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
      // If the file doesn't exist, create it using ConvertAPI
      const pdfManager = new PDF();
      const options = {
        File: invoiceUrl,
        PageSize: 'a4',
        RespectViewport: 'false',
        MarginTop: 0,
        MarginRight: 0,
        MarginBottom: 0,
        MarginLeft: 0,
        ConversionDelay: 3,
        CompressPDF: 'true',
      };

      // Create the directory if it doesn't exist
      const dir = `${process.env['PRIVATE_DIR']}/invoice`;
      try {
        await fs.access(dir);
      } catch (error) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Use the ConvertAPI to generate the PDF
      const convertapi = pdfManager['convertapi']; // Access the convertapi instance from PDF class
      const result = await convertapi.convert('pdf', options, 'htm');
      await result.saveFiles(pdfPath);

      // Ensure the PDF is properly sized
      await pdfManager.resizePDFPages(pdfPath, 210, 297); // A4 size in mm

      this.logger.log(blue.bold(`Invoice created at: ${white.bold(pdfPath)}`));
    }

    return pdfPath;
  }

  public async processPrintApiWebhook(printApiOrderId: string) {}

  public async calculateShippingCosts(): Promise<void> {
    const authToken = await this.getAuthToken();
    let countryCodes = this.countryCodes;

    this.logger.log(
      color.blue.bold(
        `Calculating shipping costs for ${color.white.bold(
          countryCodes.length.toString()
        )} countries`
      )
    );

    // Process countries in batches of 5
    const batchSize = 5;
    for (let i = 0; i < countryCodes.length; i += batchSize) {
      const countryBatch = countryCodes.slice(i, i + batchSize);

      await Promise.all(
        countryBatch.map(async (countryCode) => {
          await this.processCountryShippingCosts(countryCode, authToken!);
        })
      );

      // Add a small delay between batches to avoid overwhelming the API
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private async processCountryShippingCosts(
    countryCode: string,
    authToken: string
  ): Promise<void> {
    const amounts = [80, 405, 1000];

    try {
      // Process all amounts in parallel for this country
      await Promise.all(
        amounts.map(async (amount) => {
          try {
            // Check if record exists
            const existingRecord = await this.prisma.shippingCostNew.findFirst({
              where: {
                country: countryCode,
                size: amount,
              },
            });

            const threeWeeksAgo = new Date();
            threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);

            this.logger.log(
              color.blue.bold(
                `Processing country: ${color.white.bold(
                  countryCode
                )} for amount ${color.white.bold(amount)}`
              )
            );

            const orderItems = [];
            // Create items with 2000 pages each
            orderItems.push({
              type: 'physical',
              amount: '1',
              product: 'losbladig',
              number: '1',
              copies: (amount * 2).toString(),
              color: 'all',
              size: 'custom',
              printside: 'double',
              finishing: 'loose',
              finishing2: 'none',
              papertype: 'card',
              size_custom_width: '60',
              size_custom_height: '60',
              check_doc: 'standard',
              delivery_method: 'post',
              add_file_method: 'url',
              file_url:
                'https://api.qrsong.io/public/pdf/f6d1ad6be0c3f5a06fc4d0b8b1776b791f5b7f3d46cc9864d5c4c1ef3380016c_printer.pdf',
            });

            // Process the order request
            const result = await this.processOrderRequest(
              orderItems,
              {
                fullname: 'Rick Groenewegen',
                email: 'john@doe.com',
                address: 'Prinsenhof 1',
                housenumber: '1',
                zipcode: '1234AB',
                city: 'Sassenheim',
                countrycode: countryCode,
              },
              true,
              false
            );

            if (result.success) {
              const deliveryResponse = await fetch(
                `${process.env['PRINTENBIND_API_URL']}/v1/delivery/${result.data.orderId}`,
                {
                  method: 'GET',
                  headers: { Authorization: authToken },
                }
              );

              const delivery = await deliveryResponse.json();

              const price = delivery.amount / delivery.parcel_count;

              if (existingRecord) {
                await this.prisma.shippingCostNew.update({
                  where: { id: existingRecord.id },
                  data: {
                    cost: parseFloat(price.toFixed(2)),
                  },
                });
              } else {
                await this.prisma.shippingCostNew.create({
                  data: {
                    country: countryCode,
                    size: amount,
                    cost: parseFloat(price.toFixed(2)),
                  },
                });
              }

              this.logger.log(
                color.blue.bold(
                  `Stored shipping costs for ${color.white.bold(
                    countryCode
                  )} with ${color.white.bold(
                    amount.toString()
                  )} items: Shipping: ${color.white.bold(
                    result.data.shipping.toFixed(2)
                  )}, Handling: ${color.white.bold(
                    result.data.handling.toFixed(2)
                  )}`
                )
              );
            } else {
              this.logger.log(
                color.blue.bold(
                  `Skipping ${color.white.bold(
                    countryCode
                  )} with ${color.white.bold(
                    amount.toString()
                  )} items - record is recent enough`
                )
              );
            }
          } catch (error) {
            this.logger.log(
              color.red.bold(
                `Error processing ${color.white.bold(
                  countryCode
                )} with ${color.white.bold(amount.toString())} items: ${error}`
              )
            );
          }
        })
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error processing country ${color.white.bold(countryCode)}: ${error}`
        )
      );
    }
  }

  public async getShippingCosts(
    countryCode: string,
    amountTracks: number,
    subType: 'sheets' | 'none' = 'none'
  ): Promise<{ cost: number } | null> {
    try {
      let amount = 0;
      const marginArray = [80, 405, 1000];

      // Chech to which number in marginArray the amountTracks belongs. Everything <=80 belongs to 80 etc
      for (let i = 0; i < marginArray.length; i++) {
        if (amountTracks <= marginArray[i]) {
          amount = marginArray[i];
          break;
        }
      }

      // If the amount is bigger than 1000, set it to 1000
      if (amountTracks > 1000) {
        amount = 1000;
      }

      if (subType == 'sheets') {
        amount = marginArray[0];
      }

      // Check cache first
      const cacheKey = `shipping_costs_${countryCode}_${amount}`;
      const cachedCosts = await this.cache.get(cacheKey);

      if (cachedCosts) {
        return JSON.parse(cachedCosts);
      }

      // Get from database if not in cache
      const costs = await this.prisma.shippingCostNew.findFirst({
        where: {
          country: countryCode,
          size: amount,
        },
        select: {
          cost: true,
        },
      });

      if (costs) {
        // Cache the results for 1 day
        await this.cache.set(cacheKey, JSON.stringify(costs), 86400);
        return costs;
      }

      return null;
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting shipping costs: ${error}`));
      return null;
    }
  }

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

  private async getDeliveryInfo(orderId: string): Promise<any> {
    try {
      const authToken = await this.getAuthToken();
      const response = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/delivery/${orderId}`,
        {
          method: 'GET',
          headers: { Authorization: authToken! },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get delivery info: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting delivery info: ${error}`));
      return null;
    }
  }

  public async handleTrackingMails(): Promise<void> {
    try {
      const unshippedOrders = await this.prisma.payment.findMany({
        where: {
          printApiStatus: 'Submitted',
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
        for (const order of unshippedOrders) {
          const payment = await this.prisma.payment.findUnique({
            where: { paymentId: order.paymentId },
          });

          if (payment) {
            const orderStatus = await this.getOrderStatus(
              order.printApiOrderId
            );

            if (orderStatus.status == 'Verzonden') {
              this.logger.log(
                color.blue.bold(
                  `Order ${color.white.bold(
                    order.printApiOrderId
                  )} has been shipped`
                )
              );

              // Get the latest delivery info to ensure we have the most up-to-date tracking link
              const deliveryInfo = await this.getDeliveryInfo(
                order.printApiOrderId
              );
              const trackingLink =
                deliveryInfo?.tracktrace_url ||
                payment.printApiTrackingLink ||
                '';

              // Update order status and tracking link
              await this.prisma.payment.update({
                where: { id: order.id },
                data: {
                  printApiShipped: true,
                  printApiStatus: 'Shipped',
                  printApiTrackingLink: trackingLink,
                },
              });

              if (trackingLink && trackingLink.length > 0) {
                const pdfPath = await this.createInvoice(payment);
                this.mail.sendTrackingEmail(payment, trackingLink, pdfPath);
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
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error retrieving unshipped orders: ${error}`)
      );
    }
  }

  /**
   * Retrieves all payments with a printApiOrderId > 0 and calls setPaymentInfo for each.
   */
  public async updateAllPaymentsWithPrintApiOrderId(): Promise<void> {
    try {
      const payments = await this.prisma.payment.findMany({
        where: {
          AND: [
            {
              printApiOrderId: {
                not: '',
              },
            },
            {
              printApiOrderId: {
                not: undefined,
              },
            },
          ],
        },
        select: {
          paymentId: true,
        },
      });

      this.logger.log(
        color.blue.bold(
          `Updating payment info for ${color.white.bold(
            payments.length.toString()
          )} payments`
        )
      );

      for (const payment of payments) {
        const paymentData = await this.prisma.payment.findUnique({
          where: { paymentId: payment.paymentId },
        });
        if (
          paymentData &&
          paymentData.printApiOrderId &&
          paymentData.printApiOrderId !== ''
        ) {
          await this.setPaymentInfo(paymentData.printApiOrderId, paymentData);
        }
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error updating payments with printApiOrderId: ${error}`)
      );
    }
  }
}

export default PrintEnBind;
