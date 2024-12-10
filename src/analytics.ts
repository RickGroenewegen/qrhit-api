import Redis from 'ioredis';
import PrismaInstance from './prisma';

class AnalyticsClient {
  private static instance: AnalyticsClient;
  private client: Redis;
  private prisma = PrismaInstance.getInstance();

  private constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.client = new Redis(redisUrl, { db: 1 });
  }

  public static getInstance(): AnalyticsClient {
    if (!AnalyticsClient.instance) {
      AnalyticsClient.instance = new AnalyticsClient();
    }
    return AnalyticsClient.instance;
  }

  private getKey(category: string, action: string): string {
    return `analytics:${category}:${action}`;
  }

  public async increaseCounter(
    category: string,
    action: string,
    increment: number = 1
  ): Promise<number> {
    const key = this.getKey(category, action);
    return await this.client.incrby(key, increment);
  }

  public async decreaseCounter(
    category: string,
    action: string,
    decrement: number = 1
  ): Promise<number> {
    const key = this.getKey(category, action);
    return await this.client.decrby(key, decrement);
  }

  public async getCounter(category: string, action: string): Promise<number> {
    const key = this.getKey(category, action);
    const value = await this.client.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  public async setCounter(
    category: string,
    action: string,
    value: number
  ): Promise<void> {
    const key = this.getKey(category, action);
    await this.client.set(key, value.toString());
  }

  public async getAllCounters(): Promise<
    Record<string, Record<string, number>>
  > {
    const keys = await this.client.keys('analytics:*');
    const result: Record<string, Record<string, number>> = {};

    for (const key of keys) {
      const [, category, action] = key.split(':');
      const value = await this.client.get(key);

      if (!result[category]) {
        result[category] = {};
      }
      result[category][action] = parseInt(value || '0', 10);
    }

    const financeResult = await this.getProfitAndTurnOver();

    result['finance']['profit'] = financeResult.totalProfit;
    result['finance']['turnover'] = financeResult.totalPrice;

    const soldResult = await this.getTotalPlaylistsSoldByType();

    console.log(111, soldResult);

    return result;
  }

  public async getTotalPlaylistsSoldByType(
    excludedEmails: string[] = ['west14@gmail.com', 'info@rickgroenewegen.nl']
  ): Promise<Record<string, number>> {
    const result = await this.prisma.paymentHasPlaylist.groupBy({
      by: ['type'],
      _sum: {
        amount: true,
      },
      where: {
        payment: {
          user: {
            email: {
              notIn: excludedEmails,
            },
          },
        },
      },
    });

    return result.reduce((acc, item) => {
      acc[item.type] = item._sum.amount || 0;
      return acc;
    }, {} as Record<string, number>);
  }

  public async getProfitAndTurnOver(
    excludedEmails: string[] = ['west14@gmail.com', 'info@rickgroenewegen.nl']
  ): Promise<{ totalPrice: number; totalProfit: number }> {
    const payments = await this.prisma.payment.findMany({
      where: {
        user: {
          email: {
            notIn: excludedEmails,
          },
        },
      },
      select: {
        totalPrice: true,
        profit: true,
      },
    });

    const totals = payments.reduce(
      (acc, payment) => {
        acc.totalPrice += payment.totalPrice;
        acc.totalProfit += payment.profit;
        return acc;
      },
      { totalPrice: 0, totalProfit: 0 }
    );

    return totals;
  }
}

export default AnalyticsClient;
