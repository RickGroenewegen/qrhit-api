import { I18n } from 'i18n';
import { promises as fs } from 'fs';
import path from 'path';
import PrismaInstance from './prisma';
import { ChatGPT } from './chatgpt';
import Logger from './logger';
import { sanitizeBrandName } from './brandName';
import { SITE_LOCALES } from './data/shared/shared-data.generated';
import { color, white } from 'console-log-colors';

interface LocaleInfo {
  code: string;
  name: string;
  greeting: string;
  storefront: string; // Apple Music storefront code
}

// The languages qrsong.io is served in, from src/data/shared/locales.json.
const LOCALE_DATA: LocaleInfo[] = SITE_LOCALES.map((l) => ({
  code: l.code,
  name: l.name,
  greeting: l.greeting ?? 'Hello',
  storefront: l.storefront ?? 'nl',
}));

/**
 * Locales we produce formal B2B documents in (quotations, technical
 * instructions, MoneyBird invoices). Deliberately smaller than LOCALE_DATA:
 * these documents are commercial correspondence that has to read correctly in
 * formal register, so every other company locale falls back to English.
 */
export const BUSINESS_LOCALES = ['nl', 'de', 'en'] as const;
export type BusinessLocale = (typeof BUSINESS_LOCALES)[number];

/**
 * BCP47 tags used for Intl date/number formatting in those documents. These
 * carry the country conventions for free — de-DE puts the euro sign after the
 * amount (1.234,56 €) and formats dates as 1. September 2026, where nl-NL puts
 * it in front (€ 1.234,56).
 */
