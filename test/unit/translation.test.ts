import { describe, it, expect, vi, beforeEach } from 'vitest';

// translateEmptyFields uses Prisma + ChatGPT: both mocked (no DB / OpenAI).
const { prismaMock, translateTextMock } = vi.hoisted(() => {
  const delegate = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  });
  return {
    prismaMock: {
      playlist: delegate(),
      genre: delegate(),
      trustPilot: delegate(),
      companyList: delegate(),
      blog: delegate(),
      eventBase: delegate(),
    },
    translateTextMock: vi.fn(),
  };
});

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class {
    translateText = translateTextMock;
  },
}));

import Translation from '../../src/translation';

const translation = new Translation();

describe('locale metadata', () => {
  it('exposes all 12 supported locales', () => {
    expect(Translation.ALL_LOCALES).toEqual([
      'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'jp', 'cn', 'sv', 'no',
    ]);
    expect(translation.allLocales).toEqual(Translation.ALL_LOCALES);
  });

  it('maps locale codes to language names with English fallback', () => {
    expect(translation.getLanguageName('nl')).toBe('Dutch');
    expect(translation.getLanguageName('jp')).toBe('Japanese');
    expect(translation.getLanguageName('xx')).toBe('English');
  });

  it('maps locale codes to greetings with Hello fallback', () => {
    expect(translation.getGreeting('fr')).toBe('Bonjour');
    expect(translation.getGreeting('cn')).toBe('你好');
    expect(translation.getGreeting('xx')).toBe('Hello');
  });

  it('maps locale codes to Apple Music storefronts (sv -> se, en -> us, fallback nl)', () => {
    expect(translation.getStorefront('sv')).toBe('se');
    expect(translation.getStorefront('en')).toBe('us');
    expect(translation.getStorefront('xx')).toBe('nl');
  });

  it('validates locales against the supported list', () => {
    expect(translation.isValidLocale('de')).toBe(true);
    expect(translation.isValidLocale('zz')).toBe(false);
    expect(translation.isValidLocale('')).toBe(false);
  });
});

describe('translate', () => {
  it('returns the translation for an existing key and locale', () => {
    expect(translation.translate('product_type.digital', 'en')).toBe(
      'Digital PDF'
    );
  });

  it('uses the default locale when none is given', () => {
    expect(translation.translate('product_type.digital')).toBe('Digital PDF');
  });

  it('interpolates mustache placeholders', () => {
    expect(
      translation.translate('mail.mailSubject', 'en', { orderId: 'QR-42' })
    ).toBe('We have received order QR-42!');
  });
});

describe('getTranslationsByPrefix', () => {
  it('returns keys under the prefix with the prefix stripped', async () => {
    const result = await translation.getTranslationsByPrefix(
      'en',
      'product_type'
    );
    expect(result).toMatchObject({
      digital: 'Digital PDF',
      sheets: 'Print Sheets',
      physical: 'Physical Cards',
    });
  });

  it('serves repeated lookups from the in-memory cache (same object)', async () => {
    const first = await translation.getTranslationsByPrefix(
      'en',
      'product_type'
    );
    const second = await translation.getTranslationsByPrefix(
      'en',
      'product_type'
    );
    expect(second).toBe(first);
  });

  it('returns null for a prefix with no matches (also when cached)', async () => {
    expect(
      await translation.getTranslationsByPrefix('en', 'no_such_prefix_xyz')
    ).toBeNull();
    expect(
      await translation.getTranslationsByPrefix('en', 'no_such_prefix_xyz')
    ).toBeNull();
  });

  it('throws when the locale file does not exist', async () => {
    await expect(
      translation.getTranslationsByPrefix('zz', 'product_type')
    ).rejects.toThrow('Locale file for zz not found.');
  });
});

describe('translateEmptyFields', () => {
  beforeEach(() => {
    for (const d of Object.values(prismaMock)) {
      d.findMany.mockReset().mockResolvedValue([]);
      d.update.mockReset().mockResolvedValue({});
    }
    translateTextMock.mockReset();
  });

  it('translates empty target fields from the _en source via ChatGPT', async () => {
    prismaMock.playlist.findMany.mockResolvedValue([
      { id: 1, description_en: 'Hello world' },
      { id: 2, description_en: '' }, // falsy source -> skipped
    ]);
    translateTextMock.mockResolvedValue({ de: 'Hallo Welt' });

    await translation.translateEmptyFields('de');

    expect(translateTextMock).toHaveBeenCalledWith('Hello world', ['de']);
    expect(prismaMock.playlist.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.playlist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { description_de: 'Hallo Welt' },
    });
    // findMany was called with the null-OR where clause first
    expect(prismaMock.playlist.findMany).toHaveBeenCalledWith({
      where: {
        description_en: { not: '' },
        OR: [{ description_de: '' }, { description_de: null }],
      },
      select: { id: true, description_en: true },
    });
  });

  it('falls back to the non-OR query when the first findMany rejects', async () => {
    prismaMock.genre.findMany
      .mockRejectedValueOnce(new Error('Unknown column'))
      .mockResolvedValueOnce([{ id: 7, name_en: 'Rock' }]);
    translateTextMock.mockResolvedValue({ nl: 'Rock-NL' });

    await translation.translateEmptyFields('nl');

    expect(prismaMock.genre.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.genre.findMany).toHaveBeenLastCalledWith({
      where: { name_en: { not: '' }, name_nl: '' },
      select: { id: true, name_en: true },
    });
    expect(prismaMock.genre.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { name_nl: 'Rock-NL' },
    });
  });

  it('continues after a per-record translation error and skips empty results', async () => {
    prismaMock.blog.findMany.mockImplementation(async (args: any) =>
      args?.where?.title_en
        ? [
            { id: 1, title_en: 'First' },
            { id: 2, title_en: 'Second' },
            { id: 3, title_en: 'Third' },
          ]
        : []
    );
    translateTextMock
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({}) // no translation for locale -> no update
      .mockResolvedValueOnce({ fr: 'Troisième' });

    await translation.translateEmptyFields('fr');

    expect(prismaMock.blog.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.blog.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { title_fr: 'Troisième' },
    });
  });
});

