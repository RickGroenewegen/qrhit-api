import axios from 'axios';
import { CronJob } from 'cron';
import cluster from 'cluster';
import { promises as fs } from 'fs';
import path from 'path';
import Logger from './logger';
import { color } from 'console-log-colors';
import PrismaInstance from './prisma';
import Utils from './utils';

export interface ExternalCardData {
  id: number;
  spotifyId: string | null;
  spotifyLink: string | null;
  appleMusicLink: string | null;
  tidalLink: string | null;
  youtubeMusicLink: string | null;
  deezerLink: string | null;
  amazonMusicLink: string | null;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

class ExternalCardService {
  private static instance: ExternalCardService;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private utils = new Utils();

  // In-memory maps (loaded from database)
  private jumboCardMap: Map<string, ExternalCardData> = new Map();
  private countryCardMaps: Map<string, Map<string, ExternalCardData>> = new Map();
  private musicMatchMap: Map<string, ExternalCardData> = new Map();
  private mapsLoaded: boolean = false;
  private mapsLoadingPromise: Promise<void> | null = null;

  private constructor() {
    // Maps will be loaded on first access
  }

  public static getInstance(): ExternalCardService {
    if (!ExternalCardService.instance) {
      ExternalCardService.instance = new ExternalCardService();
      // Start the nightly import cron job
      ExternalCardService.instance.startNightlyImportCron();
      // Load maps from database on startup
      ExternalCardService.instance.loadMapsFromDatabase();
    }
    return ExternalCardService.instance;
  }

  /**
   * Load all in-memory maps from the database
   */
  public async loadMapsFromDatabase(): Promise<void> {
    // Prevent multiple concurrent loads
    if (this.mapsLoadingPromise) {
      return this.mapsLoadingPromise;
    }

    this.mapsLoadingPromise = this._loadMapsFromDatabase();
    await this.mapsLoadingPromise;
    this.mapsLoadingPromise = null;
  }

