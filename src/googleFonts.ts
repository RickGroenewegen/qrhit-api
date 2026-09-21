import { color, white } from 'console-log-colors';
import Logger from './logger';
import Cache from './cache';
import { findFont, getGoogleFontWeights } from './fonts';

/**
 * The full Google Fonts catalogue, for business orders that need a font
 * outside the fixed list in fonts.ts.
 *
 * The fixed list is what customers pick from and ships with a deploy. Admins
 * can instead select any family from this catalogue in the card designer; the
 * order then stores an ordinary `selectedFont` CSS string whose leading family
 * is the Google name, exactly as the fixed fonts do. Nothing downstream needs
 * to know the difference except the weights: Google's css2 endpoint rejects a
 * request for a weight the family does not have, so the weights for an
 * unlisted font have to come from the catalogue rather than the '400;700'
 * default.
 *
 * The catalogue is fetched from the Web Fonts Developer API with the project's
 * GOOGLE_API_KEY and cached in Redis for a day; each worker also keeps an
 * in-memory copy so a PDF render does not touch Redis per page.
 */

export interface GoogleFontFamily {
  family: string;
  category: string;
  /** Upright weights the family offers, ascending, e.g. ['400', '700']. */
  weights: string[];
}

const CACHE_KEY = 'google_fonts:catalogue';
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const API_URL = 'https://www.googleapis.com/webfonts/v1/webfonts';

/** Generic CSS family to fall back on, by Google category. */
const CATEGORY_FALLBACK: Record<string, string> = {
  serif: 'serif',
  'sans-serif': 'sans-serif',
  display: 'sans-serif',
  handwriting: 'cursive',
  monospace: 'monospace',
};

/**
 * Google lists variants as 'regular', 'italic', '700', '700italic', ...
 * Only upright weights matter for the cards.
 */
export function variantsToWeights(variants: string[]): string[] {
  const weights = new Set<string>();
  for (const variant of variants) {
    if (variant === 'regular') weights.add('400');
    else if (/^\d+$/.test(variant)) weights.add(variant);
  }
  return [...weights].sort((a, b) => Number(a) - Number(b));
}

/**
 * The CSS family string the designer stores for a catalogue font. Mirrors the
 * shape of the fixed entries so findFont()/the PDF partial parse it the same.
 */
export function familyToCss(font: GoogleFontFamily): string {
  const generic = CATEGORY_FALLBACK[font.category] ?? 'sans-serif';
  return `"${font.family}", Arial, ${generic}`;
}

/** Leading family name of a selectedFont string, quotes stripped. */
function leadingFamily(selectedFont: string): string {
  return selectedFont.split(',')[0].trim().replace(/["']/g, '');
}

class GoogleFonts {
  private static instance: GoogleFonts;
  private logger = new Logger();
  private cache = Cache.getInstance();
  private memo: { list: GoogleFontFamily[]; expiresAt: number } | null = null;

  private constructor() {}

  public static getInstance(): GoogleFonts {
    if (!GoogleFonts.instance) {
      GoogleFonts.instance = new GoogleFonts();
    }
    return GoogleFonts.instance;
  }

  /**
   * Every family Google offers, alphabetical. Empty when the key is missing
   * or Google is unreachable, never a throw: a failed lookup must not break a
   * PDF render or the designer, it only means the '400' fallback applies.
   */
  public async getCatalogue(): Promise<GoogleFontFamily[]> {
    if (this.memo && this.memo.expiresAt > Date.now()) return this.memo.list;

    try {
      const cached = await this.cache.get(CACHE_KEY);
      if (cached) {
        const list = JSON.parse(cached) as GoogleFontFamily[];
        this.remember(list);
        return list;
      }
    } catch (error) {
      this.logger.log(
        color.yellow.bold(`[${white.bold('GoogleFonts')}] Cache read failed: ${(error as Error).message}`)
      );
    }

    const list = await this.fetchCatalogue();
    if (list.length) {
      this.remember(list);
      try {
        await this.cache.set(CACHE_KEY, JSON.stringify(list), CACHE_TTL_SECONDS);
      } catch (error) {
        this.logger.log(
          color.yellow.bold(`[${white.bold('GoogleFonts')}] Cache write failed: ${(error as Error).message}`)
        );
      }
    }
    return list;
  }

  /** Case-insensitive lookup of one family by its Google name. */
  public async findFamily(name: string): Promise<GoogleFontFamily | undefined> {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return undefined;
    const list = await this.getCatalogue();
    return list.find((font) => font.family.toLowerCase() === wanted);
  }

  /**
   * Weight string ('400;700') to request for a selectedFont CSS string.
   * Fixed fonts keep their configured weights; anything else is looked up in
   * the catalogue. Unknown fonts get '400', which every family has.
   */
  public async resolveWeights(selectedFont: string | null | undefined): Promise<string> {
    if (!selectedFont) return '400;700';
    if (findFont(selectedFont)) return getGoogleFontWeights(selectedFont);

    const match = await this.findFamily(leadingFamily(selectedFont));
    return match && match.weights.length ? match.weights.join(';') : '400';
  }

  /**
   * A drop-in for the `getGoogleFontWeights` view helper with the order's own
   * font pre-resolved, so the synchronous EJS partial can serve catalogue
   * fonts without doing the async lookup itself.
   */
  public async weightsHelper(selectedFont: string | null | undefined): Promise<(font: string) => string> {
    const resolved = await this.resolveWeights(selectedFont);
    return (font: string) => (font === selectedFont ? resolved : getGoogleFontWeights(font));
  }

  private remember(list: GoogleFontFamily[]): void {
    this.memo = { list, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
  }

  private async fetchCatalogue(): Promise<GoogleFontFamily[]> {
    const key = process.env['GOOGLE_API_KEY'];
    if (!key) {
      this.logger.log(
        color.yellow.bold(`[${white.bold('GoogleFonts')}] GOOGLE_API_KEY not set, catalogue unavailable`)
      );
      return [];
    }

    try {
      const response = await fetch(`${API_URL}?key=${encodeURIComponent(key)}&sort=alpha`);
      if (!response.ok) {
        this.logger.log(
          color.red.bold(`[${white.bold('GoogleFonts')}] Catalogue request failed: HTTP ${response.status}`)
        );
        return [];
      }
      const body = (await response.json()) as {
        items?: { family: string; category: string; variants: string[] }[];
      };
      const list = (body.items ?? []).map((item) => ({
        family: item.family,
        category: item.category,
        weights: variantsToWeights(item.variants ?? []),
      }));
      this.logger.log(
        color.blue.bold(`[${white.bold('GoogleFonts')}] Loaded catalogue: ${white.bold(String(list.length))} families`)
      );
      return list;
    } catch (error) {
      this.logger.log(
        color.red.bold(`[${white.bold('GoogleFonts')}] Catalogue request failed: ${(error as Error).message}`)
      );
      return [];
    }
  }
}

export default GoogleFonts;
