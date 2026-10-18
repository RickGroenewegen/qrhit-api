import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import ejs from 'ejs';
import jsQR from 'jsqr';
import sharp from 'sharp';
import {
  BROCHURE_LAYOUT,
  buildDefaultPlaylistsView,
  DefaultPlaylistError,
  DefaultPlaylistRow,
  defaultPlaylistsFileName,
  defaultPlaylistsViewQuery,
  getDefaultPlaylistsTranslator,
  parseDefaultPlaylistIds,
  parseDefaultPlaylistsBody,
  qrSvg,
} from '../../src/defaultPlaylists';
import Translation from '../../src/translation';

/**
 * The default playlists (src/defaultPlaylists.ts): the strict PUT body
 * parser, the id list of the brochure, and the brochure itself built from
 * the proof fixture (30 themes x 3 sizes) without a database.
 */

const FIXTURE: DefaultPlaylistRow[] = JSON.parse(
  readFileSync(path.join(__dirname, '../../scripts/default-playlists/fixture.json'), 'utf8')
);
const VIEW = path.join(__dirname, '../../src/views/default_playlists.ejs');
const translation = new Translation();
const NOW = new Date('2026-10-16T10:00:00Z');

/** A valid PUT row; override what a test is about. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    themeKey: '80s-hits',
    cardCount: 48,
    category: 'decades',
    name: { en: '80s Hits', nl: 'Hits uit de jaren 80', de: 'Hits der 80er' },
    description: { en: 'Big hair.', nl: null, de: 'Große Frisuren.' },
    spotifyPlaylistId: 'AbCdEfGhIjKlMnOpQrStUv',
    trackCount: 48,
    yearFrom: 1980,
    yearTo: 1989,
    decades: [{ decade: 1980, count: 48 }],
    artists: ['Queen', 'ABBA'],
    sortOrder: 30,
    ...overrides,
  };
}

const parseError = (body: unknown): string => {
  try {
    parseDefaultPlaylistsBody(body, NOW);
  } catch (error) {
    expect(error).toBeInstanceOf(DefaultPlaylistError);
    return (error as Error).message;
  }
  throw new Error('expected the body to be refused');
};

async function view(rows: DefaultPlaylistRow[], locale = 'en') {
  return buildDefaultPlaylistsView(rows, {
    locale,
    t: await getDefaultPlaylistsTranslator(translation, locale),
    intlTag: translation.getIntlTag(locale),
    baseUrl: 'http://api.test',
    now: NOW,
  });
}

describe('parseDefaultPlaylistsBody', () => {
  it('accepts the whole fixture as GET returns it (id, spotifyUrl and updatedAt are ignored)', () => {
    const rows = parseDefaultPlaylistsBody({ playlists: FIXTURE }, NOW);
    expect(rows).toHaveLength(90);
    expect(rows[0]).not.toHaveProperty('id');
    expect(rows[0]).not.toHaveProperty('spotifyUrl');
    expect(rows[0].name.nl).toBe('Hits uit de jaren 60');
  });

  it('trims, defaults sortOrder to 0 and empty descriptions to null', () => {
    const [parsed] = parseDefaultPlaylistsBody(
      {
        playlists: [
          row({
            name: { en: '  80s Hits ', nl: 'Jaren 80', de: '80er' },
            description: { en: '  ', de: 'Text' },
            sortOrder: undefined,
          }),
        ],
      },
      NOW
    );
    expect(parsed.name.en).toBe('80s Hits');
    expect(parsed.description).toEqual({ en: null, nl: null, de: 'Text' });
    expect(parsed.sortOrder).toBe(0);
    const [noDescription] = parseDefaultPlaylistsBody({ playlists: [row({ description: undefined })] }, NOW);
    expect(noDescription.description).toEqual({ en: null, nl: null, de: null });
  });

  it('refuses a body that is not { playlists: [...] }, an empty list or more than 300 rows', () => {
    expect(parseError(null)).toBe('body must be { playlists: [...] }');
    expect(parseError([row()])).toBe('body must be { playlists: [...] }');
    expect(parseError({ playlists: [] })).toBe('playlists is empty');
    const many = Array.from({ length: 301 }, (_, i) => row({ themeKey: `theme-${i}` }));
    expect(parseError({ playlists: many })).toBe('at most 300 playlists per call');
  });

  it.each([
    [{ cardCount: 100 }, 'cardCount must be 48, 96, 192'],
    [{ cardCount: '48' }, 'cardCount must be 48, 96, 192'],
    [{ category: 'pop' }, 'category must be one of decades, genres, themes, local'],
    [{ themeKey: 'Rock Classics' }, 'themeKey must be lowercase words joined by dashes'],
    [{ themeKey: '-rock' }, 'themeKey must be lowercase words joined by dashes'],
    [{ name: { en: '80s', nl: '', de: '80er' } }, 'name.nl is required'],
    [{ name: { en: 'x'.repeat(121), nl: 'a', de: 'b' } }, 'name.en is longer than 120 characters'],
    [{ name: { en: 'a', nl: 'b', de: 'c', fr: 'd' } }, 'name has unknown language fr'],
    [{ name: '80s Hits' }, 'name must be { en, nl, de }'],
    [{ description: { en: 42 } }, 'description.en must be a string or null'],
    [{ spotifyPlaylistId: 'spotify:playlist:abc' }, 'spotifyPlaylistId must be a Spotify playlist id'],
    [{ spotifyPlaylistId: 'AbCdEfGhIjKlMnOpQrStU' }, 'spotifyPlaylistId must be a Spotify playlist id'],
    [{ trackCount: 0 }, 'trackCount must be a whole number from 1 to 1000'],
    [{ yearFrom: 1899 }, 'yearFrom must be a year from 1900 to 2027'],
    [{ yearTo: 2031 }, 'yearTo must be a year from 1900 to 2027'],
    [{ yearFrom: 1990, yearTo: 1989 }, 'yearFrom is after yearTo'],
    [{ decades: [] }, 'decades must be a non-empty array'],
    [{ decades: [{ decade: 1985, count: 48 }] }, 'decades[0].decade must be a decade such as 1980'],
    [{ decades: [{ decade: 1970, count: 48 }] }, 'decades[0].decade 1970 is outside 1980–1989'],
    [{ decades: [{ decade: 1980, count: 0 }] }, 'decades[0].count must be a whole number of at least 1'],
    [{ decades: [{ decade: 1980, count: 48, share: 1 }] }, 'decades[0] has unknown field share'],
    [{ yearTo: 1999, decades: [{ decade: 1990, count: 8 }, { decade: 1980, count: 40 }] }, 'decades must be in ascending order'],
    [{ decades: [{ decade: 1980, count: 49 }] }, 'decades count 49 songs, more than trackCount 48'],
    [{ artists: 'Queen' }, 'artists must be an array of names'],
    [{ artists: Array.from({ length: 9 }, (_, i) => `Artist ${i}`) }, 'at most 8 artists'],
    [{ artists: ['Queen', ' '] }, 'artists[1] must be a name'],
    [{ sortOrder: 1.5 }, 'sortOrder must be a whole number'],
    [{ cardcount: 48 }, 'unknown field cardcount'],
  ])('refuses %j', (override, message) => {
    expect(parseError({ playlists: [row(), row({ themeKey: 'other', spotifyPlaylistId: 'ZyXwVuTsRqPoNmLkJiHgFe', ...override })] })).toContain(
      `playlists[1]: ${message}`
    );
  });

  it('refuses the same theme and size, or the same Spotify playlist, twice in one call', () => {
    expect(parseError({ playlists: [row(), row({ spotifyPlaylistId: 'ZyXwVuTsRqPoNmLkJiHgFe' })] })).toBe(
      'playlists[1]: 80s-hits/48 appears twice'
    );
    expect(parseError({ playlists: [row(), row({ cardCount: 96, trackCount: 96, decades: [{ decade: 1980, count: 96 }] })] })).toBe(
      'playlists[1]: spotifyPlaylistId AbCdEfGhIjKlMnOpQrStUv appears twice'
    );
  });
});

describe('parseDefaultPlaylistIds', () => {
  it('reads an array or a comma list and drops duplicates', () => {
    expect(parseDefaultPlaylistIds([3, 1, 3])).toEqual([3, 1]);
    expect(parseDefaultPlaylistIds('3, 1,2')).toEqual([3, 1, 2]);
    expect(parseDefaultPlaylistIds(['7'])).toEqual([7]);
  });

  it('refuses nothing, junk and more than 300 ids', () => {
    expect(() => parseDefaultPlaylistIds(undefined)).toThrow('at least one playlist id');
    expect(() => parseDefaultPlaylistIds('')).toThrow('at least one playlist id');
    expect(() => parseDefaultPlaylistIds([1, 'x'])).toThrow('positive whole numbers');
    expect(() => parseDefaultPlaylistIds('1,0')).toThrow('positive whole numbers');
    expect(() => parseDefaultPlaylistIds([1.5])).toThrow('positive whole numbers');
    expect(() => parseDefaultPlaylistIds(Array.from({ length: 301 }, (_, i) => i + 1))).toThrow('at most 300');
  });

  it('builds the view query the Lambda prints', () => {
    expect(defaultPlaylistsViewQuery('nl', [4, 5])).toBe('locale=nl&ids=4%2C5');
  });
});

describe('buildDefaultPlaylistsView', () => {
  it('lays the whole catalogue out in categories, five themes a page, never over the page height', async () => {
    const v = await view(FIXTURE);
    expect(v.themeCount).toBe(30);
    expect(v.playlistCount).toBe(90);
    expect(v.columns).toEqual([48, 96, 192]);
    expect(v.sections.map((s) => [s.category, s.meta])).toEqual([
      ['decades', '7 themes'],
      ['genres', '9 themes'],
      ['themes', '9 themes'],
      ['local', '5 themes'],
    ]);
    expect(v.pages.map((p) => p.items.filter((i) => i.kind === 'theme').length)).toEqual([5, 5, 5, 5, 5, 5]);
    // Cover, introduction, six theme pages, closing page.
    expect(v.pageCount).toBe(9);
    expect(v.pages.map((p) => p.pageNo)).toEqual([3, 4, 5, 6, 7, 8]);
    for (const page of v.pages) {
      const height = page.items.reduce(
        (sum, item) => sum + (item.kind === 'header' ? BROCHURE_LAYOUT.HEADER_MM : BROCHURE_LAYOUT.ROW_MM),
        0
      );
      expect(height).toBeLessThanOrEqual(BROCHURE_LAYOUT.BODY_MM);
      // Every page starts with a section title, and a title is never the last thing on a page.
      expect(page.items[0].kind).toBe('header');
      expect(page.items[page.items.length - 1].kind).toBe('theme');
    }
    const numbers = v.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === 'theme' ? [i.theme.number] : [])));
    expect(numbers[0]).toBe('01');
    expect(numbers[29]).toBe('30');
  });

  it('repeats the section title on a page where a section continues', async () => {
    const v = await view(FIXTURE);
    // Decades has 7 themes: 5 on page 3, then its title again above the other 2.
    expect(v.pages[1].items[0]).toMatchObject({ kind: 'header', category: 'decades' });
    expect(v.pages[1].items.filter((i) => i.kind === 'header').map((i: any) => i.category)).toEqual(['decades', 'genres']);
  });

  it('shows only the selected sizes, in fixed columns, and leaves out themes without one', async () => {
    const pick = (key: string, sizes: number[]) => FIXTURE.filter((r) => r.themeKey === key && sizes.includes(r.cardCount));
    const rows = [...pick('80s-hits', [48, 96]), ...pick('dance-classics', [48, 192]), ...pick('christmas', [192])];
    const v = await view(rows);
    expect(v.columns).toEqual([48, 96, 192]);
    const themes = v.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === 'theme' ? [i.theme] : [])));
    expect(themes.map((t) => t.themeKey)).toEqual(['80s-hits', 'dance-classics', 'christmas']);
    expect(themes[0].sizes.map((s) => s?.cardCount ?? null)).toEqual([48, 96, null]);
    expect(themes[1].sizes.map((s) => s?.cardCount ?? null)).toEqual([48, null, 192]);
    expect(themes[2].sizes.map((s) => s?.cardCount ?? null)).toEqual([null, null, 192]);
    expect(v.sections.map((s) => s.category)).toEqual(['decades', 'genres', 'themes']);
  });

  it('has one tile column when only 48s are selected, and gives the text the room', async () => {
    const v = await view(FIXTURE.filter((r) => r.cardCount === 48));
    expect(v.columns).toEqual([48]);
    const themes = v.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === 'theme' ? [i.theme] : [])));
    expect(themes).toHaveLength(30);
    expect(themes.every((t) => t.sizes.length === 1 && t.sizes[0]?.cardCount === 48)).toBe(true);
    // A name that needs two lines next to three tiles fits on one next to one.
    const dutchParty = (await view(FIXTURE.filter((r) => r.themeKey === 'dutch-party'), 'de')).pages[0].items[1] as any;
    const dutchParty48 = (await view(FIXTURE.filter((r) => r.themeKey === 'dutch-party' && r.cardCount === 48), 'de'))
      .pages[0].items[1] as any;
    expect(dutchParty.theme.nameLines).toBe(2);
    expect(dutchParty48.theme.nameLines).toBe(1);
  });

  it('writes the theme in the document language, with the largest size speaking for it', async () => {
    const rows = FIXTURE.filter((r) => r.themeKey === '80s-hits');
    const nl = (await view(rows, 'nl')).pages[0].items[1] as any;
    expect(nl.theme.name).toBe('Hits uit de jaren 80');
    expect(nl.theme.years).toBe('1980 – 1989');
    expect(nl.theme.artists).toContain('Michael Jackson\u00a0· Madonna');
    // No Dutch description: the English one.
    const noDutch = rows.map((r) => ({ ...r, description: { ...r.description, nl: null } }));
    expect(((await view(noDutch, 'nl')).pages[0].items[1] as any).theme.description).toContain('Synthesizers, big hair');
    // An unsupported language is English.
    expect(((await view(rows, 'fr')).pages[0].items[1] as any).theme.name).toBe('80s Hits');
  });

  it('draws every chart on one decade axis and marks only a single busiest decade', async () => {
    const v = await view(FIXTURE);
    const themes = v.pages.flatMap((p) => p.items.flatMap((i) => (i.kind === 'theme' ? [i.theme] : [])));
    // Christmas reaches back to the 1940s, so every chart starts there.
    for (const t of themes) expect(t.bars.map((b) => b.label)).toEqual(["’40", "’50", "’60", "’70", "’80", "’90", "’00", "’10", "’20"]);
    const eighties = themes.find((t) => t.themeKey === '80s-hits')!;
    expect(eighties.bars.filter((b) => b.height > 0).map((b) => [b.label, b.height, b.peak])).toEqual([["’80", 100, true]]);
    // Pop Anthems has four decades with the same count: no single peak.
    const pop = themes.find((t) => t.themeKey === 'pop-anthems')!;
    expect(pop.bars.some((b) => b.peak)).toBe(false);
    // Without Christmas the axis is 1950s to 2020s.
    const noChristmas = await view(FIXTURE.filter((r) => r.themeKey === 'rock-classics'));
    expect((noChristmas.pages[0].items[1] as any).theme.bars).toHaveLength(8);
  });

  it('prints a QR code that reads back as the Spotify link, with a quiet zone', async () => {
    const url = 'https://open.spotify.com/playlist/OqF9TwBF44BvHJmtCWGWH8';
    const svg = qrSvg(url);
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 41 41"/);
    const { data, info } = await sharp(Buffer.from(svg)).resize(410, 410).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    expect(code?.data).toBe(url);
  });

  it('names the download after the bundle', async () => {
    const date = new Date('2026-10-16T08:00:00Z');
    expect(defaultPlaylistsFileName(await getDefaultPlaylistsTranslator(translation, 'en'), date)).toBe(
      'QRSong_Default_playlists_2026-10-16.pdf'
    );
    expect(defaultPlaylistsFileName(await getDefaultPlaylistsTranslator(translation, 'nl'), date)).toBe(
      'QRSong_Standaard_playlists_2026-10-16.pdf'
    );
    expect(defaultPlaylistsFileName(await getDefaultPlaylistsTranslator(translation, 'de'), date)).toBe(
      'QRSong_Standard-Playlists_2026-10-16.pdf'
    );
  });
});

describe('views/default_playlists.ejs', () => {
  const render = async (rows: DefaultPlaylistRow[], locale: string) =>
    ejs.renderFile(VIEW, await view(rows, locale), { async: false }) as unknown as string;

  it('renders cover, introduction, the theme pages and the closing page in the language asked for', async () => {
    const html = await render(FIXTURE, 'nl');
    expect(html).toContain('<html lang="nl">');
    expect(html).toContain('Standaard playlists');
    expect(html).toContain('Hits uit de jaren 80');
    expect(html).toContain('Nummers per decennium');
    // Introduction + 6 theme pages (the cover and closing page are not .sheet).
    expect(html.match(/<div class="sheet[ "]/g)).toHaveLength(7);
    expect(html.match(/class="dp-theme"/g)).toHaveLength(30);
    expect(html.match(/<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 41 41"/g)).toHaveLength(90);
    expect(html).toContain('03 / 09');
    expect(html).toContain('class="closing"');
    // Formal and price-free.
    const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    expect(text).not.toMatch(/€|\bEUR\b|\bprijs|\bprice/i);
  });

  it('links and prints only the selected sizes', async () => {
    const chosen = FIXTURE.filter((r) => r.themeKey === 'christmas' && r.cardCount !== 96);
    const html = await render(chosen, 'de');
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('Weihnachten');
    for (const r of chosen) expect(html).toContain(`href="${r.spotifyUrl}"`);
    const skipped = FIXTURE.find((r) => r.themeKey === 'christmas' && r.cardCount === 96)!;
    expect(html).not.toContain(skipped.spotifyPlaylistId);
    expect(html).not.toContain('Hits der 80er');
    // 96 is nowhere in this selection, so it gets no column either.
    expect(html.match(/class="dp-size"/g)).toHaveLength(2);
    expect(html).not.toContain('class="dp-size empty"');
    // With a 96 of another theme in the selection, Christmas leaves that slot empty.
    const withOther = await render([...chosen, FIXTURE.find((r) => r.themeKey === '80s-hits' && r.cardCount === 96)!], 'de');
    expect(withOther.match(/class="dp-size empty"/g)).toHaveLength(3);
  });
});
