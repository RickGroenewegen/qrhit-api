import { I18n } from 'i18n';

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
    console.log(444, options);

    return this.i18n.__(
      { phrase: key, locale: locale || this.i18n.getLocale() },
      options || {}
    );
  }
}

export default Translation;
