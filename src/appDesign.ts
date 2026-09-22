import fs from 'fs/promises';
import path from 'path';
import { randomInt } from 'crypto';
import sharp from 'sharp';
import sanitizeHtml from 'sanitize-html';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import AppTheme from './apptheme';
import Cache from './cache';
import { FONTS } from './fonts';
import { ChatGPT } from './chatgpt';
import { round2 } from './services/discount-allocation';

/**
 * Customer-made scan-app themes ("App Designer").
 *
 * The scan app reads a ThemeConfig from GET /theme/:slug and applies every
 * `--app-*` entry in `cssVariables` as an inline custom property on <html>.
 * The color math that turns the guided editor controls into those ~45
 * variables lives in the frontend (app-design.utils.ts), because the live
 * preview needs it there anyway. The API therefore never derives a theme: it
 * validates what the client derived (key whitelist + value grammar), stores
 * it, and serves it back. Assets (logo, background) and the font URL are the
 * two things the server owns, so a client cannot point the app at foreign
 * URLs.
 *
 * App Designer is an upgrade on the account (APP_DESIGN_PRICE, one
 * AppDesignPurchase row). The account has one default design, used for every
 * playlist the user paid for, and each order line may override it with its
 * own design or with the plain QRSong! look. A save publishes a theme file in
 * the same layout as the hand-made B2B themes (src/_data/themes/<slug>/),
 * under PUBLIC_DIR/customer-themes/<slug>/.
 *
 * The served slug carries the version (`<slug>-<version>`). The app only
 * reloads a theme when the slug of a scan differs from the active theme's id,
 * so a fixed slug would hide every edit until the app restarts. With the
 * version in the slug the next scan after a save is a new slug, and the
 * released app picks the change up without an update.
 */

// Every custom property the scan app reads. Mirrors the defaultTheme in
// qrhit-app/src/app/services/dynamic-theme.service.ts plus the handful of
// per-component extras (see the `var(--app-*)` grep in that repo). A theme
// may set fewer, never more.
export const APP_THEME_VARIABLE_KEYS: readonly string[] = [
  '--app-background',
  '--app-text-color',
  '--app-text-shadow',
  '--app-button-background',
  '--app-button-text-color',
  '--app-button-background-hover',
  '--app-button-background-activated',
  '--app-button-background-disabled',
  '--app-button-text-color-disabled',
  '--app-choice-block-background',
  '--app-choice-block-background-hover',
  '--app-choice-block-background-active',
  '--app-choice-block-background-selected',
  '--app-choice-block-border-selected',
  '--app-choice-block-text-color',
  '--app-musical-note-color',
  '--app-musical-note-shadow',
  '--app-modal-header-background',
  '--app-modal-header-text-color',
  '--app-header-text-color',
  '--app-modal-content-background',
  '--app-modal-content-text-color',
  '--app-modal-link-color',
  '--app-scanner-guide-color',
  '--app-flash-button-background-active',
  '--app-logo-filter',
  '--app-vinyl-gradient',
  '--app-vinyl-border',
  '--app-vinyl-center-background',
  '--app-vinyl-center-border',
  '--app-equalizer-color',
  '--app-equalizer-offset-y',
  '--app-scan-button-background',
  '--app-scan-button-border',
  '--app-camera-icon-color',
  '--app-camera-icon-offset-y',
  '--app-tap-text-color',
  '--app-border-color',
  '--app-input-background',
  '--app-button-accept-background',
  '--app-button-accept-background-hover',
  '--app-button-accept-text-color',
  '--app-button-secondary-background',
  '--app-button-secondary-background-hover',
  '--app-button-secondary-text-color',
  '--app-button-secondary-border-color',
  '--app-footer-text-color',
  '--app-get-more-cards-text-color',
  '--app-display-font-family',
];

