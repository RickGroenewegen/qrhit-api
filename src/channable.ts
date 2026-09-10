import { PrismaClient } from '@prisma/client';
import Logger from './logger';
import Translation from './translation';
import Order from './order';
import Shipping from './shipping';
import Utils from './utils';
import path from 'path';
import fs from 'fs/promises';
import cluster from 'cluster';
import { CronJob } from 'cron';
import { blue, red, yellow, white, green } from 'console-log-colors';
import PrismaInstance from './prisma';
import Fx from './services/fx';
import { getCurrencyForCountry } from './data/currency-map';
import {
  LOCALE_COUNTRY_PAIRS,
  ProductVariant,
  buildOfferId,
  buildProductId,
  getGenreGroup,
  getProductTypes,
  getShippingCostForVariant,
  getTracksLabel,
  getTrackCountRange,
  isPlaylistAllowedInCountry,
} from './productFeed';

/**
 * Channable product feed.
 *
 * The agency running our Merchant Center wants the catalogue to go through
 * Channable, which then pushes on to Google. Channable has no API to push
 * products into: its API only covers orders, offers, returns and shipments,
 * and the one product-shaped endpoint (POST .../offers) can update stock and
 * price on offers that already exist but cannot create them. Product data
 * enters Channable exclusively through an *import*, and the import type that
 * fits us is a data file fetched from a URL, roughly once a day.
 *
 * So this service builds the same catalogue `src/merchantcenter.ts` pushes to
 * Google, and writes it as a CSV at a stable URL for Channable to pull. The
 * two run side by side until the agency has Channable wired to Merchant
 * Center; nothing here touches anything merchantcenter.ts owns.
 *
 * Two deliberate differences from the Merchant Center path:
 *
 *  - No `markedForMerchantCenter` bookkeeping. That flag is written by
 *    promotional.ts / adminRoutes.ts and cleared only by the Google sync, so a
 *    second consumer would race with it. A feed is a full snapshot anyway, so
 *    we read every featured playlist every run and never write the flag.
 *  - No cleanup/delete pass. A product that drops out of the feed is dropped
 *    by Channable on its next import.
 */

// Where the built feed lands, under PUBLIC_DIR (served at /public/ by
// @fastify/static, though the token-guarded route is what we hand out).
const FEED_DIR = 'channable';
const FEED_FILE = 'feed.csv';

// Column order of the CSV. Google-Shopping-ish names so the agency recognises
// them at a glance, but flat — Channable maps columns in its own UI, it does
// not care about Google's nesting.
const COLUMNS = [
  'id',
  'offer_id',
  'content_language',
  'target_country',
  'title',
  'description',
  'link',
  'image_link',
  'availability',
  'condition',
  'price',
  'currency',
  'brand',
  'google_product_category',
  'product_type',
  'shipping_price',
  'shipping_currency',
  'shipping_service',
  'min_handling_time',
  'max_handling_time',
  'min_transit_time',
  'max_transit_time',
  'shipping_label',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'number_of_tracks',
  'product_variant',
  'playlist_slug',
  'playlist_id',
  'genre',
  'genre_slug',
] as const;

type FeedRow = Record<(typeof COLUMNS)[number], string>;

export class ChannableService {
  private static instance: ChannableService;
  private prisma: PrismaClient;
  private logger: Logger;
  private translate: Translation;
  private order: Order;
  private shipping: Shipping;
  private utils: Utils;
  private fx: Fx;
  // Cached shipping costs per country, populated at the start of each build
  // via loadShippingCosts(). Mirrors Shipping.getShippingInfoByCountry().
  private shippingCostsByCountry: Map<string, { size: number; cost: number }[]> =
    new Map();
  private localeCountryPairs = LOCALE_COUNTRY_PAIRS;
  // Guards against two builds writing the same file at once (the nightly cron
  // firing while an admin hits "generate now", say).
  private building: Promise<{ rows: number; path: string }> | null = null;

