import { ApiResult } from './interfaces/ApiResult';
import { createMollieClient, Locale, PaymentMethod } from '@mollie/api-client';
import { Payment } from '@prisma/client';
import PrismaInstance from './prisma';
import { color } from 'console-log-colors';
import Logger from './logger';
import Data from './data';
import Order from './order';
import Translation from './translation';
import Utils from './utils';
import Generator from './generator';
import { CartItem } from './interfaces/CartItem';
import { OrderSearch } from './interfaces/OrderSearch';
import axios from 'axios';
import Discount from './discount';
import { CronJob } from 'cron';
import cluster from 'cluster';
import { promises as fs } from 'fs';
import Game from './game';

class Mollie {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private data = Data.getInstance();
  private discount = new Discount();
  private order = Order.getInstance();
  private translation: Translation = new Translation();
  private utils = new Utils();
  private generator = Generator.getInstance();
  private openPaymentStatus = ['open', 'pending', 'authorized'];
  private paidPaymentStatus = ['paid'];
  private failedPaymentStatus = ['failed', 'canceled', 'expired'];
  private game = new Game();

  constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.startCron();
        }
      });
    }
  }

  public async getPaymentsByDay(): Promise<any> {
    let ignoreEmails: string[] = [];

    if (process.env['ENVIRONMENT'] == 'production') {
      ignoreEmails = ['west14@gmail.com', 'info@rickgroenewegen.nl'];
    }

    const report = await this.prisma.payment.groupBy({
      by: ['createdAt'],
      where: {
        vibe: false,
        AND: [
          {
            createdAt: {
              gt: new Date('2024-12-05'),
            },
          },
        ],
        email: {
          notIn: ignoreEmails,
        },
        status: {
          in: ['paid'],
        },
      },
      _count: {
        _all: true,
      },
      _sum: {
        totalPrice: true,
        totalPriceWithoutTax: true,
      },
    });

    // Process the results to group by day and calculate totals
    const dailyReport = report.reduce((acc: any[], entry) => {
      const day = new Date(entry.createdAt).toISOString().split('T')[0];

      const existingDay = acc.find((item) => item.day === day);
      if (existingDay) {
        existingDay.numberOfSales += entry._count._all;
        existingDay.totalPrice += entry._sum.totalPrice || 0;
        existingDay.totalPriceWithoutTax +=
          entry._sum.totalPriceWithoutTax || 0;
      } else {
        acc.push({
          day,
          numberOfSales: entry._count._all,
          totalPrice: entry._sum.totalPrice || 0,
          totalPriceWithoutTax: entry._sum.totalPriceWithoutTax || 0,
        });
      }
      return acc;
    }, []);

    // Sort by day descending (newest first)
    return dailyReport.sort((a, b) => b.day.localeCompare(a.day));
  }

  public async getPaymentsByMonth(
    startDate: Date,
    endDate: Date
  ): Promise<any> {
    let ignoreEmails: string[] = [];

    if (process.env['ENVIRONMENT'] == 'production') {
      ignoreEmails = ['west14@gmail.com', 'info@rickgroenewegen.nl'];
    }

    const report = await this.prisma.payment.groupBy({
      by: ['countrycode'],
      where: {
        vibe: false,
        AND: [
          {
            createdAt: {
              gte: startDate,
              lte: endDate,
            },
          },
          {
            createdAt: {
              gt: new Date('2024-12-05'),
            },
          },
        ],
        email: {
          notIn: ignoreEmails,
        },
      },
      _count: {
        _all: true,
      },
      _sum: {
        totalPrice: true,
        totalPriceWithoutTax: true,
      },
      _max: {
        taxRate: true,
      },
    });

    const detailedReport = await Promise.all(
      report.map(async (entry) => {
        const payments = await this.prisma.payment.findMany({
          where: {
            countrycode: entry.countrycode,
            createdAt: {
              gte: startDate,
              lte: endDate,
              gt: new Date('2024-12-05'),
            },
          },
          select: {
            id: true,
          },
        });

        let totalPlaylistsSold = 0;
        for (const payment of payments) {
          const playlistsCount = await this.prisma.paymentHasPlaylist.count({
            where: {
              paymentId: payment.id,
            },
          });
          totalPlaylistsSold += playlistsCount;
        }

        return {
          country: entry.countrycode || 'Unknown',
          numberOfSales: entry._count._all,
          totalPrice: entry._sum.totalPrice || 0,
          totalPriceWithoutTax: entry._sum.totalPriceWithoutTax,
          taxRate: entry._max.taxRate,
          totalPlaylists: totalPlaylistsSold,
        };
      })
    );

    return detailedReport.sort((a, b) => b.totalPrice - a.totalPrice);
  }

  public async getPaymentsByTaxRate(
    startDate: Date,
    endDate: Date
  ): Promise<any> {
    let ignoreEmails: string[] = [];

    if (process.env['ENVIRONMENT'] == 'production') {
      ignoreEmails = ['west14@gmail.com', 'info@rickgroenewegen.nl'];
    }

    const report = await this.prisma.payment.groupBy({
      by: ['taxRate'],
      where: {
        vibe: false,
        AND: [
          {
            createdAt: {
              gte: startDate,
              lte: endDate,
            },
          },
          {
            createdAt: {
              gt: new Date('2024-12-05'),
            },
          },
        ],
        email: {
          notIn: ignoreEmails,
        },
      },
      _count: {
        _all: true,
      },
      _sum: {
        totalPrice: true,
        totalPriceWithoutTax: true,
        productVATPrice: true,
      },
    });

    const detailedReport = report.map((entry) => ({
      taxRate: entry.taxRate || 0,
      numberOfSales: entry._count._all,
      totalPrice: entry._sum.totalPrice || 0,
      totalPriceWithoutTax: entry._sum.totalPriceWithoutTax || 0,
      totalVAT: entry._sum.productVATPrice || 0,
    }));

    return detailedReport.sort((a, b) => b.totalPrice - a.totalPrice);
  }

  public startCron(): void {
    new CronJob('0 1 * * *', async () => {
      await this.cleanPayments();
    }).start();
  }

  private async cleanPayments(): Promise<void> {
    try {
      const expiredPayments = await this.prisma.payment.findMany({
        where: {
          status: {
            in: ['expired', 'canceled'],
          },
        },
        select: {
          id: true,
        },
      });

      const expiredPaymentIds = expiredPayments.map((payment) => payment.id);

      if (expiredPaymentIds.length > 0) {
        await this.prisma.payment.deleteMany({
          where: {
            id: { in: expiredPaymentIds },
          },
        });

        this.logger.log(
          color.green.bold(
            `Deleted ${color.white.bold(
              expiredPaymentIds.length
            )} expired payments.`
          )
        );
      } else {
        this.logger.log(
          color.yellow.bold('No expired payments found to delete.')
        );
      }
    } catch (error: any) {
      this.logger.log(color.red.bold('Error cleaning expired payments!'));
    }
  }

  private getMollieLocaleData(
    locale: string,
    locationCountryCode: string
  ): {
    locale: Locale;
    paymentMethods: PaymentMethod[];
  } {
    const localeMap: { [key: string]: string } = {
      en: 'en_US',
      nl: 'nl_NL',
      de: 'de_DE',
      fr: 'fr_FR',
      es: 'es_ES',
      it: 'it_IT',
      pt: 'pt_PT',
      pl: 'pl_PL',
      hin: 'en_US',
    };

    const paymentMethodMap: { [key: string]: PaymentMethod[] } = {
      en: [PaymentMethod.paysafecard, PaymentMethod.trustly],
      nl: [
        PaymentMethod.ideal,
        PaymentMethod.bancontact,
        PaymentMethod.belfius,
        PaymentMethod.kbc,
        PaymentMethod.satispay,
        PaymentMethod.trustly,
      ],
      de: [PaymentMethod.satispay, PaymentMethod.trustly, PaymentMethod.eps],
      fr: [
        PaymentMethod.bancontact,
        PaymentMethod.belfius,
        PaymentMethod.kbc,
        PaymentMethod.satispay,
      ],
      es: [PaymentMethod.satispay, PaymentMethod.trustly],
      it: [
        PaymentMethod.satispay,
        PaymentMethod.twint,
        PaymentMethod.bancomatpay,
      ],
      pt: [PaymentMethod.satispay],
      pl: [PaymentMethod.przelewy24, PaymentMethod.blik],
    };

    let paymentMethods = paymentMethodMap[locale] || [];

    if (
      locationCountryCode.length > 0 &&
      paymentMethodMap[locationCountryCode]
    ) {
      paymentMethods = [
        ...paymentMethods,
        ...paymentMethodMap[locationCountryCode],
      ];
    }

    return {
      locale: (localeMap[locale] || 'en_US') as Locale,
      paymentMethods,
    };
  }

  public async clearPDFs(paymentId: string) {
    const payment = await this.getPayment(paymentId);
    const playlists = payment.PaymentHasPlaylist;

    const deletePDF = async (filename: string, type: string) => {
      if (filename !== '') {
        const pdfPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
        try {
          await fs.unlink(pdfPath);
          this.logger.log(
            color.blue.bold(`Deleted ${type} PDF: ${color.white.bold(pdfPath)}`)
          );
        } catch (e) {
          this.logger.log(
            color.yellow.bold(
              `Failed to delete ${type} PDF: ${color.white.bold(pdfPath)}`
            )
          );
        }
      }
    };

    for (const playlist of playlists) {
      await deletePDF(playlist.filename, 'standard');
      await deletePDF(playlist.filenameDigital, 'digital');
    }
  }

  public async getPaymentList(
    search: OrderSearch & { page: number; itemsPerPage: number }
  ): Promise<{ payments: any[]; totalItems: number }> {
    const showTestPayments = process.env['ENVIRONMENT'] == 'development';

    const whereClause =
      Array.isArray(search.status) && search.status.length > 0
        ? { status: { in: search.status } }
        : {};

    const textSearchClause =
      search.textSearch && search.textSearch.trim() !== ''
        ? {
            OR: [
              { fullname: { search: search.textSearch } },
              { orderId: { search: search.textSearch } },
              { printApiOrderId: { search: search.textSearch } },
              {
                PaymentHasPlaylist: {
                  some: {
                    playlist: {
                      name: { search: search.textSearch },
                    },
                  },
                },
              },
            ],
          }
        : {};

    const finalizedClause =
      typeof search.finalized === 'boolean'
        ? { finalized: search.finalized }
        : {};

    // Physical filter - if true, only include payments with physical items
    const physicalClause = search.physical
      ? {
          PaymentHasPlaylist: {
            some: {
              type: 'physical',
            },
          },
        }
      : {};

    const totalItems = await this.prisma.payment.count({
      where: {
        vibe: false,
        test: showTestPayments,
        ...whereClause,
        ...textSearchClause,
        ...finalizedClause,
        ...physicalClause,
      },
    });

    const payments = await this.prisma.payment.findMany({
      where: {
        vibe: false,
        test: showTestPayments,
        ...whereClause,
        ...textSearchClause,
        ...finalizedClause,
        ...physicalClause,
      },
      skip: (search.page - 1) * search.itemsPerPage,
      take: search.itemsPerPage,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        paymentId: true,
        status: true,
        totalPrice: true,
        totalPriceWithoutTax: true,
        printApiPrice: true,
        createdAt: true,
        updatedAt: true,
        orderId: true,
        profit: true,
        printApiStatus: true,
        printApiTrackingLink: true,
        printApiOrderRequest: true,
        printApiOrderResponse: true,
        printApiOrderId: true,
        sentToPrinterAt: true,
        sentToPrinter: true,
        fast: true,
        email: true,
        fullname: true,
        locale: true,
        address: true,
        city: true,
        zipcode: true,
        housenumber: true,
        printApiShipped: true,
        countrycode: true,
        user: {
          select: {
            hash: true,
          },
        },
        PaymentHasPlaylist: {
          select: {
            id: true,
            amount: true,
            filename: true,
            eco: true,
            doubleSided: true,
            hideDomain: true,
            background: true,
            logo: true,
            subType: true,
            orderType: {
              select: {
                name: true,
                digital: true,
              },
            },
            filenameDigital: true,
            printApiUploaded: true,
            printApiUploadResponse: true,
            type: true,
            playlist: {
              select: {
                name: true,
                playlistId: true,
              },
            },
          },
        },
      },
    });

    return { payments, totalItems };
  }

  public async deletePayment(paymentId: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if payment exists
      const payment = await this.prisma.payment.findUnique({
        where: { paymentId },
      });

      if (!payment) {
        return { success: false, error: 'Payment not found' };
      }

      // Delete the payment (cascading deletes will handle related records)
      await this.prisma.payment.delete({
        where: { paymentId },
      });

      return { success: true };
    } catch (error) {
      console.error('Error deleting payment:', error);
      return { success: false, error: 'Failed to delete payment from database' };
    }
  }

  private mollieClient = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY']!,
  });

  private mollieClientTest = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY_TEST']!,
  });

  private async getClient(ip: string) {
    if (
      process.env['ENVIRONMENT'] == 'development' ||
      this.utils.isTrustedIp(ip)
    ) {
      return { test: true, client: this.mollieClientTest };
    } else {
      return { test: false, client: this.mollieClient };
    }
  }

  public async getPaymentUri(
    params: any,
    clientIp: string,
    waitForDirectGeneration: boolean = false,
    skipGenerationMail: boolean = false
  ): Promise<ApiResult> {
    try {
      let useOrderType = 'digital';
      let description = '';
      let totalCards = 0;
      let molliePaymentId = '';
      let mollieCheckoutUrl = '';
      let mollieTest = false;
      let molliePaymentStatus = 'noMollie';
      let molliePaymentAmount = 0;
      let discountAmount = 0;
      let discountUseIds: number[] = [];
      let discountUsed = false;
      let triggerDirectGeneration: boolean = false;
      let vibe: boolean = false;

      if (params.extraOrderData.vibe) {
        vibe = params.extraOrderData.vibe;
      }

      const calculateResult = await this.order.calculateOrder({
        orderType: params.orderType,
        countrycode: params.extraOrderData.countrycode,
        cart: params.cart,
        fast: params.extraOrderData.fast || false,
      });

      const discountResult = await this.discount.calculateDiscounts(
        params.cart,
        calculateResult.data.total
      );

      discountAmount = discountResult.discountAmount;
      discountUseIds = discountResult.discountUseIds;
      discountUsed = discountResult.discountUsed;

      if (discountAmount > calculateResult.data.total) {
        discountAmount = calculateResult.data.total;
      }

      calculateResult.data.total -= discountAmount;
      calculateResult.data.discount = discountAmount;

      const paymentClientResult = await this.getClient(clientIp);
      const paymentClient = paymentClientResult.client;
      mollieTest = paymentClientResult.test;

      const translations = await this.translation.getTranslationsByPrefix(
        params.locale,
        'payment'
      );

      // if any of params.items has a type of 'physical' then we need to set useOrderType to 'physical'
      for (let i = 0; i < params.cart.items.length; i++) {
        if (params.cart.items[i].type == 'physical') {
          useOrderType = 'physical';
          totalCards += params.cart.items[i].amount;
        }
      }

      if (params.cart.items[0].productType == 'giftcard') {
        description = `${translations!.giftcard}`;
      } else {
        description = `${translations!.playlist} : ${
          params.cart.items[0].playlistName
        }`;
      }

      if (params.cart.items.length > 1) {
        // If it only contains giftcards, we can use the giftcard translation
        if (
          params.cart.items.every((item: any) => item.productType == 'giftcard')
        ) {
          description = `${params.cart.items.length}x ${
            translations!.giftcards
          }`;
        } else if (
          // If it only contains playlists, we can use the playlist translation
          params.cart.items.every((item: any) => item.productType == 'playlist')
        ) {
          description = `${params.cart.items.length}x ${
            translations!.playlists
          }`;
        } else {
          // If it contains a mix of playlists and giftcards, we can use the items translation
          description = `${params.cart.items.length}x ${translations!.items}`;
        }
      }

      // Description is 255 characters max
      if (description.length > 255) {
        description = description.substring(0, 250);
      }

      if (calculateResult.data.total === 0 && discountUsed) {
        molliePaymentId = `free_${this.utils.generateRandomString(10)}`;
        molliePaymentAmount = 0;
        molliePaymentStatus = 'paid';
        mollieCheckoutUrl = `${process.env['FRONTEND_URI']}/${params.locale}/generate/progress`;
        triggerDirectGeneration = true;
      } else {
        if (calculateResult.data.total <= 3) {
          throw new Error('Order calculation');
        }

        // Try to get the country code from the IP to improve the payment methods
        let locationCountryCode = '';
        try {
          const response = await axios.get(
            `https://ipapi.co/${clientIp}/json`,
            {
              timeout: 2000,
            }
          );
          const location = response.data;
          if (!location.error) {
            locationCountryCode = location.country.toLowerCase();
          }
        } catch (error) {}

        const localeData = this.getMollieLocaleData(
          params.locale,
          locationCountryCode
        );
        const defaultMethods: PaymentMethod[] = [
          PaymentMethod.applepay,
          PaymentMethod.ideal,
          PaymentMethod.paypal,
          PaymentMethod.creditcard,
        ];
        const paymentMethods = [
          ...defaultMethods,
          ...localeData.paymentMethods,
        ];

        const payment = await paymentClient.payments.create({
          amount: {
            currency: 'EUR',
            value: calculateResult.data.total.toFixed(2),
          },
          metadata: {
            clientIp,
            refreshPlaylists: params.refreshPlaylists.join(','),
          },
          method: paymentMethods,
          description: description,
          redirectUrl: `${process.env['FRONTEND_URI']}/${params.locale}/generate/check_payment`,
          webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
          locale: localeData.locale,
        });

        molliePaymentId = payment.id;
        mollieTest = payment.mode == 'test';
        molliePaymentAmount = parseFloat(payment.amount.value);
        molliePaymentStatus = payment.status;
        mollieCheckoutUrl = payment.getCheckoutUrl()!;
      }

      const userDatabaseId = await this.data.storeUser({
        userId: params.extraOrderData.email,
        email: params.extraOrderData.email,
        displayName: params.extraOrderData.fullname,
        locale: params.locale,
      });

      const playlistDatabaseIds = await this.data.storePlaylists(
        userDatabaseId,
        params.cart.items
      );

      const productPriceWithoutTax = parseFloat(
        parseFloat(calculateResult.data.price).toFixed(2)
      );

      let shippingPriceWithoutTax = 0;
      let shippingVATPrice = 0;

      if (useOrderType == 'physical') {
        shippingPriceWithoutTax = parseFloat(
          (
            parseFloat(calculateResult.data.payment) /
            (1 + calculateResult.data.taxRateShipping / 100)
          ).toFixed(2)
        );

        shippingVATPrice = parseFloat(
          (
            parseFloat(calculateResult.data.payment) - shippingPriceWithoutTax
          ).toFixed(2)
        );
      }

      const productVATPrice = parseFloat(
        (
          parseFloat(calculateResult.data.price) *
          (calculateResult.data.taxRate / 100)
        ).toFixed(2)
      );

      const totalVATPrice = parseFloat(
        (productVATPrice + shippingVATPrice).toFixed(2)
      );

      const playlists = await Promise.all(
        params.cart.items.map(async (item: CartItem, index: number) => {
          const orderType = await this.order.getOrderType(
            item.numberOfTracks,
            item.type === 'digital',
            item.productType,
            item.playlistId,
            item.subType
          );

          if (item.isSlug) {
            const dbPlaylist = await this.prisma.playlist.findFirst({
              where: { slug: item.playlistId },
            });
          }

          const printApiItemPrice = orderType.amount * item.amount;

          let itemPrice = item.price * item.amount;
          
          // Add €2 per set if hideDomain is true (for cards only)
          if (item.hideDomain && item.productType === 'cards') {
            itemPrice += 2 * item.amount;
          }

          const itemPriceWithoutVAT = parseFloat(
            (itemPrice / (1 + calculateResult.data.taxRate / 100)).toFixed(2)
          );
          const itemPriceVAT = parseFloat(
            (itemPrice - itemPriceWithoutVAT).toFixed(2)
          );

          return {
            playlistId: playlistDatabaseIds[index],
            orderTypeId: orderType.id,
            amount: item.amount,
            numberOfTracks: item.numberOfTracks,
            type: item.type == 'sheets' ? 'physical' : item.type,
            subType: item.type == 'sheets' ? 'sheets' : 'none',
            doubleSided: item.doubleSided,
            eco: item.eco,
            qrColor: item.qrColor || '#000000',
            qrBackgroundColor: item.qrBackgroundColor || '#ffffff',
            hideCircle: item.hideCircle,
            qrBackgroundType: item.qrBackgroundType || (item.hideCircle ? 'none' : 'square'),
            hideDomain: item.hideDomain,
            price: itemPrice,
            priceWithoutVAT: itemPriceWithoutVAT,
            priceVAT: itemPriceVAT,
            printApiPrice: printApiItemPrice,
            emoji: item.emoji || '',
            background: item.background || '',
            logo: item.logo || '',
            selectedFont: item.selectedFont || 'Arial, sans-serif',
            selectedFontSize: item.selectedFontSize || '16px',
            // Front side color/gradient
            backgroundFrontType: item.backgroundFrontType || 'image',
            backgroundFrontColor: item.backgroundFrontColor || '#ffffff',
            useFrontGradient: item.useFrontGradient || false,
            gradientFrontColor: item.gradientFrontColor || '#ffffff',
            gradientFrontDegrees: item.gradientFrontDegrees || 180,
            gradientFrontPosition: item.gradientFrontPosition || 50,
            // Back side
            backgroundBackType: item.backgroundBackType || 'image',
            backgroundBack: item.backgroundBack || '',
            backgroundBackColor: item.backgroundBackColor || '#ffffff',
            fontColor: item.fontColor || '#000000',
            useGradient: item.useGradient || false,
            gradientBackgroundColor: item.gradientBackgroundColor || '#ffffff',
            gradientDegrees: item.gradientDegrees || 180,
            gradientPosition: item.gradientPosition || 50,
          };
        })
      );

      let totalProfit = parseFloat(
        (productPriceWithoutTax + shippingPriceWithoutTax).toFixed(2)
      );

      if (params.cart.items[0].productType == 'giftcard') {
        if (useOrderType == 'physical') {
          totalProfit =
            molliePaymentAmount - (shippingPriceWithoutTax + shippingVATPrice);
        } else {
          totalProfit = params.cart.items[0].price;
        }
      }

      delete params.extraOrderData.orderType;
      delete params.extraOrderData.total;
      delete params.extraOrderData.price;
      delete params.extraOrderData.agreeTerms;
      delete params.extraOrderData.agreeNoRefund;

      const taxRate = (await this.data.getTaxRate(
        params.extraOrderData.countrycode
      ))!;
      const molliePaymentAmountWithoutTax = parseFloat(
        (molliePaymentAmount / (1 + taxRate / 100)).toFixed(2)
      );

      const insertResult = await this.prisma.payment.create({
        data: {
          paymentId: molliePaymentId,
          vibe,
          user: {
            connect: { id: userDatabaseId },
          },
          totalPrice: molliePaymentAmount,
          totalPriceWithoutTax: molliePaymentAmountWithoutTax,
          status: molliePaymentStatus,
          locale: params.locale,
          taxRate: calculateResult.data.taxRate,
          taxRateShipping: calculateResult.data.taxRateShipping,
          productPriceWithoutTax,
          shippingPriceWithoutTax,
          productVATPrice,
          shippingVATPrice,
          totalVATPrice,
          clientIp,
          test: mollieTest,
          profit: totalProfit,
          printApiPrice: 0,
          discount: discountAmount,
          PaymentHasPlaylist: { create: playlists },
          ...params.extraOrderData,
        },
      });

      const paymentId = insertResult.id;

      const newOrderId = 100000000 + paymentId;

      // Update the users marketingEmails field
      await this.prisma.user.update({
        where: {
          id: userDatabaseId,
        },
        data: {
          marketingEmails: params.extraOrderData.marketingEmails,
          sync: true,
        },
      });

      // Associate the payment with each discount use
      for (const discountUseId of discountUseIds) {
        await this.discount.associatePaymentWithDiscountUse(
          discountUseId,
          paymentId
        );
      }
      await this.prisma.payment.update({
        where: {
          id: paymentId,
        },
        data: {
          orderId: newOrderId.toString(),
        },
      });

      if (triggerDirectGeneration) {
        if (waitForDirectGeneration) {
          await this.generator.queueGenerate(
            molliePaymentId,
            clientIp,
            params.refreshPlaylists.join(','),
            false,
            skipGenerationMail,
            false
          );
        } else {
          this.generator.queueGenerate(
            molliePaymentId,
            clientIp,
            params.refreshPlaylists.join(','),
            false,
            false,
            false
          );
        }
      }

      return {
        success: true,
        data: {
          paymentId: molliePaymentId,
          paymentUri: mollieCheckoutUrl,
          userId: userDatabaseId,
        },
      };
    } catch (e) {
      console.log(e);
      return {
        success: false,
        error: 'Failed to create payment',
      };
    }
  }

  public async canDownloadPDF(
    playlistId: string,
    paymentId: string
  ): Promise<boolean> {
    const payment = await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
      select: {
        PaymentHasPlaylist: {
          select: {
            playlist: {
              select: {
                playlistId: true,
              },
            },
          },
        },
      },
    });

    if (payment) {
      return payment.PaymentHasPlaylist.some(
        (relation) => relation.playlist.playlistId === playlistId
      );
    } else {
      return false;
    }
  }

  public async processWebhook(params: any): Promise<ApiResult> {
    if (params.id) {
      this.logger.log(
        color.blue.bold('Processing webhook with ID: ') +
        color.white.bold(params.id)
      );

      // Check if this is a valid Mollie payment ID format (starts with "tr_")
      if (!params.id.startsWith('tr_')) {
        this.logger.log(
          color.red.bold('Invalid payment ID format in webhook: ') +
          color.white.bold(params.id)
        );
        return {
          success: false,
          error: 'Invalid payment ID format'
        };
      }

      let payment;

      // Try the live client first, with a fallback to test
      try {
        payment = await this.mollieClient.payments.get(params.id);
      } catch (e) {
        payment = await this.mollieClientTest.payments.get(params.id);
      }

      const dbPayment = await this.prisma.payment.findUnique({
        select: {
          id: true,
          paymentId: true,
          status: true,
          user: {
            select: {
              hash: true,
            },
          },
        },
        where: {
          paymentId: payment.id,
        },
      });

      this.logger.log(
        color.blue.bold('Processed webhook for payment: ') +
          color.bold.white(payment.id) +
          color.blue.bold(' with status: ') +
          color.bold.white(payment.status)
      );

      try {
        // Update the payment in the database
        await this.prisma.payment.update({
          where: {
            paymentId: payment.id,
          },
          data: {
            status: payment.status,
            paymentMethod: payment.method,
          },
        });
      } catch (e) {
        this.logger.log(
          color.red.bold('Failed to update payment in database: ') +
            color.white.bold(payment.id)
        );
        return {
          success: false,
          error: 'Failed to update payment',
        };
      }

      if (
        dbPayment &&
        (dbPayment.status != payment.status ||
          process.env['ENVIRONMENT'] == 'development')
      ) {
        if (payment.status == 'paid') {
          const metadata = payment.metadata as {
            clientIp: string;
            refreshPlaylists: string;
          };

          // Clear the playlist cache for this user since they may have purchased new playlists
          if (dbPayment.user?.hash) {
            await this.game.clearUserPlaylistCache(dbPayment.user.hash);
            this.logger.log(
              color.green.bold('Cleared playlist cache for user: ') +
              color.white.bold(dbPayment.user.hash)
            );
          }

          this.generator.queueGenerate(
            params.id,
            metadata.clientIp,
            metadata.refreshPlaylists,
            false,
            false,
            false
          );
        } else if (this.failedPaymentStatus.includes(payment.status)) {
          await this.discount.removeDiscountUsesByPaymentId(dbPayment.id);
        }
      }
    }
    return {
      success: true,
    };
  }

  public async checkPaymentStatus(paymentId: string): Promise<ApiResult> {
    // Get the payment from the database
    const payment = await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
      select: {
        status: true,
        user: {
          select: {
            userId: true, // Selectively retrieve only the userId from the user record
            hash: true,
          },
        },
      },
    });

    if (payment && this.paidPaymentStatus.includes(payment.status)) {
      return {
        success: true,
        data: {
          status: 'paid',
          payment,
        },
      };
    } else if (payment && this.openPaymentStatus.includes(payment.status)) {
      return {
        success: false,
        data: {
          status: 'open',
        },
      };
    } else if (payment && this.failedPaymentStatus.includes(payment.status)) {
      return {
        success: false,
        data: {
          status: 'failed',
        },
      };
    } else {
      return {
        success: false,
        error: 'Error checking payment status',
      };
    }
  }

  public async getPayment(paymentId: string): Promise<any> {
    return (await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
      select: {
        id: true,
        userId: true,
        paymentId: true,
        status: true,
        createdAt: true,
        taxRate: true,
        profit: true,
        finalized: true,
        taxRateShipping: true,
        updatedAt: true,
        orderId: true,
        totalPrice: true,
        paymentMethod: true,
        printApiOrderId: true,
        locale: true,
        productPriceWithoutTax: true,
        shippingPriceWithoutTax: true,
        productVATPrice: true,
        shippingVATPrice: true,
        totalVATPrice: true,
        differentInvoiceAddress: true,
        invoiceAddress: true,
        invoiceHousenumber: true,
        invoiceCity: true,
        invoiceZipcode: true,
        invoiceCountrycode: true,
        shipping: true,
        fullname: true,
        email: true,
        address: true,
        housenumber: true,
        city: true,
        zipcode: true,
        qrSubDir: true,
        countrycode: true,
        vibe: true,
        user: {
          select: {
            email: true,
            hash: true,
          },
        },
        PaymentHasPlaylist: {
          select: {
            filename: true,
            filenameDigital: true,
            playlist: {
              select: {
                playlistId: true, // Only selecting the playlistId from the related Playlist
              },
            },
          },
        },
      },
    })) as Payment | null; // Add 'as Payment | null' to explicitly cast the returned object.
  }
}

export default Mollie;