const BUSINESS_INTL_TAGS: Record<BusinessLocale, string> = {
  nl: 'nl-NL',
  de: 'de-DE',
  en: 'en-GB',
};

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
   * Narrow any company locale down to one we actually produce business
   * documents in. Null, unknown and unsupported locales all become English —
   * this is the single fallback point, so callers never have to guess.
   */
  public resolveBusinessLocale(locale?: string | null): BusinessLocale {
    const code = (locale || '').trim().toLowerCase();
    return (BUSINESS_LOCALES as readonly string[]).includes(code)
      ? (code as BusinessLocale)
      : 'en';
  }

  /** BCP47 tag for Intl formatters in business documents. */
  public getIntlTag(locale?: string | null): string {
    return BUSINESS_INTL_TAGS[this.resolveBusinessLocale(locale)];
  }

  /**
   * Same contract as getTranslationsByPrefix, but reads the formal B2B bundle
   * at locales/business/<locale>.json instead of the (informal) main bundle.
   * Missing keys fall back to English so a half-translated bundle never
   * renders "undefined" into a PDF.
   */
  public async getBusinessTranslations(
    locale: string,
    prefix: string
  ): Promise<Record<string, string>> {
    const resolved = this.resolveBusinessLocale(locale);
    const english = await this.readBusinessBundle('en', prefix);
    if (resolved === 'en') return english;
    return { ...english, ...(await this.readBusinessBundle(resolved, prefix)) };
  }

  /**
   * Returns a ready-to-use `t(key, vars)` for an EJS view. Templates read far
   * better as `t('validUntil')` than as raw dictionary lookups, and this keeps
   * the {{placeholder}} interpolation in one place. An unknown key renders as
   * the key itself, which is loud in a PDF but never crashes the render.
   */
  public async getBusinessTranslator(
    locale: string,
    prefix: string
  ): Promise<(key: string, vars?: Record<string, any>) => string> {
    const bundle = await this.getBusinessTranslations(locale, prefix);
    return (key: string, vars?: Record<string, any>) =>
      Translation.interpolate(bundle[key] ?? key, vars);
  }

  /** Replace {{name}} placeholders with values from `vars`. */
  public static interpolate(
    text: string,
    vars?: Record<string, any>
  ): string {
    if (!vars) return text;
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
      vars[name] != null ? String(vars[name]) : match
    );
  }

  private async readBusinessBundle(
    locale: BusinessLocale,
    prefix: string
  ): Promise<Record<string, string>> {
    const cacheKey = `business:${locale}:${prefix}`;
    const cached = this.memoryCache.get(cacheKey);
    if (cached) return cached;

    const bundlePath = path.join(
      `${process.env['APP_ROOT']}/locales/business`,
      `${locale}.json`
    );

    const filtered: Record<string, string> = {};
    try {
      const translations = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
      for (const key in translations) {
        if (key.startsWith(`${prefix}.`)) {
          filtered[key.slice(prefix.length + 1)] = translations[key];
        }
      }
    } catch {
      new Logger().log(
        color.red.bold('Business locale bundle missing or invalid: ') +
          white.bold(bundlePath)
      );
    }

    this.memoryCache.set(cacheKey, filtered);
    return filtered;
  }

  /**
   * Fill every empty language-specific database field for `locales` from its
   * English (_en) source: the backfill a new language needs (Admin › Bulk
   * actions › Translate Fields). It covers every `<field>_<locale>` column
   * that is still read: genre names, playlist descriptions, company list
   * descriptions, and occasion names, descriptions and bodies. The `blogs`
   * and `trustpilot` tables have such columns too, but nothing reads them
   * (the blog is markdown, reviews are a JSON file), and a new language does
   * not get them.
   *
   * Each row is translated by the translator that wrote its other languages,
   * in one call for all of its missing locales:
   * - genres: the genre-name translator of the nightly cron;
   * - playlists: the SEO translator for an SEO-written description, word for
   *   word for a kept one (preserveDescription), otherwise translateText; the
   *   row is then marked for Merchant Center and its product page cache,
   *   which never expires, is cleared;
   * - the rest: translateText.
   * A field that cannot be read (a column missing from the schema) or a row
   * the model fails on is logged, and the run moves on. Progress is logged
   * to stdout.
   */
  public async translateEmptyFields(locales: string[]): Promise<void> {
    const prisma = PrismaInstance.getInstance();
    const chatgpt = new ChatGPT();
    const logger = new Logger();
    const tag = white.bold('[translate-fields]');

    const targets = [...new Set(locales)].filter(
      (l) => l !== 'en' && this.isValidLocale(l)
    );
    if (targets.length === 0) return;
    const targetNames = targets.map((l) => this.getLanguageName(l)).join(', ');

    type FieldConfig = {
      model: string;
      delegate: any;
      field: string;
      // Columns the translator needs besides id and the field's own columns.
      extraSelect?: Record<string, true>;
      translate: (record: any, missing: string[]) => Promise<Record<string, string>>;
      // Written along with the translations.
      extraData?: Record<string, unknown>;
      afterUpdate?: (record: any) => Promise<void>;
    };

    const generic =
      (field: string) =>
      (record: any, missing: string[]): Promise<Record<string, string>> =>
        chatgpt.translateText(record[`${field}_en`], missing);

    const configs: FieldConfig[] = [
      {
        model: 'genre',
        delegate: prisma.genre,
        field: 'name',
        translate: (record, missing) => chatgpt.translateGenreNames(record.name_en, missing),
      },
      {
        model: 'Playlist',
        delegate: prisma.playlist,
        field: 'description',
        extraSelect: {
          playlistId: true,
          name: true,
          promotionalDescription: true,
          preserveDescription: true,
          seoDescriptionGenerated: true,
        },
        translate: (record, missing) =>
          this.translatePlaylistDescription(chatgpt, record, missing),
        extraData: { markedForMerchantCenter: true },
        afterUpdate: async (record) => {
          const Data = (await import('./data')).default;
          await Data.getInstance().clearPlaylistCache(record.playlistId);
        },
      },
      {
        model: 'CompanyList',
        delegate: prisma.companyList,
        field: 'description',
        translate: generic('description'),
      },
      ...['name', 'description', 'body'].map((field) => ({
        model: 'EventBase',
        delegate: prisma.eventBase,
        field,
        translate: generic(field),
      })),
    ];

    logger.log(color.blue.bold(`${tag} Starting translation to ${white.bold(targetNames)}...`));

    let totalUpdated = 0;

    for (const config of configs) {
      const { field } = config;
      const enField = `${field}_en`;
      const targetFields = targets.map((l) => `${field}_${l}`);
      const label = white.bold(`${config.model}.${field}`);
      const select = {
        id: true,
        [enField]: true,
        ...Object.fromEntries(targetFields.map((f) => [f, true])),
        ...config.extraSelect,
      };

      let records: any[];
      try {
        // A non-nullable column refuses `null` in a filter, so those are
        // asked again with empty strings only.
        records = await config.delegate
          .findMany({
            where: {
              [enField]: { not: '' },
              OR: targetFields.flatMap((f) => [{ [f]: '' }, { [f]: null }]),
            },
            select,
          })
          .catch(() =>
            config.delegate.findMany({
              where: {
                [enField]: { not: '' },
                OR: targetFields.map((f) => ({ [f]: '' })),
              },
              select,
            })
          );
      } catch (err: any) {
        logger.log(color.red.bold(`${tag} Cannot read ${label}, skipping: ${white.bold(err.message)}`));
        continue;
      }

      if (records.length === 0) {
        logger.log(color.gray(`${tag} ${label}: no empty fields, skipping`));
        continue;
      }

      logger.log(color.blue.bold(`${tag} ${label}: translating ${white.bold(String(records.length))} records`));

      for (const record of records) {
        const enValue = record[enField];
        const missing = targets.filter((l) => !String(record[`${field}_${l}`] ?? '').trim());
        if (!enValue || missing.length === 0) continue;

        try {
          const translations = await config.translate(record, missing);
          const data: Record<string, string> = {};
          for (const locale of missing) {
            const value = translations[locale]?.trim();
            if (value) data[`${field}_${locale}`] = value;
          }

          if (Object.keys(data).length === 0) {
            logger.log(color.yellow.bold(`${tag} No translation for ${label} (id=${white.bold(String(record.id))})`));
            continue;
          }

          await config.delegate.update({
            where: { id: record.id },
            data: { ...data, ...config.extraData },
          });
          await config.afterUpdate?.(record);

          const first = Object.values(data)[0];
          const preview = first.length > 80 ? first.substring(0, 80) + '...' : first;
          logger.log(color.blue.bold(`${tag} Updated ${label} (id=${white.bold(String(record.id))}) in ${white.bold(Object.keys(data).map((k) => k.slice(field.length + 1)).join(', '))}: '${white.bold(preview)}'`));
          totalUpdated += Object.keys(data).length;
        } catch (err: any) {
          logger.log(color.red.bold(`${tag} ERROR translating ${label} (id=${white.bold(String(record.id))}): ${white.bold(err.message)}`));
        }
      }
    }

    logger.log(color.blue.bold(`${tag} Done. Updated ${white.bold(String(totalUpdated))} fields for ${white.bold(targetNames)}.`));

    // EventBase names/descriptions feed the public occasion pages — bust their cache.
    try {
      const cache = (await import('./cache')).default.getInstance();
      await cache.delPattern('occasion_v1_*');
      await cache.delPattern('occasions_list_v1_*');
    } catch {
      // Non-fatal: caches expire on their own TTL.
    }
  }

  /**
   * A playlist description in `locales`, made the way its other languages
   * were (see SeoDescriptions.generateForPlaylist and
   * Promotional.translateDescription): the SEO translator for SEO copy, word
   * for word from the customer's own text for a kept description, and plain
   * translation for the rest. A kept description already written in one of
   * `locales` is stored as it stands.
   */
  private async translatePlaylistDescription(
    chatgpt: ChatGPT,
    playlist: {
      name: string;
      description_en: string;
      promotionalDescription: string | null;
      preserveDescription: boolean;
      seoDescriptionGenerated: boolean;
    },
    locales: string[]
  ): Promise<Record<string, string>> {
    if (playlist.preserveDescription) {
      const original = sanitizeBrandName(
        (playlist.promotionalDescription || playlist.description_en).trim()
      );
      const { sourceLocale, translations } = await chatgpt.translateLiterally(
        original,
        playlist.name,
        locales
      );
      return Object.fromEntries(
        locales
          .map((l) => [l, l === sourceLocale ? original : sanitizeBrandName(translations[l] || '')])
          .filter(([, value]) => value)
      );
    }

    if (playlist.seoDescriptionGenerated) {
      return chatgpt.translateSeoDescription(playlist.description_en, playlist.name, locales);
    }

    const translations = await chatgpt.translateText(
      sanitizeBrandName(playlist.description_en),
      locales
    );
    return Object.fromEntries(
      Object.entries(translations).map(([l, value]) => [l, sanitizeBrandName(value)])
    );
  }
}

export default Translation;