  private constructor() {
    this.prisma = PrismaInstance.getInstance();
    this.logger = new Logger();
    this.translate = new Translation();
    this.order = Order.getInstance();
    this.shipping = Shipping.getInstance();
    this.utils = new Utils();
    this.fx = Fx.getInstance();

    // Rebuild the feed nightly at 5 AM — after the 1 AM AI product images and
    // the 4 AM Merchant Center sync, so it picks up that night's images.
    // Only run on primary cluster worker and main server.
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer) {
          this.logger.log(
            blue.bold('Setting up Channable feed build at 5 AM')
          );
          const job = new CronJob('0 5 * * *', async () => {
            this.logger.log(blue.bold('Running scheduled Channable feed build'));
            try {
              await this.generateFeed();
            } catch (error) {
              this.logger.log(
                red(`Scheduled Channable feed build failed: ${error}`)
              );
            }
          });
          job.start();
        }
      });
    }
  }

  public static getInstance(): ChannableService {
    if (!ChannableService.instance) {
      ChannableService.instance = new ChannableService();
    }
    return ChannableService.instance;
  }

  /**
   * Absolute path of the built feed on disk. With a country code, the path of
   * that country's slice — the agency can point a per-country Channable
   * project straight at it instead of importing everything and filtering.
   */
  public getFeedPath(country?: string): string {
    const publicDir =
      process.env['PUBLIC_DIR'] || path.join(__dirname, '..', 'public');
    const file = country ? `feed_${country.toUpperCase()}.csv` : FEED_FILE;
    return path.join(publicDir, FEED_DIR, file);
  }

  /**
   * The countries we publish a slice for, so the route can reject an unknown
   * ?country= instead of 404ing on a file that was never going to exist.
   */
  public getFeedCountries(): string[] {
    return [...new Set(this.localeCountryPairs.map((p) => p.country))];
  }

  /**
   * True when a feed has already been built. The route uses this to decide
   * whether it has to build inline (first boot) or can just serve the file.
   */
  public async feedExists(country?: string): Promise<boolean> {
    try {
      await fs.access(this.getFeedPath(country));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the feed and write it to disk. Concurrent callers share one build
   * rather than trampling each other's output.
   */
  public async generateFeed(): Promise<{ rows: number; path: string }> {
    if (this.building) {
      return this.building;
    }
    this.building = this.runBuild().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async runBuild(): Promise<{ rows: number; path: string }> {
    const started = Date.now();
    this.logger.log(blue.bold('Channable feed build starting'));

    // Load real shipping costs once per run (same source as the public
    // /shipping-info page) so every row gets the correct per-country,
    // per-size price instead of a hardcoded value.
    await this.loadShippingCosts();

    const rows = await this.buildRows();
    const feedPath = await this.writeCsv(rows);

    this.logger.log(
      green.bold(
        `✓ Channable feed built: ${white.bold(rows.length.toString())} rows in ${white.bold(
          `${((Date.now() - started) / 1000).toFixed(1)}s`
        )} → ${white.bold(feedPath)}`
      )
    );

    return { rows: rows.length, path: feedPath };
  }

  /**
   * Build one row per (playlist × locale/country). Mirrors uploadPlaylist()
   * and createMerchantProduct() in src/merchantcenter.ts, minus the Google
   * API shapes (micros, nested shipping, resource names).
   */
  private async buildRows(): Promise<FeedRow[]> {
    const isDevelopment = process.env['ENVIRONMENT'] === 'development';
    const debugMode = process.env['DEBUG_CHANNABLE'] === 'true';
    const playlistLimit = isDevelopment ? 2 : undefined;

    // Split into two queries for the same reason merchantcenter.ts does: the
    // Playlist table has many TEXT columns, and sorting by `score` while
    // selecting all of them overflows MariaDB's sort_buffer_size.
    // Note there is no markedForMerchantCenter filter here — a feed is a full
    // snapshot, and that flag belongs to the Google sync.
    const sortedPlaylistIds = await this.prisma.playlist.findMany({
      where: {
        featured: true,
        slug: { not: '' },
        promotionalActive: true,
      },
      orderBy: { score: 'desc' },
      select: { id: true },
      take: playlistLimit,
    });

    const playlistsUnordered = await this.prisma.playlist.findMany({
      where: { id: { in: sortedPlaylistIds.map((p) => p.id) } },
      include: { genre: true },
    });

    const playlistsById = new Map(playlistsUnordered.map((p) => [p.id, p]));
    const playlists = sortedPlaylistIds
      .map(({ id }) => playlistsById.get(id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);

    if (playlists.length === 0) {
      this.logger.log(yellow('Warning: No featured playlists found'));
      return [];
    }

    this.logger.log(
      blue.bold(
        `Found ${white.bold(playlists.length.toString())} playlists for the feed`
      )
    );

    const rows: FeedRow[] = [];
    let skippedNoImage = 0;
    let failed = 0;

    for (const playlist of playlists) {
      // Isolate each playlist: one bad row must never abort the whole build,
      // or a single failure would take the entire feed down with it.
      try {
        const playlistRows = await this.buildRowsForPlaylist(playlist);
        rows.push(...playlistRows.rows);
        skippedNoImage += playlistRows.skippedNoImage;
      } catch (error: any) {
        failed++;
        this.logger.log(
          red(
            `✗ Playlist ${white.bold(
              playlist.slug || playlist.playlistId || String(playlist.id)
            )} failed, continuing: ${error?.message || error}`
          )
        );
      }

      if (debugMode && rows.length > 0) {
        this.logger.log(
          yellow.bold('Debug mode: stopping after the first playlist')
        );
        break;
      }
    }

    if (skippedNoImage > 0) {
      this.logger.log(
        yellow(
          `Skipped ${white.bold(skippedNoImage.toString())} variants with no hosted product image`
        )
      );
    }
    if (failed > 0) {
      this.logger.log(
        yellow(`${white.bold(failed.toString())} playlists failed`)
      );
    }

    return rows;
  }

  /**
   * Every row a single playlist contributes: one per locale/country pair it is
   * allowed to appear in, for each product type we sell.
   */
  private async buildRowsForPlaylist(
    playlist: any
  ): Promise<{ rows: FeedRow[]; skippedNoImage: number }> {
    const rows: FeedRow[] = [];
    let skippedNoImage = 0;

    // Price comes from the same OrderType lookup the summary component uses.
    const cardsOrderType = await this.order.getOrderType(
      playlist.numberOfTracks,
      false,
      'cards',
      playlist.playlistId,
      'none'
    );

    const productTypes: Array<{ type: 'physical'; price: number }> = [
      {
        type: 'physical',
        price:
          cardsOrderType?.amount ||
          cardsOrderType?.amountWithMargin ||
          playlist.price ||
          29.99,
      },
    ];

    for (const { locale, country } of this.localeCountryPairs) {
      // Same "localised + international" rule as the public /:locale/playlists
      // page: international playlists go everywhere, locale-specific ones go to
      // any country whose allowed locales intersect their featuredLocale.
      if (!isPlaylistAllowedInCountry(playlist.featuredLocale, country)) {
        continue;
      }

      for (const productType of productTypes) {
        const variant: ProductVariant = {
          id: playlist.id,
          playlistId: playlist.playlistId,
          name: playlist.name,
          description:
            playlist[`description_${locale}`] || playlist.description_en,
          image: playlist.image,
          price: productType.price,
          numberOfTracks: playlist.numberOfTracks,
          type: productType.type,
          locale,
          country,
          slug: playlist.slug,
          genre: playlist.genre ? playlist.genre[`name_${locale}`] : undefined,
          genreSlug: playlist.genre?.slug,
        };

        const row = await this.buildRow(variant);
        if (row) {
          rows.push(row);
        } else {
          skippedNoImage++;
        }
      }
    }

    return { rows, skippedNoImage };
  }

  /**
   * One CSV row for one variant, or null when we have no hosted image for it.
   */
  private async buildRow(variant: ProductVariant): Promise<FeedRow | null> {
    const baseUrl = process.env['FRONTEND_URI'] || 'https://www.qrsong.io';
    const country = variant.country;

    // Never publish a raw Spotify / Apple CDN cover: Google rejects those
    // (image_link_broken / image_decoding_error) and Channable would just pass
    // them straight through. Only our own hosted images under
    // /public/products/ count. Same guard as createMerchantProduct().
    const imageLink = await this.resolveExistingProductImage(variant);
    if (!imageLink) {
      return null;
    }

    const offerId = buildOfferId(variant);
    const productId = buildProductId(variant);
    const productUrl = `${baseUrl}/${variant.locale}/product/${variant.slug}?orderType=${variant.type}`;

    // Title, from the `merchant.*` translation bundle.
    const merchantTranslations = await this.translate.getTranslationsByPrefix(
      variant.locale,
      'merchant'
    );
    const qrMusicGame = merchantTranslations?.qr_music_game || 'QR Music Game';
    const cardsLabel = merchantTranslations?.cards || 'cards';
    let productSuffix = '';
    switch (variant.type) {
      case 'digital':
        productSuffix = merchantTranslations?.pdf || 'PDF';
        break;
      case 'sheets':
        productSuffix = merchantTranslations?.sheets || 'sheets';
        break;
      case 'physical':
        productSuffix = cardsLabel;
        break;
    }
    const title = `${qrMusicGame} (${productSuffix}) - ${variant.name} - ${variant.numberOfTracks} ${cardsLabel}`;

    // Description + the "Contains N music tracks" line.
    let description = variant.description || '';
    description += ` ${getTracksLabel(variant.numberOfTracks, variant.locale)}`;

    const googleCategory = variant.type === 'digital' ? '839' : '5030';

    // Local currency, converted from our EUR prices. FX may downgrade us to
    // EUR when a rate is missing, so trust the currency it returns rather than
    // the one we asked for — value and currency must stay consistent.
    const targetCurrency = getCurrencyForCountry(country);
    const priceResult = await this.fx.convertAndFormat(
      variant.price,
      targetCurrency
    );
    const currency = priceResult.currency;

    // Shipping: digital ships instantly for free, everything else uses the
    // real per-country, per-size cost.
    let shippingPrice: string;
    let shippingService: string;
    let handling: [string, string];
    let transit: [string, string];

    if (variant.type === 'digital') {
      shippingPrice = '0.00';
      shippingService = 'Digital Delivery';
      handling = ['0', '0'];
      transit = ['0', '0'];
    } else {
      const lookedUpCost = getShippingCostForVariant(
        this.shippingCostsByCountry,
        country,
        variant.type,
        variant.numberOfTracks
      );
      // Fall back to 4.95 EUR when a country is missing from ShippingCostNew —
      // better than dropping the row entirely.
      const shippingResult = await this.fx.convertAndFormat(
        lookedUpCost ?? 4.95,
        currency
      );
      shippingPrice = this.toAmount(shippingResult.value);
      shippingService = 'Standard Shipping';
      handling = ['1', '2'];
      transit = ['2', '5'];
    }

    return {
      id: productId,
      offer_id: offerId,
      content_language: variant.locale,
      target_country: country,
      title,
      description: description.substring(0, 5000), // Max 5000 characters
      link: productUrl,
      image_link: imageLink,
      availability: 'in_stock',
      condition: 'new',
      price: this.toAmount(priceResult.value),
      currency,
      brand: 'QRSong!',
      google_product_category: googleCategory,
      // Google's breadcrumb separator, so Channable can pass it straight on.
      product_type: getProductTypes(variant).join(' > '),
      shipping_price: shippingPrice,
      shipping_currency: currency,
      shipping_service: shippingService,
      min_handling_time: handling[0],
      max_handling_time: handling[1],
      min_transit_time: transit[0],
      max_transit_time: transit[1],
      shipping_label:
        variant.type === 'digital' ? 'digital_delivery' : 'standard_shipping',
      // PMax campaign segmentation, same meanings as the Merchant Center feed.
      custom_label_0: variant.type,
      custom_label_1: getGenreGroup(variant.genreSlug),
      custom_label_2: variant.genreSlug || 'unknown',
      custom_label_3: getTrackCountRange(variant.numberOfTracks),
      number_of_tracks: variant.numberOfTracks.toString(),
      product_variant: variant.type,
      playlist_slug: variant.slug,
      playlist_id: variant.playlistId,
      genre: variant.genre || '',
      genre_slug: variant.genreSlug || '',
    };
  }

  /**
   * Find an already-generated product image for this variant. Read-only by
   * design: image generation (AI photos at 1 AM, the Sharp composite
   * fallback) lives in src/merchantcenter.ts and we reuse its output rather
   * than paying for a second set. Lookup order matches
   * merchantcenter.generateProductImage(): the AI photo wins, then an existing
   * composite, then nothing.
   *
   * NOTE: when merchantcenter.ts is eventually retired, that image-generation
   * half has to move here (or into a shared module) or this feed will slowly
   * lose images as playlists change.
   */
  private async resolveExistingProductImage(
    variant: ProductVariant
  ): Promise<string | null> {
    const publicDir =
      process.env['PUBLIC_DIR'] || path.join(__dirname, '..', 'public');
    const productsDir = path.join(publicDir, 'products');
    const apiUri = process.env['API_URI'] || 'https://api.qrsong.io';

    let files: string[];
    try {
      files = await fs.readdir(productsDir);
    } catch {
      return null;
    }

    // 1. The AI product photo, keyed by Spotify playlist id. Newest wins.
    const aiMatches = files
      .filter(
        (f) =>
          f.startsWith(`merchant_ai_${variant.playlistId}_`) &&
          f.endsWith('.jpg')
      )
      .sort();
    if (aiMatches.length > 0) {
      return `${apiUri}/public/products/${aiMatches[aiMatches.length - 1]}`;
    }

    // 2. The Sharp composite, keyed by playlist + type + locale.
    const imageKey = `${variant.playlistId}_${variant.type}_${variant.locale}`;
    const composite = files.find(
      (f) => f.startsWith(`merchant_${imageKey}_`) && f.endsWith('.jpg')
    );
    if (composite) {
      return `${apiUri}/public/products/${composite}`;
    }

    return null;
  }

  /**
   * Load shipping costs for every country from the same source the public
   * /shipping-info page uses, cached for the duration of one build so we don't
   * hit the database once per row.
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
   * Normalise a price to a plain decimal string ("29.99"). Channable's Google
   * Shopping export composes "29.99 EUR" itself from price + currency, and its
   * rule engine needs the bare number.
   */
  private toAmount(value: string | number): string {
    const amount = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(amount)) {
      return '0.00';
    }
    return amount.toFixed(2);
  }

  /**
   * Write the full feed plus one file per country we sell in.
   */
  private async writeCsv(rows: FeedRow[]): Promise<string> {
    const feedPath = this.getFeedPath();
    await fs.mkdir(path.dirname(feedPath), { recursive: true });

    await this.writeCsvFile(feedPath, rows);

    // Per-country slices, written even when empty so a country that
    // temporarily has no products serves an empty feed rather than a 404 —
    // Channable treats a missing file as an import error, but an empty one as
    // "nothing to list today".
    for (const country of this.getFeedCountries()) {
      await this.writeCsvFile(
        this.getFeedPath(country),
        rows.filter((r) => r.target_country === country)
      );
    }

    return feedPath;
  }

  /**
   * Serialise rows to RFC 4180 CSV at one path. The write is atomic (temp file
   * + rename) so Channable can never fetch a half-written feed — a truncated
   * import would look like the catalogue had suddenly shrunk.
   */
  private async writeCsvFile(
    filePath: string,
    rows: FeedRow[]
  ): Promise<void> {
    const lines = [COLUMNS.join(',')];
    for (const row of rows) {
      lines.push(COLUMNS.map((c) => this.csvEscape(row[c])).join(','));
    }
    // Trailing newline so the last row is a complete line.
    const csv = lines.join('\r\n') + '\r\n';

    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, csv, 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  /**
   * RFC 4180 field escaping. Titles and descriptions are user-authored, so
   * they routinely contain commas, quotes and newlines.
   */
  private csvEscape(value: string): string {
    const s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }
}

export const channable = ChannableService.getInstance();
