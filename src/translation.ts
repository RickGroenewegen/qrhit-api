import { I18n } from 'i18n';
import { promises as fs } from 'fs';
import path from 'path';
import PrismaInstance from './prisma';
import { ChatGPT } from './chatgpt';
import Logger from './logger';
import { color, white } from 'console-log-colors';

interface LocaleInfo {
  code: string;
  name: string;
  greeting: string;
  storefront: string; // Apple Music storefront code
}

const LOCALE_DATA: LocaleInfo[] = [
  { code: 'en', name: 'English', greeting: 'Hello', storefront: 'us' },
  { code: 'nl', name: 'Dutch', greeting: 'Hallo', storefront: 'nl' },
  { code: 'de', name: 'German', greeting: 'Hallo', storefront: 'de' },
  { code: 'fr', name: 'French', greeting: 'Bonjour', storefront: 'fr' },
  { code: 'es', name: 'Spanish', greeting: 'Hola', storefront: 'es' },
  { code: 'it', name: 'Italian', greeting: 'Ciao', storefront: 'it' },
  { code: 'pt', name: 'Portuguese', greeting: 'Olá', storefront: 'pt' },
  { code: 'pl', name: 'Polish', greeting: 'Cześć', storefront: 'pl' },
  { code: 'jp', name: 'Japanese', greeting: 'こんにちは', storefront: 'jp' },
  { code: 'cn', name: 'Chinese', greeting: '你好', storefront: 'cn' },
  { code: 'sv', name: 'Swedish', greeting: 'Hej', storefront: 'se' },
  { code: 'no', name: 'Norwegian', greeting: 'Hei', storefront: 'no' },
];

class Translation {
  private i18n: I18n;
  private memoryCache: Map<string, Record<string, string>> = new Map();
  public static readonly ALL_LOCALES: string[] = LOCALE_DATA.map(l => l.code);
  public allLocales: string[] = Translation.ALL_LOCALES;

  // Maps derived from LOCALE_DATA
  public static readonly LOCALE_NAMES: Record<string, string> = Object.fromEntries(
    LOCALE_DATA.map(l => [l.code, l.name])
  );
  public static readonly LOCALE_GREETINGS: Record<string, string> = Object.fromEntries(
    LOCALE_DATA.map(l => [l.code, l.greeting])
  );
  public static readonly LOCALE_STOREFRONTS: Record<string, string> = Object.fromEntries(
    LOCALE_DATA.map(l => [l.code, l.storefront])
  );

  constructor() {
    this.i18n = new I18n({
      locales: Translation.ALL_LOCALES,
      directory: `${process.env['APP_ROOT']}/locales`,
    });
  }

  public getLanguageName(locale: string): string {
    return Translation.LOCALE_NAMES[locale] || 'English';
  }

  public getGreeting(locale: string): string {
    return Translation.LOCALE_GREETINGS[locale] || 'Hello';
  }

  public getStorefront(locale: string): string {
    return Translation.LOCALE_STOREFRONTS[locale] || 'nl';
  }

  // Method to retrieve a specific translation with interpolation options
  public translate(
    key: string,
    locale?: string,
    options?: Record<string, any>
  ): string {
    return this.i18n.__(
      { phrase: key, locale: locale || this.i18n.getLocale() },
      options || {}
    );
  }

  public isValidLocale(locale: string): boolean {
    return this.allLocales.includes(locale);
  }

  // Method to get all translations for a specific locale that start with a given prefix
  public async getTranslationsByPrefix(
    locale: string,
    prefix: string
  ): Promise<Record<string, string> | null> {
    // Create a cache key for this specific locale and prefix combination
    const cacheKey = `${locale}:${prefix}`;

    // Try to get from in-memory cache first
    const cachedData = this.memoryCache.get(cacheKey);
    if (cachedData) {
      return Object.keys(cachedData).length > 0 ? cachedData : null;
    }

    // If not in cache, read from file
    const translationsPath = path.join(
      `${process.env['APP_ROOT']}/locales`,
      `${locale}.json`
    );

    try {
      await fs.access(translationsPath);
      const data = await fs.readFile(translationsPath, 'utf-8');
      const translations = JSON.parse(data);
      const filteredTranslations: Record<string, string> = {};

      for (const key in translations) {
        if (key.startsWith(prefix)) {
          const newKey = key.slice(prefix.length + 1);
          filteredTranslations[newKey] = translations[key];
        }
      }

      // Store in memory cache
      this.memoryCache.set(cacheKey, filteredTranslations);

      return Object.keys(filteredTranslations).length > 0
        ? filteredTranslations
        : null;
    } catch {
      throw new Error(`Locale file for ${locale} not found.`);
    }
  }

