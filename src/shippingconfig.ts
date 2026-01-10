import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Cache from './cache';

export interface CountryShippingConfigData {
  id: number;
  countryCode: string;
  minDaysOffset: number;
  maxDaysOffset: number;
  createdAt: Date;
  updatedAt: Date;
}

class ShippingConfig {
  private static instance: ShippingConfig;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): ShippingConfig {
    if (!ShippingConfig.instance) {
      ShippingConfig.instance = new ShippingConfig();
    }
    return ShippingConfig.instance;
  }

  /**
   * Get all country shipping configurations
   * Cached for 5 minutes
   */
  public async getAllConfigs(): Promise<CountryShippingConfigData[]> {
    try {
      const cacheKey = 'country_shipping_configs';
      const cachedData = await this.cache.get(cacheKey);

      if (cachedData) {
        return JSON.parse(cachedData);
      }

      const configs = await this.prisma.countryShippingConfig.findMany({
        orderBy: {
          countryCode: 'asc',
        },
      });

      // Cache for 5 minutes (300 seconds)
      await this.cache.set(cacheKey, JSON.stringify(configs), 300);

      return configs;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error getting country shipping configs: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return [];
    }
  }

  /**
   * Get shipping config for a specific country
   */
  public async getConfigForCountry(
    countryCode: string
  ): Promise<CountryShippingConfigData | null> {
    try {
      const configs = await this.getAllConfigs();
      return (
        configs.find(
          (c) => c.countryCode.toUpperCase() === countryCode.toUpperCase()
        ) || null
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error getting config for country ${countryCode}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Create or update shipping config for a country
   */
  public async upsertConfig(
    countryCode: string,
    minDaysOffset: number,
    maxDaysOffset: number
  ): Promise<CountryShippingConfigData | null> {
    try {
      const normalizedCountryCode = countryCode.toUpperCase();

      const config = await this.prisma.countryShippingConfig.upsert({
        where: {
          countryCode: normalizedCountryCode,
        },
        update: {
          minDaysOffset,
          maxDaysOffset,
        },
        create: {
          countryCode: normalizedCountryCode,
          minDaysOffset,
          maxDaysOffset,
        },
      });

      // Invalidate caches
      await this.invalidateCache();

      this.logger.log(
        color.green.bold(
          `Shipping config updated for ${normalizedCountryCode}: min=${minDaysOffset}, max=${maxDaysOffset}`
        )
      );

      return config;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error upserting config for country ${countryCode}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Delete shipping config for a country (reverts to calculated values)
   */
  public async deleteConfig(countryCode: string): Promise<boolean> {
    try {
      const normalizedCountryCode = countryCode.toUpperCase();

      await this.prisma.countryShippingConfig.delete({
        where: {
          countryCode: normalizedCountryCode,
        },
      });

      // Invalidate caches
      await this.invalidateCache();

      this.logger.log(
        color.green.bold(`Shipping config deleted for ${normalizedCountryCode}`)
      );

      return true;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error deleting config for country ${countryCode}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return false;
    }
  }

  /**
   * Invalidate all shipping-related caches
   */
  private async invalidateCache(): Promise<void> {
    try {
      await this.cache.del('country_shipping_configs');
      await this.cache.del('average_delivery_times');
      await this.cache.del('shipping_info_by_country');
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error invalidating shipping caches: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
    }
  }
}

export default ShippingConfig;
