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
  private loadPromise: Promise<void> | null = null;
  private retryAttempt: number = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
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
      // Workers load via warmup() after fastify.listen (plus the lazy
      // trigger in getTheme), keeping the full-table JOIN out of the boot
      // window where the cold pool creates connections one at a time.
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
   * Load the theme of every order line into memory, so a scan never queries
   * the database. Runs at startup and on every reload.
   *
   * Which theme a line gets, first match wins:
   *   1. `php.theme` set by an admin: a hand-made B2B theme.
   *   2. The line's own App Designer override, when the account owns the
   *      upgrade: `custom` serves its design, `standard` serves nothing (the
   *      app's built-in look), `default` falls through.
   *   3. The account's default App Designer design, when it owns the upgrade.
   * Customer slugs are served as `<slug>-<version>` (see src/appDesign.ts).
   */
  public async loadAppThemes(shouldLog: boolean = false): Promise<void> {
    try {
      const themes: any[] = await this.prisma.$queryRaw`
        SELECT php.id, php.theme, php.themeName, p.serviceType,
               ent.userId AS entitledUserId,
               ov.mode AS ovMode, ov.slug AS ovSlug, ov.version AS ovVersion,
               ov.name AS ovName, (ov.theme IS NOT NULL) AS ovHasTheme,
               df.slug AS dfSlug, df.version AS dfVersion, df.name AS dfName,
               (df.theme IS NOT NULL) AS dfHasTheme
        FROM payment_has_playlist php
        JOIN playlists p ON php.playlistId = p.id
        JOIN payments pay ON pay.id = php.paymentId
        LEFT JOIN (SELECT DISTINCT userId FROM app_design_purchases) ent
          ON ent.userId = pay.userId
        LEFT JOIN app_designs ov ON ov.paymentHasPlaylistId = php.id
        LEFT JOIN app_designs df
          ON df.userId = pay.userId AND df.paymentHasPlaylistId IS NULL
      `;

      this.appThemes.clear();

      for (const themeRow of themes) {
        const { s, n } = resolveLineTheme(themeRow);
        this.appThemes.set(themeRow.id, {
          s,
          n,
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
      this.retryAttempt = 0;
    } catch (error: any) {
      this.logger.log(
        color.red.bold('Failed to load app themes: ') +
          color.white.bold(error.message)
      );
      // Leave appThemesInitialized false so getTheme keeps triggering
      // ensureLoaded; retry with backoff instead of serving an empty map.
      this.scheduleRetry();
    }
  }

  /**
   * Load the themes once, deduplicating concurrent triggers.
   */
  private ensureLoaded(): Promise<void> {
    if (this.appThemesInitialized) {
      return Promise.resolve();
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    if (this.retryTimer) {
      // Backoff in progress; only the timer may start the next attempt,
      // otherwise every request would relaunch the failed query instantly.
      return Promise.resolve();
    }
    this.loadPromise = this.loadAppThemes(false).finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    const delays = [5000, 15000, 60000];
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensureLoaded();
    }, delay);
    this.retryTimer.unref();
  }

  /**
   * Kick off the initial load outside the boot window. Called by workers
   * after fastify.listen; a no-op once themes are loaded.
   */
  public warmup(delayMs: number = 0): void {
    setTimeout(() => {
      this.ensureLoaded();
    }, delayMs).unref();
  }

  /**
   * Get theme and service type for a given payment_has_playlist ID
   * Returns null if not found
   */
  public getTheme(phpId: number): { s: string; n: string; st: string } | null {
    if (!this.appThemesInitialized) {
      // Trigger the load (deduplicated) but serve whatever the map holds:
      // a stale map from before a failed reload beats returning null.
      this.ensureLoaded();
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

/**
 * The slug and name one order line gets, from a row of the loadAppThemes
 * query. Kept pure so the precedence rules can be tested without a database.
 * MySQL returns the IS NOT NULL flags as 0/1 (sometimes BigInt), hence Number().
 */
export function resolveLineTheme(row: any): { s: string; n: string } {
  if (row.theme) {
    return { s: row.theme, n: row.themeName || row.theme };
  }
  if (row.entitledUserId === null || row.entitledUserId === undefined) {
    return { s: '', n: '' };
  }
  if (row.ovMode === 'standard') {
    return { s: '', n: '' };
  }
  if (row.ovMode === 'custom' && row.ovSlug && Number(row.ovHasTheme) === 1) {
    return { s: `${row.ovSlug}-${Number(row.ovVersion)}`, n: row.ovName || '' };
  }
  if (row.dfSlug && Number(row.dfHasTheme) === 1) {
    return { s: `${row.dfSlug}-${Number(row.dfVersion)}`, n: row.dfName || '' };
  }
  return { s: '', n: '' };
}

export default AppTheme;
