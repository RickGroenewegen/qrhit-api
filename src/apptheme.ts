import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Utils from './utils';
import cluster from 'cluster';

class AppTheme {
  private static instance: AppTheme;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private appThemes: Map<number, { s: string; n: string }> = new Map();
  private appThemesInitialized: boolean = false;

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
  }

  public static getInstance(): AppTheme {
    if (!AppTheme.instance) {
      AppTheme.instance = new AppTheme();
    }
    return AppTheme.instance;
  }

  /**
   * Load all app themes from payment_has_playlist into memory
   * This runs on API startup to avoid database queries on every request
   */
  public async loadAppThemes(shouldLog: boolean = false): Promise<void> {
    try {
      const themes: any[] = await this.prisma.$queryRaw`
        SELECT id, theme, themeName
        FROM payment_has_playlist
        WHERE theme IS NOT NULL AND theme != ''
      `;

      this.appThemes.clear();

      for (const themeRow of themes) {
        this.appThemes.set(themeRow.id, {
          s: themeRow.theme,
          n: themeRow.themeName || themeRow.theme,
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
   * Get theme for a given payment_has_playlist ID
   * Returns null if no theme is configured
   */
  public getTheme(phpId: number): { s: string; n: string } | null {
    if (!this.appThemesInitialized) {
      console.warn('App themes not yet initialized, returning null');
      return null;
    }

    console.log(111, this.appThemes);
    console.log(222,  phpId)

    return this.appThemes.get(phpId) || null;
  }

  /**
   * Check if themes are initialized
   */
  public isInitialized(): boolean {
    return this.appThemesInitialized;
  }

  /**
   * Reload themes (useful for adding new themes without restarting API)
   */
  public async reload(): Promise<void> {
    this.appThemesInitialized = false;
    await this.loadAppThemes();
  }

  /**
   * Get all themes (for debugging)
   */
  public getAllThemes(): Map<number, { s: string; n: string }> {
    return new Map(this.appThemes);
  }
}

export default AppTheme;
