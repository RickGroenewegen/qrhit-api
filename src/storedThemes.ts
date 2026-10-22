import crypto from 'crypto';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import AppTheme from './apptheme';
import {
  APP_THEME_CACHE_TTL,
  FONT_FAMILY_RE,
  parseCustomerSlug,
  sanitizeHelpText,
  validateCssVariables,
} from './appDesign';

/**
 * Hand-made scan-app themes stored as data, so a new or changed business
 * theme needs no deploy (the card templates did the same for card layouts,
 * src/cardTemplates.ts). Rick's qrsong toolkit pushes a theme folder
 * (`<slug>.json` + optional logo.png / background.png) with
 * `qrsong theme push`; every push is a new, immutable version in
 * `app_theme_versions`, its pictures content-addressed under
 * PUBLIC_DIR/app-themes/<slug>/.
 *
 * GET /theme/:slug (themeRoutes.ts) serves the newest stored version before
 * the folders in src/_data/themes, which keep serving every theme that was
 * never pushed. A scanned card gets `<slug>--v<version>` (apptheme.ts), so
 * the released app reloads the theme on the next scan after a push; the
 * route answers any `--v<n>` with the newest version under the slug asked
 * for, because the app caches a theme under its id.
 *
 * The values are checked with the App Designer's grammar (appDesign.ts):
 * only variables the app reads, no url(), a Google Fonts stylesheet only,
 * the help text cut down to what the app's help screen shows.
 */

export class StoredThemeError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * A stored theme's own slug: words of a-z and 0-9 joined by single hyphens, so
 * `--v` in a served slug is never part of the slug itself, and at most 56
 * characters, leaving room for `--v<version>` within the 64 of a served slug.
 */