export const APP_THEME_CACHE_TTL = 86400;
// Editor uploads (random filenames) land here; a save copies the ones a
// design uses into its theme directory as logo.png / background.png.
export const APP_THEME_ASSET_DIR = 'app-theme';
// Published customer themes, one directory per slug.
export const CUSTOMER_THEME_DIR = 'customer-themes';

// Base slug of a customer theme: `c` plus 10 random characters. Random, not
// an id, because GET /theme/:slug is public and customer photos must not be
// enumerable. Hand-made theme slugs never take this shape.
const CUSTOMER_SLUG_BASE = /^c[a-z0-9]{10}$/;
const CUSTOMER_SLUG_SERVED = /^(c[a-z0-9]{10})-(\d{1,9})$/;
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type AppDesignScope = { userId: number; paymentHasPlaylistId?: number };
// What an order line does: follow the account default, use its own design,
// or show the plain QRSong! app.
export type AppDesignOverrideMode = 'default' | 'custom' | 'standard';
export const APP_DESIGN_OVERRIDE_MODES: readonly AppDesignOverrideMode[] = [
  'default',
  'custom',
  'standard',
];

export function newCustomerSlug(): string {
  let slug = 'c';
  for (let i = 0; i < 10; i++) slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return slug;
}

/** The slug the scan app gets: the base slug plus the current version. */
export function servedCustomerSlug(slug: string, version: number): string {
  return `${slug}-${version}`;
}

/**
 * `c…-<n>` as served to the app, or a bare base slug, back to the base.
 * Null for anything else (a hand-made theme slug).
 */
export function parseCustomerSlug(slug: string): { base: string; version: number | null } | null {
  const served = CUSTOMER_SLUG_SERVED.exec(slug);
  if (served) return { base: served[1], version: parseInt(served[2], 10) };
  if (CUSTOMER_SLUG_BASE.test(slug)) return { base: slug, version: null };
  return null;
}

export function scopeKeyFor(scope: AppDesignScope): string {
  return scope.paymentHasPlaylistId ? `p${scope.paymentHasPlaylistId}` : `u${scope.userId}`;
}

// What the account page sends. Kept as a loose record on purpose; the editor
// owns the shape and the server only needs a few fields out of it.
export interface AppDesignInput {
  design: Record<string, unknown>;
  theme: {
    cssVariables: Record<string, string>;
    showMusicalNotes?: boolean;
    showRecord?: boolean;
    showEqualizer?: boolean;
  };
  name?: string;
  helpText?: string | null;
  logo?: string | null;
  background?: string | null;
  fontId?: string | null;
}

export interface ThemeConfig {
  id: string;
  name: string;
  version: number;
  cacheTTL: number;
  showMusicalNotes: boolean;
  showRecord: boolean;
  showEqualizer: boolean;
  cssVariables: Record<string, string>;
  assets: { logo: string | null; background: string | null };
  fonts: { family: string; url: string | null };
  helpText: string | null;
}

// Where a theme came from: a hand-made B2B theme in src/_data/themes, or a
// customer design from the App Designer. Sent along in GET /theme/:slug; the
// released app ignores fields it does not know.
export type ThemeSource = 'business' | 'customer';

export interface PaletteSuggestion {
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  accentTextColor: string;
  buttonStyle: 'accent' | 'glass';
  fontId: string;
  showMusicalNotes: boolean;
  mood: string;
  source: 'ai' | 'fallback';
}

const HEX = /^#[0-9a-f]{3,8}$/i;
// One CSS color: hex, rgb()/rgba() with numbers and an optional alpha, or a
// small set of keywords the derivation uses.
const COLOR =
  '(?:#[0-9a-fA-F]{3,8}|rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*(?:0|1|0?\\.\\d+)\\s*)?\\)|transparent|white|black|none)';
