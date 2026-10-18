import QRCode from 'qrcode';
import type { DefaultPlaylist } from '@prisma/client';
import PrismaInstance from './prisma';
import type Translation from './translation';

/**
 * The default playlists we offer companies and resellers (2026-10-16): about
 * 30 curated themes ("80s Hits", "Rock Classics", "Christmas" …), each in
 * three box sizes, every one a playlist in our own Spotify account. Rick's
 * toolkit (`qrsong default-playlists …`) fills the catalogue through
 * PUT /business/default-playlists; the dashboard (Companies → Default
 * playlists) lists them and prints a brochure of a selection for resellers.
 * They replaced the playlist suggestions brochure (all featured playlists by
 * market, genre and box size).
 *
 * Routes: src/routes/defaultPlaylistRoutes.ts. The brochure view is
 * views/default_playlists.ejs; buildDefaultPlaylistsView turns rows into its
 * pages without touching the database, so scripts/default-playlists/render.ts
 * can proof it from a fixture.
 */

export const DEFAULT_PLAYLIST_CARD_COUNTS = [48, 96, 192] as const;
export type DefaultPlaylistCardCount = (typeof DEFAULT_PLAYLIST_CARD_COUNTS)[number];

/** In this order in the brochure. */
export const DEFAULT_PLAYLIST_CATEGORIES = ['decades', 'genres', 'themes', 'local'] as const;
export type DefaultPlaylistCategory = (typeof DEFAULT_PLAYLIST_CATEGORIES)[number];

/** Rows per PUT, and ids per brochure. */
export const MAX_DEFAULT_PLAYLISTS = 300;

const LANGS = ['en', 'nl', 'de'] as const;
type Lang = (typeof LANGS)[number];

export interface DecadeCount {
  decade: number;
  count: number;
}

export interface DefaultPlaylistRow {
  id: number;
  themeKey: string;
  cardCount: DefaultPlaylistCardCount;
  category: DefaultPlaylistCategory;
  name: Record<Lang, string>;
  description: Record<Lang, string | null>;
  spotifyPlaylistId: string;
  spotifyUrl: string;
  trackCount: number;
  yearFrom: number;
  yearTo: number;
  decades: DecadeCount[];
  artists: string[];
  sortOrder: number;
  updatedAt: string;
}

export type DefaultPlaylistInput = Omit<DefaultPlaylistRow, 'id' | 'spotifyUrl' | 'updatedAt'>;

export class DefaultPlaylistError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export function spotifyPlaylistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

// ---------------------------------------------------------------- validation

