import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Cache from './cache';

interface SettingsData {
  id: number;
  productionDays: number;
  productionMessage: string;
  createdAt: Date;
  updatedAt: Date;
}

class SiteSettings {
  private static instance: SiteSettings;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): SiteSettings {
    if (!SiteSettings.instance) {
      SiteSettings.instance = new SiteSettings();
    }
    return SiteSettings.instance;
  }

  /**
   * Get all production settings (should only be one row)
   * Cached for 5 minutes
   */
  public async getSettings(): Promise<SettingsData | null> {
    try {
      // Check cache first
      const cacheKey = 'production_settings';
      const cachedData = await this.cache.get(cacheKey);

      if (cachedData) {
        return JSON.parse(cachedData);
      }

      // Get settings from database (first row)
      const settings = await this.prisma.settings.findFirst({
        orderBy: {
          id: 'asc',
        },
      });

      if (settings) {
        // Cache for 5 minutes (300 seconds)
        await this.cache.set(cacheKey, JSON.stringify(settings), 300);
      }

      return settings;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error getting production settings: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Get production days setting
   */
  public async getProductionDays(): Promise<number | null> {
    try {
      const settings = await this.getSettings();
      return settings ? settings.productionDays : null;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error getting production days: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Get production message setting
   */
  public async getProductionMessage(): Promise<string | null> {
    try {
      const settings = await this.getSettings();
      return settings ? settings.productionMessage : null;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error getting production message: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Update production settings
   * Clears production settings cache and shipping info cache after update
   */
  public async updateSettings(data: {
    productionDays?: number;
    productionMessage?: string;
  }): Promise<SettingsData | null> {
    try {
      // Get current settings or create if doesn't exist
      let settings = await this.prisma.settings.findFirst();

      if (!settings) {
        // Create initial settings
        settings = await this.prisma.settings.create({
          data: {
            productionDays: data.productionDays ?? 3,
            productionMessage: data.productionMessage ?? '',
          },
        });
      } else {
        // Update existing settings
        settings = await this.prisma.settings.update({
          where: {
            id: settings.id,
          },
          data: {
            ...(data.productionDays !== undefined && {
              productionDays: data.productionDays,
            }),
            ...(data.productionMessage !== undefined && {
              productionMessage: data.productionMessage,
            }),
          },
        });
      }

      // Clear caches
      await this.cache.del('production_settings');
      await this.cache.del('shipping_info_by_country');

      this.logger.log(color.green.bold('Production settings updated successfully'));

      return settings;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error updating production settings: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Initialize production settings if they don't exist
   * Creates a default settings row
   */
  public async initializeSettings(): Promise<void> {
    try {
      const settings = await this.prisma.settings.findFirst();

      if (!settings) {
        await this.prisma.settings.create({
          data: {
            productionDays: 3,
            productionMessage: 'Your order will be produced and shipped within {days} business days.',
          },
        });

        this.logger.log(color.green.bold('Production settings initialized with defaults'));
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error initializing production settings: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
    }
  }
}

export default SiteSettings;
