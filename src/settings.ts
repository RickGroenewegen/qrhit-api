import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';

// Define known setting keys for type safety
export type SettingKey =
  | 'spotify_access_token'
  | 'spotify_refresh_token'
  | 'spotify_token_expires_at'; // Store expiry time as Unix timestamp (milliseconds)

class Settings {
  private static instance: Settings;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private readonly CACHE_TTL_SECONDS = 60;
  private readonly LOCK_TTL_SECONDS = 10; // Time to allow for DB fetch and cache set
  private readonly LOCK_RETRY_DELAY_MS = 200;
  private readonly LOCK_MAX_RETRIES = 5;

  private constructor() {}

  public static getInstance(): Settings {
    if (!Settings.instance) {
      Settings.instance = new Settings();
    }
    return Settings.instance;
  }

  private getCacheKey(key: SettingKey): string {
    return `setting:${key}`;
  }

  /**
   * Retrieves a setting value.
   * Attempts to fetch from cache first. If not found, fetches from DB,
   * caches it, and returns the value. Uses a lock to prevent race conditions
   * during DB fetch and cache population.
   * @param key The key of the setting to retrieve.
   * @returns The setting value as a string, or null if not found.
   */
  public async getSetting(key: SettingKey): Promise<string | null> {
    const cacheKey = this.getCacheKey(key);

    // 1. Try to get from cache (pass `false` for `never` to enable caching in dev)
    let cachedValue = await this.cache.get(cacheKey, false);
    if (cachedValue !== null) {
      this.logger.log(
        color.green.bold(`Setting '${color.white.bold(key)}' found in cache.`)
      );
      return cachedValue;
    }

    // 2. If not in cache, try to acquire lock to fetch from DB
    const lockKey = `setting_lock:${key}`; // Use a distinct key for the lock
    const lockAcquired = await this.cache.acquireLock(
      lockKey,
      this.LOCK_TTL_SECONDS
    );

    if (lockAcquired) {
      this.logger.log(
        color.blue.bold(
          `Acquired lock for setting '${color.white.bold(
            key
          )}'. Fetching from DB.`
        )
      );
      try {
        // Re-check cache: another instance might have populated it just before we acquired lock.
        cachedValue = await this.cache.get(cacheKey, false);
        if (cachedValue !== null) {
          this.logger.log(
            color.green.bold(
              `Setting '${color.white.bold(
                key
              )}' found in cache after acquiring lock.`
            )
          );
          return cachedValue;
        }

        const setting = await this.prisma.appSetting.findUnique({
          where: { key: key },
        });
        const valueFromDb = setting?.value ?? null;

        if (valueFromDb !== null) {
          await this.cache.set(cacheKey, valueFromDb, this.CACHE_TTL_SECONDS);
          this.logger.log(
            color.blue.bold(
              `Setting '${color.white.bold(
                key
              )}' fetched from DB and cached.`
            )
          );
        } else {
          this.logger.log(
            color.yellow.bold(
              `Setting '${color.white.bold(key)}' not found in DB.`
            )
          );
        }
        return valueFromDb;
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error reading setting (${color.white.bold(
              key
            )}) from DB while holding lock: ${color.white.bold(String(error))}`
          )
        );
        return null;
      } finally {
        await this.cache.releaseLock(lockKey);
        this.logger.log(
          color.blue.bold(`Released lock for setting '${color.white.bold(key)}'.`)
        );
      }
    } else {
      // Lock not acquired, another instance is fetching. Wait and retry from cache.
      this.logger.log(
        color.yellow.bold(
          `Could not acquire lock for setting '${color.white.bold(
            key
          )}'. Waiting for cache.`
        )
      );
      for (let i = 0; i < this.LOCK_MAX_RETRIES; i++) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.LOCK_RETRY_DELAY_MS)
        );
        cachedValue = await this.cache.get(cacheKey, false);
        if (cachedValue !== null) {
          this.logger.log(
            color.green.bold(
              `Setting '${color.white.bold(key)}' found in cache after waiting (attempt ${i + 1}).`
            )
          );
          return cachedValue;
        }
      }

      this.logger.log(
        color.red.bold(
          `Setting '${color.white.bold(
            key
          )}' not found in cache after waiting. Fetching from DB as fallback.`
        )
      );
      // Fallback: directly read from DB.
      try {
        const setting = await this.prisma.appSetting.findUnique({
          where: { key: key },
        });
        return setting?.value ?? null;
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error reading setting (${color.white.bold(
              key
            )}) from DB (fallback): ${color.white.bold(String(error))}`
          )
        );
        return null;
      }
    }
  }

  /**
   * Sets or updates a setting value in the database and invalidates cache.
   * @param key The key of the setting to set.
   * @param value The value to store for the setting.
   */
  public async setSetting(key: SettingKey, value: string): Promise<void> {
    try {
      await this.prisma.appSetting.upsert({
        where: { key: key },
        update: { value: value },
        create: { key: key, value: value },
      });
      this.logger.log(
        color.blue.bold(
          `Setting '${color.white.bold(key)}' updated in the database.`
        )
      );
      // Invalidate cache
      const cacheKey = this.getCacheKey(key);
      await this.cache.del(cacheKey);
      this.logger.log(
        color.blue.bold(`Cache for setting '${color.white.bold(key)}' invalidated.`)
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error writing setting (${color.white.bold(
            key
          )}) to DB: ${color.white.bold(String(error))}`
        )
      );
    }
  }

  /**
   * Deletes a setting from the database and invalidates cache.
   * @param key The key of the setting to delete.
   */
  public async deleteSetting(key: SettingKey): Promise<void> {
    const cacheKey = this.getCacheKey(key);
    try {
      await this.prisma.appSetting.delete({
        where: { key: key },
      });
      this.logger.log(
        color.blue.bold(
          `Setting '${color.white.bold(key)}' deleted from the database.`
        )
      );
      await this.cache.del(cacheKey);
      this.logger.log(
        color.blue.bold(`Cache for setting '${color.white.bold(key)}' invalidated.`)
      );
    } catch (error) {
      // Log error but don't throw, maybe it didn't exist
      this.logger.log(
        color.yellow.bold(
          `Error deleting setting (${color.white.bold(
            key
          )}) from DB: ${color.white.bold(String(error))}`
        )
      );
      // Attempt to invalidate cache even if DB delete failed or key didn't exist
      await this.cache.del(cacheKey);
      this.logger.log(
        color.yellow.bold(
          `Attempted cache invalidation for setting '${color.white.bold(key)}' after delete error/key not found.`
        )
      );
    }
  }
}

export default Settings;