const THEME_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPOTIFY_PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const ARTIST_MAX = 100;
const ARTISTS_MAX = 8;
const FIRST_YEAR = 1900;
/** Fields a GET row carries that a PUT may send back unchanged; they are ignored. */
const IGNORED_FIELDS = new Set(['id', 'spotifyUrl', 'updatedAt']);
const FIELDS = new Set([
  'themeKey',
  'cardCount',
  'category',
  'name',
  'description',
  'spotifyPlaylistId',
  'trackCount',
  'yearFrom',
  'yearTo',
  'decades',
  'artists',
  'sortOrder',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/**
 * Reads the body of PUT /business/default-playlists. Strict on purpose: the
 * toolkit is the only writer, and a typo there should fail loudly rather
 * than print a wrong year range in a brochure. Throws DefaultPlaylistError
 * (400) naming the row and the field.
 */
export function parseDefaultPlaylistsBody(body: unknown, now = new Date()): DefaultPlaylistInput[] {
  if (!isObject(body) || !Array.isArray(body['playlists'])) {
    throw new DefaultPlaylistError('body must be { playlists: [...] }');
  }
  const list = body['playlists'] as unknown[];
  if (list.length === 0) throw new DefaultPlaylistError('playlists is empty');
  if (list.length > MAX_DEFAULT_PLAYLISTS) {
    throw new DefaultPlaylistError(`at most ${MAX_DEFAULT_PLAYLISTS} playlists per call`);
  }
  const lastYear = now.getFullYear() + 1;
  const rows = list.map((raw, i) => parseRow(raw, i, lastYear));

  const sizes = new Set<string>();
  const spotifyIds = new Set<string>();
  rows.forEach((row, i) => {
    const size = `${row.themeKey}/${row.cardCount}`;
    if (sizes.has(size)) throw new DefaultPlaylistError(`playlists[${i}]: ${size} appears twice`);
    sizes.add(size);
    if (spotifyIds.has(row.spotifyPlaylistId)) {
      throw new DefaultPlaylistError(`playlists[${i}]: spotifyPlaylistId ${row.spotifyPlaylistId} appears twice`);
    }
    spotifyIds.add(row.spotifyPlaylistId);
  });
  return rows;
}

function parseRow(raw: unknown, index: number, lastYear: number): DefaultPlaylistInput {
  const fail = (message: string): never => {
    throw new DefaultPlaylistError(`playlists[${index}]: ${message}`);
  };
  if (!isObject(raw)) return fail('must be an object');
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key) && !IGNORED_FIELDS.has(key));
  if (unknown.length) fail(`unknown field ${unknown.join(', ')}`);

  const themeKey = raw['themeKey'];
  if (typeof themeKey !== 'string' || themeKey.length > 64 || !THEME_KEY.test(themeKey)) {
    fail('themeKey must be lowercase words joined by dashes (e.g. "80s-hits"), at most 64 characters');
  }
  const cardCount = raw['cardCount'];
  if (!(DEFAULT_PLAYLIST_CARD_COUNTS as readonly unknown[]).includes(cardCount)) {
    fail(`cardCount must be ${DEFAULT_PLAYLIST_CARD_COUNTS.join(', ')}`);
  }
  const category = raw['category'];
  if (!(DEFAULT_PLAYLIST_CATEGORIES as readonly unknown[]).includes(category)) {
    fail(`category must be one of ${DEFAULT_PLAYLIST_CATEGORIES.join(', ')}`);
  }

  const nameRaw = raw['name'];
  if (!isObject(nameRaw)) return fail('name must be { en, nl, de }');
  const extraNames = Object.keys(nameRaw).filter((key) => !(LANGS as readonly string[]).includes(key));
  if (extraNames.length) fail(`name has unknown language ${extraNames.join(', ')}`);
  const name = {} as Record<Lang, string>;
  for (const lang of LANGS) {
    const value = nameRaw[lang];
    if (typeof value !== 'string' || !value.trim()) fail(`name.${lang} is required`);
    const clean = (value as string).trim();
    if (clean.length > NAME_MAX) fail(`name.${lang} is longer than ${NAME_MAX} characters`);
    name[lang] = clean;
  }

  const description = { en: null, nl: null, de: null } as Record<Lang, string | null>;
  const descriptionRaw = raw['description'];
  if (descriptionRaw !== undefined && descriptionRaw !== null) {
    if (!isObject(descriptionRaw)) return fail('description must be { en, nl, de }');
    const extra = Object.keys(descriptionRaw).filter((key) => !(LANGS as readonly string[]).includes(key));
    if (extra.length) fail(`description has unknown language ${extra.join(', ')}`);
    for (const lang of LANGS) {
      const value = descriptionRaw[lang];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') fail(`description.${lang} must be a string or null`);
      const clean = (value as string).trim();
      if (clean.length > DESCRIPTION_MAX) fail(`description.${lang} is longer than ${DESCRIPTION_MAX} characters`);
      description[lang] = clean || null;
    }
  }

  const spotifyPlaylistId = raw['spotifyPlaylistId'];
  if (typeof spotifyPlaylistId !== 'string' || !SPOTIFY_PLAYLIST_ID.test(spotifyPlaylistId)) {
    fail('spotifyPlaylistId must be a Spotify playlist id (22 letters and digits)');
  }

  const trackCount = raw['trackCount'];
  if (!isInt(trackCount) || trackCount < 1 || trackCount > 1000) fail('trackCount must be a whole number from 1 to 1000');

  const yearFrom = raw['yearFrom'];
  const yearTo = raw['yearTo'];
  if (!isInt(yearFrom) || yearFrom < FIRST_YEAR || yearFrom > lastYear) {
    fail(`yearFrom must be a year from ${FIRST_YEAR} to ${lastYear}`);
  }
  if (!isInt(yearTo) || yearTo < FIRST_YEAR || yearTo > lastYear) {
    fail(`yearTo must be a year from ${FIRST_YEAR} to ${lastYear}`);
  }
  if ((yearFrom as number) > (yearTo as number)) fail('yearFrom is after yearTo');

  const decadesRaw = raw['decades'];
  if (!Array.isArray(decadesRaw) || decadesRaw.length === 0) fail('decades must be a non-empty array');
  const firstDecade = Math.floor((yearFrom as number) / 10) * 10;
  const decades: DecadeCount[] = [];
  let songs = 0;
  (decadesRaw as unknown[]).forEach((entry, j) => {
    if (!isObject(entry)) fail(`decades[${j}] must be { decade, count }`);
    const extra = Object.keys(entry as object).filter((key) => key !== 'decade' && key !== 'count');
    if (extra.length) fail(`decades[${j}] has unknown field ${extra.join(', ')}`);
    const { decade, count } = entry as Record<string, unknown>;
    if (!isInt(decade) || decade % 10 !== 0) fail(`decades[${j}].decade must be a decade such as 1980`);
    if ((decade as number) < firstDecade || (decade as number) > (yearTo as number)) {
      fail(`decades[${j}].decade ${decade} is outside ${yearFrom}–${yearTo}`);
    }
    if (!isInt(count) || count < 1) fail(`decades[${j}].count must be a whole number of at least 1`);
    if (decades.length && decades[decades.length - 1].decade >= (decade as number)) {
      fail('decades must be in ascending order, each decade once');
    }
    decades.push({ decade: decade as number, count: count as number });
    songs += count as number;
  });
  if (songs > (trackCount as number)) fail(`decades count ${songs} songs, more than trackCount ${trackCount}`);

  const artistsRaw = raw['artists'];
  if (!Array.isArray(artistsRaw)) return fail('artists must be an array of names');
  if (artistsRaw.length > ARTISTS_MAX) fail(`at most ${ARTISTS_MAX} artists`);
  const artists = artistsRaw.map((artist, j) => {
    if (typeof artist !== 'string' || !artist.trim()) fail(`artists[${j}] must be a name`);
    const clean = (artist as string).trim();
    if (clean.length > ARTIST_MAX) fail(`artists[${j}] is longer than ${ARTIST_MAX} characters`);
    return clean;
  });

  const sortOrder = raw['sortOrder'] ?? 0;
  if (!isInt(sortOrder) || Math.abs(sortOrder) > 1_000_000) fail('sortOrder must be a whole number');

  return {
    themeKey: themeKey as string,
    cardCount: cardCount as DefaultPlaylistCardCount,
    category: category as DefaultPlaylistCategory,
    name,
    description,
    spotifyPlaylistId: spotifyPlaylistId as string,
    trackCount: trackCount as number,
    yearFrom: yearFrom as number,
    yearTo: yearTo as number,
    decades,
    artists,
    sortOrder: sortOrder as number,
  };
}

