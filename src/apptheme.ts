import { color } from 'console-log-colors';
import Redis from 'ioredis';
import Logger from './logger';
import PrismaInstance from './prisma';
import Utils from './utils';
import cluster from 'cluster';

class AppTheme {
  private static instance: AppTheme;
  private static readonly RELOAD_CHANNEL = 'apptheme:reload';
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private appThemes: Map<number, { s: string; n: string; st: string }> = new Map();
  private appThemesInitialized: boolean = false;
  // Unique id for this process so we can ignore reload messages we published ourselves
  private instanceId: string = `${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;

  private constructor() {
    // Initialize themes on startup
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          await this.loadAppThemes(true);
        } else {
          await this.loadAppThemes(false);
        }
      });
    } else {
      this.loadAppThemes(false);
    }

    // Listen for cross-worker reload broadcasts
    this.setupReloadSubscriber();
  }

  public static getInstance(): AppTheme {
    if (!AppTheme.instance) {
      AppTheme.instance = new AppTheme();
    }
    return AppTheme.instance;
  }

  /**
   * Set up Redis pub/sub so a reload on one worker propagates to all workers.
   * Each Node cluster worker keeps its own in-memory theme cache, so without
   * this broadcast only the worker that handled the request would be fresh.
   */
  private setupReloadSubscriber(): void {
    const redisUrl = process.env['REDIS_URL'];

    if (!redisUrl) {
      // No Redis configured - fall back to local-only reloads
      return;
    }

    try {
      this.publisher = new Redis(redisUrl, { db: 0 });
      this.subscriber = new Redis(redisUrl, { db: 0 });

      this.publisher.on('error', (error) => {
        this.logger.log(
          color.red.bold('AppTheme publisher Redis error: ') +
            color.white.bold(error.message)
        );
      });
      this.subscriber.on('error', (error) => {
        this.logger.log(
          color.red.bold('AppTheme subscriber Redis error: ') +
            color.white.bold(error.message)
        );
      });

      this.subscriber.subscribe(AppTheme.RELOAD_CHANNEL);
      this.subscriber.on('message', async (channel, message) => {
        if (channel !== AppTheme.RELOAD_CHANNEL) {
          return;
        }

        // Ignore the broadcast we published ourselves - that worker already
        // reloaded locally in reload().
        if (message === this.instanceId) {
          return;
        }

        await this.loadAppThemes(false);
      });
    } catch (error: any) {
      this.logger.log(
        color.red.bold('Failed to set up AppTheme reload subscriber: ') +
          color.white.bold(error.message)
      );
    }
  }

  /**
   * Load all app themes from payment_has_playlist into memory
   * This runs on API startup to avoid database queries on every request
   */
  public async loadAppThemes(shouldLog: boolean = false): Promise<void> {
    try {
      const themes: any[] = await this.prisma.$queryRaw`
        SELECT php.id, php.theme, php.themeName, p.serviceType
        FROM payment_has_playlist php
        JOIN playlists p ON php.playlistId = p.id
      `;

      this.appThemes.clear();

      for (const themeRow of themes) {
        this.appThemes.set(themeRow.id, {
          s: themeRow.theme || '',
          n: themeRow.themeName || themeRow.theme || '',
          st: themeRow.serviceType || 'spotify',
        });
      }

      // Only log on main/primary server
      if (shouldLog) {
        this.logger.log(
          color.blue.bold(
            `Loaded ${color.white.bold(this.appThemes.size)} app themes`
          )
        );
      }

      this.appThemesInitialized = true;
    } catch (error: any) {
      console.error(`Failed to load app themes: ${error.message}`);
      this.appThemesInitialized = true; // Mark as initialized even on error to prevent blocking
    }
  }

  /**
   * Get theme and service type for a given payment_has_playlist ID
   * Returns null if not found
   */
  public getTheme(phpId: number): { s: string; n: string; st: string } | null {
    if (!this.appThemesInitialized) {
      console.warn('App themes not yet initialized, returning null');
      return null;
    }
    return this.appThemes.get(phpId) || null;
  }

  /**
   * Check if themes are initialized
   */
  public isInitialized(): boolean {
    return this.appThemesInitialized;
  }

  /**
   * Reload themes (useful for adding new themes without restarting API).
   * Reloads this worker immediately and broadcasts to all other workers.
   */
  public async reload(): Promise<void> {
    this.appThemesInitialized = false;
    await this.loadAppThemes();

    // Notify the other workers so their in-memory caches stay in sync
    if (this.publisher) {
      try {
        await this.publisher.publish(AppTheme.RELOAD_CHANNEL, this.instanceId);
      } catch (error: any) {
        this.logger.log(
          color.red.bold('Failed to broadcast AppTheme reload: ') +
            color.white.bold(error.message)
        );
      }
    }
  }

  /**
   * Get all themes (for debugging)
   */
  public getAllThemes(): Map<number, { s: string; n: string; st: string }> {
    return new Map(this.appThemes);
  }
}

export default AppTheme;
