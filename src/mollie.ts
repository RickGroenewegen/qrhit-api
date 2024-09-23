import { ApiResult } from './interfaces/ApiResult';
import { createMollieClient, Locale } from '@mollie/api-client';
import { Payment } from '@prisma/client';
import PrismaInstance from './prisma';
import { color } from 'console-log-colors';
import Logger from './logger';
import Data from './data';
import Order from './order';
import Translation from './translation';
import Utils from './utils';
import Generator from './generator';

class Mollie {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private data = new Data();
  private order = Order.getInstance();
  private translation: Translation = new Translation();
  private utils = new Utils();
  private generator = new Generator();

  private getMollieLocale(locale: string): Locale {
    const localeMap: { [key: string]: string } = {
      en: 'en_US',
      nl: 'nl_NL',
      de: 'de_DE',
      fr: 'fr_FR',
      es: 'es_ES',
      it: 'it_IT',
      pt: 'pt_PT',
    };

    return (localeMap[locale] || 'en_US') as Locale; // Default to en_US if no match is found
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
    console.log(111, params);

    try {
      let amount = params.extraOrderData.amount || 1;
      let useOrderType = params.extraOrderData.orderType;

      if (params.tracks.length > 500) {
        // Limit the amount of tracks to 500
        params.tracks = params.tracks.slice(0, 500);
      }

      const orderType = await this.order.getOrderType(
        params.tracks.length,
        useOrderType == 'digital'
      );

      // Get the order type
      const calculateResult = await this.order.calculateOrder({
        orderType: params.orderType,
        countrycode: params.extraOrderData.countrycode,
        cart: params.cart,
      });

      const paymentClient = await this.getClient(clientIp);

      const translations = this.translation.getTranslationsByPrefix(
        params.locale,
        'payment'
      );

      let description =
        translations!.playlist +
        ': ' +
        params.playlist.name +
        ' (' +
        params.tracks.length +
        ' ' +
        translations!.cards +
        ')';

      if (useOrderType == 'digital') {
        description =
          translations!.digital +
          ' ' +
          params.tracks.length +
          ' ' +
          translations!.cards;
      }

      const payment = await paymentClient.payments.create({
        amount: {
          currency: 'EUR',
          value: calculateResult.data.total.toString(),
        },
        metadata: {
          clientIp,
        },
        description: description,
        redirectUrl: `${process.env['FRONTEND_URI']}/generate/check_payment`,
        webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
        locale: this.getMollieLocale(params.locale),
      });

      const userDatabaseId = await this.data.storeUser({
        userId: params.extraOrderData.email,
        email: params.extraOrderData.email,
        displayName: params.extraOrderData.fullname,
      });

      const playlistDatabaseId = await this.data.storePlaylist(
        userDatabaseId,
        params.playlist,
        calculateResult.data.price,
        !params.playlist.cached
      );

      delete params.extraOrderData.orderType;
      delete params.extraOrderData.total;
      delete params.extraOrderData.agreeTerms;
      delete params.extraOrderData.agreeNoRefund;
      params.extraOrderData.amount = parseInt(params.extraOrderData.amount);

      const productPriceWithoutTax = parseFloat(
        (
          parseFloat(calculateResult.data.price) /
          (1 + calculateResult.data.taxRate / 100)
        ).toFixed(2)
      );
      const productVATPrice = parseFloat(
        (
          parseFloat(calculateResult.data.price) - productPriceWithoutTax
        ).toFixed(2)
      );

      let shippingPriceWithoutTax = 0;
      let shippingVATPrice = 0;
      let taxRateShipping = 0;

      if (useOrderType != 'digital') {
        taxRateShipping = calculateResult.data.taxRateShipping;
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

      const totalVATPrice = parseFloat(
        (productVATPrice + shippingVATPrice).toFixed(2)
      );

      // Create the payment in the database
      const insertResult = await this.prisma.payment.create({
        data: {
          paymentId: payment.id,
          userId: userDatabaseId,
          totalPrice: parseFloat(payment.amount.value),
          playlistId: playlistDatabaseId,
          status: payment.status,
          orderTypeId: orderType!.id,
          locale: params.locale,
          taxRate: calculateResult.data.taxRate,
          taxRateShipping: taxRateShipping,
          productPriceWithoutTax,
          shippingPriceWithoutTax,
          productVATPrice,
          shippingVATPrice,
          totalVATPrice,
          clientIp,
          numberOfTracks: params.tracks.length,
          ...params.extraOrderData,
        },
      });

      const paymentId = insertResult.id;

      const newOrderId = 100000000 + paymentId;

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
        playlist: {
          select: {
            playlistId: true,
          },
        },
      },
    });

    if (payment && payment.playlist!.playlistId == playlistId) {
      return true;
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
        const metadata = payment.metadata as { clientIp: string };
        this.generator.generate(params.id, metadata.clientIp, this);
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
        amount: true,
        status: true,
        filename: true,
        filenameDigital: true,
        createdAt: true,
        taxRate: true,
        taxRateShipping: true,
        updatedAt: true,
        orderType: true,
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
        price: true,
        shipping: true,
        fullname: true,
        email: true,
        address: true,
        city: true,
        zipcode: true,
        numberOfTracks: true,
        countrycode: true,
        user: {
          select: {
            email: true,
          },
        },
        playlist: {
          select: {
            playlistId: true, // Only selecting the playlistId from the related Playlist
            id: true,
          },
        },
      },
    })) as Payment | null; // Add 'as Payment | null' to explicitly cast the returned object.
  }
}

export default Mollie;