export const STORED_THEME_SLUG = /^(?=.{1,56}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVED_STORED_SLUG = /^(.+)--v(\d{1,9})$/;

export const THEME_ASSET_KINDS = ['logo', 'background'] as const;
export type ThemeAssetKind = (typeof THEME_ASSET_KINDS)[number];

const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_ASSET_PIXELS = 25_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GOOGLE_FONTS_CSS = /^https:\/\/fonts\.googleapis\.com\/css2\?[A-Za-z0-9+:;@&=.,%_-]{1,400}$/;
const FLAGS = ['showMusicalNotes', 'showRecord', 'showEqualizer'] as const;
// Set when the theme is served, so a folder's own values are left out.
const SERVED_KEYS = ['id', 'version', 'assets', 'source'];
const THEME_KEYS = ['name', ...FLAGS, 'cacheTTL', 'cssVariables', 'fonts', 'helpText', ...SERVED_KEYS];

/** What is stored for a version; id, version, source and assets are added when it is served. */
export interface StoredThemeConfig {
  name: string;
  showMusicalNotes?: boolean;
  showRecord?: boolean;
  showEqualizer?: boolean;
  cacheTTL: number;
  cssVariables: Record<string, string>;
  fonts?: { family: string; url: string | null };
  helpText: string | null;
}

export interface StoredThemeVersion {
  slug: string;
  version: number;
  name: string;
  config: StoredThemeConfig;
  logo: string | null;
  background: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Why a slug cannot be pushed, or null. */
export function storedSlugProblem(slug: string): string | null {
  if (!STORED_THEME_SLUG.test(slug)) {
    return 'a theme slug is 1-56 characters: words of a-z and 0-9 joined by single hyphens';
  }
  if (slug === 'default') return '"default" is the app\'s built-in look: the app never asks the API for it';
  if (parseCustomerSlug(slug)) return `"${slug}" has the shape of an App Designer (customer) theme slug`;
  return null;
}

/**
 * The stored theme a requested slug points at: its own slug, or the slug a
 * scanned card carries (`<slug>--v<n>`). Null for anything else.
 */
export function parseStoredSlug(slug: string): { base: string; version: number | null } | null {
  const served = SERVED_STORED_SLUG.exec(slug);
  if (served) return STORED_THEME_SLUG.test(served[1]) ? { base: served[1], version: parseInt(served[2], 10) } : null;
  return STORED_THEME_SLUG.test(slug) ? { base: slug, version: null } : null;
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Checks a theme folder's JSON and returns what is stored. Every problem is
 * collected, so one push names all of them; things that are not wrong but
 * worth knowing come back as warnings.
 */
export function checkThemeManifest(manifest: unknown): { config: StoredThemeConfig; warnings: string[] } {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new StoredThemeError('the theme JSON must be an object');
  }
  const m = manifest as Record<string, any>;
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name || name.length > 191) errors.push('"name" is required: the theme\'s name, at most 191 characters');

  for (const flag of FLAGS) {
    if (m[flag] !== undefined && typeof m[flag] !== 'boolean') errors.push(`"${flag}" must be true or false`);
  }

  let cacheTTL = APP_THEME_CACHE_TTL;
  if (m.cacheTTL !== undefined) {
    if (!Number.isInteger(m.cacheTTL) || m.cacheTTL < 60 || m.cacheTTL > 30 * 86400) {
      errors.push('"cacheTTL" must be whole seconds between 60 and 2592000');
    } else {
      cacheTTL = m.cacheTTL;
    }
  }

  const { cssVariables, rejected } = validateCssVariables(m.cssVariables);
  for (const key of rejected) {
    if (key === 'cssVariables') {
      errors.push('"cssVariables" is required: an object of --app-* variables');
    } else if (!key.startsWith('--app-')) {
      errors.push(`cssVariables: "${key}" is not a variable the app reads`);
    } else {
      errors.push(`cssVariables: ${key} ${JSON.stringify(m.cssVariables[key])} is not a value the app accepts (or not a variable it reads)`);
    }
  }

  let fonts: StoredThemeConfig['fonts'];
  if (m.fonts !== undefined && m.fonts !== null) {
    const family = m.fonts?.family;
    const url = m.fonts?.url ?? null;
    if (typeof family !== 'string' || !FONT_FAMILY_RE.test(family)) {
      errors.push('fonts.family must be a font stack of letters, digits, spaces, commas, quotes and hyphens');
    }
    if (url !== null && (typeof url !== 'string' || !GOOGLE_FONTS_CSS.test(url))) {
      errors.push('fonts.url must be a Google Fonts stylesheet (https://fonts.googleapis.com/css2?…) or null');
    }
    fonts = { family, url };
  }

  let helpText: string | null = null;
  if (m.helpText !== undefined && m.helpText !== null && m.helpText !== '') {
    if (typeof m.helpText !== 'string') {
      errors.push('"helpText" must be HTML text');
    } else {
      helpText = sanitizeHelpText(m.helpText, { layoutStyles: true });
      if (!helpText) errors.push('"helpText" has no text the app can show');
      else if (textOf(helpText) !== textOf(m.helpText)) {
        warnings.push('the help text lost something the app does not show (only p, br, h2, h3, strong, em, u, ul, ol, li and links stay)');
      }
    }
  }

  const unknown = Object.keys(m).filter((k) => !THEME_KEYS.includes(k));
  if (unknown.length) warnings.push(`left out, not part of a theme: ${unknown.join(', ')}`);

  if (errors.length) throw new StoredThemeError(errors.join('\n'));
  // In the order of a theme folder's JSON.
  const flags = Object.fromEntries(FLAGS.filter((f) => m[f] !== undefined).map((f) => [f, m[f] as boolean]));
  const config: StoredThemeConfig = { name, ...flags, cacheTTL, cssVariables, ...(fonts ? { fonts } : {}), helpText };
  return { config, warnings };
}

/** Checks a logo or background upload and returns the content-addressed file name it is stored under. */
export async function checkThemeAsset(kind: ThemeAssetKind, bytes: Buffer): Promise<string> {
  if (!bytes.length) throw new StoredThemeError(`${kind}.png is empty`);
  if (bytes.length > MAX_ASSET_BYTES) throw new StoredThemeError(`${kind}.png is larger than 15 MB`, 413);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new StoredThemeError(`${kind} must be a PNG file`);
  const meta = await sharp(bytes, { limitInputPixels: MAX_ASSET_PIXELS })
    .metadata()
    .catch(() => null);
  if (!meta?.width || !meta.height) throw new StoredThemeError(`${kind}.png cannot be read as an image`);
  if (meta.width * meta.height > MAX_ASSET_PIXELS) throw new StoredThemeError(`${kind}.png is larger than 25 megapixels`);
  return `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`;
}

/** Where a stored theme's pictures live. */
export function themeAssetPath(slug: string, file: string): string {
  return path.join(process.env['PUBLIC_DIR'] as string, 'app-themes', slug, file);
}

/** The folder of a hand-made theme that is served without being stored (src/_data/themes). */
export function legacyThemeDir(slug: string): string {
  return path.join(process.env['APP_ROOT'] as string, '_data', 'themes', slug);
}

/** The `version` in a legacy folder's JSON, 0 when there is none. */
function legacyFolderVersion(slug: string): number {
  try {
    const json = JSON.parse(readFileSync(path.join(legacyThemeDir(slug), `${slug}.json`), 'utf8'));
    return Number.isInteger(json.version) && json.version > 0 ? json.version : 0;
  } catch {
    return 0;
  }
}

/**
 * The theme as GET /theme/:slug serves it: the stored JSON, the version, and
 * asset URLs under the slug that was asked for, version-busted like the folder
 * themes (themeRoutes.ts).
 */
export function servedStoredTheme(theme: StoredThemeVersion, requestedSlug: string, apiUri: string) {
  const asset = (kind: ThemeAssetKind) => (theme[kind] ? `${apiUri}/theme/${requestedSlug}/${kind}?v=${theme.version}` : null);
  return {
    id: requestedSlug,
    ...theme.config,
    version: theme.version,
    source: 'business' as const,
    assets: { logo: asset('logo'), background: asset('background') },
  };
}

function toVersion(row: any): StoredThemeVersion {
  return {
    slug: row.slug,
    version: row.version,
    name: row.name,
    config: row.config as StoredThemeConfig,
    logo: row.logo ?? null,
    background: row.background ?? null,
    note: row.note ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
  };
}

async function storeAsset(slug: string, file: string, bytes: Buffer): Promise<void> {
  const target = themeAssetPath(slug, file);
  if (existsSync(target)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, target);
}

class StoredThemes {
  private static instance: StoredThemes;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  public static getInstance(): StoredThemes {
    if (!StoredThemes.instance) StoredThemes.instance = new StoredThemes();
    return StoredThemes.instance;
  }

  /**
   * Stores a new version: checks the slug, the JSON and the pictures, writes
   * the pictures and then the row, and reloads the scan map so cards get the
   * new versioned slug at once. A pushed slug that also has a folder starts
   * above the folder's own version, so apps holding the folder's theme in
   * their cache take the new one.
   */
  public async push(
    slug: string,
    manifest: unknown,
    uploads: Partial<Record<ThemeAssetKind, Buffer>>,
    opts: { note?: string | null; createdBy?: string | null; checkOnly?: boolean } = {}
  ): Promise<{ theme: StoredThemeVersion | null; name: string; warnings: string[] }> {
    const slugProblem = storedSlugProblem(slug);
    if (slugProblem) throw new StoredThemeError(slugProblem, 409);
    const { config, warnings } = checkThemeManifest(manifest);
    const files: Partial<Record<ThemeAssetKind, string>> = {};
    for (const kind of THEME_ASSET_KINDS) {
      const bytes = uploads[kind];
      if (bytes) files[kind] = await checkThemeAsset(kind, bytes);
    }
    if (!files.logo) {
      warnings.push('no logo: the app shows the QRSong! logo (send a transparent logo.png when the logo is part of the background)');
    }
    if (!files.background) warnings.push('no background: only --app-background shows');
    if (opts.checkOnly) return { theme: null, name: config.name, warnings };

    for (const kind of THEME_ASSET_KINDS) {
      if (files[kind]) await storeAsset(slug, files[kind]!, uploads[kind]!);
    }

    // The unique (slug, version) index settles two pushes at the same moment.
    let row: any = null;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const latest = await this.prisma.appThemeVersion.findFirst({
        where: { slug },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      try {
        row = await this.prisma.appThemeVersion.create({
          data: {
            slug,
            version: Math.max(latest?.version ?? 0, legacyFolderVersion(slug)) + 1,
            name: config.name,
            config: config as any,
            logo: files.logo ?? null,
            background: files.background ?? null,
            note: opts.note ? String(opts.note).slice(0, 500) : null,
            createdBy: opts.createdBy ? String(opts.createdBy).slice(0, 191) : null,
          },
        });
      } catch (error: any) {
        if (error?.code !== 'P2002' || attempt === 2) throw error;
      }
    }
    try {
      await AppTheme.getInstance().reload();
    } catch (error: any) {
      this.logger.log(color.red.bold('Stored theme pushed, but the scan map did not reload: ') + color.white.bold(error.message));
    }
    return { theme: toVersion(row), name: config.name, warnings };
  }

  /** A version, or the newest with `version` null/undefined. */
  public async get(slug: string, version?: number | null): Promise<StoredThemeVersion | null> {
    if (!STORED_THEME_SLUG.test(slug)) return null;
    const row = version
      ? await this.prisma.appThemeVersion.findUnique({ where: { slug_version: { slug, version } } })
      : await this.prisma.appThemeVersion.findFirst({ where: { slug }, orderBy: { version: 'desc' } });
    return row ? toVersion(row) : null;
  }

  /**
   * The stored theme behind a requested slug (its own, or `<slug>--v<n>` from
   * a card: always the newest version). Null when there is none, and when the
   * store cannot be read, so the folder themes keep working without it.
   */
  public async forServe(requestedSlug: string): Promise<StoredThemeVersion | null> {
    const parsed = parseStoredSlug(requestedSlug);
    // An App Designer slug can never be pushed (storedSlugProblem): no query for every customer theme.
    if (!parsed || parseCustomerSlug(parsed.base)) return null;
    try {
      return await this.get(parsed.base);
    } catch (error: any) {
      this.logger.log(color.yellow.bold('Stored app themes unavailable: ') + color.white.bold(error.message));
      return null;
    }
  }

  /** Every stored theme (newest version), the order lines that use it, and the folder themes. */
  public async list() {
    const rows = await this.prisma.appThemeVersion.groupBy({ by: ['slug'], _max: { version: true } });
    const latest = (await Promise.all(rows.map((r) => this.get(r.slug, r._max.version)))).filter(
      (t): t is StoredThemeVersion => !!t
    );
    const usage = await this.prisma.paymentHasPlaylist.groupBy({
      by: ['theme'],
      where: { theme: { in: latest.map((t) => t.slug) } },
      _count: { _all: true },
    });
    const used = new Map(usage.map((u) => [u.theme, u._count._all]));
    let folders: string[] = [];
    try {
      const dir = path.dirname(legacyThemeDir('x'));
      folders = (await fs.readdir(dir)).filter((slug) => existsSync(path.join(dir, slug, `${slug}.json`))).sort();
    } catch {
      folders = [];
    }
    return {
      stored: latest
        .map((t) => ({
          slug: t.slug,
          version: t.version,
          name: t.name,
          updatedAt: t.createdAt,
          note: t.note,
          orderLines: used.get(t.slug) ?? 0,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      folders,
    };
  }

  /** The versions of one stored theme and the order lines that use it. */
  public async history(slug: string) {
    const versions = await this.prisma.appThemeVersion.findMany({
      where: { slug },
      orderBy: { version: 'desc' },
      select: { version: true, name: true, note: true, createdBy: true, createdAt: true },
    });
    if (!versions.length) return null;
    const lines = await this.prisma.paymentHasPlaylist.findMany({
      where: { theme: slug },
      select: { id: true, payment: { select: { paymentId: true, orderId: true } } },
      orderBy: { id: 'desc' },
      take: 200,
    });
    return {
      slug,
      versions,
      orderLines: lines.map((l) => ({
        paymentHasPlaylistId: l.id,
        paymentId: l.payment?.paymentId ?? null,
        orderId: l.payment?.orderId ?? null,
      })),
    };
  }
}

export default StoredThemes;