/**
 * The ids of a brochure, from the PDF body (an array) or the view's query
 * string ("1,2,3"). 1 to MAX_DEFAULT_PLAYLISTS positive whole numbers,
 * duplicates dropped; anything else throws (400).
 */
export function parseDefaultPlaylistIds(value: unknown): number[] {
  const parts: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? value.split(',').map((part) => part.trim())
      : [];
  if (parts.length === 0) throw new DefaultPlaylistError('ids: at least one playlist id');
  if (parts.length > MAX_DEFAULT_PLAYLISTS) throw new DefaultPlaylistError(`ids: at most ${MAX_DEFAULT_PLAYLISTS} playlist ids`);
  const ids = parts.map((part) => (typeof part === 'string' && /^\d{1,9}$/.test(part) ? Number(part) : part));
  if (ids.some((id) => !isInt(id) || id < 1)) throw new DefaultPlaylistError('ids must be playlist ids (positive whole numbers)');
  return Array.from(new Set(ids as number[]));
}

/** Query string of the brochure view the PDF Lambda prints. */
export function defaultPlaylistsViewQuery(locale: string, ids: number[]): string {
  return new URLSearchParams({ locale, ids: ids.join(',') }).toString();
}

// ---------------------------------------------------------------- database

function jsonDecades(value: unknown): DecadeCount[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => isObject(entry) && isInt(entry['decade']) && isInt(entry['count']))
    .map((entry: any) => ({ decade: entry.decade, count: entry.count }))
    .sort((a, b) => a.decade - b.decade);
}

