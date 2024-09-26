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
}

export default AnalyticsClient;