const COLOR_RE = new RegExp(`^${COLOR}$`);
// linear-gradient(135deg, c1, c2[, c3]) / radial-gradient(circle at 30% 30%, c1 40%, c2 70%, c3 100%)
const GRADIENT_RE = new RegExp(
  `^(?:linear|radial)-gradient\\(\\s*(?:-?\\d{1,3}deg|circle(?: at \\d{1,3}% \\d{1,3}%)?)\\s*(?:,\\s*${COLOR}(?:\\s+\\d{1,3}%)?\\s*){2,4}\\)$`
);
// "1px 1px 2px rgba(0,0,0,0.35)" or several such tuples, or none.
const SHADOW_RE = new RegExp(
  `^(?:none|(?:-?\\d{1,2}px\\s+-?\\d{1,2}px\\s+\\d{1,2}px\\s+${COLOR})(?:\\s*,\\s*-?\\d{1,2}px\\s+-?\\d{1,2}px\\s+\\d{1,2}px\\s+${COLOR}){0,3})$`
);
// The one image a theme value may name: the photo bundled in the scan app
// (qrhit-app src/assets/images/bg-disco.webp), which its built-in theme uses
// in exactly this form. The URL is relative, so the app paints its own copy:
// no file is published and nothing is downloaded. Every other url() is
// refused. The App Designer offers it as the "QRSong! photo" background.
export const APP_BUNDLED_BACKGROUND_URL = 'assets/images/bg-disco.webp';
const BUNDLED_BACKGROUND_RE = new RegExp(
  `^${COLOR} url\\("assets/images/bg-disco\\.webp"\\) center / cover no-repeat$`
);
const LENGTH_RE = /^-?\d{1,3}(?:px|%)$/;
const FILTER_RE =
  /^(?:none|(?:(?:brightness|contrast|invert|grayscale|saturate)\(\d{1,3}(?:\.\d+)?%?\)\s*){1,4})$/;
