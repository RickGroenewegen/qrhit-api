import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';

// Define known setting keys for type safety
export type SettingKey =
  | 'spotify_access_token'
  | 'spotify_refresh_token'
  | 'spotify_token_expires_at'; // Store expiry time as Unix timestamp (milliseconds)

class Settings {
  private static instance: Settings;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): Settings {
    if (!Settings.instance) {
      Settings.instance = new Settings();
    }
    return Settings.instance;
  }

  /**
   * Retrieves a setting value from the database.
   * @param key The key of the setting to retrieve.
   * @returns The setting value as a string, or null if not found or on error.
   */
  public async getSetting(key: SettingKey): Promise<string | null> {
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
          )}) from DB: ${color.white.bold(error)}`
        )
      );
      return null;
    }
  }

  /**
   * Sets or updates a setting value in the database.
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
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error writing setting (${color.white.bold(
            key
          )}) to DB: ${color.white.bold(error)}`
        )
      );
    }
  }

  /**
   * Deletes a setting from the database.
   * @param key The key of the setting to delete.
   */
  public async deleteSetting(key: SettingKey): Promise<void> {
    try {
      await this.prisma.appSetting.delete({
        where: { key: key },
      });
      this.logger.log(
        color.blue.bold(
          `Setting '${color.white.bold(key)}' deleted from the database.`
        )
      );
    } catch (error) {
      // Log error but don't throw, maybe it didn't exist
      this.logger.log(
        color.yellow.bold(
          `Error deleting setting (${color.white.bold(
            key
          )}) from DB: ${color.white.bold(error)}`
        )
      );
    }
  }
}

export default Settings;
