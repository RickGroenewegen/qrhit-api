import { describe, it, expect, vi, beforeEach } from 'vitest';

// translateEmptyFields uses Prisma, ChatGPT and the playlist cache: all
// mocked (no DB / OpenAI / Redis).
const {
  prismaMock,
  translateTextMock,
  translateGenreNamesMock,
  translateSeoDescriptionMock,
  translateLiterallyMock,
  clearPlaylistCacheMock,
} = vi.hoisted(() => {
  const delegate = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  });
  return {
    prismaMock: {
      playlist: delegate(),
      genre: delegate(),
      companyList: delegate(),
      blog: delegate(),
      eventBase: delegate(),
    },
    translateTextMock: vi.fn(),
    translateGenreNamesMock: vi.fn(),
    translateSeoDescriptionMock: vi.fn(),
    translateLiterallyMock: vi.fn(),
    clearPlaylistCacheMock: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class {
    translateText = translateTextMock;
    translateGenreNames = translateGenreNamesMock;
    translateSeoDescription = translateSeoDescriptionMock;
    translateLiterally = translateLiterallyMock;
  },
}));
vi.mock('../../src/data', () => ({
  default: { getInstance: () => ({ clearPlaylistCache: clearPlaylistCacheMock }) },
}));

import Translation from '../../src/translation';

const translation = new Translation();

