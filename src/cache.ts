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

  async rateLimit(key: string, delay: number): Promise<void> {
    const lastRequestTime = await this.get(key, false);
    const currentTime = Date.now();
    if (lastRequestTime) {
      const elapsedTime = currentTime - parseInt(lastRequestTime, 10);
      if (elapsedTime < delay) {
        await new Promise((resolve) =>
          setTimeout(resolve, delay - elapsedTime)
        );
      }
    }
    await this.set(key, currentTime.toString());
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

  // Add optional db parameter, defaulting to 0
  public async executeCommand(command: string, db: number = 0, ...args: any[]): Promise<any> {
    const needsSwitch = db !== 0; // Determine if DB switch is needed
    try {
      if (needsSwitch) {
        await this.client.select(db); // Switch to the specified DB
      }
      // @ts-ignore: Dynamic command execution
      const result = await this.client[command](...args); // Execute the command
      return result;
    } catch (error) {
      this.logManager.log('Redis command error:' + (error as Error).message);
      throw error; // Re-throwing so that specific call sites can also handle if needed
    } finally {
      // Switch back to DB 0 if we switched away
      if (needsSwitch) {
        await this.client.select(0); // Ensure we switch back to the default DB
      }
    }
  }

  async set(
    key: string,
    value: string,
    expireInSeconds?: number,
    db: number = 0 // Add optional db parameter
  ): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    if (expireInSeconds) {
      // Pass db parameter to executeCommand
      await this.executeCommand(
        'set',
        db,
        cacheKey,
        value,
        'EX',
        expireInSeconds
      );
    } else {
      // Pass db parameter to executeCommand
      await this.executeCommand('set', db, cacheKey, value);
    }
  }

  async get(
    key: string,
    never: boolean = true,
    db: number = 0
  ): Promise<string | null> {
    // Add optional db parameter
    let cacheKey = `${this.version}:${key}`;
    if (process.env['ENVIRONMENT'] === 'development' && never) {
      // cacheKey = `dev_${new Date().getTime()}:${cacheKey}`;
    }
    // Pass db parameter to executeCommand
    return await this.executeCommand('get', db, cacheKey);
  }

  // --- Other methods remain unchanged and will use executeCommand's default db (0) ---
  async flush(): Promise<void> {
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
    // Calls executeCommand without db param, defaults to 0
    const result = await this.executeCommand(
      'set',
      0, // Explicitly use default DB 0 for locks
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
    // Calls executeCommand without db param, defaults to 0
    await this.executeCommand('del', 0, lockKey);
  }
}

export default Cache;
