import Log from '../logger';
import { MAX_CARDS, MAX_CARDS_PHYSICAL, BOX_PRICE, boxTierPrice } from '../config/constants';
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
import Discount from '../discount';
import Shipping from '../shipping';
import { QRGAMES_UPGRADE_PRICE } from '../game';

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
  private spotify = Spotify.getInstance();
  private utils = new Utils();
  private discount = new Discount();
  private shipping = Shipping.getInstance();
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
            //await this.calculateShippingCosts();
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
        try {
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
        });} catch(e) {
          console.log(111,numberOfTracks,digital,productType,playlistId, subType);
          console.log(222, e)
        }

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
    cache: boolean = true,
    fast: boolean = false
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
    let paymentMethod = 'bundled';

    if (!this.data.euCountryCodes.includes(customerInfo.countrycode)) {
      paymentMethod = 'account';
    }

    // Add remaining articles
    for (let i = 0; i < items.length; i++) {
      items[i].payment_method = paymentMethod;
      // if (fast) {
      //   items[i].production_method = 'fast';
      // }

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

        // Try to get orderId from header first, fallback to response body
        const headerLocation = response.headers.get('location');
        const bodyOrder = firstResponse.order;
        const bodyLocation = firstResponse.location;

        orderId = headerLocation?.split('/')[1]
          || bodyOrder?.toString()
          || bodyLocation?.split('/')[1];

        if (orderId) {
          physicalOrderCreated = true;

          if (logging) {
            this.logger.log(
              color.blue.bold(
                `Created order: ${color.white.bold(
                  orderId
                )} and added first article — ${color.white.bold(
                  this.describeArticle(items[i])
                )}`
              )
            );
          }
          totalItemsSuccess++;
        } else if (logging) {
          // No orderId → Printenbind rejected the POST (auth, payload
          // shape, etc.). Surface the status + body so we can diagnose
          // without re-running with a debugger attached.
          this.logger.log(
            color.red.bold(
              `Printenbind did not return an orderId for ${color.white.bold(
                customerInfo.countrycode
              )} (POST /orders/articles → ${color.white.bold(
                response.status.toString()
              )})`
            )
          );
          this.logger.log(
            color.gray('  response body: ') +
              color.white(JSON.stringify(firstResponse))
          );
          this.logger.log(
            color.gray('  request body: ') +
              color.white(JSON.stringify(items[i]))
          );
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
              )} to order ${color.white.bold(orderId)} — ${color.white.bold(
                this.describeArticle(items[i])
              )}`
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
    item: any,
    playlistItem: any = null
  ): Promise<any> {
    let numberOfPages = numberOfTracks * 2;
    if (item.addHowToCard) {
      numberOfPages += 2;
    }

    if (numberOfPages > 2000) {
      numberOfPages = 2000;
    }

    if (item.type == 'digital') {
      return item;
    } else {
      // Calculate batch number with item index if available
      const batchNumber = playlistItem
        ? `${item.paymentHasPlaylistId}-${playlistItem.index}`
        : item.paymentHasPlaylistId;

      // When playlistItem exists, we're creating one order item per instance (amount=1)
      // When playlistItem is null (backward compatibility), use original amount
      const orderAmount = playlistItem ? 1 : item.amount;

      let orderObj: any = {
        type: 'physical',
        amount: orderAmount,
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
        comment: `Batch nummer op de kaartjes (rechts onderin op kant met titel/artiest/jaar) moet #${batchNumber} zijn`,
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

      // Print&Bind auto-adds a 2nd/3rd/… box for every 190 cards based on
      // the accessory line — we never specify a box quantity ourselves.
      if (item.boxEnabled) {
        orderObj.accessory_group = 'packaging';
        orderObj.accessory_item = 'box_qrsong';
      }

      return orderObj;
    }
  }

  /**
   * Build a human-readable label describing a Print&Bind article so logs
   * make it obvious whether we're sending game cards or insert cards.
   */
  private describeArticle(item: any): string {
    if (item?.type === 'physical') {
      const comment = typeof item.comment === 'string' ? item.comment : '';
      // Insert card articles carry an "Insert card..." comment and have no
      // batch number — they're identified by playlist name + page count.
      if (/^Insert cards? for/i.test(comment)) {
        const pages = parseInt(item.copies, 10) || 0;
        return `insert cards (${pages} pages)`;
      }
      // Game card articles carry a "Batch nummer ... #X-Y" comment.
      const batchMatch = comment.match(/#([\d-]+)/);
      const batchNumber = batchMatch ? batchMatch[1] : 'unknown';
      return `game cards (Batch #${batchNumber})`;
    }
    return `article (${item?.type ?? 'unknown'})`;
  }

  private createBoxOrderCardItem(
    fileUrl: string,
    playlist: any,
    quantity: number
  ): any {
    return {
      type: 'physical',
      amount: quantity,
      product: 'losbladig',
      number: '1',
      copies: '2',
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      papertype: 'card',
      size_custom_width: '120',
      size_custom_height: '120',
      check_doc: 'standard',
      delivery_method: 'post',
      add_file_method: 'url',
      file_overwrite: true,
      file_url: fileUrl,
      // Box ships as a packaging accessory on this insert-card article.
      accessory_group: 'packaging',
      accessory_item: 'box_qrsong',
      comment: `Box insert for playlist ${playlist.name}`,
    };
  }

  /**
   * Generic insert-card article shape: the file already contains every page
   * that needs printing, so `amount` stays at 1 and `copies` equals the file's
   * actual page count. Used for both single-playlist (pre-multiplied source
   * file) and multi-playlist (merged file) cases.
   */
  private createBoxOrderInsertItem(
    fileUrl: string,
    pageCount: number,
    comment: string
  ): any {
    return {
      type: 'physical',
      amount: 1,
      product: 'losbladig',
      number: '1',
      copies: pageCount.toString(),
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      papertype: 'card',
      size_custom_width: '120',
      size_custom_height: '120',
      check_doc: 'standard',
      delivery_method: 'post',
      add_file_method: 'url',
      file_overwrite: true,
      file_url: fileUrl,
      comment,
    };
  }

  public async createBoxUpgradeOrder(paymentHasPlaylistId: number, quantity: number = 1): Promise<any> {
    this.logger.log(color.blue.bold(`Starting box upgrade Print&Bind order for PHP ${paymentHasPlaylistId} (quantity: ${quantity})`));

    const php = await this.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      include: {
        payment: true,
        playlist: true,
      },
    });

    if (!php || !php.payment) {
      throw new Error(`PaymentHasPlaylist ${paymentHasPlaylistId} not found`);
    }

    const payment = php.payment;
    this.logger.log(color.blue.bold(`Box upgrade for playlist: ${color.white.bold(php.playlist.name)}, customer: ${color.white.bold(payment.fullname)}`));

    // Build box insert card file URL
    const boxFileUrl = php.boxFilename
      ? `${process.env['API_URI']}/public/box-insert/${php.boxFilename}`
      : null;

    const items: any[] = [];

    // The box itself is now a packaging accessory on the insert-card
    // article (Print&Bind no longer accepts a standalone box article).
    // If we have no insert-card PDF, we have nothing to attach the
    // accessory to and the order can't proceed.
    if (!boxFileUrl) {
      this.logger.log(color.red.bold(`No box insert card PDF found for PHP ${paymentHasPlaylistId} — box cannot be ordered without an insert-card article to attach the packaging accessory to.`));
      throw new Error('Box insert card PDF missing — cannot create box upgrade order');
    }

    this.logger.log(color.blue.bold(`Box insert card PDF: ${color.white.bold(boxFileUrl)}`));
    items.push(this.createBoxOrderCardItem(boxFileUrl, php.playlist, quantity));
    this.logger.log(color.blue.bold(`Order items: ${items.length} (insert card + packaging accessory), quantity: ${quantity}`));

    const customerInfo = {
      fullname: payment.fullname || undefined,
      email: payment.email,
      address: payment.address || undefined,
      housenumber: payment.housenumber || undefined,
      zipcode: payment.zipcode || undefined,
      city: payment.city || undefined,
      countrycode: payment.countrycode || 'NL',
    };

    this.logger.log(color.blue.bold(`Shipping to: ${color.white.bold(`${customerInfo.address} ${customerInfo.housenumber}, ${customerInfo.zipcode} ${customerInfo.city}, ${customerInfo.countrycode}`)}`));

    const result = await this.processOrderRequest(items, customerInfo);

    if (result.success && result.data?.orderId) {
      // Finish order in production
      if (process.env['ENVIRONMENT'] === 'production') {
        this.logger.log(color.blue.bold(`Finishing order ${color.white.bold(result.data.orderId)} in production`));
        await this.finishOrder(result.data.orderId, result.apiCalls);
      }

      this.logger.log(
        color.green.bold(`Successfully created box upgrade Print&Bind order: `) +
          color.white.bold(result.data.orderId) +
          color.green.bold(` for PHP ${paymentHasPlaylistId}`)
      );
    } else {
      this.logger.log(color.red.bold(`Failed to create box upgrade Print&Bind order for PHP ${paymentHasPlaylistId}: ${JSON.stringify(result)}`));
    }

    return result;
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

    // Resolve the tax rate along with the EU B2B reverse-charge flag in one
    // call. `taxRate` will be 0 when reverse charge applies; the flag is
    // returned alongside so we can surface it to the checkout UI and the
    // Mollie payment record.
    const taxContext = await this.data.resolveTaxContext({
      buyerCountry: params.countrycode,
      isBusinessOrder: !!params.isBusinessOrder,
      vatId: params.vatId || null,
    });
    const taxRate = taxContext.taxRate;

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
        let itemTotalPrice = item.price * item.amount;
        totalPrice += itemTotalPrice;
        const productPriceWithoutVAT = parseFloat(
          (itemTotalPrice / (1 + (taxRate ?? 0) / 100)).toFixed(2)
        );

        totalProductPriceWithoutVAT += productPriceWithoutVAT;
      }

      let freeShipping: boolean = false;
      let shipping = 0;
      let handling = 0;

      if (physicalItems > 0 && shippingResult) {
        shipping = shippingResult!.cost || 0;
        handling = 0;

        // Calculate total number of playlists ordered
        let totalPlaylists = 0;
        for (const item of params.cart.items) {
          if (item.productType === 'cards') {
            totalPlaylists += parseInt(item.amount) || 0;
          }
        }

        // Free shipping for NL, DE, BE when ordering 2 or more playlists
        if (
          ['NL', 'DE', 'BE'].includes(params.countrycode) &&
          totalPlaylists >= 2
        ) {
          shipping = 0;
        } else if (params.countrycode === 'NL') {
          shipping = 2.99;
        }
      } else if (physicalItems > 0 && !shippingResult) {
        totalPrice = 0;
      }

      if (params.fast) {
        totalPrice = totalPrice * 1.2; // 20% extra for fast track
        totalProductPriceWithoutVAT = totalProductPriceWithoutVAT * 1.2; // 20% extra for fast track
      }

      if (countrySelected) {
        totalPrice += shipping; // + handling;
      }

      // Calculate volume discount for digital cards
      const volumeDiscount = await this.discount.calculateVolumeDiscount(params.cart);

      // Subtract volume discount from total price
      totalPrice -= volumeDiscount;

      // Games fee for card items with games enabled
      const GAMES_FEE = QRGAMES_UPGRADE_PRICE;
      let gamesFee = 0;
      for (const item of orderItems) {
        if (item.productType === 'cards' && item.gamesEnabled === true) {
          gamesFee += GAMES_FEE;
        }
      }
      totalPrice += gamesFee;

      // Box fee for physical/sheets items with box enabled. Discount tier
      // is computed per cart item from its own total box count.
      let boxFee = 0;
      let totalBoxCount = 0;
      for (const item of orderItems) {
        if ((item.type === 'physical' || item.type === 'sheets') && item.boxEnabled === true) {
          const playlistAmount = parseInt(item.amount) || 1;
          const qty = (item.boxQuantity || 0) * playlistAmount;
          totalBoxCount += qty;
          boxFee += qty * boxTierPrice(qty);
        }
      }
      totalPrice += boxFee;

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
          volumeDiscount, // Add volume discount to result
          gamesFee, // Add games fee to result
          qrgamesUnitPrice: QRGAMES_UPGRADE_PRICE, // Per-playlist QRGames price
          boxFee,
          boxUnitPrice: BOX_PRICE,
          totalBoxCount,
          reverseCharge: taxContext.reverseCharge,
          vatIdChecked: taxContext.vatIdChecked || null,
          vatIdStatus: taxContext.vatIdStatus,
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
          body: JSON.stringify({}),
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

      if (!response.ok) {
        this.logger.log(
          color.red.bold(
            `Print&Bind order ${color.white.bold(orderId)} failed to finish: ${response.status}`
          )
        );
        return {
          success: false,
          data: {
            orderId,
          },
          apiCalls: [...(apiCalls || []), ...finishApiCalls],
        };
      }

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
    // Sticker-price helper used by the pricing page and by backend admin
    // audit reporting. There's no specific customer here, so we apply the
    // home-market (NL) rate as the displayed price. The real per-country
    // rate is applied by /order/calculate at checkout.
    const taxRate = (await this.data.getTaxRate('NL'))!;
    let price = 0;
    let colorPrice = 0.018;
    let colorPriceA4 = 0.09;
    let paperPrice = 0.034;
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
      // Calculate physical cards price (type: 'physical' without subType defaults to cards)
      const physical: number =
        (await this.calculateSingleItem({ ...params, type: 'physical', subType: 'none' }, false))
          .price - price;

      // Calculate digital price
      const digital: number =
        (await this.calculateSingleItem({ ...params, type: 'digital', subType: 'none' }, false))
          .price - price;

      // Calculate sheets price
      const sheets: number =
        (
          await this.calculateSingleItem(
            { ...params, type: 'physical', subType: 'sheets' },
            false
          )
        ).price - price;

      alternatives = {
        type: {
          physical: parseFloat(physical.toFixed(2)),
          digital: parseFloat(digital.toFixed(2)),
          sheets: parseFloat(sheets.toFixed(2)),
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

      // Fetch all payment_has_playlist_item records for this playlist
      const items = await this.prisma.paymentHasPlaylistItem.findMany({
        where: {
          paymentHasPlaylistId: playlist.paymentHasPlaylistId,
        },
        orderBy: {
          index: 'asc',
        },
      });

      // If no items exist (backward compatibility), use the old single-item approach
      if (items.length === 0) {
        const filename = playlistItem.filename;
        const fileUrl = `${process.env['API_URI']}/public/pdf/${filename}`;

        // Add the playlist multiple times based on amount property (old behavior)
        const amount = playlist.amount || 1;
        for (let i = 0; i < amount; i++) {
          const orderItem = await this.createOrderItem(
            playlist.numberOfTracks,
            fileUrl,
            playlist,
            null
          );

          orderItems.push(orderItem);
          this.logger.log(
            color.blue.bold(
              `Adding article to ${color.white.bold(
                'Print&Bind'
              )} order. Playlist: ${color.white(
                playlist.name
              )} (${color.white.bold(i + 1)}) Batch number: ${color.white.bold(
                playlist.paymentHasPlaylistId
              )} with ${color.white.bold(
                playlist.numberOfTracks
              )} tracks`
            )
          );
        }
      } else {
        // New behavior: create one order item per payment_has_playlist_item
        for (const item of items) {
          const fileUrl = `${process.env['API_URI']}/public/pdf/${item.filename}`;

          const orderItem = await this.createOrderItem(
            playlist.numberOfTracks,
            fileUrl,
            playlist,
            item
          );

          orderItems.push(orderItem);
          const batchNumber = `${playlist.paymentHasPlaylistId}-${item.index}`;
          this.logger.log(
            color.blue.bold(
              `Adding article to ${color.white.bold(
                'Print&Bind'
              )} order. Playlist: ${color.white(
                playlist.name
              )} Batch number: ${color.white.bold(
                batchNumber
              )} with ${color.white.bold(
                playlist.numberOfTracks
              )} tracks`
            )
          );
        }
      }
    }

    // Collect playlists that need a box insert in this order.
    // Each playlist's boxFilename already contains its design repeated
    // `boxQuantity` times (multiplication happens in generateBoxInsertPdf),
    // so the work here is just (a) read the per-file page count and (b) for
    // multi-playlist orders, merge those pre-multiplied files into one.
    const insertPlaylists = playlists
      .map((p) => p.playlist)
      .filter(
        (playlist: any) =>
          playlist.boxEnabled &&
          playlist.boxQuantity > 0 &&
          playlist.boxFilename
      );

    if (insertPlaylists.length >= 1) {
      const boxInsertDir = `${process.env['PUBLIC_DIR']}/box-insert`;
      const pdfManager = new PDF();

      if (insertPlaylists.length === 1) {
        // Single playlist — the file is already the right size, just
        // create one article with copies=actualPageCount.
        const playlist = insertPlaylists[0];
        const filePath = `${boxInsertDir}/${playlist.boxFilename}`;
        const pageCount = await pdfManager.countPDFPages(filePath);
        const boxFileUrl = `${process.env['API_URI']}/public/box-insert/${playlist.boxFilename}`;

        const insertItem = this.createBoxOrderInsertItem(
          boxFileUrl,
          pageCount,
          `Insert card${playlist.boxQuantity > 1 ? 's' : ''} for playlist ${playlist.name}`
        );
        orderItems.push(insertItem);

        this.logger.log(
          color.blue.bold(
            `Adding insert card article to ${color.white.bold(
              'Print&Bind'
            )} order. Playlist: ${color.white(
              playlist.name
            )} Boxes: ${color.white.bold(
              playlist.boxQuantity
            )} Pages: ${color.white.bold(pageCount)}`
          )
        );
      } else {
        // Multiple playlists — merge their pre-multiplied insert files into
        // a single PDF (no further repetition; each file already contains
        // its boxQuantity copies) and submit one consolidated article.
        const mergedFilename = `box_merged_${payment.paymentId}_${Date.now()}.pdf`;
        const mergedPath = `${boxInsertDir}/${mergedFilename}`;

        const mergeInputs = insertPlaylists.map((playlist: any) => ({
          localPath: `${boxInsertDir}/${playlist.boxFilename}`,
          repeat: 1,
        }));

        const playlistNames = insertPlaylists.map((p: any) => p.name);
        const totalBoxes = insertPlaylists.reduce(
          (sum: number, p: any) => sum + p.boxQuantity,
          0
        );

        this.logger.log(
          color.blue.bold(
            `Merging ${color.white.bold(
              insertPlaylists.length
            )} insert card design(s) into a single PDF (${color.white.bold(
              totalBoxes
            )} insert cards total) for ${color.white.bold('Print&Bind')} order`
          )
        );

        const pageCount = await pdfManager.mergeLocalPdfs(
          mergeInputs,
          mergedPath,
          'insert card'
        );

        const mergedFileUrl = `${process.env['API_URI']}/public/box-insert/${mergedFilename}`;
        const mergedOrderItem = this.createBoxOrderInsertItem(
          mergedFileUrl,
          pageCount,
          `Insert cards for playlists: ${playlistNames.join(', ')}`
        );
        orderItems.push(mergedOrderItem);

        this.logger.log(
          color.blue.bold(
            `Adding merged insert card article to ${color.white.bold(
              'Print&Bind'
            )} order. Playlists: ${color.white(
              playlistNames.join(', ')
            )} Pages: ${color.white.bold(pageCount)}`
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
      false,
      payment.fast || false
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
    payment: any,
    newStatus: string = 'Submitted'
  ): Promise<void> {
    const authToken = await this.getAuthToken();
    const taxRate = (await this.data.getTaxRate(payment.countrycode))!;

    const totalPriceWithoutTax = parseFloat(
      (payment.totalPrice / (1 + (taxRate ?? 0) / 100)).toFixed(2)
    );

    let printApiPrice = 0;
    let printApiPriceInclVat = 0;

    try {
      const orderResponse = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/orders/${printApiOrderId}`,
        {
          method: 'GET',
          headers: { Authorization: authToken! },
        }
      );

      const order = await orderResponse.json();

      if (!orderResponse.ok) {
        this.logger.log(
          color.red.bold(
            `Failed to fetch order ${printApiOrderId}: ${orderResponse.status} ${JSON.stringify(order)}`
          )
        );
        return;
      }

      printApiPrice = parseFloat(order.amount) || 0;
      const amountTax = parseFloat(order.amount_tax_standard) || 0;
      printApiPriceInclVat = parseFloat(
        (printApiPrice + amountTax).toFixed(2)
      );

      const newProfit = totalPriceWithoutTax - printApiPrice;

      await this.prisma.payment.update({
        where: { paymentId: payment.paymentId },
        data: {
          printApiPrice,
          printApiPriceInclVat,
          totalPriceWithoutTax,
          profit: newProfit,
          printApiStatus: newStatus,
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

  public async processPrintApiWebhook(printApiOrderId: string) {}

  public async calculateShippingCosts(countryCodes?: string[]): Promise<void> {
    const authToken = await this.getAuthToken();
    const codes = countryCodes || this.countryCodes;

    this.logger.log(
      color.blue.bold(
        `Calculating shipping costs for ${color.white.bold(
          codes.length.toString()
        )} countries: ${codes.join(', ')}`
      )
    );

    // Process countries one at a time. Parallel runs collided on Printenbind
    // (shared file uploads, rate limits) — serial is slower but deterministic
    // and much easier to reason about in the logs.
    for (let i = 0; i < codes.length; i++) {
      const countryCode = codes[i];
      this.logger.log(
        color.blue.bold(
          `[${i + 1}/${codes.length}] Starting ${color.white.bold(countryCode)}`
        )
      );
      await this.processCountryShippingCosts(countryCode, authToken!);
      // Gentle pause between countries so we don't blow past the API's
      // request ceiling. 1s is plenty for a 3-call-per-country workload.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private async processCountryShippingCosts(
    countryCode: string,
    authToken: string
  ): Promise<void> {
    const amountConfigs = [
      { amount: 116, fileUrl: 'https://api.qrsong.io/public/pdf/tr_btmfhy8aerkdijt2ynejj_2149_extra_printer_1.pdf' },
      { amount: 412, fileUrl: 'https://api.qrsong.io/public/pdf/tr_zadlfwasljqchqeaaycjj_1871_qr_printer_1.pdf' },
      { amount: 1680, fileUrl: 'https://api.qrsong.io/public/pdf/tr_hcvtkvdmgqe37hujmvfjj_2163_supplies_printer_1.pdf' },
    ];

    try {
      // Process each amount sequentially for this country. Parallel runs
      // caused Printenbind rate-limit and file-overwrite collisions.
      for (const { amount, fileUrl } of amountConfigs) {
        try {
          // Check if record exists
          const existingRecord = await this.prisma.shippingCostNew.findFirst({
            where: {
              country: countryCode,
              size: amount,
            },
          });

            this.logger.log(
              color.blue.bold(
                `Processing country: ${color.white.bold(
                  countryCode
                )} for amount ${color.white.bold(amount)}`
              )
            );

            const orderItems = [];
            // Create order item matching actual order structure
            // delivery_method is always 'post' in order item, 'international' is set in delivery setup
            const isNL = countryCode === 'NL';
            const orderItem: any = {
              type: 'physical',
              amount: '1',
              product: 'losbladig',
              number: '1',
              copies: (amount).toString(),
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
              file_url: fileUrl,
              // Printenbind rejects duplicate filenames with "bestaat al op
              // onze server". These shipping-cost probes reuse the same
              // three fixture PDFs on every run; without overwrite, only
              // the very first country succeeds and every subsequent 400s.
              file_overwrite: true,
            };
            if (isNL) {
              orderItem.delivery_option = 'standard';
            }
            orderItems.push(orderItem);

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
              false,
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
              // Dump the full result incl. apiCalls + Printenbind response
              // bodies so we can see which step Printenbind rejected (auth,
              // size, country, etc.) rather than just "failed".
              this.logger.log(
                color.red.bold(
                  `Failed to calculate shipping for ${color.white.bold(
                    countryCode
                  )} with ${color.white.bold(amount.toString())} items`
                )
              );
              this.logger.log(
                color.red.bold('  └─ result: ') +
                  color.white(JSON.stringify(result, null, 2))
              );
              if ((result as any).apiCalls) {
                for (const call of (result as any).apiCalls as Array<any>) {
                  this.logger.log(
                    color.yellow.bold(
                      `     [${call.statusCode}] ${call.method} ${call.url}`
                    )
                  );
                  if (call.body) {
                    this.logger.log(
                      color.gray('       body:     ') +
                        color.white(JSON.stringify(call.body))
                    );
                  }
                  this.logger.log(
                    color.gray('       response: ') +
                      color.white(JSON.stringify(call.responseBody))
                  );
                }
              }
            }
          } catch (error) {
            this.logger.log(
              color.red.bold(
                `Error processing ${color.white.bold(
                  countryCode
                )} with ${color.white.bold(amount.toString())} items: ${error}`
              )
            );
          if (error instanceof Error && error.stack) {
            this.logger.log(color.gray(error.stack));
          }
        }
        // Brief breather between amount probes so the same file never
        // gets re-uploaded back-to-back.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
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
      this.logger.log(color.red.bold(`Error getting order status for order ID ${orderId}: ${error}`));
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

            if (!orderStatus) {
              this.logger.log(color.red.bold(`Skipping order ID ${order.printApiOrderId} (paymentId: ${order.paymentId}): failed to get order status`));
              continue;
            }

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
                // Invoice is now sent with confirmation email, not tracking email
                this.mail.sendTrackingEmail(payment, trackingLink, '');
                this.logger.log(
                  color.blue.bold(
                    `Sent tracking email for order ${color.white.bold(
                      order.printApiOrderId
                    )} (${color.white.bold(payment.printApiTrackingLink)})`
                  )
                );
                await this.shipping.createShipment(payment.paymentId);
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
          await this.setPaymentInfo(
            paymentData.printApiOrderId,
            paymentData,
            paymentData.printApiStatus
          );
        }
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error updating payments with printApiOrderId: ${error}`)
      );
    }
  }

  /**
   * Updates the production method for an existing PrintEnBind order
   * @param orderId - The PrintEnBind order ID
   * @param productionMethod - 'fast' or 'standard'
   */
  public async updateProductionMethod(
    orderId: string,
    productionMethod: 'fast' | 'standard'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const authToken = await this.getAuthToken();

      const response = await fetch(
        `${process.env['PRINTENBIND_API_URL']}/v1/orders/${orderId}`,
        {
          method: 'PUT',
          headers: {
            Authorization: authToken!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            production_method: productionMethod,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.log(
          color.red.bold(
            `Failed to update production method for order ${color.white.bold(
              orderId
            )}: ${errorText}`
          )
        );
        return {
          success: false,
          error: `Failed to update production method: ${response.statusText}`,
        };
      }

      this.logger.log(
        color.blue.bold(
          `Updated production method for order ${color.white.bold(
            orderId
          )} to ${color.white.bold(productionMethod)}`
        )
      );

      return { success: true };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Error updating production method for order ${color.white.bold(
            orderId
          )}: ${error.message}`
        )
      );
      return { success: false, error: error.message };
    }
  }
}

export default PrintEnBind;