function jsonArtists(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((artist): artist is string => typeof artist === 'string' && !!artist.trim()) : [];
}

export function toDefaultPlaylistRow(record: DefaultPlaylist): DefaultPlaylistRow {
  return {
    id: record.id,
    themeKey: record.themeKey,
    cardCount: record.cardCount as DefaultPlaylistCardCount,
    category: record.category as DefaultPlaylistCategory,
    name: { en: record.name_en, nl: record.name_nl, de: record.name_de },
    description: { en: record.description_en, nl: record.description_nl, de: record.description_de },
    spotifyPlaylistId: record.spotifyPlaylistId,
    spotifyUrl: spotifyPlaylistUrl(record.spotifyPlaylistId),
    trackCount: record.trackCount,
    yearFrom: record.yearFrom,
    yearTo: record.yearTo,
    decades: jsonDecades(record.decades),
    artists: jsonArtists(record.artists),
    sortOrder: record.sortOrder,
    updatedAt: record.updatedAt.toISOString(),
  };
}

const ORDER = [{ sortOrder: 'asc' as const }, { themeKey: 'asc' as const }, { cardCount: 'asc' as const }];

export async function listDefaultPlaylists(): Promise<DefaultPlaylistRow[]> {
  const records = await PrismaInstance.getInstance().defaultPlaylist.findMany({ orderBy: ORDER });
  return records.map(toDefaultPlaylistRow);
}

export async function getDefaultPlaylistsByIds(ids: number[]): Promise<DefaultPlaylistRow[]> {
  if (ids.length === 0) return [];
  const records = await PrismaInstance.getInstance().defaultPlaylist.findMany({
    where: { id: { in: ids } },
    orderBy: ORDER,
  });
  return records.map(toDefaultPlaylistRow);
}

function columns(input: DefaultPlaylistInput) {
  return {
    category: input.category,
    name_en: input.name.en,
    name_nl: input.name.nl,
    name_de: input.name.de,
    description_en: input.description.en,
    description_nl: input.description.nl,
    description_de: input.description.de,
    spotifyPlaylistId: input.spotifyPlaylistId,
    trackCount: input.trackCount,
    yearFrom: input.yearFrom,
    yearTo: input.yearTo,
    decades: input.decades as unknown as object,
    artists: input.artists,
    sortOrder: input.sortOrder,
  };
}

/**
 * Upserts every row on (themeKey, cardCount), in one transaction, and returns
 * them in the order they were sent. A Spotify playlist belongs to one row: a
 * playlist id already stored for another theme or size is refused (400)
 * rather than left to the unique index.
 */
export async function upsertDefaultPlaylists(input: DefaultPlaylistInput[]): Promise<DefaultPlaylistRow[]> {
  const prisma = PrismaInstance.getInstance();
  const records = await prisma.$transaction(async (tx) => {
    const taken = await tx.defaultPlaylist.findMany({
      where: { spotifyPlaylistId: { in: input.map((row) => row.spotifyPlaylistId) } },
      select: { spotifyPlaylistId: true, themeKey: true, cardCount: true },
    });
    for (const row of input) {
      const other = taken.find(
        (t) => t.spotifyPlaylistId === row.spotifyPlaylistId && (t.themeKey !== row.themeKey || t.cardCount !== row.cardCount)
      );
      if (other) {
        throw new DefaultPlaylistError(
          `spotifyPlaylistId ${row.spotifyPlaylistId} is already ${other.themeKey}/${other.cardCount}; delete that row first`
        );
      }
    }
    const saved: DefaultPlaylist[] = [];
    for (const row of input) {
      saved.push(
        await tx.defaultPlaylist.upsert({
          where: { themeKey_cardCount: { themeKey: row.themeKey, cardCount: row.cardCount } },
          create: { themeKey: row.themeKey, cardCount: row.cardCount, ...columns(row) },
          update: columns(row),
        })
      );
    }
    return saved;
  }, { timeout: 60000 });
  return records.map(toDefaultPlaylistRow);
}

