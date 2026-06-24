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