describe('business locales', () => {
  it('resolves the locales we produce business documents in', () => {
    expect(translation.resolveBusinessLocale('nl')).toBe('nl');
    expect(translation.resolveBusinessLocale('de')).toBe('de');
    expect(translation.resolveBusinessLocale('en')).toBe('en');
  });

  it('falls back to English for null, empty and non-business locales', () => {
    // A company row that predates the field, or one set to a language we
    // support in the app but do not write quotations in.
    expect(translation.resolveBusinessLocale(null)).toBe('en');
    expect(translation.resolveBusinessLocale(undefined)).toBe('en');
    expect(translation.resolveBusinessLocale('')).toBe('en');
    expect(translation.resolveBusinessLocale('fr')).toBe('en');
    expect(translation.resolveBusinessLocale('jp')).toBe('en');
    expect(translation.resolveBusinessLocale('nonsense')).toBe('en');
  });

  it('normalises case and surrounding whitespace', () => {
    expect(translation.resolveBusinessLocale(' DE ')).toBe('de');
  });

  it('maps business locales to their Intl tag', () => {
    expect(translation.getIntlTag('nl')).toBe('nl-NL');
    expect(translation.getIntlTag('de')).toBe('de-DE');
    expect(translation.getIntlTag('en')).toBe('en-GB');
    expect(translation.getIntlTag('fr')).toBe('en-GB');
  });

  it('loads a prefixed slice of the business bundle with the prefix stripped', async () => {
    const t = await translation.getBusinessTranslations('de', 'quotation');
    expect(t['title']).toBe('Angebot');
    expect(t['validUntil']).toBe('Gültig bis');
    // Keys from other prefixes must not leak in.
    expect(t['boxPdf']).toBeUndefined();
    expect(Object.keys(t).some((k) => k.startsWith('quotation.'))).toBe(false);
  });

  const PREFIXES = ['quotation', 'instructions', 'invoice_lines', 'pricing'];

  it.each(PREFIXES)(
    'keeps German formal in the %s bundle: no informal du/dein',
    async (prefix) => {
      // The main app bundle is deliberately informal; business documents must
      // never inherit that tone.
      const all = await translation.getBusinessTranslations('de', prefix);
      const informal = Object.entries(all).filter(([, v]) =>
        /\b(du|dich|dir|dein|deine|deinem|deiner)\b/i.test(v)
      );
      expect(informal).toEqual([]);
    }
  );

  it.each(PREFIXES)(
    'has every %s key in all three business bundles',
    async (prefix) => {
      // Guards against a half-translated bundle rendering "undefined" into a PDF.
      const en = await translation.getBusinessTranslations('en', prefix);
      expect(Object.keys(en).length).toBeGreaterThan(0);
      for (const locale of ['nl', 'de']) {
        const bundle = await translation.getBusinessTranslations(locale, prefix);
        for (const key of Object.keys(en)) {
          expect(bundle[key], `${locale} missing ${prefix}.${key}`).toBeTruthy();
        }
      }
    }
  );

  it('never leaves a {{placeholder}} undeclared in a translated string', async () => {
    // A placeholder present in a translation but not in the English source
    // would silently render as literal {{...}} in a customer PDF.
    for (const prefix of PREFIXES) {
      const en = await translation.getBusinessTranslations('en', prefix);
      for (const locale of ['nl', 'de']) {
        const bundle = await translation.getBusinessTranslations(locale, prefix);
        for (const [key, value] of Object.entries(bundle)) {
          const vars = (value.match(/\{\{\s*\w+\s*\}\}/g) || []).sort();
          const enVars = ((en[key] || '').match(/\{\{\s*\w+\s*\}\}/g) || []).sort();
          expect(vars, `${locale} ${prefix}.${key}`).toEqual(enVars);
        }
      }
    }
  });

  it('returns a translator that interpolates placeholders', async () => {
    const t = await translation.getBusinessTranslator('de', 'quotation');
    expect(t('discount', { percent: 10 })).toBe('Rabatt (10 %)');
    expect(t('validUntil')).toBe('Gültig bis');
  });

  it('renders an unknown key as the key itself rather than undefined', async () => {
    const t = await translation.getBusinessTranslator('nl', 'quotation');
    expect(t('doesNotExist')).toBe('doesNotExist');
  });

  it('leaves placeholders alone when no value is supplied', () => {
    expect(Translation.interpolate('Total {{a}} of {{b}}', { a: '1' })).toBe(
      'Total 1 of {{b}}'
    );
    expect(Translation.interpolate('No vars here')).toBe('No vars here');
  });

  it('serves an empty bundle instead of throwing when the locale file is unreadable', async () => {
    const t = await translation.getBusinessTranslations('en', 'no_such_prefix');
    expect(t).toEqual({});
  });
});
