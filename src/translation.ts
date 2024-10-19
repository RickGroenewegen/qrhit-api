import { I18n } from 'i18n';
import { promises as fs } from 'fs';
import path from 'path';

class Translation {
  private i18n: I18n;
  private allLocales: string[] = [
    'en',
    'nl',
    'de',
    'fr',
    'es',
    'it',
    'pt',
    'pl',
    'hin',
  ];
  constructor() {
    this.i18n = new I18n({
      locales: this.allLocales,
      directory: `${process.env['APP_ROOT']}/locales`,
    });
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

      return Object.keys(filteredTranslations).length > 0
        ? filteredTranslations
        : null;
    } catch {
      throw new Error(`Locale file for ${locale} not found.`);
    }
  }
}

export default Translation;
