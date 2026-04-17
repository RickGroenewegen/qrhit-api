import { google } from 'googleapis';
import { PrismaClient } from '@prisma/client';
import Logger from './logger';
import Translation from './translation';
import Order from './order';
import Shipping from './shipping';
import Utils from './utils';
import sharp from 'sharp';
import axios from 'axios';
import path from 'path';
import fs from 'fs/promises';
import cluster from 'cluster';
import { CronJob } from 'cron';
import { blue, red, yellow, white, green } from 'console-log-colors';
import PrismaInstance from './prisma';
import Fx from './services/fx';
import { getCurrencyForCountry } from './data/currency-map';

// Set to true to delete and re-insert products (required for updating custom labels)
// Set to false to use PATCH updates (faster but cannot update customAttributes)
const USE_DELETE_INSERT_FOR_UPDATES = false;

// Genre groupings for PMax campaign segmentation (custom_label_1)
const GENRE_GROUPS: Record<string, string> = {
  // Pop & Hits
  pop: 'pop_hits',
  kpop: 'pop_hits',
  eurovision: 'pop_hits',
  general: 'pop_hits',
  // Rock & Metal
  rock: 'rock_metal',
  metal: 'rock_metal',
  // Mood & Emotion
  love: 'mood_emotion',
  oldies: 'mood_emotion',
  classical: 'mood_emotion',
  // World & Dance
  hiphop: 'world_dance',
  electronic: 'world_dance',
  rnb: 'world_dance',
  raggae: 'world_dance',
  // Other
  jazz: 'other',
  country: 'other',
  sountracks: 'other',
  '80s': 'other',
};

interface ProductVariant {
  id: number; // Database ID
  playlistId: string;
  name: string;
  description?: string;
  image: string;
  price: number;
  numberOfTracks: number;
  type: 'digital' | 'sheets' | 'physical';
  locale: string;
  country: string;
  slug: string;
  genre?: string;
  genreSlug?: string; // Genre slug for PMax custom labels
}

interface MerchantProduct {
  id: string; // Composite ID for Google (e.g., "online:en:US:123")
  offerId: string; // Simple unique ID for the product
  title: string;
  description: string;
  link: string;
  imageLink: string;
  availability: string;
  condition: string;
  price: {
    value: string;
    currency: string;
  };
  brand: string;
  contentLanguage: string;
  targetCountry: string;
  channel: string;
  productTypes: string[];
  googleProductCategory: string;
  shipping?: Array<{
    country: string;
    service: string;
    price: {
      value: string;
      currency: string;
    };
    minHandlingTime?: number;
    maxHandlingTime?: number;
    minTransitTime?: number;
    maxTransitTime?: number;
  }>;
  shippingLabel?: string;
  customAttributes: Array<{
    name: string;
    value: string;
  }>;
}

export class MerchantCenterService {
  private static instance: MerchantCenterService;
  private prisma: PrismaClient;
  private logger: Logger;
  private translate: Translation;
  private order: Order;
  private shipping: Shipping;
  private utils: Utils;
  private fx: Fx;
  // Cached shipping costs per country, populated at the start of each sync run
  // via loadShippingCosts(). Format mirrors Shipping.getShippingInfoByCountry().
  private shippingCostsByCountry: Map<
    string,
    { size: number; cost: number }[]
  > = new Map();
  private content: any; // Google Shopping Content API
  private merchantId: string;
  private auth: any;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // Supported locales for Merchant Center - limiting to main markets
  private supportedLocales = ['en', 'nl', 'de', 'es', 'sv', 'no'];

  // Mapping of locale-country combinations for Google Merchant Center
  // Multiple countries can use the same language content
  private localeCountryPairs: Array<{ locale: string; country: string }> = [
    { locale: 'en', country: 'US' },
    { locale: 'en', country: 'GB' }, // UK — English content, GBP
    { locale: 'en', country: 'AU' }, // Australia — English content, AUD
    { locale: 'en', country: 'CA' }, // Canada — English content, CAD
    { locale: 'nl', country: 'NL' },
    { locale: 'nl', country: 'BE' }, // Belgium using Dutch content
    { locale: 'de', country: 'DE' },
    { locale: 'de', country: 'AT' }, // Austria using German content
    { locale: 'de', country: 'CH' }, // Switzerland using German content, CHF
    { locale: 'es', country: 'ES' },
    { locale: 'sv', country: 'SE' },
    { locale: 'no', country: 'NO' },
  ];

  // Per-country currency is resolved via the shared
  // `getCurrencyForCountry()` helper in `src/data/currency-map.ts` — it
  // falls back to EUR for anything not in the supported-currencies map,
  // which is what Google Merchant Center expects for our European markets.

