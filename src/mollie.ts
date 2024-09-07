import { ApiResult } from './interfaces/ApiResult';
import { createMollieClient } from '@mollie/api-client';
import { Payment, PrismaClient } from '@prisma/client';
import { color } from 'console-log-colors';
import Logger from './logger';
import Data from './data';
import Order from './order';

class Mollie {
  private prisma = new PrismaClient();
  private logger = new Logger();
  private data = new Data();
  private order = Order.getInstance();

  private mollieClient = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY']!,
  });

  private mollieClientTest = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY_TEST']!,
  });

  private async getClient(ip: string) {
    if (
      process.env['ENVIRONMENT'] == 'DEVELOPMENT' ||
      (process.env['TRUSTED_IPS'] &&
        process.env['TRUSTED_IPS'].split(',').includes(ip))
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
      let amount = params.extraOrderData.amount || 1;

      const orderType = await this.order.getOrderType(params.tracks.length);

      // Get the order type
      const calculateResult = await this.order.calculateOrder({
        orderType: params.orderType,
        countrycode: params.extraOrderData.countrycode,
        amount,
        numberOfTracks: params.tracks.length,
      });

      const paymentClient = await this.getClient(clientIp);

      const payment = await paymentClient.payments.create({
        amount: {
          currency: 'EUR',
          value: calculateResult.data.total.toString(),
        },
        metadata: {
          clientIp,
        },
        description: orderType!.description,
        redirectUrl: `${process.env['FRONTEND_URI']}/generate/check_payment`,
        webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
      });

      const userDatabaseId = await this.data.storeUser({
        userId: params.extraOrderData.email,
        email: params.extraOrderData.email,
        displayName: params.extraOrderData.fullname,
      });

      const playlistDatabaseId = await this.data.storePlaylist(
        userDatabaseId,
        params.playlist,
        calculateResult.data.price
      );

      delete params.extraOrderData.orderType;
      delete params.extraOrderData.total;
      delete params.extraOrderData.agreeTerms;
      params.extraOrderData.amount = parseInt(params.extraOrderData.amount);

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
        createdAt: true,
        updatedAt: true,
        orderType: true,
        orderId: true,
        totalPrice: true,
        printApiOrderId: true,
        locale: true,
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
