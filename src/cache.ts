import { color } from 'console-log-colors';
import Redis from 'ioredis';
import Log from './logger';

class Cache {
  private logManager = new Log();
  private static instance: Cache;
  private client: Redis;

  private constructor() {
    this.client = new Redis(process.env['REDIS_URL']!);
    // Handle connection errors
    this.client.on('error', (error) => {
      this.logManager.log(
        color.red.bold('Redis connection error: ') +
          color.white.bold(error.message)
      );
    });
  }

  public static getInstance(): Cache {
    if (!Cache.instance) {
      Cache.instance = new Cache();
    }
    return Cache.instance;
  }

  async init(): Promise<void> {
    this.logManager.log(color.green.bold('Redis connection established'));
  }

  private async executeCommand(command: string, ...args: any[]): Promise<any> {
    try {
      // @ts-ignore: Dynamic command execution
      return await this.client[command](...args);
    } catch (error) {
      this.logManager.log('Redis command error:' + (error as Error).message);
      throw error; // Re-throwing so that specific call sites can also handle if needed
    }
  }

  async set(
    key: string,
    value: string,
    expireInSeconds?: number
  ): Promise<void> {
    if (expireInSeconds) {
      await this.executeCommand('set', key, value, 'EX', expireInSeconds);
    } else {
      await this.executeCommand('set', key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return await this.executeCommand('get', key);
  }

  async setArray(key: string, values: string[]): Promise<void> {
    await this.executeCommand('del', key); // Ensure the key is empty before setting new values
    await this.executeCommand('sadd', key, ...values);
  }

  async getArray(key: string): Promise<string[]> {
    return await this.executeCommand('smembers', key);
  }

  async valueExistsInArray(key: string, value: string): Promise<boolean> {
    const exists = await this.executeCommand('sismember', key, value);
    return exists === 1;
  }

  async addValueToArray(key: string, value: string): Promise<void> {
    await this.executeCommand('sadd', key, value);
  }

  async addValuesToArray(key: string, values: string[]): Promise<void> {
    await this.executeCommand('sadd', key, ...values);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export default Cache;
