import { I18n } from 'i18n';
import fs from 'fs';
import path from 'path';

class Translation {
  private i18n: I18n;

  constructor() {
    this.i18n = new I18n({
      locales: ['en', 'nl'],
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

  // Method to get all translations for a specific locale that start with a given prefix
  public getTranslationsByPrefix(
    locale: string,
    prefix: string
  ): Record<string, string> | null {
    const translationsPath = path.join(
      `${process.env['APP_ROOT']}/locales`,
      `${locale}.json`
    );

    if (!fs.existsSync(translationsPath)) {
      throw new Error(`Locale file for ${locale} not found.`);
    }

    const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf-8'));
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
  }
}

export default Translation;