  private constructor() {
    this.prisma = PrismaInstance.getInstance();
    this.logger = new Logger();
    this.translate = new Translation();
    this.order = Order.getInstance();
    this.shipping = Shipping.getInstance();
    this.utils = new Utils();
    this.fx = Fx.getInstance();
    this.merchantId = process.env.GOOGLE_MERCHANT_ID || '';

    // Set up cron job to sync products at 4 AM every day
    // Only run on primary cluster worker and main server
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer) {
          this.logger.log(
            blue.bold('Setting up Merchant Center daily sync at 4 AM')
          );
          const job = new CronJob('0 4 * * *', async () => {
            this.logger.log(
              blue.bold('Running scheduled Merchant Center sync')
            );
            try {
              await this.uploadFeaturedPlaylists();
            } catch (error) {
              this.logger.log(
                red(`Scheduled Merchant Center sync failed: ${error}`)
              );
            }
          });
          job.start();
        }
      });
    }
  }

  public static getInstance(): MerchantCenterService {
    if (!MerchantCenterService.instance) {
      MerchantCenterService.instance = new MerchantCenterService();
    }
    return MerchantCenterService.instance;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initializeAuth();
    await this.initPromise;
    this.initialized = true;
  }

  private async initializeAuth() {
    try {
      // Check if required environment variables are set
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
        this.logger.log(
          'Warning: GOOGLE_SERVICE_ACCOUNT_KEY_FILE not set in environment variables'
        );
        // Initialize with mock/empty content for testing
        this.content = {
          products: {
            get: async () => null,
            insert: async () => {},
            update: async () => {},
            delete: async () => {},
            list: async () => ({ data: { resources: [] } }),
          },
        };
        return;
      }

      if (!this.merchantId) {
        this.logger.log(
          'Warning: GOOGLE_MERCHANT_ID not set in environment variables'
        );
        // Initialize with mock/empty content for testing
        this.content = {
          products: {
            get: async () => null,
            insert: async () => {},
            update: async () => {},
            delete: async () => {},
            list: async () => ({ data: { resources: [] } }),
          },
        };
        return;
      }

      // Use service account authentication
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/content'],
      });

      this.auth = await auth.getClient();

      // Initialize the Content API
      this.content = google.content({
        version: 'v2.1',
        auth: this.auth,
      });

      this.logger.log(blue.bold('Merchant Center API initialized'));
    } catch (error) {
      this.logger.log(
        `Failed to initialize Google Merchant Center API: ${error}`
      );
      // Initialize with mock/empty content to prevent crashes
      this.content = {
        products: {
          get: async () => null,
          insert: async () => {},
          update: async () => {},
          delete: async () => {},
          list: async () => ({ data: { resources: [] } }),
        },
      };
    }
  }

  /**
   * Upload featured playlists to Google Merchant Center (sync mode)
   * This will:
   * - Create new products for featured playlists
   * - Update existing products
   * - Remove products that are no longer featured
   * In development: uploads 2 playlists for faster testing
   * In production: uploads all featured playlists
   */
  public async uploadFeaturedPlaylists(): Promise<void> {
    await this.ensureInitialized();

    try {
      // In development, only upload 2 playlists for faster testing
      // In production, upload all featured playlists
      const isDevelopment = process.env['ENVIRONMENT'] === 'development';
      const playlistLimit = isDevelopment ? 2 : undefined;

      this.logger.log(blue.bold('Merchant Center sync starting'));

      // Load real shipping costs once per sync run (same source as the
      // public /shipping-info page) so every product variant gets the
      // correct per-country, per-size price instead of a hardcoded value.
      await this.loadShippingCosts();
      this.logger.log(
        blue.bold(
          `🔧 Environment: ${white.bold(isDevelopment ? 'DEVELOPMENT' : 'PRODUCTION')}`
        )
      );
      this.logger.log(
        blue.bold(
          `📊 Playlist limit: ${white.bold(playlistLimit !== undefined ? playlistLimit.toString() : 'UNLIMITED (all featured)')}`
        )
      );

      // Fetch featured playlists from database.
      // NOTE: We split this into two queries to avoid MariaDB's
      // "Out of sort memory" error. The Playlist table contains many TEXT
      // columns (description_en, description_nl, ...), and sorting by `score`
      // while selecting all columns forces filesort to buffer those TEXT
      // fields, overflowing sort_buffer_size on production.
      // Step 1: fetch only the IDs in the correct order (tiny row size).
      // Only playlists flagged as needing a Merchant Center sync are picked up.
      // The flag is set whenever a featured playlist is edited via the dashboard
      // and cleared again after a successful upload below.
      const sortedPlaylistIds = await this.prisma.playlist.findMany({
        where: {
          featured: true,
          slug: { not: '' },
          markedForMerchantCenter: true,
          promotionalActive: true,
        },
        orderBy: {
          score: 'desc',
        },
        select: {
          id: true,
        },
        take: playlistLimit,
      });

      // Step 2: fetch the full records for those IDs (no ORDER BY needed).
      const playlistsUnordered = await this.prisma.playlist.findMany({
        where: {
          id: { in: sortedPlaylistIds.map((p) => p.id) },
        },
        include: {
          genre: true,
        },
      });

      // Re-order the full records to match the score-sorted IDs.
      const playlistsById = new Map(
        playlistsUnordered.map((p) => [p.id, p])
      );
      const playlists = sortedPlaylistIds
        .map(({ id }) => playlistsById.get(id))
        .filter((p): p is NonNullable<typeof p> => p !== undefined);

      if (playlists.length === 0) {
        this.logger.log('Warning: No featured playlists found');
        return;
      }

      this.logger.log(
        blue.bold(`Found ${white.bold(playlists.length.toString())} playlists to upload`)
      );

      // Track which product IDs should exist
      const expectedProductIds: Set<string> = new Set();

      // Process each playlist and collect expected product IDs
      for (let i = 0; i < playlists.length; i++) {
        const playlist = playlists[i];
        const progress = ((i + 1) / playlists.length * 100).toFixed(1);
        const productIds = await this.uploadPlaylist(playlist, progress);
        productIds.forEach((id) => expectedProductIds.add(id));

        // Clear the sync flag once the playlist has been uploaded.
        // Skip in development since dev runs don't actually hit the API.
        if (!isDevelopment) {
          try {
            await this.prisma.playlist.update({
              where: { id: playlist.id },
              data: { markedForMerchantCenter: false },
            });
          } catch (flagError) {
            this.logger.log(
              yellow(
                `Failed to clear markedForMerchantCenter for playlist ${playlist.id}: ${flagError}`
              )
            );
          }
        }
      }

      // Expand the expected-product-ID set with every other featured playlist
      // that wasn't uploaded in this batch. Without this, the cleanup pass below
      // would delete products belonging to playlists whose markedForMerchantCenter
      // flag was already cleared by a previous run.
      try {
        const allFeaturedPlaylists = await this.prisma.playlist.findMany({
          where: {
            featured: true,
            slug: { not: '' },
            promotionalActive: true,
          },
          select: {
            id: true,
            featuredLocale: true,
          },
        });

        for (const p of allFeaturedPlaylists) {
          const ids = this.computeExpectedProductIdsForPlaylist(p);
          ids.forEach((id) => expectedProductIds.add(id));
        }
      } catch (error) {
        this.logger.log(
          yellow(
            `Failed to load all featured playlists for cleanup, skipping cleanup to avoid deleting valid products: ${error}`
          )
        );
        this.logger.log(green.bold('✓ Sync completed'));
        return;
      }

      // Get all existing products from Merchant Center
      try {
        const existingProducts = await this.listProducts();
        let removedCount = 0;

        // Find and remove outdated products
        for (const product of existingProducts) {
          if (product.id && !expectedProductIds.has(product.id)) {
            try {
              await this.deleteProduct(product.id);
              removedCount++;
            } catch (error) {
              // Silent failure
            }
          }
        }

        if (removedCount > 0) {
          this.logger.log(
            yellow(
              `Removed ${white.bold(removedCount.toString())} outdated products`
            )
          );
        }
      } catch (error) {
        // Silent failure for cleanup
      }

      this.logger.log(green.bold('✓ Sync completed'));
    } catch (error) {
      this.logger.log(red(`Sync failed: ${error}`));
      throw error;
    }
  }

  /**
   * Upload a single playlist with all its variants (digital, sheets, physical)
   * @param playlist - The playlist to upload
   * @param progress - Progress percentage string (e.g., "23.1")
   * @returns Array of product IDs that were created/updated
   */
  private async uploadPlaylist(playlist: any, progress?: string): Promise<string[]> {
    const productIds: string[] = [];

    // Get actual prices from OrderType like the summary component does
    const numberOfTracks = playlist.numberOfTracks;

    // Get order types for each product variant
    const cardsOrderType = await this.order.getOrderType(
      numberOfTracks,
      false,
      'cards',
      playlist.playlistId,
      'none'
    );
    const digitalOrderType = await this.order.getOrderType(
      numberOfTracks,
      true,
      'cards',
      playlist.playlistId,
      'none'
    );
    const sheetsOrderType = await this.order.getOrderType(
      numberOfTracks,
      false,
      'cards',
      playlist.playlistId,
      'sheets'
    );

    const productTypes = [
      {
        type: 'digital',
        price:
          digitalOrderType?.amount ||
          digitalOrderType?.amountWithMargin ||
          playlist.priceDigital ||
          9.99,
      },
      {
        type: 'sheets',
        price:
          sheetsOrderType?.amount ||
          sheetsOrderType?.amountWithMargin ||
          playlist.priceSheets ||
          14.99,
      },
      {
        type: 'physical',
        price:
          cardsOrderType?.amount ||
          cardsOrderType?.amountWithMargin ||
          playlist.price ||
          29.99,
      },
    ];

    // In development, only process en, nl, de locales
    const isDevelopment = process.env['ENVIRONMENT'] === 'development';
    const debugMode = process.env['DEBUG_MERCHANT_CENTER'] === 'true';
    const pairsToProcess = isDevelopment
      ? this.localeCountryPairs.filter((p) =>
          ['en', 'nl', 'de', 'es', 'sv', 'no'].includes(p.locale)
        )
      : this.localeCountryPairs;

    // Process each product type for each locale-country pair
    let variantCount = 0;
    for (const pair of pairsToProcess) {
      const { locale, country } = pair;

      // Check if playlist has a specific featured locale
      // If featuredLocale is set, only upload for that specific locale
      // If featuredLocale is not set, upload for all supported locales
      if (playlist.featuredLocale) {
        // Only process if this is the specific featured locale
        if (playlist.featuredLocale !== locale) {
          continue;
        }
        // Also check if the featured locale is in the supported locales
        if (!this.supportedLocales.includes(playlist.featuredLocale)) {
          // Skip this playlist entirely if its featured locale is not supported
          continue;
        }
      }

      for (const productType of productTypes) {
        // In debug mode, only test the first variant
        if (debugMode && variantCount > 0) {
          this.logger.log(
            yellow.bold(
              'Debug mode: Skipping remaining variants for faster testing'
            )
          );
          break;
        }

        const variant: ProductVariant = {
          id: playlist.id, // Use database ID
          playlistId: playlist.playlistId,
          name: playlist.name,
          description:
            playlist[`description_${locale}`] || playlist.description_en,
          image: playlist.image,
          price: productType.price,
          numberOfTracks: playlist.numberOfTracks,
          type: productType.type as 'digital' | 'sheets' | 'physical',
          locale: locale,
          country: country,
          slug: playlist.slug,
          genre: playlist.genre ? playlist.genre[`name_${locale}`] : undefined,
          genreSlug: playlist.genre?.slug, // For PMax custom labels
        };

        const productId = await this.uploadProductVariant(variant, progress);
        if (productId) {
          productIds.push(productId);
          variantCount++;
        }
      }

      // Break outer loop too if in debug mode
      if (debugMode && variantCount > 0) {
        break;
      }
    }

    return productIds;
  }

  /**
   * Compute the set of Merchant Center product IDs that a given playlist is
   * expected to have, mirroring the locale/country/type loop in uploadPlaylist
   * and the ID format in createMerchantProduct. Used by the cleanup pass so it
   * doesn't delete products belonging to playlists that weren't part of this
   * batch.
   */
  private computeExpectedProductIdsForPlaylist(playlist: {
    id: number;
    featuredLocale: string | null;
  }): string[] {
    const ids: string[] = [];
    const isDevelopment = process.env['ENVIRONMENT'] === 'development';
    const pairsToProcess = isDevelopment
      ? this.localeCountryPairs.filter((p) =>
          ['en', 'nl', 'de', 'es', 'sv', 'no'].includes(p.locale)
        )
      : this.localeCountryPairs;

    const productTypeNums: Array<{ type: string; num: number }> = [
      { type: 'digital', num: 1 },
      { type: 'sheets', num: 2 },
      { type: 'physical', num: 3 },
    ];
    const localeNumMap: { [key: string]: number } = {
      en: 1,
      nl: 2,
      de: 3,
      es: 4,
      sv: 5,
      no: 6,
    };

    for (const pair of pairsToProcess) {
      const { locale, country } = pair;

      // Mirror the featuredLocale gating from uploadPlaylist.
      if (playlist.featuredLocale) {
        if (playlist.featuredLocale !== locale) continue;
        if (!this.supportedLocales.includes(playlist.featuredLocale)) continue;
      }

      const localeNum = localeNumMap[locale] || 1;
      for (const pt of productTypeNums) {
        const uniqueId = `${playlist.id}_${pt.num}_${localeNum}`;
        ids.push(`online:${locale}:${country}:${uniqueId}`);
      }
    }

    return ids;
  }

  /**
   * Upload a single product variant to Google Merchant Center
   * @param variant - The product variant to upload
   * @param progress - Progress percentage string (e.g., "23.1")
   * @returns The product ID if successful, null otherwise
   */
  private async uploadProductVariant(
    variant: ProductVariant,
    progress?: string
  ): Promise<string | null> {
    try {
      const product = await this.createMerchantProduct(variant);
      const isDevelopment = process.env['ENVIRONMENT'] === 'development';

      // In development mode, skip actual API calls
      if (isDevelopment) {
        const progressText = progress ? ` (${progress}%)` : '';
        this.logger.log(
          blue.bold(
            `🔨 DEV: Would upload ${white.bold(variant.slug)} [${white.bold(
              variant.type
            )}/${white.bold(variant.locale)}/${white.bold(variant.country)}]${progressText}`
          )
        );
        return product.id;
      }

      // Check if product exists
      const existingProduct = await this.getProduct(product.id);
      const debugMode = process.env['DEBUG_MERCHANT_CENTER'] === 'true';

      if (existingProduct) {
        if (debugMode) {
          this.logger.log(blue.bold('🔍 Existing product ID format:'));
          this.logger.log(blue(`  - Our ID: ${white.bold(product.id)}`));
          this.logger.log(
            blue(`  - Google's ID: ${white.bold(existingProduct.id || 'N/A')}`)
          );
          this.logger.log(
            blue(`  - OfferId: ${white.bold(existingProduct.offerId || 'N/A')}`)
          );
        }

        if (USE_DELETE_INSERT_FOR_UPDATES) {
          // Delete and re-insert to update custom labels (PATCH cannot update customAttributes)
          try {
            await this.deleteProduct(existingProduct.id || product.id);
            if (debugMode) {
              this.logger.log(blue(`🗑️ Deleted existing product for re-insert`));
            }
          } catch (deleteError: any) {
            if (debugMode) {
              this.logger.log(yellow(`Delete warning: ${deleteError.message}`));
            }
            // Continue with insert anyway
          }

          // Re-insert with new custom labels
          await this.insertProduct(product);
          const progressText = progress ? ` (${progress}%)` : '';
          this.logger.log(
            yellow(
              `↻ ${white.bold(variant.slug)} [${white.bold(
                variant.type
              )}/${white.bold(variant.locale)}/${white.bold(variant.country)}]${progressText}`
            )
          );
        } else {
          // Use PATCH update (faster but cannot update customAttributes)
          try {
            await this.updateProduct(product, existingProduct.id || product.id);
            const progressText = progress ? ` (${progress}%)` : '';
            this.logger.log(
              yellow(
                `↻ ${white.bold(variant.slug)} [${white.bold(
                  variant.type
                )}/${white.bold(variant.locale)}/${white.bold(variant.country)}]${progressText}`
              )
            );
          } catch (updateError: any) {
            if (debugMode) {
              this.logger.log(red(`Update failed: ${updateError.message}`));
            }
            throw updateError;
          }
        }
      } else {
        // Insert new product
        await this.insertProduct(product);
        const progressText = progress ? ` (${progress}%)` : '';
        this.logger.log(
          green.bold(
            `✓ ${white.bold(variant.slug)} [${white.bold(
              variant.type
            )}/${white.bold(variant.locale)}/${white.bold(variant.country)}]${progressText}`
          )
        );
      }

      return product.id;
    } catch (error: any) {
      const progressText = progress ? ` (${progress}%)` : '';
      this.logger.log(
        red(
          `✗ ${white.bold(variant.slug)} [${white.bold(
            variant.type
          )}/${white.bold(variant.locale)}/${white.bold(variant.country)}]: ${error.message || error}${progressText}`
        )
      );
      return null;
    }
  }

  /**
   * Create a Google Merchant Center product object
   */
  private async createMerchantProduct(
    variant: ProductVariant
  ): Promise<MerchantProduct> {
    const baseUrl = process.env.FRONTEND_URI || 'https://www.qrsong.io';
    const country = variant.country;

    // Generate unique ID using Google's required format
    // Format for online products: "online:{lang}:{country}:{id}"
    // We'll use a simple numeric ID combining playlist ID, type, and locale
    const typeNum =
      variant.type === 'digital' ? 1 : variant.type === 'sheets' ? 2 : 3;
    const localeNum =
      { en: 1, nl: 2, de: 3, es: 4, sv: 5, no: 6 }[variant.locale] || 1;
    const uniqueId = `${variant.id}_${typeNum}_${localeNum}`;
    const productId = `online:${variant.locale}:${country}:${uniqueId}`;

    // Generate composite product image with the template (unique per variant)
    const imageKey = `${variant.playlistId}_${variant.type}_${variant.locale}`;

    const productImage = await this.generateProductImage(
      variant.image,
      imageKey,
      variant.type
    );

    // Check if we're using the fallback Spotify image (indicates generation failure)
    if (productImage.includes('scdn.co') || productImage.includes('spotify')) {
      this.logger.log(
        red('⚠️ WARNING: Using original Spotify image instead of composite')
      );
      this.logger.log(
        red(`  Product: ${variant.slug} [${variant.type}/${variant.locale}]`)
      );
      this.logger.log(red(`  Image URL: ${productImage}`));
    }

    // Generate product URL with orderType parameter
    const productUrl = `${baseUrl}/${variant.locale}/product/${variant.slug}?orderType=${variant.type}`;

    // Get translations for the product title
    const merchantTranslations = await this.translate.getTranslationsByPrefix(
      variant.locale,
      'merchant'
    );

    // Build the product title based on type
    const qrMusicGame = merchantTranslations?.qr_music_game || 'QR Music Game';
    let productSuffix = '';

    switch (variant.type) {
      case 'digital':
        productSuffix = merchantTranslations?.pdf || 'PDF';
        break;
      case 'sheets':
        productSuffix = merchantTranslations?.sheets || 'sheets';
        break;
      case 'physical':
        productSuffix = merchantTranslations?.cards || 'cards';
        break;
    }

    // Format: "QR Music Game (type) - [playlist] - [number] cards"
    const title = `${qrMusicGame} (${productSuffix}) - ${variant.name} - ${
      variant.numberOfTracks
    } ${merchantTranslations?.cards || 'cards'}`;

    // Create description
    let description = variant.description || '';
    // Add track count to description
    const tracksLabel: { [key: string]: string } = {
      en: `Contains ${variant.numberOfTracks} music tracks`,
      nl: `Bevat ${variant.numberOfTracks} muzieknummers`,
      de: `Enthält ${variant.numberOfTracks} Musiktitel`,
      fr: `Contient ${variant.numberOfTracks} pistes musicales`,
      es: `Contiene ${variant.numberOfTracks} pistas de música`,
      it: `Contiene ${variant.numberOfTracks} brani musicali`,
      pt: `Contém ${variant.numberOfTracks} faixas de música`,
      pl: `Zawiera ${variant.numberOfTracks} utworów muzycznych`,
      jp: `${variant.numberOfTracks}曲の音楽トラックを含む`,
      cn: `包含${variant.numberOfTracks}首音乐曲目`,
      sv: `Innehåller ${variant.numberOfTracks} musikspår`,
      no: `Inneholder ${variant.numberOfTracks} musikkspor`,
    };
    description += ` ${tracksLabel[variant.locale] || tracksLabel['en']}`;

    // Determine Google product category based on type
    let googleCategory = '5030'; // Default: Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts
    if (variant.type === 'digital') {
      googleCategory = '839'; // Media > Music & Sound Recordings
    }

    // Resolve currency for the target country (Google requires local currency)
    // and convert the EUR product price. FX fallback may downgrade us to EUR
    // if rates aren't available — we trust the returned currency, not the
    // requested one, to keep value + currency consistent in the feed.
    const targetCurrency = getCurrencyForCountry(country);
    const priceResult = await this.fx.convertAndFormat(
      variant.price,
      targetCurrency
    );
    const currency = priceResult.currency;
    const priceValue = priceResult.value;

    // Add shipping information based on product type. For physical / sheets
    // we look up the real per-country, per-size cost from the same source the
    // public /shipping-info page uses, instead of a hardcoded value.
    const shipping = [];

    // Digital products have free instant shipping
    if (variant.type === 'digital') {
      shipping.push({
        country: country,
        service: 'Digital Delivery',
        price: {
          value: '0',
          currency: currency,
        },
        minHandlingTime: 0,
        maxHandlingTime: 0,
        minTransitTime: 0,
        maxTransitTime: 0,
      });
    } else {
      const lookedUpCost = this.getShippingCostForVariant(
        country,
        variant.type,
        variant.numberOfTracks
      );
      // Fall back to 4.95 EUR if we couldn't resolve a real cost (e.g. country
      // missing from ShippingCostNew). Better than failing the whole upload.
      const shippingCostEur = lookedUpCost ?? 4.95;
      const shippingResult = await this.fx.convertAndFormat(
        shippingCostEur,
        currency
      );

      shipping.push({
        country: country,
        service: 'Standard Shipping',
        price: {
          value: shippingResult.value,
          currency: currency,
        },
        minHandlingTime: 1,
        maxHandlingTime: 2,
        minTransitTime: 2,
        maxTransitTime: 5,
      });
    }

    return {
      id: productId,
      offerId: uniqueId, // Add the offerId field which is required
      title: title,
      description: description.substring(0, 5000), // Max 5000 characters
      link: productUrl,
      imageLink: productImage, // Use the generated composite image
      availability: 'in_stock',
      condition: 'new',
      price: {
        value: priceValue,
        currency: currency,
      },
      brand: 'QRSong!',
      contentLanguage: variant.locale,
      targetCountry: country,
      channel: 'online',
      productTypes: this.getProductTypes(variant),
      googleProductCategory: googleCategory,
      shipping: shipping,
      shippingLabel:
        variant.type === 'digital' ? 'digital_delivery' : 'standard_shipping',
      customAttributes: [
        {
          name: 'number_of_tracks',
          value: variant.numberOfTracks.toString(),
        },
        {
          name: 'product_variant',
          value: variant.type,
        },
        {
          name: 'playlist_slug',
          value: variant.slug,
        },
        // Custom labels for PMax campaign segmentation
        {
          name: 'custom_label_0',
          value: variant.type, // Product type: digital, sheets, physical
        },
        {
          name: 'custom_label_1',
          value: this.getGenreGroup(variant.genreSlug), // Genre group: pop_hits, rock_metal, etc.
        },
        {
          name: 'custom_label_2',
          value: variant.genreSlug || 'unknown', // Individual genre slug
        },
        {
          name: 'custom_label_3',
          value: this.getTrackCountRange(variant.numberOfTracks), // Track count: small, medium, large
        },
        {
          name: 'custom_label_4',
          value: '', // Reserved for future use
        },
      ],
    };
  }

  /**
   * Get product type label in the specified locale using translation system
   */
  private async getProductTypeLabel(
    type: string,
    locale: string
  ): Promise<string> {
    // Get all product type translations for this locale
    const productTranslations = await this.translate.getTranslationsByPrefix(
      locale,
      'product_type'
    );

    if (productTranslations && productTranslations[type]) {
      return productTranslations[type];
    }

    // Fall back to English if locale not found
    if (locale !== 'en') {
      const enTranslations = await this.translate.getTranslationsByPrefix(
        'en',
        'product_type'
      );
      if (enTranslations && enTranslations[type]) {
        return enTranslations[type];
      }
    }

    // Final fallback
    const defaultLabels: { [key: string]: string } = {
      digital: 'Digital PDF',
      sheets: 'Print Sheets',
      physical: 'Physical Cards',
    };
    return defaultLabels[type] || type;
  }

  /**
   * Generate a composite product image with the playlist cover on the product card template
   * @param playlistImageUrl - URL of the playlist cover image
   * @param imageKey - Unique key for caching (e.g., playlistId_type_locale)
   * @param productType - Type of product (digital, sheets, or physical)
   * @returns URL of the generated composite image
   */
  private async generateProductImage(
    playlistImageUrl: string,
    imageKey: string,
    productType: string
  ): Promise<string> {
    try {
      // Paths for images - use product_pdf.jpg for digital, product_sheets.jpg for sheets, product_cards.jpg for cards
      let templateFile: string;
      if (productType === 'digital') {
        templateFile = 'product_pdf.jpg';
      } else if (productType === 'sheets') {
        templateFile = 'product_sheets.jpg';
      } else {
        templateFile = 'product_cards.jpg';
      }
      const templatePath = `${process.env['ASSETS_DIR']}/images/${templateFile}`;

      const publicDir =
        process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
      const outputDir = path.join(publicDir, 'products');
      const outputFileName = `merchant_${imageKey}.jpg`;
      const outputPath = path.join(outputDir, outputFileName);

      // In development, always regenerate images to ensure latest styling
      const isDevelopment = process.env['ENVIRONMENT'] === 'development';
      const forceRegenerate = isDevelopment;

      // For updates, we need to use a different filename to force Google to see it as a new image
      // Include a timestamp in the filename itself, not just as a parameter
      const timestamp = Date.now();
      const versionedFileName = `merchant_${imageKey}_${timestamp}.jpg`;
      const versionedOutputPath = path.join(outputDir, versionedFileName);

      // Check if we should use existing image (only in production and if not forcing regenerate)
      if (!forceRegenerate) {
        try {
          // Look for any existing image with this pattern
          const files = await fs.readdir(outputDir);
          const existingFile = files.find(
            (f) => f.startsWith(`merchant_${imageKey}_`) && f.endsWith('.jpg')
          );

          if (existingFile && !process.env.FORCE_NEW_IMAGES) {
            // Use existing file
            const apiUri = process.env.API_URI || 'https://api.qrsong.io';
            return `${apiUri}/public/products/${existingFile}`;
          }
        } catch {
          // Directory doesn't exist or error reading, continue to generate
        }
      }

      // Clean up old versions of this image (but keep recent ones for Google to fetch)
      try {
        const files = await fs.readdir(outputDir);
        const oldFiles = files.filter(
          (f) => f.startsWith(`merchant_${imageKey}_`) && f.endsWith('.jpg')
        );
        const now = Date.now();
        const KEEP_DURATION = 60 * 60 * 1000; // Keep files for at least 1 hour

        for (const oldFile of oldFiles) {
          try {
            // Extract timestamp from filename (merchant_KEY_TIMESTAMP.jpg)
            const parts = oldFile.split('_');
            const timestampStr = parts[parts.length - 1].replace('.jpg', '');
            const fileTimestamp = parseInt(timestampStr);

            // Only delete if file is older than 24 hours
            if (!isNaN(fileTimestamp) && now - fileTimestamp > KEEP_DURATION) {
              await fs.unlink(path.join(outputDir, oldFile));
              if (process.env['DEBUG_MERCHANT_CENTER'] === 'true') {
                this.logger.log(
                  yellow(`  🗑️ Cleaned up old image: ${oldFile}`)
                );
              }
            }
          } catch {
            // Ignore cleanup errors for individual files
          }
        }
      } catch {
        // Ignore cleanup errors
      }

      // Create output directory if it doesn't exist
      try {
        await fs.mkdir(outputDir, { recursive: true });
      } catch (error: any) {
        // Directory might already exist, that's ok
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }

      // Download the playlist image
      let playlistImageBuffer: Buffer;
      try {
        const response = await axios.get(playlistImageUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          maxRedirects: 5,
        });
        // Don't use 'binary' encoding - response.data is already a buffer/arraybuffer
        playlistImageBuffer = Buffer.from(response.data);
      } catch (downloadError: any) {
        // This will cause fallback to Spotify image
        throw downloadError;
      }

      // Get template dimensions
      const templateMetadata = await sharp(templatePath).metadata();
      const templateWidth = templateMetadata.width || 1200;
      const templateHeight = templateMetadata.height || 1200;

      // Calculate overlay dimensions
      // For cards: place in top right, smaller size (80% of normal)
      // For others: place in bottom right
      const isCards = productType === 'physical';
      const baseSizeMultiplier = 0.45;
      const cardsSizeMultiplier = baseSizeMultiplier * 0.80;

      const overlaySize = Math.floor(
        Math.min(templateWidth, templateHeight) * (isCards ? cardsSizeMultiplier : baseSizeMultiplier)
      );
      const margin = Math.floor(Math.min(templateWidth, templateHeight) * 0.04);
      const borderWidth = 6;

      // Determine position based on product type
      const topPosition = isCards
        ? margin
        : templateHeight - overlaySize - margin;
      const shadowTopPosition = isCards
        ? margin + 4
        : templateHeight - overlaySize - margin + 4;

      // Resize playlist image - add error handling
      let resizedPlaylistImage: Buffer;
      try {
        // First, ensure Sharp can process the image by converting it to a known format
        resizedPlaylistImage = await sharp(playlistImageBuffer)
          .jpeg() // Convert to JPEG first to ensure compatibility
          .resize(
            overlaySize - borderWidth * 2,
            overlaySize - borderWidth * 2,
            {
              fit: 'cover',
              position: 'centre',
            }
          )
          .toBuffer();
      } catch (resizeError: any) {
        // This will cause fallback to Spotify image
        throw resizeError;
      }

      // Create white border frame
      const borderedImage = await sharp(resizedPlaylistImage)
        .extend({
          top: borderWidth,
          bottom: borderWidth,
          left: borderWidth,
          right: borderWidth,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .toBuffer();

      // Create a subtle shadow effect by compositing twice - once offset for shadow, once on top
      await sharp(templatePath)
        .composite([
          // Shadow layer - slightly offset and darker
          {
            input: await sharp(borderedImage)
              .modulate({ brightness: 0.3 }) // Darken for shadow effect
              .toBuffer(),
            top: shadowTopPosition,
            left: templateWidth - overlaySize - margin + 4,
            blend: 'multiply',
          },
          // Main image on top
          {
            input: borderedImage,
            top: topPosition,
            left: templateWidth - overlaySize - margin,
          },
        ])
        .jpeg({ quality: 90 })
        .toFile(versionedOutputPath);

      // Image generated successfully - return versioned filename
      const apiUri = process.env.API_URI || 'https://api.qrsong.io';
      return `${apiUri}/public/products/${versionedFileName}`;
    } catch (error: any) {
      // Log error that causes fallback to original Spotify image
      this.logger.log(
        red(
          `⚠️ Image composite generation failed - using Spotify image as fallback`
        )
      );
      this.logger.log(red(`  Error: ${error.message || error}`));
      this.logger.log(red(`  Product: ${imageKey}`));
      this.logger.log(red(`  Fallback URL: ${playlistImageUrl}`));
      return playlistImageUrl;
    }
  }

  /**
   * Get product type hierarchy for Google Shopping
   */
  private getProductTypes(variant: ProductVariant): string[] {
    const types = ['Music', 'QR Codes'];

    if (variant.genre) {
      types.push(variant.genre);
    }

    switch (variant.type) {
      case 'digital':
        types.push('Digital Downloads');
        break;
      case 'sheets':
        types.push('Printable');
        break;
      case 'physical':
        types.push('Physical Product');
        break;
    }

    return types;
  }

  /**
   * Get the genre group for PMax segmentation (custom_label_1)
   */
  private getGenreGroup(genreSlug?: string): string {
    if (!genreSlug) return 'other';
    return GENRE_GROUPS[genreSlug.toLowerCase()] || 'other';
  }

  /**
   * Get track count range for PMax segmentation (custom_label_3)
   */
  private getTrackCountRange(numberOfTracks: number): string {
    if (numberOfTracks < 100) return 'small';
    if (numberOfTracks <= 250) return 'medium';
    return 'large';
  }

  /**
   * Load shipping costs for every country from the same source the public
   * /shipping-info page uses (Shipping.getShippingInfoByCountry). Result is
   * cached on the instance for the duration of the sync run so we don't hit
   * the database once per variant.
   */
  private async loadShippingCosts(): Promise<void> {
    try {
      const info = await this.shipping.getShippingInfoByCountry();
      this.shippingCostsByCountry = new Map(
        info.countries.map((c) => [c.countryCode, c.shippingCosts])
      );
      this.logger.log(
        blue.bold(
          `📦 Loaded shipping costs for ${white.bold(
            this.shippingCostsByCountry.size.toString()
          )} countries`
        )
      );
    } catch (error) {
      this.logger.log(
        red(`Failed to load shipping costs, falling back to defaults: ${error}`)
      );
      this.shippingCostsByCountry = new Map();
    }
  }

  /**
   * Resolve the shipping cost (in EUR) for a given country / product type /
   * track count, mirroring the size-tier logic used by PrintEnBind:
   *   - sheets always use the smallest tier (80)
   *   - physical use the smallest tier whose size >= numberOfTracks (capped at 1000)
   * Returns null if no matching cost is found, in which case the caller
   * should fall back to a sane default.
   */
  private getShippingCostForVariant(
    country: string,
    type: 'digital' | 'sheets' | 'physical',
    numberOfTracks: number
  ): number | null {
    if (type === 'digital') return 0;

    const costs = this.shippingCostsByCountry.get(country);
    if (!costs || costs.length === 0) return null;

    const TIERS = [80, 405, 1000];
    let targetSize: number;
    if (type === 'sheets') {
      targetSize = TIERS[0];
    } else {
      targetSize =
        TIERS.find((t) => numberOfTracks <= t) ?? TIERS[TIERS.length - 1];
    }

    // Exact tier match first; if not present, fall back to the smallest size
    // >= targetSize, then to the largest available.
    const exact = costs.find((c) => c.size === targetSize);
    if (exact) return exact.cost;

    const sorted = [...costs].sort((a, b) => a.size - b.size);
    const next = sorted.find((c) => c.size >= targetSize);
    if (next) return next.cost;
    return sorted[sorted.length - 1].cost;
  }

  /**
   * Get a product from Google Merchant Center
   */
  private async getProduct(productId: string): Promise<any> {
    if (!this.content || !this.content.products) {
      this.logger.log(yellow('Warning: Merchant Center API not initialized'));
      return null;
    }

    try {
      const response = await this.content.products.get({
        merchantId: this.merchantId,
        productId: productId,
      });
      return response.data;
    } catch (error: any) {
      if (error.code === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Insert a new product to Google Merchant Center
   */
  private async insertProduct(product: MerchantProduct): Promise<void> {
    if (!this.content || !this.content.products) {
      this.logger.log(yellow('Warning: Merchant Center API not initialized'));
      return;
    }

    try {
      await this.content.products.insert({
        merchantId: this.merchantId,
        requestBody: product as any,
      });
    } catch (error: any) {
      // Rethrow with simplified message
      throw error;
    }
  }

  /**
   * Update an existing product in Google Merchant Center
   */
  private async updateProduct(
    product: MerchantProduct,
    googleProductId?: string
  ): Promise<void> {
    if (!this.content || !this.content.products) {
      this.logger.log(yellow('Warning: Merchant Center API not initialized'));
      return;
    }

    try {
      // Enable debug mode for updates
      const debugMode = process.env['DEBUG_MERCHANT_CENTER'] === 'true';

      // Get the product before update for comparison
      let productBefore: any = null;
      if (debugMode) {
        try {
          productBefore = await this.getProduct(product.id);
          this.logger.log(blue.bold('📋 Product before update:'));
          this.logger.log(
            blue(`  - Link: ${white.bold(productBefore?.link || 'N/A')}`)
          );
          this.logger.log(
            blue(`  - Image: ${white.bold(productBefore?.imageLink || 'N/A')}`)
          );
          this.logger.log(
            blue(
              `  - Price: ${white.bold(productBefore?.price?.value || 'N/A')} ${
                productBefore?.price?.currency || ''
              }`
            )
          );
          this.logger.log(
            blue(`  - Title: ${white.bold(productBefore?.title || 'N/A')}`)
          );
        } catch (e) {
          this.logger.log(yellow('Could not fetch product before update'));
        }
      }

      // For PATCH updates, we need to specify which fields we're updating
      // Note: customAttributes cannot be updated via PATCH, use USE_DELETE_INSERT_FOR_UPDATES=true instead
      const updateMask = [
        'title',
        'description',
        'link',
        'imageLink', // This is the critical one for image updates
        'price',
        'availability',
        'brand',
        'googleProductCategory',
        'productTypes',
        'shipping',
        'shippingLabel',
      ].join(',');

      // Build the product update payload
      // According to docs, we should send the full product object with only the fields we want to update
      const productForUpdate = {
        title: product.title,
        description: product.description,
        link: product.link,
        imageLink: product.imageLink, // Ensure the new image URL is here
        price: product.price,
        availability: product.availability,
        brand: product.brand,
        googleProductCategory: product.googleProductCategory,
        productTypes: product.productTypes,
        shipping: product.shipping,
        shippingLabel: product.shippingLabel,
        condition: product.condition, // Add condition since it's required
        // Note: customAttributes excluded - use USE_DELETE_INSERT_FOR_UPDATES=true to update labels
      };

      if (debugMode) {
        this.logger.log(blue.bold('📝 Sending PATCH update with:'));
        this.logger.log(blue(`  - Update Mask: ${white.bold(updateMask)}`));
        this.logger.log(
          blue(`  - Link: ${white.bold(productForUpdate.link || 'N/A')}`)
        );
        this.logger.log(
          blue(`  - Image: ${white.bold(productForUpdate.imageLink || 'N/A')}`)
        );
        this.logger.log(
          blue(
            `  - Price: ${white.bold(productForUpdate.price?.value || 'N/A')} ${
              productForUpdate.price?.currency || ''
            }`
          )
        );
        this.logger.log(
          blue(`  - Title: ${white.bold(productForUpdate.title || 'N/A')}`)
        );
      }

      // Use update method with updateMask for partial updates (PATCH under the hood)
      // Try using just the offerId first, as that's what shows in Merchant Center
      const productIdToUpdate = googleProductId || product.id;

      if (debugMode) {
        this.logger.log(
          blue(
            `  - Using Product ID for update: ${white.bold(productIdToUpdate)}`
          )
        );
        this.logger.log(
          blue(`  - Alternative offerId: ${white.bold(product.offerId)}`)
        );
      }

      try {
        // First try with the full composite ID
        await this.content.products.update({
          merchantId: this.merchantId,
          productId: productIdToUpdate,
          updateMask: updateMask, // This parameter makes it a PATCH request
          requestBody: productForUpdate as any,
        });
      } catch (firstError: any) {
        if (debugMode) {
          this.logger.log(yellow(`  - Full ID failed: ${firstError.message}`));
          this.logger.log(
            yellow(`  - Trying with offerId: ${white.bold(product.offerId)}`)
          );
        }

        // If full ID fails, try with just the offerId
        await this.content.products.update({
          merchantId: this.merchantId,
          productId: product.offerId, // Try just the offerId
          updateMask: updateMask,
          requestBody: productForUpdate as any,
        });
      }

      // Verify the update worked
      if (debugMode) {
        // Wait longer for the update to propagate (Google has eventual consistency)
        const waitTime = parseInt(process.env.DEBUG_WAIT_TIME || '3000');
        if (waitTime > 0) {
          this.logger.log(
            blue(
              `  ⏳ Waiting ${white.bold(
                (waitTime / 1000).toString()
              )}s for Google to process update...`
            )
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        try {
          const productAfter = await this.getProduct(product.id);
          this.logger.log(green.bold('✅ Product after update:'));
          this.logger.log(
            green(`  - Link: ${white.bold(productAfter?.link || 'N/A')}`)
          );
          this.logger.log(
            green(`  - Image: ${white.bold(productAfter?.imageLink || 'N/A')}`)
          );
          this.logger.log(
            green(
              `  - Price: ${white.bold(productAfter?.price?.value || 'N/A')} ${
                productAfter?.price?.currency || ''
              }`
            )
          );
          this.logger.log(
            green(`  - Title: ${white.bold(productAfter?.title || 'N/A')}`)
          );

          // Check what changed
          const changes: string[] = [];
          if (productBefore?.link !== productAfter?.link) changes.push('Link');
          if (productBefore?.imageLink !== productAfter?.imageLink)
            changes.push('Image URL');
          if (productBefore?.price?.value !== productAfter?.price?.value)
            changes.push('Price');
          if (productBefore?.title !== productAfter?.title)
            changes.push('Title');
          if (productBefore?.description !== productAfter?.description)
            changes.push('Description');

          if (changes.length > 0) {
            this.logger.log(
              green.bold(
                `  ✓ Changed fields: ${white.bold(changes.join(', '))}`
              )
            );
          } else {
            this.logger.log(yellow.bold('  ⚠️ No immediate changes detected'));
            this.logger.log(
              yellow(
                '  Note: Google Merchant Center has eventual consistency - changes may take 5-30 minutes to appear'
              )
            );
          }
        } catch (e) {
          this.logger.log(
            yellow('Could not fetch product after update for verification')
          );
        }
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Delete a product from Google Merchant Center
   */
  public async deleteProduct(productId: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.content.products.delete({
        merchantId: this.merchantId,
        productId: productId,
      });
      // Product deleted successfully
    } catch (error) {
      throw error;
    }
  }

  /**
   * Clear all products from Google Merchant Center (Development only)
   * This will delete ALL products from the account - use with caution!
   */
  public async clearAllProducts(): Promise<void> {
    // Only allow in development environment
    if (process.env['ENVIRONMENT'] !== 'development') {
      this.logger.log(
        'ERROR: clearAllProducts() can only be run in development environment!'
      );
      throw new Error(
        'clearAllProducts() is only available in development mode'
      );
    }

    await this.ensureInitialized();

    try {
      this.logger.log(yellow('Clearing all products (dev mode)'));

      // Get all existing products
      const existingProducts = await this.listProducts();

      if (existingProducts.length === 0) {
        return;
      }

      // Delete each product
      let deletedCount = 0;
      let failedCount = 0;

      for (const product of existingProducts) {
        if (product.id) {
          try {
            await this.content.products.delete({
              merchantId: this.merchantId,
              productId: product.id,
            });
            deletedCount++;
            // Silent deletion
          } catch (error) {
            failedCount++;
            // Silent failure, counted in summary
          }
        }
      }

      if (deletedCount > 0) {
        this.logger.log(
          blue.bold(`Cleared ${white(deletedCount.toString())} products`)
        );
      }
      if (failedCount > 0) {
        this.logger.log(
          yellow(`Failed to clear ${white(failedCount.toString())} products`)
        );
      }
    } catch (error) {
      this.logger.log(`Error clearing products: ${error}`);
      throw error;
    }
  }

  /**
   * List all products in Google Merchant Center
   */
  public async listProducts(): Promise<any[]> {
    await this.ensureInitialized();

    try {
      const response = await this.content.products.list({
        merchantId: this.merchantId,
      });
      return response.data.resources || [];
    } catch (error) {
      this.logger.log(`Failed to list products: ${error}`);
      throw error;
    }
  }

  /**
   * Sync all featured playlists with Google Merchant Center
   */
  public async syncAllFeaturedPlaylists(): Promise<void> {
    await this.ensureInitialized();

    try {
      this.logger.log('Starting full sync with Google Merchant Center');

      // Get all featured playlists
      const playlists = await this.prisma.playlist.findMany({
        where: {
          featured: true,
          slug: { not: '' },
        },
        include: {
          genre: true,
        },
      });

      this.logger.log(`Syncing ${playlists.length} featured playlists`);

      for (const playlist of playlists) {
        await this.uploadPlaylist(playlist);
      }

      this.logger.log('Full sync completed');
    } catch (error) {
      this.logger.log(`Error during full sync: ${error}`);
      throw error;
    }
  }
}

// Export singleton instance
export const merchantCenter = MerchantCenterService.getInstance();
