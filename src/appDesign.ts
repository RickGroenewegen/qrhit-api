import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import AppTheme from './apptheme';
import { FONTS } from './fonts';
import { ChatGPT } from './chatgpt';

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
export const APP_THEME_ASSET_DIR = 'app-theme';
export const APP_DESIGN_SLUG_PREFIX = 'u';

// Public part of the design row: what both the account page and the
// checkout flow send. Kept as a loose record on purpose; the editor owns
// the shape and the server only needs a few fields out of it.
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

/**
 * Customers write plain text; the app renders helpText with [innerHTML], so
 * everything is escaped and paragraphs are the only markup we add.
 */
export function sanitizeHelpText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (!trimmed) return null;
  return trimmed
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
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
    if (!valueAllowed(kindFor(key), value as string)) {
      rejected.push(key);
      continue;
    }
    cssVariables[key] = (value as string).trim();
  }
  return { cssVariables, rejected };
}

export function slugForPaymentHasPlaylist(phpId: number): string {
  return `${APP_DESIGN_SLUG_PREFIX}${phpId}`;
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

class AppDesign {
  private static instance: AppDesign;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private appTheme = AppTheme.getInstance();
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
      background: sanitizeAssetFilename(body.background ?? design['background']),
      fontId:
        typeof (body.fontId ?? design['fontId']) === 'string'
          ? (body.fontId ?? design['fontId'])
          : null,
    };
    return { input, rejected };
  }

  /**
   * Create or replace the design for an order line, bump its version so the
   * app's cache comparison picks it up, and point the line's theme slug at
   * it. Reloads the in-memory slug map (and broadcasts to other workers).
   */
  public async saveDesign(
    paymentHasPlaylistId: number,
    input: AppDesignInput,
    opts: { reload?: boolean } = {}
  ) {
    const slug = slugForPaymentHasPlaylist(paymentHasPlaylistId);
    const storedTheme = {
      cssVariables: input.theme.cssVariables,
      showMusicalNotes: input.theme.showMusicalNotes !== false,
      showRecord: input.theme.showRecord !== false,
      showEqualizer: input.theme.showEqualizer !== false,
      fontId: input.fontId || null,
    };
    const existing = await this.prisma.appDesign.findUnique({
      where: { paymentHasPlaylistId },
      select: { version: true },
    });
    const version = (existing?.version || 0) + 1;
    const row = await this.prisma.appDesign.upsert({
      where: { paymentHasPlaylistId },
      create: {
        paymentHasPlaylistId,
        slug,
        name: input.name || 'My QRSong app',
        version,
        design: input.design as any,
        theme: storedTheme as any,
        logo: input.logo || null,
        background: input.background || null,
        helpText: sanitizeHelpText(input.helpText),
      },
      update: {
        name: input.name || 'My QRSong app',
        version,
        design: input.design as any,
        theme: storedTheme as any,
        logo: input.logo || null,
        background: input.background || null,
        helpText: sanitizeHelpText(input.helpText),
      },
    });
    await this.prisma.paymentHasPlaylist.update({
      where: { id: paymentHasPlaylistId },
      data: { theme: slug, themeName: row.name },
    });
    if (opts.reload !== false) {
      await this.appTheme.reload();
    }
    this.logger.log(
      color.blue.bold(
        `Saved app design ${white.bold(slug)} version ${white.bold(
          String(version)
        )}`
      )
    );
    return row;
  }

  public async getBySlug(slug: string) {
    return this.prisma.appDesign.findUnique({ where: { slug } });
  }

  public async getByPaymentHasPlaylistId(paymentHasPlaylistId: number) {
    return this.prisma.appDesign.findUnique({ where: { paymentHasPlaylistId } });
  }

  /**
   * The exact shape the scan app expects from GET /theme/:slug. Asset URLs
   * carry the version as a cache buster, same trick as the file-based route.
   */
  public buildThemeResponse(row: {
    slug: string;
    name: string;
    version: number;
    theme: any;
    logo: string | null;
    background: string | null;
    helpText: string | null;
  }): ThemeConfig {
    const theme = (row.theme || {}) as Record<string, any>;
    const apiUri = process.env['API_URI'] || '';
    const v = row.version;
    return {
      id: row.slug,
      name: row.name,
      version: v,
      cacheTTL: APP_THEME_CACHE_TTL,
      showMusicalNotes: theme['showMusicalNotes'] !== false,
      showRecord: theme['showRecord'] !== false,
      showEqualizer: theme['showEqualizer'] !== false,
      cssVariables: theme['cssVariables'] || {},
      assets: {
        logo: row.logo ? `${apiUri}/theme/${row.slug}/logo?v=${v}` : null,
        background: row.background
          ? `${apiUri}/theme/${row.slug}/background?v=${v}`
          : null,
      },
      fonts: fontsForId(theme['fontId']),
      helpText: row.helpText || null,
    };
  }

  /**
   * Resolve an asset request for a DB-backed theme to a file on disk, or
   * null when the theme or the asset does not exist.
   */
  public async resolveAssetPath(
    slug: string,
    kind: 'logo' | 'background'
  ): Promise<string | null> {
    const row = await this.getBySlug(slug);
    const filename = row ? row[kind] : null;
    if (!filename) return null;
    const filePath = this.assetPath(filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      return null;
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