  private async _loadMapsFromDatabase(): Promise<void> {
    const isPrimary = cluster.isPrimary;

    try {
      // Clear existing maps
      this.jumboCardMap.clear();
      this.countryCardMaps.clear();
      this.musicMatchMap.clear();

      // Load all external cards from database
      const cards = await this.prisma.externalCard.findMany();

      let jumboCount = 0;
      let countryCount = 0;
      let musicMatchCount = 0;

      for (const card of cards) {
        const cardData: ExternalCardData = {
          id: card.id,
          spotifyId: card.spotifyId,
          spotifyLink: card.spotifyLink,
          appleMusicLink: card.appleMusicLink,
          tidalLink: card.tidalLink,
          youtubeMusicLink: card.youtubeMusicLink,
          deezerLink: card.deezerLink,
          amazonMusicLink: card.amazonMusicLink,
        };

        if (card.cardType === 'jumbo' && card.sku) {
          const key = `${card.sku}_${card.cardNumber}`;
          this.jumboCardMap.set(key, cardData);
          jumboCount++;
        } else if (card.cardType === 'country' && card.countryCode) {
          if (!this.countryCardMaps.has(card.countryCode)) {
            this.countryCardMaps.set(card.countryCode, new Map());
          }
          this.countryCardMaps.get(card.countryCode)!.set(card.cardNumber, cardData);
          countryCount++;
        } else if (card.cardType === 'musicmatch' && card.playlistId) {
          const key = `${card.playlistId}_${card.cardNumber}`;
          this.musicMatchMap.set(key, cardData);
          musicMatchCount++;
        }
      }

      this.mapsLoaded = true;

      if (isPrimary) {
        this.utils.isMainServer().then(async (isMainServer) => {
          if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
            this.logger.log(
              color.green.bold(
                `External cards loaded from database: ${color.white.bold(jumboCount)} Jumbo, ${color.white.bold(countryCount)} Country, ${color.white.bold(musicMatchCount)} MusicMatch`
              )
            );
          }
        });
      }
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`Failed to load external cards from database: ${e.message || e}`)
      );
    }
  }

  /**
   * Ensure maps are loaded before lookup
   */
  private async ensureMapsLoaded(): Promise<void> {
    if (!this.mapsLoaded) {
      await this.loadMapsFromDatabase();
    }
  }

  // ============ LOOKUP METHODS ============

  /**
   * Get card data by Jumbo key (sku_cardNumber)
   */
  public async getCardByJumboKey(sku: string, cardNumber: string): Promise<ExternalCardData | null> {
    await this.ensureMapsLoaded();
    const key = `${sku}_${cardNumber}`;
    return this.jumboCardMap.get(key) || null;
  }

  /**
   * Get card data by country key (countryCode, cardNumber)
   */
  public async getCardByCountryKey(countryCode: string, cardNumber: string): Promise<ExternalCardData | null> {
    await this.ensureMapsLoaded();
    const countryMap = this.countryCardMaps.get(countryCode.toLowerCase());
    if (!countryMap) return null;
    return countryMap.get(cardNumber) || null;
  }

  /**
   * Get card data by MusicMatch key (playlistId_trackId)
   */
  public async getCardByMusicMatchKey(playlistId: string, trackId: string): Promise<ExternalCardData | null> {
    await this.ensureMapsLoaded();
    const key = `${playlistId}_${trackId}`;
    return this.musicMatchMap.get(key) || null;
  }

  /**
   * Update a card's data in the in-memory cache
   * Called after MusicFetch updates links for external cards
   */
  public async updateCardInCache(
    cardId: number,
    cardType: string,
    keyIdentifier: { sku?: string; countryCode?: string; playlistId?: string; cardNumber: string },
    newData: Partial<ExternalCardData>
  ): Promise<void> {
    await this.ensureMapsLoaded();

    let existingCard: ExternalCardData | undefined;
    let mapKey: string;

    if (cardType === 'jumbo' && keyIdentifier.sku) {
      mapKey = `${keyIdentifier.sku}_${keyIdentifier.cardNumber}`;
      existingCard = this.jumboCardMap.get(mapKey);
      if (existingCard) {
        this.jumboCardMap.set(mapKey, { ...existingCard, ...newData });
      }
    } else if (cardType === 'country' && keyIdentifier.countryCode) {
      const countryMap = this.countryCardMaps.get(keyIdentifier.countryCode.toLowerCase());
      if (countryMap) {
        existingCard = countryMap.get(keyIdentifier.cardNumber);
        if (existingCard) {
          countryMap.set(keyIdentifier.cardNumber, { ...existingCard, ...newData });
        }
      }
    } else if (cardType === 'musicmatch' && keyIdentifier.playlistId) {
      mapKey = `${keyIdentifier.playlistId}_${keyIdentifier.cardNumber}`;
      existingCard = this.musicMatchMap.get(mapKey);
      if (existingCard) {
        this.musicMatchMap.set(mapKey, { ...existingCard, ...newData });
      }
    }
  }

  /**
   * Update all cards with a given spotifyId in the in-memory cache
   * Called after MusicFetch updates links for external cards
   */
  public async updateCardsWithSpotifyIdInCache(
    spotifyId: string,
    newLinks: Partial<ExternalCardData>
  ): Promise<void> {
    await this.ensureMapsLoaded();

    // Update in jumboCardMap
    for (const [key, card] of this.jumboCardMap) {
      if (card.spotifyId === spotifyId) {
        this.jumboCardMap.set(key, { ...card, ...newLinks });
      }
    }

    // Update in countryCardMaps
    for (const [, countryMap] of this.countryCardMaps) {
      for (const [key, card] of countryMap) {
        if (card.spotifyId === spotifyId) {
          countryMap.set(key, { ...card, ...newLinks });
        }
      }
    }

    // Update in musicMatchMap
    for (const [key, card] of this.musicMatchMap) {
      if (card.spotifyId === spotifyId) {
        this.musicMatchMap.set(key, { ...card, ...newLinks });
      }
    }
  }

  // ============ IMPORT METHODS ============

  /**
   * Import Jumbo cards from external API - Batched insert (skip duplicates)
   */
  public async importJumboCards(): Promise<ImportResult> {
    const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const BATCH_SIZE = 500;

    this.logger.log(color.blue.bold(`[Jumbo] Starting import...`));

    try {
      this.logger.log(color.blue.bold(`[Jumbo] Fetching data from API...`));
      const url = 'https://hitster.jumboplay.com/hitster-assets/gameset_database.json';
      const response = await axios.get(url, { timeout: 30000 });
      const data = response.data;

      if (!data || !Array.isArray(data.gamesets)) {
        result.errors.push('Invalid response format: no gamesets array');
        return result;
      }

      this.logger.log(color.blue.bold(`[Jumbo] Found ${color.white.bold(data.gamesets.length)} gamesets`));

      // Collect all cards to insert
      const cardsToInsert: Array<{
        cardType: 'jumbo';
        sku: string;
        cardNumber: string;
        spotifyId: string;
        spotifyLink: string;
        gamesetLanguage: string | null;
        gamesetName: string | null;
      }> = [];

      for (const gameset of data.gamesets) {
        const sku = gameset.sku;
        const cards = gameset.gameset_data?.cards;
        const gamesetLanguage = gameset.gameset_data?.gameset_language || null;
        const gamesetName = gameset.gameset_data?.gameset_name || null;

        if (!sku || !Array.isArray(cards)) {
          continue;
        }

        for (const card of cards) {
          const cardNumber = card.CardNumber;
          const spotifyId = card.Spotify;

          if (!cardNumber || !spotifyId) {
            result.skipped++;
            continue;
          }

          cardsToInsert.push({
            cardType: 'jumbo',
            sku,
            cardNumber,
            spotifyId,
            spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
            gamesetLanguage,
            gamesetName,
          });
        }
      }

      result.total = cardsToInsert.length;
      const totalBatches = Math.ceil(cardsToInsert.length / BATCH_SIZE);
      this.logger.log(color.blue.bold(`[Jumbo] Collected ${color.white.bold(result.total)} cards in ${color.white.bold(totalBatches)} batches`));

      // Process in batches using createMany with skipDuplicates
      for (let i = 0; i < cardsToInsert.length; i += BATCH_SIZE) {
        const batch = cardsToInsert.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const progress = Math.round((i + batch.length) / cardsToInsert.length * 100);

        try {
          const createResult = await this.prisma.externalCard.createMany({
            data: batch,
            skipDuplicates: true,
          });

          result.created += createResult.count;
          result.skipped += batch.length - createResult.count;
          this.logger.log(color.blue.bold(`[Jumbo] Batch ${color.white.bold(batchNum + '/' + totalBatches)} (${color.white.bold(progress + '%')}) - ${color.white.bold(createResult.count)} new, ${color.white.bold(batch.length - createResult.count)} skipped`));
        } catch (e: any) {
          result.errors.push(`Jumbo batch ${i}-${i + batch.length}: ${e.message || e}`);
          this.logger.log(color.red.bold(`[Jumbo] Batch ${batchNum} failed: ${e.message || e}`));
        }
      }

      this.logger.log(color.blue.bold(`[Jumbo] Complete: ${color.white.bold(result.total)} total, ${color.white.bold(result.created)} created, ${color.white.bold(result.skipped)} skipped`));
    } catch (e: any) {
      result.errors.push(`Failed to fetch Jumbo data: ${e.message || e}`);
      this.logger.log(color.red.bold(`[Jumbo] Import failed: ${e.message || e}`));
    }

    return result;
  }

  /**
   * Import country cards from JSON files - Batched insert (skip duplicates)
   */
  public async importCountryCards(): Promise<ImportResult> {
    const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const BATCH_SIZE = 500;

    this.logger.log(color.blue.bold(`[Country] Starting import...`));

    try {
      const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');
      const dirPath = path.join(appRoot, '_data', 'jumbo');

      // Check if directory exists
      try {
        await fs.access(dirPath);
      } catch {
        result.errors.push(`Country card data directory not found: ${dirPath}`);
        this.logger.log(color.red.bold(`[Country] Data directory not found: ${dirPath}`));
        return result;
      }

      const files = await fs.readdir(dirPath);
      const jsonFiles = files.filter((file: string) => file.endsWith('.json'));
      this.logger.log(color.blue.bold(`[Country] Found ${color.white.bold(jsonFiles.length)} country files`));

      // Collect all cards to insert
      const cardsToInsert: Array<{
        cardType: 'country';
        countryCode: string;
        cardNumber: string;
        spotifyId: string;
        spotifyLink: string;
      }> = [];

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(dirPath, file);
          const fileContent = await fs.readFile(filePath, 'utf8');
          const data = JSON.parse(fileContent);

          if (!data || !data.name || !data.cards || typeof data.cards !== 'object') {
            result.errors.push(`Invalid format in ${file}`);
            continue;
          }

          const countryCode = data.name.toLowerCase();
          const cardCount = Object.keys(data.cards).length;
          this.logger.log(color.blue.bold(`[Country] Loading ${color.white.bold(cardCount)} cards from ${color.white.bold(countryCode.toUpperCase())}`));

          for (const [cardNumber, spotifyId] of Object.entries(data.cards)) {
            if (!spotifyId || typeof spotifyId !== 'string') {
              result.skipped++;
              continue;
            }

            cardsToInsert.push({
              cardType: 'country',
              countryCode,
              cardNumber,
              spotifyId,
              spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
            });
          }
        } catch (e: any) {
          result.errors.push(`Failed to process ${file}: ${e.message || e}`);
          this.logger.log(color.red.bold(`[Country] Failed to process ${file}: ${e.message || e}`));
        }
      }

      result.total = cardsToInsert.length;
      const totalBatches = Math.ceil(cardsToInsert.length / BATCH_SIZE);
      this.logger.log(color.blue.bold(`[Country] Collected ${color.white.bold(result.total)} cards in ${color.white.bold(totalBatches)} batches`));

      // Process in batches using createMany with skipDuplicates
      for (let i = 0; i < cardsToInsert.length; i += BATCH_SIZE) {
        const batch = cardsToInsert.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const progress = Math.round((i + batch.length) / cardsToInsert.length * 100);

        try {
          const createResult = await this.prisma.externalCard.createMany({
            data: batch,
            skipDuplicates: true,
          });

          result.created += createResult.count;
          result.skipped += batch.length - createResult.count;
          this.logger.log(color.blue.bold(`[Country] Batch ${color.white.bold(batchNum + '/' + totalBatches)} (${color.white.bold(progress + '%')}) - ${color.white.bold(createResult.count)} new, ${color.white.bold(batch.length - createResult.count)} skipped`));
        } catch (e: any) {
          result.errors.push(`Country batch ${i}-${i + batch.length}: ${e.message || e}`);
          this.logger.log(color.red.bold(`[Country] Batch ${batchNum} failed: ${e.message || e}`));
        }
      }

      this.logger.log(color.blue.bold(`[Country] Complete: ${color.white.bold(result.total)} total, ${color.white.bold(result.created)} created, ${color.white.bold(result.skipped)} skipped`));
    } catch (e: any) {
      result.errors.push(`Country import failed: ${e.message || e}`);
      this.logger.log(color.red.bold(`[Country] Import failed: ${e.message || e}`));
    }

    return result;
  }

  /**
   * Import MusicMatch cards from JSON file - Batched insert (skip duplicates)
   */
  public async importMusicMatchCards(): Promise<ImportResult> {
    const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const BATCH_SIZE = 500;

    this.logger.log(color.blue.bold(`[MusicMatch] Starting import...`));

    try {
      const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');
      const filePath = path.join(appRoot, '_data', 'musicmatch.json');

      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, 'utf8');
      } catch {
        result.errors.push(`MusicMatch data file not found: ${filePath}`);
        this.logger.log(color.red.bold(`[MusicMatch] Data file not found: ${filePath}`));
        return result;
      }

      const data = JSON.parse(fileContent);

      if (!data || !data.p || !Array.isArray(data.p)) {
        result.errors.push('Invalid MusicMatch format: no playlists array');
        this.logger.log(color.red.bold(`[MusicMatch] Invalid format: no playlists array`));
        return result;
      }

      this.logger.log(color.blue.bold(`[MusicMatch] Found ${color.white.bold(data.p.length)} playlists`));

      // Collect all cards to insert
      const cardsToInsert: Array<{
        cardType: 'musicmatch';
        playlistId: string;
        cardNumber: string;
        spotifyId: string;
        spotifyLink: string;
      }> = [];

      for (const playlist of data.p) {
        const playlistId = playlist.i;
        if (!playlistId || !Array.isArray(playlist.t)) {
          continue;
        }

        for (const track of playlist.t) {
          const trackId = track.i;
          const spotifyId = track.l;

          if (!trackId || !spotifyId) {
            result.skipped++;
            continue;
          }

          cardsToInsert.push({
            cardType: 'musicmatch',
            playlistId: String(playlistId),
            cardNumber: String(trackId),
            spotifyId,
            spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
          });
        }
      }

      result.total = cardsToInsert.length;
      const totalBatches = Math.ceil(cardsToInsert.length / BATCH_SIZE);
      this.logger.log(color.blue.bold(`[MusicMatch] Collected ${color.white.bold(result.total)} cards in ${color.white.bold(totalBatches)} batches`));

      // Process in batches using createMany with skipDuplicates
      for (let i = 0; i < cardsToInsert.length; i += BATCH_SIZE) {
        const batch = cardsToInsert.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const progress = Math.round((i + batch.length) / cardsToInsert.length * 100);

        try {
          const createResult = await this.prisma.externalCard.createMany({
            data: batch,
            skipDuplicates: true,
          });

          result.created += createResult.count;
          result.skipped += batch.length - createResult.count;
          this.logger.log(color.blue.bold(`[MusicMatch] Batch ${color.white.bold(batchNum + '/' + totalBatches)} (${color.white.bold(progress + '%')}) - ${color.white.bold(createResult.count)} new, ${color.white.bold(batch.length - createResult.count)} skipped`));
        } catch (e: any) {
          result.errors.push(`MusicMatch batch ${i}-${i + batch.length}: ${e.message || e}`);
          this.logger.log(color.red.bold(`[MusicMatch] Batch ${batchNum} failed: ${e.message || e}`));
        }
      }

      this.logger.log(color.blue.bold(`[MusicMatch] Complete: ${color.white.bold(result.total)} total, ${color.white.bold(result.created)} created, ${color.white.bold(result.skipped)} skipped`));
    } catch (e: any) {
      result.errors.push(`MusicMatch import failed: ${e.message || e}`);
      this.logger.log(color.red.bold(`[MusicMatch] Import failed: ${e.message || e}`));
    }

    return result;
  }

  /**
   * Import all external cards from all sources
   */
  public async importAllExternalCards(): Promise<ImportResult> {
    const totalResult: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };

    this.logger.log(color.blue.bold('Starting external card import from all sources...'));

    // Import Jumbo cards
    const jumboResult = await this.importJumboCards();
    totalResult.total += jumboResult.total;
    totalResult.created += jumboResult.created;
    totalResult.updated += jumboResult.updated;
    totalResult.skipped += jumboResult.skipped;
    totalResult.errors.push(...jumboResult.errors);

    // Import country cards
    const countryResult = await this.importCountryCards();
    totalResult.total += countryResult.total;
    totalResult.created += countryResult.created;
    totalResult.updated += countryResult.updated;
    totalResult.skipped += countryResult.skipped;
    totalResult.errors.push(...countryResult.errors);

    // Import MusicMatch cards
    const musicMatchResult = await this.importMusicMatchCards();
    totalResult.total += musicMatchResult.total;
    totalResult.created += musicMatchResult.created;
    totalResult.updated += musicMatchResult.updated;
    totalResult.skipped += musicMatchResult.skipped;
    totalResult.errors.push(...musicMatchResult.errors);

    this.logger.log(
      color.green.bold(
        `External card import complete: ${totalResult.total} total, ${totalResult.created} created, ${totalResult.updated} updated, ${totalResult.skipped} skipped, ${totalResult.errors.length} errors`
      )
    );

    // Reload maps from database after import
    this.mapsLoaded = false;
    await this.loadMapsFromDatabase();

    return totalResult;
  }

  /**
   * Start the nightly import cron job (runs at 2 AM)
   */
  public startNightlyImportCron(): void {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          const importJob = new CronJob('0 2 * * *', async () => {
            this.logger.log(color.blue.bold('Starting nightly external card import...'));
            try {
              await this.importAllExternalCards();
            } catch (e: any) {
              this.logger.log(
                color.red.bold(`Nightly external card import failed: ${e.message || e}`)
              );
            }
          });
          importJob.start();
          this.logger.log(
            color.green.bold('External card nightly import cron scheduled for 2 AM')
          );
        }
      });
    }
  }

  /**
   * Get statistics about external cards
   */
  public async getStats(): Promise<{
    total: number;
    jumbo: number;
    country: number;
    musicmatch: number;
    withSpotify: number;
    withAppleMusic: number;
    withTidal: number;
    withYoutubeMusic: number;
    withDeezer: number;
    withAmazonMusic: number;
  }> {
    const [total, jumbo, country, musicmatch, withSpotify, withAppleMusic, withTidal, withYoutubeMusic, withDeezer, withAmazonMusic] = await Promise.all([
      this.prisma.externalCard.count(),
      this.prisma.externalCard.count({ where: { cardType: 'jumbo' } }),
      this.prisma.externalCard.count({ where: { cardType: 'country' } }),
      this.prisma.externalCard.count({ where: { cardType: 'musicmatch' } }),
      this.prisma.externalCard.count({ where: { spotifyLink: { not: null } } }),
      this.prisma.externalCard.count({ where: { appleMusicLink: { not: null } } }),
      this.prisma.externalCard.count({ where: { tidalLink: { not: null } } }),
      this.prisma.externalCard.count({ where: { youtubeMusicLink: { not: null } } }),
      this.prisma.externalCard.count({ where: { deezerLink: { not: null } } }),
      this.prisma.externalCard.count({ where: { amazonMusicLink: { not: null } } }),
    ]);

    return {
      total,
      jumbo,
      country,
      musicmatch,
      withSpotify,
      withAppleMusic,
      withTidal,
      withYoutubeMusic,
      withDeezer,
      withAmazonMusic,
    };
  }
}

export default ExternalCardService;
