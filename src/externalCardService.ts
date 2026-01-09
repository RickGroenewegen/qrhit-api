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

  // ============ IMPORT METHODS ============

  /**
   * Import Jumbo cards from external API (UPSERT)
   */
  public async importJumboCards(): Promise<ImportResult> {
    const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };

    try {
      const url = 'https://hitster.jumboplay.com/hitster-assets/gameset_database.json';
      const response = await axios.get(url, { timeout: 30000 });
      const data = response.data;

      if (!data || !Array.isArray(data.gamesets)) {
        result.errors.push('Invalid response format: no gamesets array');
        return result;
      }

      for (const gameset of data.gamesets) {
        const sku = gameset.sku;
        const cards = gameset.gameset_data?.cards;
        const gamesetLanguage = gameset.gameset_data?.language || null;
        const gamesetName = gameset.gameset_data?.name || null;

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

          result.total++;

          try {
            const existing = await this.prisma.externalCard.findFirst({
              where: {
                cardType: 'jumbo',
                sku: sku,
                cardNumber: cardNumber,
              },
            });

            if (existing) {
              // Update only if spotifyId changed
              if (existing.spotifyId !== spotifyId) {
                await this.prisma.externalCard.update({
                  where: { id: existing.id },
                  data: {
                    spotifyId: spotifyId,
                    spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
                    gamesetLanguage,
                    gamesetName,
                  },
                });
                result.updated++;
              } else {
                result.skipped++;
              }
            } else {
              await this.prisma.externalCard.create({
                data: {
                  cardType: 'jumbo',
                  sku: sku,
                  cardNumber: cardNumber,
                  spotifyId: spotifyId,
                  spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
                  gamesetLanguage,
                  gamesetName,
                },
              });
              result.created++;
            }
          } catch (e: any) {
            result.errors.push(`Jumbo ${sku}_${cardNumber}: ${e.message || e}`);
          }
        }
      }

      this.logger.log(
        color.green.bold(
          `Jumbo import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`
        )
      );
    } catch (e: any) {
      result.errors.push(`Failed to fetch Jumbo data: ${e.message || e}`);
      this.logger.log(color.red.bold(`Jumbo import failed: ${e.message || e}`));
    }

    return result;
  }

  /**
   * Import country cards from JSON files (UPSERT)
   */
  public async importCountryCards(): Promise<ImportResult> {
    const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };

    try {
      const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');
      const dirPath = path.join(appRoot, '_data', 'jumbo');

      // Check if directory exists
      try {
        await fs.access(dirPath);
      } catch {
        result.errors.push(`Country card data directory not found: ${dirPath}`);
        return result;
      }

      const files = await fs.readdir(dirPath);
      const jsonFiles = files.filter((file: string) => file.endsWith('.json'));

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

          for (const [cardNumber, spotifyId] of Object.entries(data.cards)) {
            if (!spotifyId || typeof spotifyId !== 'string') {
              result.skipped++;
              continue;
            }

            result.total++;

            try {
              const existing = await this.prisma.externalCard.findFirst({
                where: {
                  cardType: 'country',
                  countryCode: countryCode,
                  cardNumber: cardNumber,
                },
              });

              if (existing) {
                if (existing.spotifyId !== spotifyId) {
                  await this.prisma.externalCard.update({
                    where: { id: existing.id },
                    data: {
                      spotifyId: spotifyId,
                      spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
                    },
                  });
                  result.updated++;
                } else {
                  result.skipped++;
                }
              } else {
                await this.prisma.externalCard.create({
                  data: {
                    cardType: 'country',
                    countryCode: countryCode,
                    cardNumber: cardNumber,
                    spotifyId: spotifyId as string,
                    spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
                  },
                });
                result.created++;
              }
            } catch (e: any) {
              result.errors.push(`Country ${countryCode}_${cardNumber}: ${e.message || e}`);
            }
          }
        } catch (e: any) {
          result.errors.push(`Failed to process ${file}: ${e.message || e}`);
        }
      }

      this.logger.log(
        color.green.bold(
          `Country import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`
        )
      );
    } catch (e: any) {
      result.errors.push(`Country import failed: ${e.message || e}`);
      this.logger.log(color.red.bold(`Country import failed: ${e.message || e}`));
    }

    return result;
  }

  /**
   * Import MusicMatch cards from JSON file (UPSERT)
   */
  public async importMusicMatchCards(): Promise<ImportResult> {
    const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };

    try {
      const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');
      const filePath = path.join(appRoot, '_data', 'musicmatch.json');

      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, 'utf8');
      } catch {
        result.errors.push(`MusicMatch data file not found: ${filePath}`);
        return result;
      }

      const data = JSON.parse(fileContent);

      if (!data || !data.p || !Array.isArray(data.p)) {
        result.errors.push('Invalid MusicMatch format: no playlists array');
        return result;
      }

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

          result.total++;

          try {
            const existing = await this.prisma.externalCard.findFirst({
              where: {
                cardType: 'musicmatch',
                playlistId: String(playlistId),
                cardNumber: String(trackId),
              },
            });

            if (existing) {
              if (existing.spotifyId !== spotifyId) {
                await this.prisma.externalCard.update({
                  where: { id: existing.id },
                  data: {
                    spotifyId: spotifyId,
                    spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
                  },
                });
                result.updated++;
              } else {
                result.skipped++;
              }
            } else {
              await this.prisma.externalCard.create({
                data: {
                  cardType: 'musicmatch',
                  playlistId: String(playlistId),
                  cardNumber: String(trackId),
                  spotifyId: spotifyId,
                  spotifyLink: `https://open.spotify.com/track/${spotifyId}`,
                },
              });
              result.created++;
            }
          } catch (e: any) {
            result.errors.push(`MusicMatch ${playlistId}_${trackId}: ${e.message || e}`);
          }
        }
      }

      this.logger.log(
        color.green.bold(
          `MusicMatch import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`
        )
      );
    } catch (e: any) {
      result.errors.push(`MusicMatch import failed: ${e.message || e}`);
      this.logger.log(color.red.bold(`MusicMatch import failed: ${e.message || e}`));
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