/** False when there is no such row. The Spotify playlist itself stays. */
export async function deleteDefaultPlaylist(id: number): Promise<boolean> {
  const result = await PrismaInstance.getInstance().defaultPlaylist.deleteMany({ where: { id } });
  return result.count > 0;
}

// ---------------------------------------------------------------- brochure

export type Translate = (key: string, vars?: Record<string, any>) => string;

/**
 * The brochure's `t`: its own `defaultPlaylists.*` copy, falling back to
 * `pricing.*` for what the shared cover, closing page and brochure partials
 * read (contact labels, the box sizes, the page footer).
 */
export async function getDefaultPlaylistsTranslator(translation: Translation, locale: string): Promise<Translate> {
  const own = await translation.getBusinessTranslator(locale, 'defaultPlaylists');
  const pricing = await translation.getBusinessTranslator(locale, 'pricing');
  return (key, vars) => {
    const text = own(key, vars);
    return text === key ? pricing(key, vars) : text;
  };
}

/** e.g. QRSong_Default_playlists_2026-10-16.pdf; the dashboard reads it from Content-Disposition. */
export function defaultPlaylistsFileName(t: Translate, date = new Date()): string {
  return `${t('fileName').replace(/\s+/g, '_')}_${date.toISOString().slice(0, 10)}.pdf`;
}

/**
 * Fixed heights of the theme pages, in mm. The pages are cut in TypeScript
 * from these numbers and the view sets the same heights in CSS, so a page can
 * never overflow: the body of a sheet holds BODY_MM, a section title
 * HEADER_MM, a theme ROW_MM (its bottom gap included). The proof script
 * (scripts/default-playlists/render.ts) checks the result in Chrome.
 */
export const BROCHURE_LAYOUT = {
  BODY_MM: 245,
  HEADER_MM: 13,
  ROW_MM: 43.5,
  GAP_MM: 4,
  /** QR tile side, quiet zone included: the code itself is 33/41 of it (16.5 mm). */
  QR_MM: 20.5,
} as const;

/** The decade axis every chart in one brochure shares, so their bars line up. */
const AXIS_FIRST = 1950;
const AXIS_LAST = 2020;
const DESCRIPTION_CHARS = 230;

export interface BrochureSize {
  id: number;
  cardCount: DefaultPlaylistCardCount;
  spotifyUrl: string;
  qrSvg: string;
}

export interface BrochureTheme {
  number: string;
  themeKey: string;
  category: DefaultPlaylistCategory;
  name: string;
  /** Font size of the name in px, and its lines: a two-line name costs the description a line. */
  nameSize: number;
  nameLines: 1 | 2;
  description: string;
  years: string;
  artists: string;
  bars: { label: string; height: number; count: number; peak: boolean }[];
  /** One slot per column of the brochure (its box sizes); null where this theme has no such size selected. */
  sizes: (BrochureSize | null)[];
}

export type BrochureItem =
  | { kind: 'header'; category: DefaultPlaylistCategory; title: string; meta: string }
  | { kind: 'theme'; theme: BrochureTheme };

export interface BrochurePage {
  pageNo: number;
  items: BrochureItem[];
}

export interface DefaultPlaylistsView {
  locale: string;
  t: Translate;
  baseUrl: string;
  formatDate: (date: Date) => string;
  version: string;
  editionName: string;
  docTitle: string;
  /** Box sizes that appear in this selection, ascending: the tile columns. */
  columns: DefaultPlaylistCardCount[];
  sections: { category: DefaultPlaylistCategory; title: string; meta: string }[];
  themeCount: number;
  playlistCount: number;
  pages: BrochurePage[];
  /** Cover and closing page included. */
  pageCount: number;
  layout: typeof BROCHURE_LAYOUT;
}

