import Log from '../logger';
import { maxCardsFor, BOX_PRICE, BOX_UNIT_COST, boxTierPrice } from '../config/constants';
import PrismaInstance from '../prisma';
import Cache from '../cache';
import { ApiResult } from '../interfaces/ApiResult';
import { color, blue, white } from 'console-log-colors';
import Mail from '../mail';
import fs from 'fs/promises';
import Data from '../data';
import PDF from '../pdf';
import PushoverClient from '../pushover';
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

/**
 * One HTTP exchange with Print&Bind. The list of calls made for an order is
 * stored on the payment (printApiOrderResponse) so the admin dashboard can
 * show exactly what was sent and what came back.
 */
interface PbApiCall {
  method: string;
  url: string;
  body?: any;
  statusCode: number;
  responseBody: any;
}

/**
 * Order statuses (Print&Bind's own Dutch enum) that mean the parcel has left
 * the building. `Verzonden` is the normal one; the other two are reached when
 * the hourly poll missed the shipped window.
 */
const PB_SHIPPED_STATUSES = ['Verzonden', 'Afgeleverd', 'Afgehaald'];

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
  private pushover = new PushoverClient();

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          // Poll Print&Bind for shipped orders and send the tracking mail
          const trackingJob = new CronJob('15 * * * *', async () => {
            await this.handleTrackingMails();
          });
          trackingJob.start();

          // Send gift box folding instructions 24 hours after shipping
          const boxInstructionsJob = new CronJob('35 * * * *', async () => {
            await this.handleBoxInstructionMails();
          });
          boxInstructionsJob.start();
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
    let maxCards = maxCardsFor(digital);
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

  // ---------------------------------------------------------------------------
  // Print&Bind REST client (https://www.printenbind.nl/api/docs)
  // ---------------------------------------------------------------------------

  /**
   * Base URL of the REST API without a trailing slash. Development points at
   * https://sandbox.printenbind.nl/api/rest, production at
   * https://www.printenbind.nl/api/rest.
   */
  private pbBaseUrl(): string {
    return (process.env['PRINTENBIND_API_URL'] || '').replace(/\/+$/, '');
  }

  /** True when PRINTENBIND_API_URL points at the live API rather than the sandbox. */
  private isLiveApi(): boolean {
    return !/\/\/sandbox\./i.test(this.pbBaseUrl());
  }

  /**
   * POST /orders checks the order out immediately; the REST API has no
   * separate "finish" step like v1 had. Outside production we therefore only
   * ever place orders on the sandbox. Development pointed at the live URL is
   * limited to /orders/calculate.
   */
  private mayPlaceOrders(): boolean {
    return process.env['ENVIRONMENT'] === 'production' || !this.isLiveApi();
  }

  /**
   * Single entry point for every HTTP call to Print&Bind. Adds bearer auth,
   * parses the JSON body (resources are wrapped in `{ data }`) and appends
   * the exchange to `apiCalls` when given.
   */
  private async pbFetch(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: any,
    apiCalls?: PbApiCall[]
  ): Promise<{ ok: boolean; status: number; statusText: string; data: any }> {
    const url = `${this.pbBaseUrl()}${path}`;
    const authToken = await this.getAuthToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken}`,
      Accept: 'application/json',
    };
    const init: NonNullable<Parameters<typeof fetch>[1]> = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const text = await response.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (apiCalls) {
      apiCalls.push({
        method,
        url,
        ...(body !== undefined ? { body } : {}),
        statusCode: response.status,
        responseBody: data,
      });
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
    };
  }

  /**
   * Human readable summary of a Print&Bind error response. Validation
   * errors (422) carry per-field messages, either as `{ field: [msg] }` or
   * as `[[field, msg], ...]` pairs.
   */
  private describePbError(result: {
    status: number;
    statusText: string;
    data: any;
  }): string {
    const parts: string[] = [
      `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`,
    ];
    const data = result.data;
    if (data && typeof data === 'object') {
      if (data.message) {
        parts.push(String(data.message));
      }
      const errors = data.errors;
      if (Array.isArray(errors)) {
        for (const entry of errors) {
          parts.push(Array.isArray(entry) ? entry.join(': ') : String(entry));
        }
      } else if (errors && typeof errors === 'object') {
        for (const [field, messages] of Object.entries(errors)) {
          parts.push(
            `${field}: ${
              Array.isArray(messages) ? messages.join('; ') : String(messages)
            }`
          );
        }
      }
    } else if (typeof data === 'string' && data.length > 0) {
      parts.push(data.slice(0, 200));
    }
    return parts.join(' | ');
  }

  /** GET /orders/{id}; returns the order resource, or null when that fails. */
  private async getOrder(
    orderId: string,
    apiCalls?: PbApiCall[]
  ): Promise<any | null> {
    try {
      const result = await this.pbFetch(
        'GET',
        `/orders/${orderId}`,
        undefined,
        apiCalls
      );
      if (!result.ok || !result.data?.data) {
        this.logger.log(
          color.red.bold(
            `Failed to fetch Print&Bind order ${color.white.bold(
              orderId
            )}: ${this.describePbError(result)}`
          )
        );
        return null;
      }
      return result.data.data;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error fetching Print&Bind order ${color.white.bold(
            orderId
          )}: ${error}`
        )
      );
      return null;
    }
  }

  /**
   * The REST API only returns carrier barcodes. Rebuild the tracking URLs the
   * v1 API used to hand us: shipping.ts parses `code/country/postalcode` off
   * the URL tail and the tracking mail links to it.
   */
  private buildTrackingUrl(
    code: string,
    countrycode?: string | null,
    zipcode?: string | null
  ): string {
    const country = (countrycode || 'NL').trim().toUpperCase();
    let zip = (zipcode || '').trim();
    if (country === 'NL') {
      // PostNL formats Dutch postal codes as "1234 AB"; checkout stores them
      // with or without the space.
      const match = zip
        .replace(/\s+/g, '')
        .toUpperCase()
        .match(/^(\d{4})([A-Z]{2})$/);
      if (match) {
        zip = `${match[1]} ${match[2]}`;
      }
      return `https://jouw.postnl.nl/track-and-trace/${code}/NL/${zip}`;
    }
    return `https://www.internationalparceltracking.com/Main.aspx#/track/${code}/${country}/${zip}`;
  }

  /** Tracking link for an order resource, or '' while nothing has shipped. */
  private trackingLinkFromOrder(
    order: any,
    countrycode?: string | null,
    zipcode?: string | null
  ): string {
    const codes: string[] = Array.isArray(order?.tracktrace)
      ? order.tracktrace.filter(
          (code: any) => typeof code === 'string' && code.length > 0
        )
      : [];
    if (codes.length === 0) {
      return '';
    }
    if (codes.length > 1) {
      this.logger.log(
        color.yellow.bold(
          `Print&Bind order ${color.white.bold(
            String(order.id)
          )} shipped in ${color.white.bold(
            codes.length
          )} parcels; using the first tracking code (${codes.join(', ')})`
        )
      );
    }
    return this.buildTrackingUrl(codes[0], countrycode, zipcode);
  }

  /**
   * Convert an internal article (built by createOrderItem and the box
   * builders) into the REST article payload: internal routing fields are
   * stripped, v1-only article fields dropped, and numbers/booleans typed the
   * way the REST validation expects.
   */
  private toPbArticle(item: any): Record<string, any> {
    const {
      type: _type,
      amount: _amount,
      delivery_method: _deliveryMethod,
      delivery_option: _deliveryOption,
      payment_method: _paymentMethod,
      check_doc,
      borderless,
      number,
      copies,
      ...rest
    } = item;

    return {
      ...rest,
      number: parseInt(String(number), 10) || 1,
      copies: parseInt(String(copies), 10) || 1,
      // v1 took 'standard' here; in REST `true` requests the paid extended check
      check_doc: check_doc === true,
      borderless:
        borderless !== undefined ? Boolean(borderless) : rest.size === 'custom',
      add_inserts: false,
    };
  }

  /**
   * Build the REST `StoreOrderRequest`: address, delivery, production and the
   * articles. Field limits follow the API schema.
   */
  private buildOrderRequest(
    customerInfo: {
      fullname?: string;
      email: string;
      address?: string;
      housenumber?: string;
      zipcode?: string;
      city?: string;
      countrycode: string;
    },
    articles: Record<string, any>[],
    options: { fast: boolean; orderComment: string; reference?: string }
  ): Record<string, any> {
    const country = (customerInfo.countrycode || 'NL').toUpperCase();
    const request: Record<string, any> = {
      contact: (customerInfo.fullname?.trim() || 'John Doe').slice(0, 35),
      street: (customerInfo.address?.trim() || 'Some lane').slice(0, 95),
      number: (customerInfo.housenumber?.trim() || '1').slice(0, 35),
      postalcode: (customerInfo.zipcode?.trim() || '1234AB').slice(0, 17),
      city: (customerInfo.city?.trim() || 'Amsterdam').slice(0, 35),
      country,
      email: (customerInfo.email || 'john@doe.com').slice(0, 100),
      // Same rule as v1: NL goes via post (Print&Bind picks mailbox or parcel
      // by size), everything else via the international service.
      delivery_method: country === 'NL' ? 'post' : 'international',
      production_method: options.fast ? 'fast' : 'standard',
      // No Print&Bind branding on the package (was `blanco: 1` in v1)
      anonymous: true,
      articles,
    };
    if (options.orderComment) {
      request.comment = options.orderComment.slice(0, 255);
    }
    if (options.reference) {
      // Must be unique per order at Print&Bind; a re-send of the same
      // payment gets a fresh suffix.
      request.reference = `${options.reference}-${Date.now().toString(
        36
      )}`.slice(0, 100);
    }
    return request;
  }

  /**
   * Turn our internal items into one Print&Bind order. Physical items become
   * the articles of a single `POST /orders`, which places the order right
   * away; digital items are priced locally and never leave the building. With
   * `dryRun` the same request goes to `POST /orders/calculate`, which prices
   * it without creating anything.
   */
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
    options: {
      logging?: boolean;
      fast?: boolean;
      orderComment?: string;
      reference?: string;
      dryRun?: boolean;
    } = {}
  ): Promise<ApiResult & { apiCalls: PbApiCall[] }> {
    const {
      logging = false,
      fast = false,
      orderComment = '',
      reference,
      dryRun = false,
    } = options;

    let total = 0;
    let shipping = 0;
    let price = 0;
    let payment = 0;
    let totalProductPriceWithoutVAT = 0;
    const apiCalls: PbApiCall[] = [];

    const taxRate = (await this.data.getTaxRate(customerInfo.countrycode))!;
    const taxModifier = 1 + (taxRate ?? 0) / 100;
    const round2 = (value: number) => parseFloat(value.toFixed(2));

    const totalItems = items.length;
    let totalItemsSuccess = 0;
    let orderId: string | null = null;
    let error: string | undefined;
    const articles: Record<string, any>[] = [];

    for (const item of items) {
      if (item.type == 'physical') {
        if (item.product === 'losbladig') {
          // Our own sales price for the game cards (ex VAT); only used for
          // the price breakdown in the result.
          const orderType = await this.getOrderType(
            (parseInt(String(item.copies), 10) || 0) / 2,
            false,
            'cards',
            item.playlistId
          );
          if (orderType?.amountWithMargin) {
            totalProductPriceWithoutVAT += round2(
              orderType.amountWithMargin / taxModifier
            );
          }
        }
        articles.push(this.toPbArticle(item));
      } else if (item.type == 'digital') {
        const orderType = await this.getOrderType(
          item.numberOfTracks,
          true,
          item.productType,
          item.playlistId
        );

        if (orderType) {
          let itemPrice = 0;

          if (item.productType === 'cards') {
            itemPrice = parseFloat(
              (orderType.amountWithMargin * item.amount).toFixed(2)
            );
          } else if (item.productType === 'giftcard') {
            itemPrice = parseFloat(item.price.toFixed(2));
          }

          const productPriceWithoutVAT = round2(itemPrice / taxModifier);

          total += itemPrice;
          price += productPriceWithoutVAT;

          totalItemsSuccess++;
        }
      }
    }

    let blocked = false;

    if (articles.length > 0) {
      const placeOrder = !dryRun && this.mayPlaceOrders();
      blocked = !dryRun && !placeOrder;

      if (blocked) {
        this.logger.log(
          color.red.bold(
            `Refusing to place a Print&Bind order on the live API while ENVIRONMENT is ${color.white.bold(
              String(process.env['ENVIRONMENT'])
            )}. Point PRINTENBIND_API_URL at the sandbox. Running /orders/calculate instead so the request can still be inspected.`
          )
        );
        error =
          'Print&Bind live API cannot be used to place orders outside production';
      }

      const orderRequest = this.buildOrderRequest(customerInfo, articles, {
        fast,
        orderComment,
        reference,
      });
      const endpoint = placeOrder ? '/orders' : '/orders/calculate';

      if (logging) {
        const summary = items
          .filter((item) => item.type == 'physical')
          .map((item) => this.describeArticle(item))
          .join(', ');
        this.logger.log(
          color.blue.bold(
            `Sending ${color.white.bold(
              articles.length
            )} article(s) to Print&Bind in a single POST ${endpoint}: ${color.white.bold(
              summary
            )}`
          )
        );
      }

      const result = await this.pbFetch(
        'POST',
        endpoint,
        orderRequest,
        apiCalls
      );
      const order = result.ok ? result.data?.data : null;

      if (!order) {
        this.logger.log(
          color.red.bold(
            `Print&Bind rejected the order request (POST ${endpoint}) for ${color.white.bold(
              customerInfo.countrycode
            )}: ${this.describePbError(result)}`
          )
        );
        this.logger.log(
          color.gray('  request body: ') +
            color.white(JSON.stringify(orderRequest))
        );
        error =
          error ||
          `Print&Bind rejected the order: ${this.describePbError(result)}`;
      } else {
        orderId =
          order.id !== null && order.id !== undefined ? String(order.id) : null;

        const amount = parseFloat(order.amount) || 0;
        const articlesAmount = (
          Array.isArray(order.articles) ? order.articles : []
        ).reduce(
          (sum: number, article: any) =>
            sum + (parseFloat(article.amount) || 0),
          0
        );
        // Delivery and the per-article startup fee are no longer itemised
        // by the API; whatever sits above the article prices is what we pay
        // on top of the print work.
        const deliveryAndHandling = Math.max(
          0,
          round2(amount - articlesAmount)
        );

        total += round2(
          (totalProductPriceWithoutVAT + deliveryAndHandling) * taxModifier
        );
        shipping += round2(deliveryAndHandling * taxModifier);
        price += round2(totalProductPriceWithoutVAT * taxModifier);
        payment = round2(deliveryAndHandling * taxModifier);

        if (placeOrder && !orderId) {
          this.logger.log(
            color.red.bold(
              `Print&Bind accepted the order request but returned no order id: ${JSON.stringify(
                order
              )}`
            )
          );
          error = 'Print&Bind returned no order id';
        } else {
          totalItemsSuccess += articles.length;
          if (logging) {
            this.logger.log(
              color.blue.bold(
                `${placeOrder ? 'Placed' : 'Calculated'} Print&Bind order ${color.white.bold(
                  orderId ?? '(dry run)'
                )} with ${color.white.bold(
                  articles.length
                )} article(s): supplier amount ${color.white.bold(
                  amount.toFixed(2)
                )} ex VAT (${color.white.bold(
                  deliveryAndHandling.toFixed(2)
                )} delivery + handling)`
              )
            );
          }
        }
      }
    }

    const success =
      totalItems > 0 && totalItemsSuccess === totalItems && !blocked;

    if (!success) {
      return {
        success: false,
        data: {},
        ...(error ? { error } : {}),
        apiCalls,
      };
    }

    return {
      success: true,
      data: {
        orderId,
        total,
        shipping,
        handling: 0,
        taxRateShipping: taxRate,
        taxRate,
        price,
        payment,
      },
      apiCalls,
    };
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

    // Safety ceiling on the page count we hand the printer. Derived from the
    // physical card cap (2 pages per card, front + back, plus the how-to
    // card) rather than a literal — it used to be a hardcoded 2000, which was
    // MAX_CARDS_PHYSICAL back when that was 1000, so raising the cap silently
    // under-printed every order above 1000 cards.
    const maxPages = maxCardsFor(false) * 2 + 2;
    if (numberOfPages > maxPages) {
      numberOfPages = maxPages;
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

      // Print&Bind's `losbladig` (loose page) product. `borderless` and
      // `check_doc` are explicit in the REST API; the values below are what
      // Print&Bind applied to our v1 orders (borderless for the 60x60 custom
      // size, standard file check), so the product and price stay the same.
      let orderObj: any = {
        type: 'physical',
        amount: orderAmount,
        product: 'losbladig',
        number: 1,
        copies: numberOfPages,
        color: 'all',
        size: 'custom',
        printside: 'double',
        finishing: 'loose',
        finishing2: 'none',
        finishing_extra: 'none',
        accessory_item: 'none',
        papertype: 'card',
        size_custom_width: 60,
        size_custom_height: 60,
        borderless: true,
        check_doc: false,
        add_file_method: 'url',
        file_overwrite: true,
        file_url: fileUrl,
        comment: `Batch nummer op de kaartjes (rechts onderin op kant met titel/artiest/jaar) moet #${batchNumber} zijn`,
      };

      if (item.subType == 'sheets') {
        orderObj.copies = Math.ceil(numberOfTracks / 12) * 2;
        orderObj.size = 'a4';
        orderObj.borderless = false;
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
      // Insert card articles are 120x120 'werkblad' without a packaging
      // accessory. Game card articles are 'losbladig' and carry a
      // "Batch nummer ... #X-Y" comment.
      if (item.product === 'werkblad' && !item.accessory_group) {
        const pages = parseInt(String(item.copies), 10) || 0;
        return `insert cards (${pages} pages)`;
      }
      const batchMatch = comment.match(/#([\d-]+)/);
      const batchNumber = batchMatch ? batchMatch[1] : 'unknown';
      return `game cards (Batch #${batchNumber})`;
    }
    return `article (${item?.type ?? 'unknown'})`;
  }

  private createBoxOrderCardItem(
    fileUrl: string,
    playlist: any,
    pageCount: number
  ): any {
    return {
      type: 'physical',
      // The file is pre-multiplied (one front+back pair per purchased box),
      // same convention as createBoxOrderInsertItem: amount stays 1 and
      // copies equals the file's actual page count.
      amount: 1,
      product: 'werkblad',
      number: 1,
      copies: pageCount,
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      finishing2: 'none',
      finishing_extra: 'none',
      papertype: 'card',
      size_custom_width: 120,
      size_custom_height: 120,
      borderless: true,
      check_doc: false,
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
      product: 'werkblad',
      number: 1,
      copies: pageCount,
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      finishing2: 'none',
      finishing_extra: 'none',
      accessory_item: 'none',
      papertype: 'card',
      size_custom_width: 120,
      size_custom_height: 120,
      borderless: true,
      check_doc: false,
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

    // The regenerated file already contains one front+back pair per
    // purchased box (the webhook passes the purchased total to
    // generateBoxInsertPdf), so read the real page count and submit a
    // single article — same convention as the main order flow.
    const pdfManager = new PDF();
    const boxFilePath = `${process.env['PUBLIC_DIR']}/box-insert/${php.boxFilename}`;
    const pageCount = await pdfManager.countPDFPages(boxFilePath);
    items.push(this.createBoxOrderCardItem(boxFileUrl, php.playlist, pageCount));
    this.logger.log(color.blue.bold(`Order items: ${items.length} (insert card + packaging accessory), boxes: ${quantity}, pages: ${pageCount}`));

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

    // Same packer warning as the main order flow: the article itself only
    // carries one packaging accessory line, so the total box count is
    // communicated via the order-level comment.
    const orderComment = `LET OP: Deze order moet verpakt worden met in totaal ${quantity} QRSong! ${
      quantity === 1 ? 'doos' : 'dozen'
    }`;

    const result = await this.processOrderRequest(items, customerInfo, {
      logging: true,
      orderComment,
      reference: `${payment.paymentId}-box-${paymentHasPlaylistId}`,
    });

    if (result.success && result.data?.orderId) {
      this.logger.log(
        color.green.bold(`Successfully placed box upgrade Print&Bind order: `) +
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
        } else if (['ES', 'NO', 'SE'].includes(params.countrycode)) {
          shipping = 3.90;
        }
      } else if (physicalItems > 0 && !shippingResult) {
        // No shipping rate for this country. Zeroing the total used to make the
        // checkout button silently do nothing (a €0 total blocks submission but
        // leaves no invalid field to point at). Say so instead, so the frontend
        // can name the country and offer the digital version.
        this.logger.log(
          color.yellow.bold(
            `No shipping rate for country ${color.white.bold(
              params.countrycode
            )} — refusing to calculate a physical order`
          )
        );
        return {
          success: false,
          error: 'no_shipping',
          countrycode: params.countrycode,
        };
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

  /**
   * Connectivity check: GET /me returns the customer the token belongs to.
   */
  public async testOrder(): Promise<any | null> {
    const result = await this.pbFetch('GET', '/me');
    if (!result.ok) {
      this.logger.log(
        color.red.bold(
          `Print&Bind API check failed (${color.white.bold(
            this.pbBaseUrl()
          )}): ${this.describePbError(result)}`
        )
      );
      return null;
    }
    const customer = result.data?.data ?? null;
    this.logger.log(
      color.blue.bold(
        `Print&Bind API reachable at ${color.white.bold(
          this.pbBaseUrl()
        )} as ${color.white.bold(customer?.name ?? 'unknown')}${
          this.isLiveApi() ? ' (live)' : ' (sandbox)'
        }`
      )
    );
    return customer;
  }

  private async getAuthToken(): Promise<string | null> {
    return process.env['PRINTENBIND_API_KEY'] || null;
  }

  /**
   * Raw print cost per card in EUR — just paper + ink, no handling, no
   * minimum-order amortization, no profit, no VAT. Mirrors the constants in
   * `calculateSingleItem`. Used by post-purchase upgrade pricing where the
   * customer pays a simple per-card markup rather than going through the
   * full margin model.
   */
  public getRawCardCostEur(): number {
    const colorPrice = 0.018;
    const paperPrice = 0.034;
    return colorPrice * 2 + paperPrice;
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
              `Prepared article for ${color.white.bold(
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
              `Prepared article for ${color.white.bold(
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
    // `boxQuantity × amount` times (multiplication happens in
    // generateBoxInsertPdf), so the work here is just (a) read the per-file
    // page count and (b) for multi-playlist orders, merge those
    // pre-multiplied files into one.
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
          ''
        );
        orderItems.push(insertItem);

        this.logger.log(
          color.blue.bold(
            `Prepared insert card article for ${color.white.bold(
              'Print&Bind'
            )} order. Playlist: ${color.white(
              playlist.name
            )} Boxes: ${color.white.bold(
              playlist.boxQuantity * (playlist.amount || 1)
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
          (sum: number, p: any) => sum + p.boxQuantity * (p.amount || 1),
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
          ''
        );
        orderItems.push(mergedOrderItem);

        this.logger.log(
          color.blue.bold(
            `Prepared merged insert card article for ${color.white.bold(
              'Print&Bind'
            )} order. Playlists: ${color.white(
              playlistNames.join(', ')
            )} Pages: ${color.white.bold(pageCount)}`
          )
        );
        this.logger.log(
          color.blue.bold(
            `Merged insert card article JSON: ${color.white.bold(
              JSON.stringify(mergedOrderItem, null, 2)
            )}`
          )
        );
      }
    }

    if (orderItems.length === 0) {
      this.logger.log(
        color.red.bold(
          `No order items to send for payment ${color.white.bold(
            payment.paymentId
          )}`
        )
      );
      return {
        success: false,
        request: '',
        response: {
          apiCalls: [],
          error: 'No order items to send',
        },
      };
    }

    // If this order contains any boxes, warn the packer up-front about the
    // total number of boxes that need to be included in the shipment. The
    // total is summed across all playlists (boxQuantity × playlist amount).
    const totalBoxCount = playlists.reduce((sum: number, playlistItem: any) => {
      const playlist = playlistItem.playlist;
      if (playlist.boxEnabled && playlist.boxQuantity > 0) {
        return sum + playlist.boxQuantity * (playlist.amount || 1);
      }
      return sum;
    }, 0);

    const orderComment =
      totalBoxCount > 0
        ? `LET OP: Deze order moet verpakt worden met in totaal ${totalBoxCount} QRSong! ${
            totalBoxCount === 1 ? 'doos' : 'dozen'
          }`
        : '';

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
      {
        logging: true,
        fast: payment.fast || false,
        orderComment,
        reference: payment.paymentId,
      }
    );

    return this.finishPlacedOrder(result, payment, 'order');
  }

  /**
   * Standalone order flow for loose inlay cards (admin dashboard "Send to
   * printer - inlay card only"). Fully separate from createOrder: it builds
   * only the inlay card article(s) and runs the complete order from A to
   * Z — create, finish (skipped on development), tracking and payment info.
   */
  public async orderInlayCard(payment: any, playlists: any[]): Promise<any> {
    const orderItems = [];

    // Collect playlists that have an inlay (box insert) card. Each
    // playlist's boxFilename already contains its design repeated
    // `boxQuantity × amount` times (multiplication happens in
    // generateBoxInsertPdf).
    const insertPlaylists = playlists
      .map((p) => p.playlist)
      .filter(
        (playlist: any) =>
          playlist.boxEnabled &&
          playlist.boxQuantity > 0 &&
          playlist.boxFilename
      );

    if (insertPlaylists.length === 0) {
      this.logger.log(
        color.red.bold(
          `No inlay cards configured for payment ${color.white.bold(
            payment.paymentId
          )}`
        )
      );
      return {
        success: false,
        request: '',
        response: {
          apiCalls: [],
          error: 'No inlay cards configured for this order',
        },
      };
    }

    const boxInsertDir = `${process.env['PUBLIC_DIR']}/box-insert`;
    const pdfManager = new PDF();

    if (insertPlaylists.length === 1) {
      // Single playlist — the file is already the right size, just
      // create one article with copies=actualPageCount.
      const playlist = insertPlaylists[0];
      const filePath = `${boxInsertDir}/${playlist.boxFilename}`;
      const pageCount = await pdfManager.countPDFPages(filePath);
      const boxFileUrl = `${process.env['API_URI']}/public/box-insert/${playlist.boxFilename}`;

      orderItems.push(this.createBoxOrderInsertItem(boxFileUrl, pageCount, ''));

      this.logger.log(
        color.blue.bold(
          `Prepared inlay card article for ${color.white.bold(
            'Print&Bind'
          )} order. Playlist: ${color.white(
            playlist.name
          )} Cards: ${color.white.bold(
            playlist.boxQuantity * (playlist.amount || 1)
          )} Pages: ${color.white.bold(pageCount)}`
        )
      );
    } else {
      // Multiple playlists — merge their pre-multiplied insert files into
      // a single PDF and submit one consolidated article.
      const mergedFilename = `box_merged_${payment.paymentId}_${Date.now()}.pdf`;
      const mergedPath = `${boxInsertDir}/${mergedFilename}`;

      const mergeInputs = insertPlaylists.map((playlist: any) => ({
        localPath: `${boxInsertDir}/${playlist.boxFilename}`,
        repeat: 1,
      }));

      const playlistNames = insertPlaylists.map((p: any) => p.name);

      const pageCount = await pdfManager.mergeLocalPdfs(
        mergeInputs,
        mergedPath,
        'inlay card'
      );

      const mergedFileUrl = `${process.env['API_URI']}/public/box-insert/${mergedFilename}`;
      orderItems.push(
        this.createBoxOrderInsertItem(mergedFileUrl, pageCount, '')
      );

      this.logger.log(
        color.blue.bold(
          `Prepared merged inlay card article for ${color.white.bold(
            'Print&Bind'
          )} order. Playlists: ${color.white(
            playlistNames.join(', ')
          )} Pages: ${color.white.bold(pageCount)}`
        )
      );
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
      {
        logging: true,
        fast: payment.fast || false,
        reference: `${payment.paymentId}-inlay`,
      }
    );

    return this.finishPlacedOrder(result, payment, 'inlay card order');
  }

  /**
   * Shared tail of the order flows: log the placed order, kick off the
   * payment/profit bookkeeping and shape the result the generator stores on
   * the payment (`response` ends up in printApiOrderResponse).
   */
  private finishPlacedOrder(
    result: ApiResult & { apiCalls: PbApiCall[] },
    payment: any,
    label: string
  ): { success: boolean; request: string; response: any } {
    const apiCalls = result.apiCalls || [];

    if (result.success && result.data?.orderId) {
      this.logger.log(
        color.green.bold(
          `Placed Print&Bind ${label} ${color.white.bold(
            result.data.orderId
          )} for payment ${color.white.bold(payment.paymentId)}`
        )
      );

      this.setPaymentInfo(result.data.orderId, payment);

      return {
        success: true,
        request: '',
        response: {
          apiCalls,
          id: result.data.orderId,
        },
      };
    }

    return {
      success: false,
      request: '',
      response: {
        apiCalls,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }

  private async setPaymentInfo(
    printApiOrderId: string,
    payment: any,
    newStatus: string = 'Submitted'
  ): Promise<void> {
    const taxRate = (await this.data.getTaxRate(payment.countrycode))!;

    const totalPriceWithoutTax = parseFloat(
      (payment.totalPrice / (1 + (taxRate ?? 0) / 100)).toFixed(2)
    );

    let printApiPrice = 0;
    let printApiPriceInclVat = 0;

    try {
      const order = await this.getOrder(printApiOrderId);

      if (!order) {
        return;
      }

      // `amount` is the full order amount ex VAT (articles, delivery and
      // handling), the same figure v1 reported as order.amount.
      printApiPrice = parseFloat(order.amount) || 0;
      const amountTax = parseFloat(order.amount_tax_standard) || 0;
      printApiPriceInclVat = parseFloat(
        (printApiPrice + amountTax).toFixed(2)
      );

      // Empty boxes are bought from a supplier outside the print-API invoice,
      // so deduct their wholesale cost (BOX_UNIT_COST × total boxes shipped)
      // from the profit to reflect true margin.
      const playlistsForBoxes = await this.prisma.paymentHasPlaylist.findMany({
        where: { paymentId: payment.id },
        select: { boxEnabled: true, boxQuantity: true, amount: true },
      });
      const totalBoxCount = playlistsForBoxes.reduce((sum, p) => {
        if (p.boxEnabled && p.boxQuantity > 0) {
          return sum + p.boxQuantity * (p.amount || 1);
        }
        return sum;
      }, 0);
      const boxCost = parseFloat((totalBoxCount * BOX_UNIT_COST).toFixed(2));

      const newProfit = parseFloat(
        (totalPriceWithoutTax - printApiPrice - boxCost).toFixed(2)
      );

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
          )}] [BOX: ${color.white.bold(
            `${totalBoxCount}×${BOX_UNIT_COST.toFixed(2)}=${boxCost.toFixed(2)}`
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

  /**
   * v1 learned the delivery price per country by creating carts it never
   * finished and reading their delivery record. The REST API prices delivery
   * only on placed orders (`/orders/calculate` leaves it out) and
   * `POST /orders` places a real order, so this probe is parked:
   * `shipping_costs_new` keeps its current values and `getShippingCosts`
   * keeps reading from it.
   */
  public async calculateShippingCosts(countryCodes?: string[]): Promise<void> {
    const codes = countryCodes || [];
    this.logger.log(
      color.yellow.bold(
        `Shipping cost calculation is not available on the Print&Bind REST API (calculate returns no delivery costs); keeping the stored rates${
          codes.length > 0 ? ` for ${color.white.bold(codes.join(', '))}` : ''
        }`
      )
    );
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

  /**
   * Returns the list for the admin "Shipment Check" table: every payment that
   * has a Print&Bind order ID and a printApiStatus of 'Submitted'. This is a
   * DB-only query so the table can render instantly; the delivery data for each
   * order is fetched separately (one call per order) via checkDeliveryForOrder.
   */
  public async getSubmittedOrders(): Promise<any[]> {
    const payments = await this.prisma.payment.findMany({
      where: {
        printApiStatus: 'Submitted',
        printApiOrderId: { notIn: [''] },
      },
      select: {
        paymentId: true,
        printApiOrderId: true,
        fullname: true,
        email: true,
        countrycode: true,
        printApiTrackingLink: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return payments.map((payment) => ({
      paymentId: payment.paymentId,
      printApiOrderId: payment.printApiOrderId,
      fullname: payment.fullname,
      email: payment.email,
      countrycode: payment.countrycode,
      createdAt: payment.createdAt,
    }));
  }

  /**
   * Retrieves the Print&Bind order for a single order id and reports whether
   * its delivery looks ok, missing, or errored. Used by the admin "Shipment
   * Check" table to fill in each row one by one.
   */
  public async checkDeliveryForOrder(orderId: string): Promise<any> {
    let deliveryStatus: 'ok' | 'missing' | 'error' = 'ok';
    let deliveryError: string | null = null;
    let order: any = null;
    let trackingUrl: string | null = null;

    try {
      const result = await this.pbFetch('GET', `/orders/${orderId}`);

      if (!result.ok) {
        deliveryStatus = 'error';
        deliveryError = this.describePbError(result);
      } else {
        order = result.data?.data ?? null;
        if (!order || !order.delivery_method) {
          deliveryStatus = 'missing';
          deliveryError = 'No delivery data found';
        } else {
          const payment = await this.prisma.payment.findFirst({
            where: { printApiOrderId: orderId },
            select: { countrycode: true, zipcode: true },
          });
          trackingUrl =
            this.trackingLinkFromOrder(
              order,
              payment?.countrycode,
              payment?.zipcode
            ) || null;
        }
      }
    } catch (error: any) {
      deliveryStatus = 'error';
      deliveryError = error?.message || String(error);
    }

    return {
      printApiOrderId: orderId,
      deliveryStatus,
      deliveryError,
      deliveryMethod: order?.delivery_method ?? null,
      amount: order?.amount ?? null,
      trackingUrl,
    };
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
            const pbOrder = await this.getOrder(order.printApiOrderId);

            if (!pbOrder) {
              this.logger.log(color.red.bold(`Skipping order ID ${order.printApiOrderId} (paymentId: ${order.paymentId}): failed to get order status`));
              continue;
            }

            if (PB_SHIPPED_STATUSES.includes(pbOrder.status)) {
              this.logger.log(
                color.blue.bold(
                  `Order ${color.white.bold(
                    order.printApiOrderId
                  )} has been shipped (${color.white.bold(pbOrder.status)})`
                )
              );

              // The order resource carries the carrier barcode(s) once shipped
              const trackingLink =
                this.trackingLinkFromOrder(
                  pbOrder,
                  payment.countrycode,
                  payment.zipcode
                ) ||
                payment.printApiTrackingLink ||
                '';

              // Update order status and tracking link
              await this.prisma.payment.update({
                where: { id: order.id },
                data: {
                  printApiShipped: true,
                  printApiShippedAt: new Date(),
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
   * Sends the gift box folding instructions email to orders that contain a
   * gift box, 24 hours after the tracking email went out.
   */
  public async handleBoxInstructionMails(): Promise<void> {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const payments = await this.prisma.payment.findMany({
        where: {
          status: 'paid',
          test: false,
          printApiShipped: true,
          printApiShippedAt: {
            not: null,
            lte: twentyFourHoursAgo,
          },
          boxInstructionsMailSent: false,
          PaymentHasPlaylist: {
            some: {
              boxEnabled: true,
              boxQuantity: {
                gt: 0,
              },
            },
          },
        },
      });

      for (const payment of payments) {
        // Flag first so a crash mid-send can never cause repeated emails
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { boxInstructionsMailSent: true },
        });

        await this.mail.sendBoxInstructionsEmail(payment);

        this.logger.log(
          color.blue.bold(
            `Sent gift box instructions email for order ${color.white.bold(
              payment.orderId
            )} to ${color.white.bold(payment.email)}`
          )
        );
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error sending box instruction mails: ${error}`)
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
   * The REST API sets production_method only when the order is created (v1
   * allowed a PUT afterwards). When express is toggled on a payment that was
   * already sent, the change has to be made by Print&Bind customer service,
   * so an admin is alerted instead.
   */
  public async updateProductionMethod(
    orderId: string,
    productionMethod: 'fast' | 'standard'
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(
      color.yellow.bold(
        `Cannot update production method for order ${color.white.bold(
          orderId
        )} to ${color.white.bold(
          productionMethod
        )}: not supported by the Print&Bind REST API, notifying admin`
      )
    );

    await this.pushover.sendMessage(
      {
        title: 'Print&Bind production method change needed',
        message: `Print&Bind order ${orderId} was already placed; the REST API cannot change its production method to '${productionMethod}'. Ask Print&Bind customer service to change it.`,
      },
      '',
      true
    );

    return {
      success: false,
      error:
        'Changing the production method is not supported by the Print&Bind REST API',
    };
  }
}

export default PrintEnBind;
