import Log from './logger';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import Cache from './cache';
import { ApiResult } from './interfaces/ApiResult';

class Order {
  private static instance: Order;
  private prisma = new PrismaClient();
  private cacheToken: string = 'printapi_auth_token';
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): Order {
    if (!Order.instance) {
      Order.instance = new Order();
    }
    return Order.instance;
  }

  public async calculateOrder(params: any): Promise<ApiResult> {
    let price = 0;
    let total = 0;

    const authToken = await this.getAuthToken();
    const orderType = await this.prisma.orderType.findUnique({
      where: {
        name: params.orderType,
      },
    });

    if (orderType) {
      price = parseFloat(
        (orderType.amount * parseInt(params.amount)).toFixed(2)
      );

      total += price;

      let response: any = {};

      if (params.orderType !== 'digital') {
        response = await axios({
          method: 'post',
          url: `${process.env['PRINT_API_URL']}/v2/shipping/quote `,
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          data: {
            country: 'NL',
            items: [
              {
                productId: orderType.printApiProductId,
                quantity: params.amount,
              },
            ],
          },
        });

        total += response.data.payment;
      }

      total = parseFloat(total.toFixed(2));

      return {
        success: true,
        data: {
          price,
          total,
          ...response.data,
        },
      };
    } else {
      return {
        success: false,
        error: 'Order type not found',
      };
    }
  }

  private async getAuthToken(): Promise<string | null> {
    let authToken: string | null = '';
    authToken = await this.cache.get(this.cacheToken);
    if (!authToken) {
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
      this.cache.set(this.cacheToken, response.data.access_token, 7200);
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
            productId: 'boek_hc_a5_sta',
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

    console.log(1111, responseOrder.data);
  }
}

export default Order;