/**
 * A Spotify link as an inline SVG QR code, with a quiet zone of four modules
 * on a white square: crisp at any print size, no file or request needed.
 */
export function qrSvg(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const quiet = 4;
  const total = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!qr.modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && qr.modules.get(y, x)) x++;
      path += `M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/><path fill="#18565E" d="${path}"/></svg>`
  );
}

/** Width of a theme's text column with all three size tiles (see the view's CSS). */
const INFO_MM_ALL_SIZES = 69;
/** Average width of a character of the theme name, in em of the display face (Archivo, expanded). */
const NAME_EM = 0.74;

/**
 * Picks the name's font size from an estimate of its width: one line at
 * 14 px when it fits, else two lines at 13 px, else two lines at 11 px
 * (clamped). Estimated, not measured, so the pagination stays a pure
 * function; the proof script measures the result.
 */
function fitName(name: string, infoMm: number): { nameSize: number; nameLines: 1 | 2 } {
  const perLine = (px: number) => Math.floor(infoMm / (px * NAME_EM * 0.2646));
  if (name.length <= perLine(14)) return { nameSize: 14, nameLines: 1 };
  if (name.length <= perLine(13) * 2 - 4) return { nameSize: 13, nameLines: 2 };
  return { nameSize: 11, nameLines: 2 };
}

/**
 * As many whole artist names as fit the two lines under the description
 * (8.5 px Inter, ~1.3 mm a character, after the label in its wider display
 * face), so a name is never cut.
 */
function fitArtists(artists: string[], infoMm: number, label: string): string {
  const budget = Math.floor((infoMm / 1.3) * 2) - Math.ceil(label.length * 1.5) - 4;
  let line = '';
  for (const artist of artists) {
    // A no-break space before the dot keeps it at the end of a line, never at the start.
    const next = line ? `${line}\u00a0· ${artist}` : artist;
    if (next.length > budget) break;
    line = next;
  }
  return line || clip(artists[0] ?? '', budget);
}

function clip(text: string, max: number): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

function themeTitle(t: Translate, category: DefaultPlaylistCategory): string {
  return t(`category${category[0].toUpperCase()}${category.slice(1)}`);
}

function themeCountLabel(t: Translate, count: number): string {
  return count === 1 ? t('themesOne') : t('themesCount', { count });
}

/**
 * Everything views/default_playlists.ejs needs, from rows alone: the themes
 * grouped by category, each with the selected sizes, its chart, its QR codes,
 * and the pages cut from BROCHURE_LAYOUT. No database, no network.
 */
