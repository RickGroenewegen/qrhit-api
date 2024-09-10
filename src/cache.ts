import { color, white } from 'console-log-colors';
import Redis from 'ioredis';
import Log from './logger';
import fs from 'fs/promises';

class Cache {
  private logManager = new Log();
  private static instance: Cache;
  private client: Redis;
  private version: string = '1.0.0';

  private constructor() {
    const redisUrl = process.env['REDIS_URL'];

    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }

    this.client = new Redis(redisUrl);

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
      Cache.instance.init();
    }
    return Cache.instance;
  }

  async init(): Promise<void> {
    this.version = JSON.parse(
      (await fs.readFile('package.json')).toString()
    ).version;
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
    let cacheKey = `${this.version}:${key}`;
    if (expireInSeconds) {
      await this.executeCommand('set', cacheKey, value, 'EX', expireInSeconds);
    } else {
      await this.executeCommand('set', cacheKey, value);
    }
  }

  async get(key: string): Promise<string | null> {
    let cacheKey = `${this.version}:${key}`;
    if (process.env['ENVIRONMENT'] === 'development') {
      cacheKey = `dev_${new Date().getTime()}:${cacheKey}`;
    }
    return await this.executeCommand('get', cacheKey);
  }

  async del(key: string): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('del', cacheKey);
  }

  async setArray(key: string, values: string[]): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('del', cacheKey); // Ensure the key is empty before setting new values
    await this.executeCommand('sadd', cacheKey, ...values);
  }

  async getArray(key: string): Promise<string[]> {
    let cacheKey = `${this.version}:${key}`;
    return await this.executeCommand('smembers', cacheKey);
  }

  async valueExistsInArray(key: string, value: string): Promise<boolean> {
    let cacheKey = `${this.version}:${key}`;
    const exists = await this.executeCommand('sismember', cacheKey, value);
    return exists === 1;
  }

  async addValueToArray(key: string, value: string): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('sadd', cacheKey, value);
  }

  async addValuesToArray(key: string, values: string[]): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('sadd', cacheKey, ...values);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export default Cache;
