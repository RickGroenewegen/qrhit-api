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

    this.client = new Redis(redisUrl, { db: 0 });

    // Handle connection errors
    this.client.on('error', (error) => {
      this.logManager.log(
        color.red.bold('Redis connection error: ') +
          color.white.bold(error.message)
      );
    });
  }

  // Updated rateLimit to accept and pass db parameter
  async rateLimit(key: string, delay: number, db: number = 0): Promise<void> {
    const lastRequestTime = await this.get(key, false, db); // Pass db to get
    const currentTime = Date.now();
    if (lastRequestTime) {
      const elapsedTime = currentTime - parseInt(lastRequestTime, 10);
      if (elapsedTime < delay) {
        await new Promise((resolve) =>
          setTimeout(resolve, delay - elapsedTime)
        );
      }
    }
    await this.set(key, currentTime.toString(), undefined, db); // Pass db to set
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

  // Updated executeCommand to handle DB selection
  public async executeCommand(command: string, db: number = 0, ...args: any[]): Promise<any> {
    const originalDb = 0; // Assuming the default connection is always DB 0
    let selectedDb = false;

    try {
      // Select the target database if it's not the default
      if (db !== originalDb) {
        // Use the client's select method directly
        await this.client.select(db);
        selectedDb = true;
      }

      // Execute the actual command
      // @ts-ignore: Dynamic command execution
      const result = await this.client[command](...args);
      return result;
    } catch (error) {
      this.logManager.log(`Redis command error (DB ${db}, Command ${command}): ${(error as Error).message}`);
      throw error; // Re-throwing so that specific call sites can also handle if needed
    } finally {
      // Ensure we switch back to the original database if we switched away
      if (selectedDb) {
        // Use the client's select method directly
        await this.client.select(originalDb);
      }
    }
  }

  // Updated set method with optional db parameter
  async set(
    key: string,
    value: string,
    expireInSeconds?: number,
    db: number = 0 // Added db parameter
  ): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    if (expireInSeconds) {
      // Pass db to executeCommand
      await this.executeCommand('set', db, cacheKey, value, 'EX', expireInSeconds);
    } else {
      // Pass db to executeCommand
      await this.executeCommand('set', db, cacheKey, value);
    }
  }

  // Updated get method with optional db parameter
  async get(key: string, never: boolean = true, db: number = 0): Promise<string | null> {
    let cacheKey = `${this.version}:${key}`;
    if (process.env['ENVIRONMENT'] === 'development' && never) {
      // Optional: Consider if dev prefix needs db info
      // cacheKey = `dev_${db}_${new Date().getTime()}:${cacheKey}`;
    }
    // Pass db to executeCommand
    return await this.executeCommand('get', db, cacheKey);
  }

  async flush(): Promise<void> {
    // Note: flush still uses executeCommand without db, so it will use default db 0
    // If flush needs db parameter, it should be added here too.
    await this.executeCommand('flushdb');
  }

  async del(key: string): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('del', cacheKey);
  }

  async delPattern(pattern: string): Promise<void> {
    let cachePattern = `${this.version}:${pattern}`;
    const keys = await this.executeCommand('keys', cachePattern);
    if (keys && keys.length > 0) {
      await this.executeCommand('del', ...keys);
    }
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

  async acquireLock(key: string, ttlSeconds: number = 300): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const result = await this.executeCommand(
      'set',
      lockKey,
      '1',
      'NX',
      'EX',
      ttlSeconds
    );
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    const lockKey = `lock:${key}`;
    await this.executeCommand('del', lockKey);
  }
}

export default Cache;