export function buildDefaultPlaylistsView(
  rows: DefaultPlaylistRow[],
  opts: { locale: string; t: Translate; intlTag: string; baseUrl: string; now?: Date }
): DefaultPlaylistsView {
  const { t, locale } = opts;
  const lang: Lang = (LANGS as readonly string[]).includes(locale) ? (locale as Lang) : 'en';
  const now = opts.now ?? new Date();
  const formatDate = (date: Date) =>
    new Intl.DateTimeFormat(opts.intlTag, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);

  const columns = DEFAULT_PLAYLIST_CARD_COUNTS.filter((size) => rows.some((row) => row.cardCount === size));
  // The text column gets what the chart and the size tiles leave of the row.
  const infoMm = INFO_MM_ALL_SIZES + (DEFAULT_PLAYLIST_CARD_COUNTS.length - columns.length) * (BROCHURE_LAYOUT.QR_MM + 3);

  const byTheme = new Map<string, DefaultPlaylistRow[]>();
  for (const row of rows) {
    const list = byTheme.get(row.themeKey) ?? [];
    list.push(row);
    byTheme.set(row.themeKey, list);
  }

  // One axis for the whole brochure: 1950s to 2020s, wider when a list reaches further.
  const allDecades = rows.flatMap((row) => row.decades.map((d) => d.decade));
  const axisFirst = Math.min(AXIS_FIRST, ...allDecades);
  const axisLast = Math.max(AXIS_LAST, ...allDecades);
  const axis: number[] = [];
  for (let decade = axisFirst; decade <= axisLast; decade += 10) axis.push(decade);

  const grouped = Array.from(byTheme.values()).map((sizes) => {
    sizes.sort((a, b) => a.cardCount - b.cardCount);
    // The largest selected size speaks for the theme: its name, chart and artists.
    const lead = sizes[sizes.length - 1];
    const counts = new Map(lead.decades.map((d) => [d.decade, d.count]));
    const max = Math.max(1, ...lead.decades.map((d) => d.count));
    // The busiest decade in POP, but only when there is one.
    const peaks = lead.decades.filter((d) => d.count === max).length;
    const yearFrom = Math.min(...sizes.map((s) => s.yearFrom));
    const yearTo = Math.max(...sizes.map((s) => s.yearTo));
    const name = lead.name[lang] || lead.name.en;
    return {
      sortOrder: Math.min(...sizes.map((s) => s.sortOrder)),
      theme: {
        number: '',
        themeKey: lead.themeKey,
        category: lead.category,
        name,
        ...fitName(name, infoMm),
        description: clip(lead.description[lang] || lead.description.en || '', DESCRIPTION_CHARS),
        years: yearFrom === yearTo ? String(yearFrom) : `${yearFrom} – ${yearTo}`,
        artists: fitArtists(lead.artists, infoMm, t('artistsLabel')),
        bars: axis.map((decade) => {
          const count = counts.get(decade) ?? 0;
          return {
            label: `’${String(decade % 100).padStart(2, '0')}`,
            height: count ? Math.max(6, Math.round((count / max) * 100)) : 0,
            count,
            peak: count === max && peaks === 1,
          };
        }),
        sizes: columns.map((size) => {
          const row = sizes.find((s) => s.cardCount === size);
          return row
            ? { id: row.id, cardCount: row.cardCount, spotifyUrl: row.spotifyUrl, qrSvg: qrSvg(row.spotifyUrl) }
            : null;
        }),
      } as BrochureTheme,
    };
  });

  const sections = DEFAULT_PLAYLIST_CATEGORIES.map((category) => {
    const themes = grouped
      .filter((g) => g.theme.category === category)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.theme.themeKey.localeCompare(b.theme.themeKey))
      .map((g) => g.theme);
    return { category, title: themeTitle(t, category), meta: themeCountLabel(t, themes.length), themes };
  }).filter((section) => section.themes.length > 0);

  let number = 0;
  for (const section of sections) {
    for (const theme of section.themes) theme.number = String(++number).padStart(2, '0');
  }

  // Cut the pages: a section title always has its first theme under it, and
  // a section that runs onto a new page repeats its title there.
  const { BODY_MM, HEADER_MM, ROW_MM } = BROCHURE_LAYOUT;
  const firstPageNo = 3; // cover, the intro page, then the themes
  const pages: BrochurePage[] = [];
  let page: BrochurePage | null = null;
  let used = 0;
  const open = () => {
    page = { pageNo: firstPageNo + pages.length, items: [] };
    pages.push(page);
    used = 0;
  };
  for (const section of sections) {
    const header: BrochureItem = { kind: 'header', category: section.category, title: section.title, meta: section.meta };
    section.themes.forEach((theme, i) => {
      const needed = ROW_MM + (i === 0 ? HEADER_MM : 0);
      if (page === null || used + needed > BODY_MM) {
        open();
        page!.items.push(header);
        used = HEADER_MM;
      } else if (i === 0) {
        page!.items.push(header);
        used += HEADER_MM;
      }
      page!.items.push({ kind: 'theme', theme });
      used += ROW_MM;
    });
  }

  return {
    locale,
    t,
    baseUrl: opts.baseUrl,
    formatDate,
    version: now.toISOString().slice(0, 10).replace(/-/g, '.'),
    editionName: t('editionName'),
    docTitle: t('docTitle'),
    columns,
    sections: sections.map(({ category, title, meta }) => ({ category, title, meta })),
    themeCount: number,
    playlistCount: rows.length,
    pages,
    pageCount: pages.length + 3,
    layout: BROCHURE_LAYOUT,
  };
}
