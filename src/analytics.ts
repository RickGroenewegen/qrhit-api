import Logger from './logger';
import Redis from 'ioredis';
import { color } from 'console-log-colors';

class AnalyticsClient {
  private static instance: AnalyticsClient;
  private logger = new Logger();
  private client: Redis;

  constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.client = new Redis(redisUrl);
    this.client
      .select(1)
      .then(() => {})
      .catch((error) => {
        this.logger.log(
          color.red.bold(
            `Error selecting Redis database index 1: ${color.white.bold(
              error.message
            )}`
          )
        );
      });
  }

  public static getInstance(): AnalyticsClient {
    if (!AnalyticsClient.instance) {
      AnalyticsClient.instance = new AnalyticsClient();
    }
    return AnalyticsClient.instance;
  }

  public async logEvent(
    category: string,
    action: string,
    value: string
  ): Promise<void> {
    const cacheKey = `analytics:${category}:${action}`;
    await this.executeCommand('set', cacheKey, value);
  }

  private async executeCommand(command: string, ...args: any[]): Promise<any> {
    try {
      // @ts-ignore: Dynamic command execution
      return await this.client[command](...args);
    } catch (error) {
      this.logger.log(
        `Redis command error: ${command} ${args.join(' ')} - ${
          (error as Error).message
        }`
      );
      throw error; // Re-throwing so that specific call sites can also handle if needed
    }
  }

  public async getEventCount(category: string, action: string): Promise<number> {
    const cacheKey = `analytics:${category}:${action}`;
    const value = await this.executeCommand('get', cacheKey);
    return value ? parseInt(value, 10) : 0;
  }

  public async getAllAnalytics(): Promise<Record<string, number>> {
    const keys = await this.executeCommand('keys', 'analytics:*');
    const result: Record<string, number> = {};

    for (const key of keys) {
      const value = await this.executeCommand('get', key);
      result[key] = value ? parseInt(value, 10) : 0;
    }

    return result;
  }

  public async getAnalyticsCount(category: string, action: string): Promise<number> {
    let cursor = '0';
    let totalCount = 0;
    const pattern = `analytics:${category}:${action}`;

    do {
      const [nextCursor, keys] = await this.executeCommand('scan', cursor, 'MATCH', pattern, 'COUNT', '100');
      cursor = nextCursor;
      totalCount += keys.length;
    } while (cursor !== '0');

    return totalCount;
  }
}

export default AnalyticsClient;
