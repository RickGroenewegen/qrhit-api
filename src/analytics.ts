import Redis from 'ioredis';

class AnalyticsClient {
  private static instance: AnalyticsClient;
  private client: Redis;

  private constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.client = new Redis(redisUrl);
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

  public async increaseCounter(category: string, action: string, increment: number = 1): Promise<number> {
    const key = this.getKey(category, action);
    return await this.client.incrby(key, increment);
  }

  public async decreaseCounter(category: string, action: string, decrement: number = 1): Promise<number> {
    const key = this.getKey(category, action);
    return await this.client.decrby(key, decrement);
  }

  public async getCounter(category: string, action: string): Promise<number> {
    const key = this.getKey(category, action);
    const value = await this.client.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  public async setCounter(category: string, action: string, value: number): Promise<void> {
    const key = this.getKey(category, action);
    await this.client.set(key, value.toString());
  }
}

export default AnalyticsClient;