const FONT_FAMILY_RE = /^[A-Za-z0-9 ,'"\-]{1,160}$/;

type ValueKind = 'color' | 'background' | 'shadow' | 'length' | 'filter' | 'font';

function kindFor(key: string): ValueKind {
  if (key === '--app-background' || key === '--app-modal-content-background') {
    return 'background';
  }
  if (key === '--app-vinyl-gradient') return 'background';
  if (key.endsWith('-shadow')) return 'shadow';
  if (key.endsWith('-offset-y')) return 'length';
  if (key === '--app-logo-filter') return 'filter';
  if (key === '--app-display-font-family') return 'font';
  return 'color';
}

function valueAllowed(kind: ValueKind, value: string): boolean {
  if (typeof value !== 'string' || value.length > 240) return false;
  if (/url\s*\(|expression|javascript:|<|>|;|\\/i.test(value)) return false;
  switch (kind) {
    case 'color':
      return COLOR_RE.test(value);
    case 'background':
      return COLOR_RE.test(value) || GRADIENT_RE.test(value);
    case 'shadow':
      return SHADOW_RE.test(value);
    case 'length':
      return LENGTH_RE.test(value);
    case 'filter':
      return FILTER_RE.test(value);
    case 'font':
      return FONT_FAMILY_RE.test(value);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// What the help text may contain: the formats the App Designer's editor
// offers (Quill: headings, bold, italic, underline, lists, links), which are
// also the tags the app's help screen styles (help-modal.component.scss).
const HELP_TEXT_HTML: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  transformTags: {
    h1: 'h2',
    h4: 'h3',
    h5: 'h3',
    h6: 'h3',
    b: 'strong',
    i: 'em',
    div: 'p',
    // The app runs in a webview: a link must open outside it, like the
    // links in its own help text, or it would replace the app.
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

/**
 * The help text the app shows, as HTML: the app renders it with
 * [innerHTML]. The editor sends HTML, which is cut down to HELP_TEXT_HTML.
 * Plain text (designs saved before the editor had formatting) is escaped
 * and gets paragraphs, as it always did.
 */
export function sanitizeHelpText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  if (!/<[a-z][^>]*>/i.test(trimmed)) {
    return trimmed
      .slice(0, 4000)
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  const html = sanitizeHtml(trimmed.slice(0, 20000), HELP_TEXT_HTML)
    // Quill 2.0.3 writes every space as &nbsp;, which would never wrap.
    .replace(/&nbsp;| /g, ' ')
    // Empty lines at the start or end of the editor.
    .replace(/^(?:\s*<p>(?:\s|<br \/>)*<\/p>)+|(?:<p>(?:\s|<br \/>)*<\/p>\s*)+$/g, '')
    .trim();
  const hasText = html.replace(/<[^>]+>/g, '').trim().length > 0;
  return hasText ? html : null;
}

/**
 * Keep only the keys the app knows and only values the grammar accepts.
 * Returns the cleaned map and the keys that were dropped, so a route can
 * tell the client what it lost instead of failing silently.
 */
export function validateCssVariables(input: unknown): {
  cssVariables: Record<string, string>;
  rejected: string[];
} {
  const cssVariables: Record<string, string> = {};
  const rejected: string[] = [];
  if (!input || typeof input !== 'object') {
    return { cssVariables, rejected: ['cssVariables'] };
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!APP_THEME_VARIABLE_KEYS.includes(key)) {
      rejected.push(key);
      continue;
    }
    const bundledBackground =
      key === '--app-background' &&
      typeof value === 'string' &&
      BUNDLED_BACKGROUND_RE.test(value.trim());
    if (!bundledBackground && !valueAllowed(kindFor(key), value as string)) {
      rejected.push(key);
      continue;
    }
    cssVariables[key] = (value as string).trim();
  }
  return { cssVariables, rejected };
}

export function isValidThemeSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

/**
 * Only a bare filename produced by our own upload route is acceptable as an
 * asset reference; anything with a path separator or an odd extension is
 * dropped rather than failing the whole save.
 */
export function sanitizeAssetFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!/^[a-z0-9]{8,64}\.(?:png|jpg|jpeg|webp)$/i.test(name)) return null;
  return name;
}

export function fontById(fontId: unknown) {
  if (typeof fontId !== 'string' || !fontId) return null;
  return FONTS.find((f) => f.id === fontId && f.googleFontName) || null;
}

/**
 * The `fonts` block the app consumes. Built here from the font catalogue so
 * the client never supplies a stylesheet URL.
 */
export function fontsForId(fontId: unknown): ThemeConfig['fonts'] {
  const font = fontById(fontId);
  if (!font) {
    return {
      family:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      url: null,
    };
  }
  const weights = font.googleFontWeights || '400;700';
  return {
    family: font.family,
    url: `https://fonts.googleapis.com/css2?family=${font.googleFontName.replace(
      / /g,
      '+'
    )}:wght@${weights}&display=swap`,
  };
}

/** What the access check needs to know about an order line. */
export interface AppDesignLine {
  payment: { userId: number; status: string };
  playlist: { type: string | null };
}

/**
 * Why this order line's app design may not be worked on, as the HTTP status
 * and message to send, or null when it may. A customer (`requesterUserId`)
 * must own the line; an admin (null) acts for whoever does. Either way the
 * line has to be a paid card order.
 */
export function appDesignLineError(
  line: AppDesignLine | null,
  requesterUserId: number | null
): { status: number; error: string } | null {
  if (!line) {
    return { status: 404, error: 'PaymentHasPlaylist not found' };
  }
  if (requesterUserId !== null && line.payment.userId !== requesterUserId) {
    return { status: 403, error: 'Unauthorized' };
  }
  if (line.payment.status !== 'paid' || line.playlist.type === 'giftcard') {
    return { status: 400, error: 'App design is only available for paid card orders' };
  }
  return null;
}

class AppDesign {
  private static instance: AppDesign;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private appTheme = AppTheme.getInstance();
  private cache = Cache.getInstance();
  private chatgpt = new ChatGPT();

  private constructor() {}

  public static getInstance(): AppDesign {
    if (!AppDesign.instance) {
      AppDesign.instance = new AppDesign();
    }
    return AppDesign.instance;
  }

  public assetDir(): string {
    return path.join(process.env['PUBLIC_DIR'] as string, APP_THEME_ASSET_DIR);
  }

  public assetPath(filename: string): string {
    return path.join(this.assetDir(), filename);
  }

  public customerThemeRoot(): string {
    return path.join(process.env['PUBLIC_DIR'] as string, CUSTOMER_THEME_DIR);
  }

  /** Directory of one published customer theme (base slug, no version). */
  public customerThemeDir(slug: string): string {
    return path.join(this.customerThemeRoot(), slug);
  }

  /** True when the account owns the App Designer upgrade. */
  public async isEntitled(userId: number): Promise<boolean> {
    const count = await this.prisma.appDesignPurchase.count({ where: { userId } });
    return count > 0;
  }

  /** The account's default design and every override, keyed for the account page. */
  public async getDesigns(userId: number) {
    const rows = await this.prisma.appDesign.findMany({ where: { userId } });
    return {
      defaultDesign: rows.find((r) => r.paymentHasPlaylistId === null) || null,
      overrides: rows.filter((r) => r.paymentHasPlaylistId !== null),
    };
  }

  /**
   * Validate a client payload. Throws with a readable message on structural
   * problems; drops individual bad variables and reports them.
   */
  public normalizeInput(body: any): {
    input: AppDesignInput;
    rejected: string[];
  } {
    if (!body || typeof body !== 'object') {
      throw new Error('Missing design payload');
    }
    const design =
      body.design && typeof body.design === 'object' ? body.design : null;
    if (!design) {
      throw new Error('Missing design state');
    }
    if (JSON.stringify(design).length > 20000) {
      throw new Error('Design state too large');
    }
    const themeIn = body.theme && typeof body.theme === 'object' ? body.theme : {};
    const { cssVariables, rejected } = validateCssVariables(themeIn.cssVariables);
    if (Object.keys(cssVariables).length === 0) {
      throw new Error('Theme has no valid CSS variables');
    }
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 120)
        : typeof design['name'] === 'string' && (design['name'] as string).trim()
          ? (design['name'] as string).trim().slice(0, 120)
          : 'My QRSong app';

    const input: AppDesignInput = {
      design,
      theme: {
        cssVariables,
        showMusicalNotes: themeIn.showMusicalNotes !== false,
        showRecord: themeIn.showRecord !== false,
        showEqualizer: themeIn.showEqualizer !== false,
      },
      name,
      helpText:
        typeof body.helpText === 'string'
          ? body.helpText
          : typeof design['helpText'] === 'string'
            ? (design['helpText'] as string)
            : null,
      logo: sanitizeAssetFilename(body.logo ?? design['logo']),
      // A photo uploaded earlier stays in the editor state when the customer
      // switches to a colour or gradient; publishing it then would show the
      // photo in the app while the preview shows the colour.
      background:
        design['backgroundType'] === 'image'
          ? sanitizeAssetFilename(body.background ?? design['background'])
          : null,
      fontId:
        typeof (body.fontId ?? design['fontId']) === 'string'
          ? (body.fontId ?? design['fontId'])
          : null,
    };
    return { input, rejected };
  }

  /**
   * Save the account default (no paymentHasPlaylistId) or a playlist's own
   * design: upsert the row, bump the version, publish the theme file and
   * reload the scan map (broadcast to every worker). Saving a playlist's
   * design also switches that line to `custom`.
   *
   * Saving does not need the upgrade: a design saved before paying is stored
   * and published, but src/apptheme.ts only hands its slug to a scan once the
   * account owns an AppDesignPurchase, so nothing unpaid reaches the app.
   */
  public async saveDesign(scope: AppDesignScope, input: AppDesignInput) {
    const scopeKey = scopeKeyFor(scope);
    const storedTheme = {
      cssVariables: input.theme.cssVariables,
      showMusicalNotes: input.theme.showMusicalNotes !== false,
      showRecord: input.theme.showRecord !== false,
      showEqualizer: input.theme.showEqualizer !== false,
      fontId: input.fontId || null,
    };
    const fields = {
      name: input.name || 'My QRSong app',
      mode: 'custom',
      design: input.design as any,
      theme: storedTheme as any,
      logo: input.logo || null,
      background: input.background || null,
      helpText: sanitizeHelpText(input.helpText),
    };
    const existing = await this.prisma.appDesign.findUnique({
      where: { scopeKey },
      select: { id: true, version: true },
    });
    const row = existing
      ? await this.prisma.appDesign.update({
          where: { id: existing.id },
          data: { ...fields, version: existing.version + 1 },
        })
      : await this.createRow(scope, scopeKey, fields);

    await this.publishThemeFiles(row);
    await this.appTheme.reload();
    this.logger.log(
      color.blue.bold(
        `Saved app design ${white.bold(scopeKey)} as ${white.bold(
          servedCustomerSlug(row.slug, row.version)
        )}`
      )
    );
    return row;
  }

  /**
   * Choose what a playlist shows: the account default, its own design or
   * the plain QRSong! app. `custom` needs a saved design; the other two
   * keep whatever design the line had, so switching back loses nothing.
   */
  public async setOverrideMode(
    userId: number,
    paymentHasPlaylistId: number,
    mode: AppDesignOverrideMode
  ) {
    const scope = { userId, paymentHasPlaylistId };
    const scopeKey = scopeKeyFor(scope);
    const existing = await this.prisma.appDesign.findUnique({ where: { scopeKey } });
    if (mode === 'custom' && !existing?.theme) {
      throw new Error('This playlist has no design of its own yet');
    }
    const row = existing
      ? await this.prisma.appDesign.update({
          where: { id: existing.id },
          data: { mode },
        })
      : await this.createRow(scope, scopeKey, { name: 'My QRSong app', mode });
    await this.appTheme.reload();
    return row;
  }

  /** New row with a fresh random slug; retries the rare slug collision. */
  private async createRow(scope: AppDesignScope, scopeKey: string, fields: Record<string, any>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.appDesign.create({
          data: {
            ...fields,
            userId: scope.userId,
            paymentHasPlaylistId: scope.paymentHasPlaylistId ?? null,
            scopeKey,
            slug: newCustomerSlug(),
            version: 1,
          } as any,
        });
      } catch (error: any) {
        const collided =
          error?.code === 'P2002' && String(error?.meta?.target || '').includes('slug');
        if (!collided || attempt >= 3) throw error;
      }
    }
  }

  /**
   * The theme file, in the shape of the hand-made themes. `id` is the base
   * slug and `assets` are left null: GET /theme/:slug sets the served id and
   * builds the asset URLs from the files next to the JSON, as it does for the
   * hand-made ones.
   */
  public buildThemeFile(row: {
    slug: string;
    name: string;
    version: number;
    theme: any;
    helpText: string | null;
  }): ThemeConfig {
    const theme = (row.theme || {}) as Record<string, any>;
    return {
      id: row.slug,
      name: row.name,
      version: row.version,
      cacheTTL: APP_THEME_CACHE_TTL,
      showMusicalNotes: theme['showMusicalNotes'] !== false,
      showRecord: theme['showRecord'] !== false,
      showEqualizer: theme['showEqualizer'] !== false,
      cssVariables: theme['cssVariables'] || {},
      assets: { logo: null, background: null },
      fonts: fontsForId(theme['fontId']),
      helpText: row.helpText || null,
    };
  }

  /**
   * Write `<slug>.json`, `logo.png` and `background.png` for a row. Every
   * file is written to a temporary name and renamed, so a worker serving the
   * theme at the same moment never reads half a file. An asset the design no
   * longer uses is removed.
   */
  public async publishThemeFiles(row: {
    slug: string;
    name: string;
    version: number;
    theme: any;
    helpText: string | null;
    logo: string | null;
    background: string | null;
  }): Promise<void> {
    const dir = this.customerThemeDir(row.slug);
    await fs.mkdir(dir, { recursive: true });
    for (const kind of ['logo', 'background'] as const) {
      const target = path.join(dir, `${kind}.png`);
      const upload = row[kind] ? sanitizeAssetFilename(row[kind]) : null;
      if (!upload) {
        await fs.rm(target, { force: true });
        continue;
      }
      const temp = `${target}.${process.pid}.tmp`;
      // Uploads are PNG already; anything else is converted so the file name
      // keeps telling the truth about its content.
      if (upload.toLowerCase().endsWith('.png')) {
        await fs.copyFile(this.assetPath(upload), temp);
      } else {
        await sharp(this.assetPath(upload)).png().toFile(temp);
      }
      await fs.rename(temp, target);
    }
    const json = path.join(dir, `${row.slug}.json`);
    const temp = `${json}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.buildThemeFile(row), null, 2));
    await fs.rename(temp, json);
  }

  /**
   * Record a paid App Designer purchase. Idempotent on the Mollie payment id,
   * because Mollie replays webhooks. `price` is the VAT-inclusive EUR amount
   * that was charged (APP_DESIGN_PRICE when the payment was created); the
   * ex-VAT and VAT parts are stored so no report has to derive them.
   */
  public async processUpgradePayment(params: {
    userId: number;
    molliePaymentId: string;
    price: number;
    taxRate: number;
    countrycode: string;
    currency: string;
    amountCharged: number;
  }): Promise<{ success: boolean; created: boolean; purchaseId?: number; error?: string }> {
    try {
      const existing = await this.prisma.appDesignPurchase.findUnique({
        where: { molliePaymentId: params.molliePaymentId },
        select: { id: true },
      });
      if (existing) {
        this.logger.log(
          color.yellow.bold(
            `App Designer webhook replay ignored for ${white.bold(params.molliePaymentId)}`
          )
        );
        return { success: true, created: false, purchaseId: existing.id };
      }
      if (await this.isEntitled(params.userId)) {
        // Paid twice (two tabs, say). The money came in, so it is booked;
        // a refund is a manual decision.
        this.logger.log(
          color.yellow.bold(
            `User ${white.bold(String(params.userId))} bought App Designer again (${white.bold(
              params.molliePaymentId
            )})`
          )
        );
      }
      const totalPriceWithoutTax = round2(params.price / (1 + params.taxRate / 100));
      let purchase;
      try {
        purchase = await this.prisma.appDesignPurchase.create({
          data: {
            userId: params.userId,
            molliePaymentId: params.molliePaymentId,
            totalPrice: params.price,
            totalPriceWithoutTax,
            totalVAT: round2(params.price - totalPriceWithoutTax),
            taxRate: params.taxRate,
            countrycode: params.countrycode,
            currency: params.currency,
            amountCharged: params.amountCharged,
          },
        });
      } catch (error: any) {
        // Two webhook deliveries racing past the check above.
        if (error?.code === 'P2002') return { success: true, created: false };
        throw error;
      }

      const user = await this.prisma.user.findUnique({
        where: { id: params.userId },
        select: { hash: true },
      });
      if (user?.hash) {
        await this.cache.del(`playlists:user:${user.hash}`);
      }
      await this.appTheme.reload();
      this.logger.log(
        color.green.bold(
          `App Designer enabled for user ${white.bold(String(params.userId))} (${white.bold(
            params.molliePaymentId
          )})`
        )
      );
      return { success: true, created: true, purchaseId: purchase.id };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`Failed to record App Designer purchase: ${white.bold(error.message)}`)
      );
      return { success: false, created: false, error: error.message };
    }
  }

  /** A published customer theme file, or null when there is none. */
  public async readThemeFile(slug: string): Promise<ThemeConfig | null> {
    try {
      const raw = await fs.readFile(
        path.join(this.customerThemeDir(slug), `${slug}.json`),
        'utf-8'
      );
      return JSON.parse(raw);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Ask OpenAI for a palette that fits an uploaded background, so the whole
   * app can be themed from one image. Falls back to a deterministic palette
   * from the image's dominant color when the model call fails or returns
   * something unusable, so the button always does something.
   */
  public async suggestPalette(backgroundFilename: string): Promise<PaletteSuggestion> {
    const filePath = this.assetPath(backgroundFilename);
    const buffer = await fs.readFile(filePath);
    const small = await sharp(buffer)
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const fallback = await this.fallbackPalette(small);

    try {
      const fontIds = FONTS.filter((f) => f.id && f.googleFontName).map(
        (f) => f.id
      );
      const suggestion = await this.chatgpt.suggestAppPalette(
        `data:image/jpeg;base64,${small.toString('base64')}`,
        fontIds
      );
      if (!suggestion) return fallback;
      const cleaned: PaletteSuggestion = {
        backgroundColor: normalizeHex(suggestion.backgroundColor) || fallback.backgroundColor,
        textColor: normalizeHex(suggestion.textColor) || fallback.textColor,
        accentColor: normalizeHex(suggestion.accentColor) || fallback.accentColor,
        accentTextColor:
          normalizeHex(suggestion.accentTextColor) || fallback.accentTextColor,
        buttonStyle: suggestion.buttonStyle === 'glass' ? 'glass' : 'accent',
        fontId: fontIds.includes(suggestion.fontId) ? suggestion.fontId : 'system',
        showMusicalNotes: suggestion.showMusicalNotes === true,
        mood: typeof suggestion.mood === 'string' ? suggestion.mood.slice(0, 80) : '',
        source: 'ai',
      };
      return cleaned;
    } catch (error: any) {
      this.logger.log(
        color.yellow.bold(
          `App design palette suggestion failed, using fallback: ${white.bold(
            error?.message || String(error)
          )}`
        )
      );
      return fallback;
    }
  }

  private async fallbackPalette(buffer: Buffer): Promise<PaletteSuggestion> {
    const stats = await sharp(buffer).stats();
    const { r, g, b } = stats.dominant;
    const backgroundColor = rgbToHex(r, g, b);
    const dark = luminance(r, g, b) < 0.45;
    const textColor = dark ? '#ffffff' : '#111111';
    const [ar, ag, ab] = complementary(r, g, b);
    const accentColor = rgbToHex(ar, ag, ab);
    const accentTextColor = luminance(ar, ag, ab) < 0.45 ? '#ffffff' : '#111111';
    return {
      backgroundColor,
      textColor,
      accentColor,
      accentTextColor,
      buttonStyle: 'accent',
      fontId: 'system',
      showMusicalNotes: false,
      mood: '',
      source: 'fallback',
    };
  }
}

function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!HEX.test(v)) return null;
  if (v.length === 4) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  return v.slice(0, 7).toLowerCase();
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Rotate the hue by 180 degrees and push saturation up so the accent stands
 * out against the (often muted) dominant color.
 */
function complementary(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        break;
      case gn:
        h = ((bn - rn) / d + 2) / 6;
        break;
      default:
        h = ((rn - gn) / d + 4) / 6;
    }
  }
  h = (h + 0.5) % 1;
  s = Math.max(0.55, s);
  const lum = 0.55;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = lum < 0.5 ? lum * (1 + s) : lum + s - lum * s;
  const p = 2 * lum - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

export default AppDesign;