  /**
   * Translate all empty language-specific fields in the database for a given locale.
   * Uses ChatGPT to translate from the English (_en) source field.
   * Progress is logged to stdout.
   */
  public async translateEmptyFields(locale: string): Promise<void> {
    const prisma = PrismaInstance.getInstance();
    const chatgpt = new ChatGPT();
    const logger = new Logger();
    const targetLang = this.getLanguageName(locale);

    let totalUpdated = 0;

    const modelConfigs: Array<{
      model: string;
      delegate: any;
      fields: string[];
    }> = [
      { model: 'Playlist', delegate: prisma.playlist, fields: ['description'] },
      { model: 'genre', delegate: prisma.genre, fields: ['name'] },
      { model: 'TrustPilot', delegate: prisma.trustPilot, fields: ['title', 'message'] },
      { model: 'CompanyList', delegate: prisma.companyList, fields: ['description'] },
      { model: 'Blog', delegate: prisma.blog, fields: ['title', 'content', 'summary'] },
      { model: 'EventBase', delegate: prisma.eventBase, fields: ['name', 'description', 'body'] },
    ];

    const tag = white.bold('[translate-fields]');

    logger.log(color.blue.bold(`${tag} Starting translation to ${white.bold(targetLang)} (${white.bold(locale)})...`));

    for (const config of modelConfigs) {
      for (const field of config.fields) {
        const enField = `${field}_en`;
        const targetField = `${field}_${locale}`;

        const records = await config.delegate.findMany({
          where: {
            [enField]: { not: '' },
            OR: [
              { [targetField]: '' },
              { [targetField]: null },
            ],
          },
          select: { id: true, [enField]: true },
        }).catch(() =>
          config.delegate.findMany({
            where: {
              [enField]: { not: '' },
              [targetField]: '',
            },
            select: { id: true, [enField]: true },
          })
        );

        if (records.length === 0) {
          logger.log(color.gray(`${tag} ${white.bold(config.model + '.' + targetField)}: no empty fields, skipping`));
          continue;
        }

        logger.log(color.blue.bold(`${tag} ${white.bold(config.model + '.' + targetField)}: translating ${white.bold(String(records.length))} records`));

        for (const record of records) {
          const enValue = record[enField];
          if (!enValue) continue;

          try {
            const translations = await chatgpt.translateText(enValue, [locale]);
            const translated = translations[locale];

            if (translated) {
              await config.delegate.update({
                where: { id: record.id },
                data: { [targetField]: translated },
              });

              const preview = translated.length > 80 ? translated.substring(0, 80) + '...' : translated;
              logger.log(color.blue.bold(`${tag} Updated ${white.bold(config.model + '.' + targetField)} (id=${white.bold(String(record.id))}) to '${white.bold(preview)}' for language '${white.bold(targetLang)}'`));
              totalUpdated++;
            }
          } catch (err: any) {
            logger.log(color.red.bold(`${tag} ERROR translating ${white.bold(config.model + '.' + targetField)} (id=${white.bold(String(record.id))}): ${white.bold(err.message)}`));
          }
        }
      }
    }

    logger.log(color.blue.bold(`${tag} Done. Updated ${white.bold(String(totalUpdated))} fields for ${white.bold(targetLang)}.`));

    // EventBase names/descriptions feed the public occasion pages — bust their cache.
    try {
      const cache = (await import('./cache')).default.getInstance();
      await cache.delPattern('occasion_v1_*');
      await cache.delPattern('occasions_list_v1_*');
    } catch {
      // Non-fatal: caches expire on their own TTL.
    }
  }
}

export default Translation;