describe('locale metadata', () => {
  it('exposes all 14 supported locales', () => {
    expect(Translation.ALL_LOCALES).toEqual([
      'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'jp', 'cn', 'sv', 'no', 'da', 'hu',
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
    translateGenreNamesMock.mockReset();
    translateSeoDescriptionMock.mockReset();
    translateLiterallyMock.mockReset();
    clearPlaylistCacheMock.mockClear();
  });

  const playlistRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    playlistId: 'p1',
    name: '80s Hits',
    description_en: 'Hello world',
    description_da: null,
    description_hu: '',
    promotionalDescription: null,
    preserveDescription: false,
    seoDescriptionGenerated: false,
    ...overrides,
  });

  it('asks for every row missing any of the locales, with null and empty both counting', async () => {
    await translation.translateEmptyFields(['da', 'hu']);

    expect(prismaMock.playlist.findMany).toHaveBeenCalledWith({
      where: {
        description_en: { not: '' },
        OR: [
          { description_da: '' },
          { description_da: null },
          { description_hu: '' },
          { description_hu: null },
        ],
      },
      select: expect.objectContaining({
        id: true,
        description_en: true,
        description_da: true,
        description_hu: true,
        preserveDescription: true,
        seoDescriptionGenerated: true,
      }),
    });
  });

  it('translates a row into all of its missing locales in one call', async () => {
    prismaMock.companyList.findMany.mockResolvedValue([
      { id: 4, description_en: 'Vote now', description_da: '', description_hu: 'Szavazz' },
    ]);
    translateTextMock.mockResolvedValue({ da: 'Stem nu' });

    await translation.translateEmptyFields(['da', 'hu']);

    // hu already has a text, so only da is asked for.
    expect(translateTextMock).toHaveBeenCalledWith('Vote now', ['da']);
    expect(prismaMock.companyList.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { description_da: 'Stem nu' },
    });
  });

  it('translates a plain playlist description with translateText and replaces the competitor name', async () => {
    prismaMock.playlist.findMany.mockResolvedValue([
      playlistRow({ description_en: 'Better than Hitster' }),
    ]);
    translateTextMock.mockResolvedValue({ da: 'Bedre end Hitster', hu: 'Jobb mint a Hitster' });

    await translation.translateEmptyFields(['da', 'hu']);

    expect(translateTextMock).toHaveBeenCalledWith('Better than QRSong!', ['da', 'hu']);
    expect(prismaMock.playlist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        description_da: 'Bedre end QRSong!',
        description_hu: 'Jobb mint a QRSong!',
        markedForMerchantCenter: true,
      },
    });
    expect(clearPlaylistCacheMock).toHaveBeenCalledWith('p1');
  });

  it('translates an SEO-written playlist description with the SEO translator', async () => {
    prismaMock.playlist.findMany.mockResolvedValue([
      playlistRow({ seoDescriptionGenerated: true }),
    ]);
    translateSeoDescriptionMock.mockResolvedValue({ da: 'Hej verden', hu: 'Szia világ' });

    await translation.translateEmptyFields(['da', 'hu']);

    expect(translateSeoDescriptionMock).toHaveBeenCalledWith('Hello world', '80s Hits', ['da', 'hu']);
    expect(translateTextMock).not.toHaveBeenCalled();
    expect(prismaMock.playlist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { description_da: 'Hej verden', description_hu: 'Szia világ', markedForMerchantCenter: true },
    });
  });

  it('translates a kept description word for word from the customer text, keeping the original in its own language', async () => {
    prismaMock.playlist.findMany.mockResolvedValue([
      playlistRow({
        preserveDescription: true,
        description_en: 'My dad loves these',
        promotionalDescription: 'Min far elsker dem',
      }),
    ]);
    translateLiterallyMock.mockResolvedValue({
      sourceLocale: 'da',
      translations: { da: 'reworded', hu: 'Apám imádja őket' },
    });

    await translation.translateEmptyFields(['da', 'hu']);

    expect(translateLiterallyMock).toHaveBeenCalledWith('Min far elsker dem', '80s Hits', ['da', 'hu']);
    expect(prismaMock.playlist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        description_da: 'Min far elsker dem',
        description_hu: 'Apám imádja őket',
        markedForMerchantCenter: true,
      },
    });
  });

  it('translates genre names with the genre translator, falling back to the non-null query', async () => {
    prismaMock.genre.findMany
      .mockRejectedValueOnce(new Error('Argument name_da must not be null'))
      .mockResolvedValueOnce([{ id: 7, name_en: 'Rock', name_da: '', name_hu: '' }]);
    translateGenreNamesMock.mockResolvedValue({ da: 'Rock', hu: 'Rock' });

    await translation.translateEmptyFields(['da', 'hu']);

    expect(prismaMock.genre.findMany).toHaveBeenLastCalledWith({
      where: { name_en: { not: '' }, OR: [{ name_da: '' }, { name_hu: '' }] },
      select: { id: true, name_en: true, name_da: true, name_hu: true },
    });
    expect(translateGenreNamesMock).toHaveBeenCalledWith('Rock', ['da', 'hu']);
    expect(prismaMock.genre.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { name_da: 'Rock', name_hu: 'Rock' },
    });
  });

  it('skips a field it cannot read and carries on with the next', async () => {
    prismaMock.genre.findMany.mockRejectedValue(new Error('Unknown column name_da'));
    prismaMock.eventBase.findMany.mockImplementation(async (args: any) =>
      args?.where?.name_en ? [{ id: 9, name_en: 'Christmas', name_da: '' }] : []
    );
    translateTextMock.mockResolvedValue({ da: 'Jul' });

    await translation.translateEmptyFields(['da']);

    expect(prismaMock.eventBase.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { name_da: 'Jul' },
    });
  });

  it('continues after a per-record translation error and skips empty results', async () => {
    prismaMock.eventBase.findMany.mockImplementation(async (args: any) =>
      args?.where?.name_en
        ? [
            { id: 1, name_en: 'First', name_fr: '' },
            { id: 2, name_en: 'Second', name_fr: '' },
            { id: 3, name_en: 'Third', name_fr: '' },
          ]
        : []
    );
    translateTextMock
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({}) // no translation for locale -> no update
      .mockResolvedValueOnce({ fr: 'Troisième' });

    await translation.translateEmptyFields(['fr']);

    expect(prismaMock.eventBase.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.eventBase.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { name_fr: 'Troisième' },
    });
  });

  it('never reads the unread blogs table', async () => {
    await translation.translateEmptyFields(['da']);
    expect(prismaMock.blog.findMany).not.toHaveBeenCalled();
  });

  it('does nothing for English or an unknown locale', async () => {
    await translation.translateEmptyFields(['en', 'xx']);
    for (const d of Object.values(prismaMock)) {
      expect(d.findMany).not.toHaveBeenCalled();
    }
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
