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

class Mollie {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private data = new Data();
  private order = Order.getInstance();
  private translation: Translation = new Translation();
  private utils = new Utils();
  private generator = new Generator();

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
        ? { fullname: { contains: search.textSearch } }
        : {};

    const totalItems = await this.prisma.payment.count({
      where: {
        test: showTestPayments,
        ...whereClause,
        ...textSearchClause,
      },
    });

    const payments = await this.prisma.payment.findMany({
      where: {
        test: showTestPayments,
        ...whereClause,
        ...textSearchClause,
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
        createdAt: true,
        updatedAt: true,
        profit: true,
        printApiStatus: true,
        printApiTrackingLink: true,
        printApiOrderRequest: true,
        printApiOrderResponse: true,
        printApiOrderId: true,
        email: true,
        fullname: true,
        locale: true,
        address: true,
        city: true,
        zipcode: true,
        printApiShipped: true,
        countrycode: true,
        PaymentHasPlaylist: {
          select: {
            amount: true,
            filename: true,
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
              },
            },
          },
        },
      },
    });

    return { payments, totalItems };
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
      return this.mollieClientTest;
    } else {
      return this.mollieClient;
    }
  }

  public async getPaymentUri(
    params: any,
    clientIp: string
  ): Promise<ApiResult> {
    try {
      let useOrderType = 'digital';
      let description = '';
      let totalCards = 0;

      const calculateResult = await this.order.calculateOrder({
        orderType: params.orderType,
        countrycode: params.extraOrderData.countrycode,
        cart: params.cart,
      });

      const paymentClient = await this.getClient(clientIp);

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

      description = `${translations!.playlist} : ${
        params.cart.items[0].playlistName
      }`;

      if (params.cart.items.length > 1) {
        description = `${params.cart.items.length}x ${translations!.playlists}`;
      }

      // Description is 255 characters max
      if (description.length > 255) {
        description = description.substring(0, 250);
      }

      if (calculateResult.data.total <= 10) {
        throw new Error('Order calculation');
      }

      // Try to get the country code from the IP to improve the payment methods
      let locationCountryCode = '';
      try {
        const response = await axios.get(`https://ipapi.co/${clientIp}/json`, {
          timeout: 2000,
        });
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
      const paymentMethods = [...defaultMethods, ...localeData.paymentMethods];

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
        redirectUrl: `${process.env['FRONTEND_URI']}/generate/check_payment`,
        webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
        locale: localeData.locale,
      });

      const userDatabaseId = await this.data.storeUser({
        userId: params.extraOrderData.email,
        email: params.extraOrderData.email,
        displayName: params.extraOrderData.fullname,
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

      let totalPrintApiPrice = 0;

      if (useOrderType == 'physical') {
        totalPrintApiPrice += shippingPriceWithoutTax;
      }

      const playlists = await Promise.all(
        params.cart.items.map(async (item: CartItem, index: number) => {
          const orderType = await this.order.getOrderType(
            item.numberOfTracks,
            item.type === 'digital'
          );

          const printApiItemPrice = orderType.amount * item.amount;

          totalPrintApiPrice += printApiItemPrice;

          const itemPrice = item.price * item.amount;

          const itemPriceWithoutVAT = parseFloat(
            (itemPrice / (1 + calculateResult.data.taxRate / 100)).toFixed(2)
          );
          const itemPriceVAT = parseFloat(
            (itemPrice - itemPriceWithoutVAT).toFixed(2)
          );

          return {
            playlistId: playlistDatabaseIds[index],
            amount: item.amount,
            orderTypeId: orderType?.id || 0,
            numberOfTracks: item.numberOfTracks,
            type: item.type,
            price: itemPrice,
            priceWithoutVAT: itemPriceWithoutVAT,
            priceVAT: itemPriceVAT,
            printApiPrice: printApiItemPrice,
          };
        })
      );

      let totalProfit = parseFloat(
        (
          productPriceWithoutTax +
          shippingPriceWithoutTax -
          totalPrintApiPrice
        ).toFixed(2)
      );

      delete params.extraOrderData.orderType;
      delete params.extraOrderData.total;
      delete params.extraOrderData.price;
      delete params.extraOrderData.agreeTerms;
      delete params.extraOrderData.agreeNoRefund;

      const insertResult = await this.prisma.payment.create({
        data: {
          paymentId: payment.id,
          user: {
            connect: { id: userDatabaseId },
          },
          totalPrice: parseFloat(payment.amount.value),
          status: payment.status,
          locale: params.locale,
          taxRate: calculateResult.data.taxRate,
          taxRateShipping: calculateResult.data.taxRateShipping,
          productPriceWithoutTax,
          shippingPriceWithoutTax,
          productVATPrice,
          shippingVATPrice,
          totalVATPrice,
          clientIp,
          test: payment.mode == 'test',
          profit: totalProfit,
          printApiPrice: totalPrintApiPrice,
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
        },
      });

      // update the payment in the database
      await this.prisma.payment.update({
        where: {
          id: paymentId,
        },
        data: {
          orderId: newOrderId.toString(),
        },
      });

      return {
        success: true,
        data: {
          paymentId: payment.id,
          paymentUri: payment.getCheckoutUrl(),
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
        dbPayment.status != payment.status &&
        payment.status == 'paid'
      ) {
        const metadata = payment.metadata as {
          clientIp: string;
          refreshPlaylists: string;
        };

        this.generator.generate(
          params.id,
          metadata.clientIp,
          metadata.refreshPlaylists,
          this
        );
      }
    }
    return {
      success: true,
    };
  }

  public async checkPaymentStatus(paymentId: string): Promise<ApiResult> {
    const openPaymentStatus = ['open', 'pending', 'authorized'];
    const paidPaymentStatus = ['paid'];
    const failedPaymentStatus = ['failed', 'canceled', 'expired'];

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

    if (payment && paidPaymentStatus.includes(payment.status)) {
      return {
        success: true,
        data: {
          status: 'paid',
          payment,
        },
      };
    } else if (payment && openPaymentStatus.includes(payment.status)) {
      return {
        success: false,
        data: {
          status: 'open',
        },
      };
    } else if (payment && failedPaymentStatus.includes(payment.status)) {
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
        invoiceCity: true,
        invoiceZipcode: true,
        invoiceCountrycode: true,
        shipping: true,
        fullname: true,
        email: true,
        address: true,
        city: true,
        zipcode: true,
        countrycode: true,
        user: {
          select: {
            email: true,
            hash: true,
          },
        },
        PaymentHasPlaylist: {
          select: {
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
