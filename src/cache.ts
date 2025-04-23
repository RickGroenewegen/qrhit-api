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

    // ioredis defaults to db 0 if not specified.
    // The executeCommand method now handles selecting the correct DB per command.
    this.client = new Redis(redisUrl);

    // Handle connection errors
    this.client.on('error', (error) => {
      this.logManager.log(
        color.red.bold('Redis connection error: ') +
          color.white.bold(error.message)
      );
    });
  }

  async rateLimit(key: string, delay: number, db: number = 0): Promise<void> {
    // Rate limiting inherently uses get/set, so pass the db parameter
    const lastRequestTime = await this.get(key, false, db);
    const currentTime = Date.now();
    if (lastRequestTime) {
      const elapsedTime = currentTime - parseInt(lastRequestTime, 10);
      if (elapsedTime < delay) {
        await new Promise((resolve) =>
          setTimeout(resolve, delay - elapsedTime)
        );
      }
    }
    // Ensure the timestamp is set in the correct db
    await this.set(key, currentTime.toString(), undefined, db);
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
  public async executeCommand(
    command: string,
    db: number = 0,
    ...args: any[]
  ): Promise<any> {
    const originalDb = 0; // Assuming the default connection is always DB 0
    let selectedDb = false;

    try {
      // Select the target database if it's not the default
      if (db !== originalDb) {
        await this.client.select(db);
        selectedDb = true;
      }

      // Execute the actual command
      // @ts-ignore: Dynamic command execution
      const result = await this.client[command](...args);
      return result;
    } catch (error) {
      this.logManager.log(
        `Redis command error (DB ${db}, Command ${command}): ${
          (error as Error).message
        }`
      );
      throw error; // Re-throwing so that specific call sites can also handle if needed
    } finally {
      // Ensure we switch back to the original database if we switched away
      if (selectedDb) {
        await this.client.select(originalDb);
      }
    }
  }

  async set(
    key: string,
    value: string,
    expireInSeconds?: number,
    db: number = 0
  ): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    if (expireInSeconds) {
      await this.executeCommand(
        'set',
        db,
        cacheKey,
        value,
        'EX',
        expireInSeconds
      );
    } else {
      await this.executeCommand('set', db, cacheKey, value);
    }
  }

  async get(
    key: string,
    never: boolean = true,
    db: number = 0
  ): Promise<string | null> {
    let cacheKey = `${this.version}:${key}`;
    if (process.env['ENVIRONMENT'] === 'development' && never) {
      // Optional: Add dev prefix logic if needed, consider if it should include db
      // cacheKey = `dev_${db}_${new Date().getTime()}:${cacheKey}`;
    }
    return await this.executeCommand('get', db, cacheKey);
  }

  async flush(db: number = 0): Promise<void> {
    // FLUSHDB flushes the currently selected DB
    await this.executeCommand('flushdb', db);
  }

  async del(key: string, db: number = 0): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('del', db, cacheKey);
  }

  async delPattern(pattern: string, db: number = 0): Promise<void> {
    let cachePattern = `${this.version}:${pattern}`;
    // 'keys' command needs to run on the target db
    const keys = await this.executeCommand('keys', db, cachePattern);
    if (keys && keys.length > 0) {
      // 'del' command also needs to run on the target db
      await this.executeCommand('del', db, ...keys);
    }
  }

  async setArray(key: string, values: string[], db: number = 0): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    // Ensure the key is deleted and values are added in the correct db
    await this.executeCommand('del', db, cacheKey);
    await this.executeCommand('sadd', db, cacheKey, ...values);
  }

  async getArray(key: string, db: number = 0): Promise<string[]> {
    let cacheKey = `${this.version}:${key}`;
    return await this.executeCommand('smembers', db, cacheKey);
  }

  async valueExistsInArray(
    key: string,
    value: string,
    db: number = 0
  ): Promise<boolean> {
    let cacheKey = `${this.version}:${key}`;
    const exists = await this.executeCommand('sismember', db, cacheKey, value);
    return exists === 1;
  }

  async addValueToArray(
    key: string,
    value: string,
    db: number = 0
  ): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('sadd', db, cacheKey, value);
  }

  async addValuesToArray(
    key: string,
    values: string[],
    db: number = 0
  ): Promise<void> {
    let cacheKey = `${this.version}:${key}`;
    await this.executeCommand('sadd', db, cacheKey, ...values);
  }

  async close(): Promise<void> {
    // Close doesn't target a specific DB, it closes the connection
    await this.client.quit();
  }

  async acquireLock(
    key: string,
    ttlSeconds: number = 300,
    db: number = 0
  ): Promise<boolean> {
    const lockKey = `lock:${key}`; // Lock key doesn't need version prefix usually
    const result = await this.executeCommand(
      'set',
      db,
      lockKey,
      '1',
      'NX',
      'EX',
      ttlSeconds
    );
    return result === 'OK';
  }

  async releaseLock(key: string, db: number = 0): Promise<void> {
    const lockKey = `lock:${key}`;
    await this.executeCommand('del', db, lockKey);
  }
}

export default Cache;
