import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Liquid, Template } from 'liquidjs';
import sharp from 'sharp';
import * as fontkit from 'fontkit';
import PrismaInstance from './prisma';
import { CARD_DESIGN_COLUMNS } from './cardDesigns';
import { getYearFontSize } from './fonts';
import { PRINTER_TYPE } from './config/constants';
import Qr, { getQrTotalModules } from './qr';

/**
 * Card templates stored as data instead of code.
 *
 * A company template used to be a views/pdf_<name>.ejs file: JavaScript that
 * runs on the API server, so it could only reach production through a deploy
 * and a restart, and an upload route for it would have been remote code
 * execution behind the admin token. A stored template is Liquid (LiquidJS,
 * the Shopify template language) for the HTML of one card front, one card
 * back and the CSS, plus its own pictures and fonts. Liquid has no access to
 * the process, the file system or the network; it sees only the plain card
 * data built here (no e-mail, address or payment).
 *
 * - Every push is a new, immutable version (card_templates). An order line
 *   pins the version it was given (payment_has_playlist.templateVersion), so
 *   a printed order never changes when its template does.
 * - The page around the cards is the fixed views/stored_card_page.ejs: fonts, the
 *   how-to card, the page breaks between front and back, and the fit script.
 * - The page is served with a Content-Security-Policy (cardTemplateCsp): no
 *   script but our own fit script, pictures and fonts only from this API and
 *   Google Fonts. That is what makes the uploaded HTML safe in the PDF
 *   Lambda's Chromium; checkSource refuses the obvious cases at upload so the
 *   author gets a clear error instead of a silently blocked element.
 * - A file template wins over a stored one of the same name, and a stored
 *   template cannot take the name of a file template.
 */

export const TEMPLATE_NAME = /^[a-z0-9_]+$/;
const STORED_NAME = /^[a-z][a-z0-9_]{1,39}$/;
export const CARD_SIZES_MM = [56, 60] as const;

const MAX_CHARS = { css: 200_000, front: 100_000, back: 100_000 } as const;
const MAX_DATA_CHARS = 100_000;
const MAX_ASSETS = 40;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_ASSETS_BYTES = 60 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const MAX_FONTS = 40;
const COMPILED_CACHE_SIZE = 50;

export class CardTemplateError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface CardTemplateSource {
  /** 56 or 60; null follows the printer (printerCardSizeMm). */
  cardSizeMm: number | null;
  css: string;
  front: string;
  back: string;
  /** Fixed values the template reads as `data`: geometry, lookup tables. Plain JSON. */
  data?: Record<string, unknown> | null;
  /**
   * Load the order's design font (partials/font-import-inline: body and the
   * .text classes in that font, !important). Default true; false for a
   * template that brings its own fonts.
   */
  designFont?: boolean;
  /**
   * The template's own fonts (font assets) as @font-face rules the page
   * writes before the css. Family, weight and style default to what the
   * font file says (fontkit), so `{ "file": "Brand-Bold.otf" }` is enough.
   */
  fonts?: FontFaceDecl[] | null;
}

export interface FontFaceDecl {
  file: string;
  family?: string;
  weight?: number;
  style?: 'normal' | 'italic' | 'oblique';
}

/** A resolved @font-face of a stored version. */
export interface FontFace {
  file: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic' | 'oblique';
  format: FontFormat;
}

export type FontFormat = 'woff2' | 'woff' | 'truetype' | 'opentype';

/** What a font file says about itself. */
export interface FontInfo {
  postscriptName: string;
  family: string;
  subfamily: string;
  weight: number;
  style: 'normal' | 'italic';
  format: FontFormat;
  glyphs: number;
}

export interface CardTemplateVersion extends Omit<CardTemplateSource, 'fonts'> {
  name: string;
  version: number;
  fonts?: FontFace[] | null;
  /** Name used in the template (`'voorkant.png' | asset`) → stored file name. */
  assets: Record<string, string>;
  note?: string | null;
  createdBy?: string | null;
  createdAt?: Date;
}

export interface UploadedAsset {
  name: string;
  bytes: Buffer;
}

// ---------------------------------------------------------------- names, files

/**
 * The folder the PDF renderer reads (server.ts: APP_ROOT/views). tsc puts
 * this file in build/src/, so __dirname/views does not exist in production.
 */
export function viewsDir(): string {
  const appRoot = process.env['APP_ROOT'];
  return appRoot ? path.join(appRoot, 'views') : path.join(__dirname, 'views');
}

export function isFileTemplate(name: string, dir = viewsDir()): boolean {
  return TEMPLATE_NAME.test(name) && existsSync(path.join(dir, `pdf_${name}.ejs`));
}

function assetDir(name: string): string {
  return path.join(process.env['PUBLIC_DIR'] as string, 'card-templates', name);
}

/** The card a printer cuts: Schneiders 56 mm, every other printer 60 mm (pdf.ts printerPageSizeMm). */
export function printerCardSizeMm(printerType: string | null | undefined): number {
  return printerType === PRINTER_TYPE.SCHNEIDERS ? 56 : 60;
}

/**
 * Refuses a stored template drawn for another card than the printer cuts: a
 * 60 mm layout on a Schneiders order would print a page the die does not fit
 * (a pdf_*.ejs file in that spot got a 56 mm page and lost its edges).
 */
export function checkCardSize(
  template: Pick<CardTemplateVersion, 'name' | 'version' | 'cardSizeMm'>,
  printerType: string | null | undefined
): void {
  if (template.cardSizeMm === null) return;
  const cut = printerCardSizeMm(printerType);
  if (template.cardSizeMm !== cut) {
    throw new CardTemplateError(
      `template ${template.name} v${template.version} is drawn for ${template.cardSizeMm} mm cards; ` +
        `printer ${printerType || 'none'} cuts ${cut} mm (make a ${cut} mm template, or one with cardSizeMm "printer")`
    );
  }
}

export function assetUrl(apiUri: string, name: string, file: string): string {
  return `${apiUri}/public/card-templates/${name}/${file}`;
}

// ---------------------------------------------------------------- source checks

interface Rule {
  re: RegExp;
  why: string;
}

/** Elements that run code, load something, or break out of the card. */
const FRAGMENT_RULES: Rule[] = [
  {
    re: /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|link|meta|base|form|input|button|textarea|select|style|template|portal|noscript)\b/i,
    why: 'the <$1> element is not allowed (styling goes in the css, scripts are blocked)',
  },
  { re: /\son[a-z]+\s*=/i, why: 'event handler attributes (onload=, onclick=, …) are not allowed' },
];

const SHARED_RULES: Rule[] = [
  { re: /\b(javascript|vbscript)\s*:/i, why: '$1: URLs are not allowed' },
  { re: /data\s*:\s*text\/html/i, why: 'data:text/html URLs are not allowed' },
  {
    re: /\{%-?\s*(include|render|layout|block)\b/,
    why: 'the {% $1 %} tag is not allowed: a template is one front, one back and the css',
  },
];

const CSS_RULES: Rule[] = [
  { re: /<\s*\/\s*style/i, why: '</style> is not allowed in the css' },
  { re: /expression\s*\(/i, why: 'CSS expression() is not allowed' },
  { re: /-moz-binding|behavior\s*:/i, why: 'CSS bindings are not allowed' },
];

const GOOGLE_FONTS_CSS = 'fonts.googleapis.com';
/** XML namespace names (xmlns="http://www.w3.org/2000/svg") are names, not downloads. */
const NAMESPACE_HOST = 'www.w3.org';

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Every problem with the source, as readable lines; empty when it can be stored. */
export function checkSource(source: CardTemplateSource): string[] {
  const errors: string[] = [];
  if (source.cardSizeMm !== null && !(CARD_SIZES_MM as readonly number[]).includes(source.cardSizeMm)) {
    errors.push(`cardSizeMm must be ${CARD_SIZES_MM.join(' or ')}, or "printer" to follow the printer's card`);
  }
  if (source.fonts !== undefined && source.fonts !== null) {
    if (!Array.isArray(source.fonts)) {
      errors.push('fonts must be a list of { file, family?, weight?, style? }');
    } else {
      if (source.fonts.length > MAX_FONTS) errors.push(`at most ${MAX_FONTS} fonts`);
      source.fonts.forEach((f: any, i) => {
        const at = `fonts[${i}]`;
        if (!f || typeof f !== 'object') return errors.push(`${at} must be an object`);
        if (typeof f.file !== 'string' || !ASSET_NAME.test(f.file)) errors.push(`${at}.file must name a font asset`);
        if (f.family !== undefined && (typeof f.family !== 'string' || !FONT_FAMILY.test(f.family))) {
          errors.push(`${at}.family may only use letters, digits, spaces, _ and - (at most 64)`);
        }
        if (f.weight !== undefined && !(Number.isInteger(f.weight) && f.weight >= 1 && f.weight <= 1000)) {
          errors.push(`${at}.weight must be 1-1000 (400 regular, 700 bold)`);
        }
        if (f.style !== undefined && !['normal', 'italic', 'oblique'].includes(f.style)) {
          errors.push(`${at}.style must be normal, italic or oblique`);
        }
      });
    }
  }
  if (source.designFont !== undefined && typeof source.designFont !== 'boolean') {
    errors.push('designFont must be true or false');
  }
  if (source.data !== undefined && source.data !== null) {
    if (typeof source.data !== 'object' || Array.isArray(source.data)) {
      errors.push('data must be a JSON object');
    } else if (JSON.stringify(source.data).length > MAX_DATA_CHARS) {
      errors.push(`data is longer than ${MAX_DATA_CHARS} characters of JSON`);
    }
  }
  for (const field of ['css', 'front', 'back'] as const) {
    const text = source[field];
    if (typeof text !== 'string') {
      errors.push(`${field} is missing`);
      continue;
    }
    if (text.length > MAX_CHARS[field]) errors.push(`${field} is longer than ${MAX_CHARS[field]} characters`);
    const rules = [...SHARED_RULES, ...(field === 'css' ? CSS_RULES : FRAGMENT_RULES)];
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (m) errors.push(`${field} line ${lineOf(text, m.index)}: ${rule.why.replace('$1', (m[1] ?? '').toLowerCase())}`);
    }
    // Nothing is fetched from outside: pictures and fonts are the template's
    // own assets ('x.png' | asset). The one exception is a Google Fonts
    // stylesheet imported in the css.
    const external = /(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
    let m: RegExpExecArray | null;
    while ((m = external.exec(text))) {
      const host = m[1].toLowerCase();
      if (field === 'css' && host === GOOGLE_FONTS_CSS) continue;
      if (host === NAMESPACE_HOST && /xmlns(:\w+)?\s*=\s*["']?$/i.test(text.slice(Math.max(0, m.index - 20), m.index).replace(/https?:$/i, ''))) continue;
      errors.push(
        `${field} line ${lineOf(text, m.index)}: ${m[0]} is outside the template; upload it as an asset and use 'name' | asset`
      );
    }
    const imports = /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi;
    while ((m = imports.exec(text))) {
      if (!m[1].startsWith(`https://${GOOGLE_FONTS_CSS}/`)) {
        errors.push(`${field} line ${lineOf(text, m.index)}: @import is only allowed for https://${GOOGLE_FONTS_CSS}/`);
      }
    }
  }
  return errors;
}

/** Asset names the source names literally (`'x.png' | asset`). */
export function referencedAssets(source: CardTemplateSource): string[] {
  const names = new Set<string>();
  for (const text of [source.css, source.front, source.back]) {
    const re = /['"]([^'"]+)['"]\s*\|\s*asset\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text || ''))) names.add(m[1]);
  }
  return [...names];
}

// ---------------------------------------------------------------- assets

const ASSET_TYPES: Record<string, { ext: string; image: boolean; names: string[] }> = {
  png: { ext: 'png', image: true, names: ['png'] },
  jpeg: { ext: 'jpg', image: true, names: ['jpg', 'jpeg'] },
  webp: { ext: 'webp', image: true, names: ['webp'] },
  woff2: { ext: 'woff2', image: false, names: ['woff2'] },
  woff: { ext: 'woff', image: false, names: ['woff'] },
  ttf: { ext: 'ttf', image: false, names: ['ttf'] },
  otf: { ext: 'otf', image: false, names: ['otf'] },
};

/** The file type from its first bytes, never from its name. SVG is refused: it can carry script. */
export function detectAssetType(bytes: Buffer): keyof typeof ASSET_TYPES | null {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1');
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 4 && ascii(0, 4) === 'wOF2') return 'woff2';
  if (bytes.length >= 4 && ascii(0, 4) === 'wOFF') return 'woff';
  if (bytes.length >= 4 && (bytes.readUInt32BE(0) === 0x00010000 || ascii(0, 4) === 'true')) return 'ttf';
  if (bytes.length >= 4 && ascii(0, 4) === 'OTTO') return 'otf';
  return null;
}

/** Checks one upload and returns the content-addressed file name it is stored under. */
export async function checkAsset(asset: UploadedAsset): Promise<string> {
  if (!ASSET_NAME.test(asset.name)) {
    throw new CardTemplateError(`asset name "${asset.name}" may only use letters, digits, _ . - (at most 80)`);
  }
  if (asset.bytes.length === 0) throw new CardTemplateError(`asset ${asset.name} is empty`);
  if (asset.bytes.length > MAX_ASSET_BYTES) throw new CardTemplateError(`asset ${asset.name} is larger than 15 MB`);
  const type = detectAssetType(asset.bytes);
  if (!type) {
    if (asset.bytes.subarray(0, 4).toString('latin1') === 'ttcf') {
      throw new CardTemplateError(`asset ${asset.name} is a font collection (.ttc/.otc): export one TTF or OTF per style`);
    }
    throw new CardTemplateError(`asset ${asset.name} is not a PNG, JPEG, WebP, WOFF2, WOFF, TTF or OTF file`);
  }
  const spec = ASSET_TYPES[type];
  const nameExt = path.extname(asset.name).slice(1).toLowerCase();
  if (!spec.names.includes(nameExt)) {
    throw new CardTemplateError(`asset ${asset.name} is a ${type.toUpperCase()} file; name it .${spec.ext}`);
  }
  if (spec.image) {
    const meta = await sharp(asset.bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
      .metadata()
      .catch(() => null);
    if (!meta) throw new CardTemplateError(`asset ${asset.name} cannot be read as an image`);
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_IMAGE_PIXELS) {
      throw new CardTemplateError(`asset ${asset.name} is larger than 50 megapixels`);
    }
  }
  if (!spec.image) describeFont(asset.bytes, asset.name);
  const hash = crypto.createHash('sha256').update(asset.bytes).digest('hex').slice(0, 32);
  return `${hash}.${spec.ext}`;
}

const FONT_FORMATS: Record<string, FontFormat> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

/**
 * Reads a font file the way a browser would have to (fontkit: TTF, OTF,
 * WOFF, WOFF2) and returns its names, weight and style; a file it cannot
 * read is refused here, not discovered as a fallback font on the cards.
 */
export function describeFont(bytes: Buffer, name = 'font'): FontInfo {
  const type = detectAssetType(bytes);
  const format = type ? FONT_FORMATS[type] : undefined;
  if (!format) throw new CardTemplateError(`asset ${name} is not a WOFF2, WOFF, TTF or OTF font`);
  // fontkit parses tables lazily, so a broken file throws on first use.
  let font: any, os2: any, glyphs: number, family: string, subfamily: string, rawWeight: number, italic: boolean;
  try {
    font = fontkit.create(bytes);
    if (!font || Array.isArray(font.fonts)) {
      throw new CardTemplateError(`asset ${name} is a font collection: export one TTF or OTF per style`);
    }
    os2 = font['OS/2'];
    glyphs = Number(font.numGlyphs) || 0;
    family = String(font.getName?.('preferredFamily') || font.familyName || '').trim();
    subfamily = String(font.getName?.('preferredSubfamily') || font.subfamilyName || '').trim();
    rawWeight = Number(os2?.usWeightClass);
    italic = !!(os2?.fsSelection?.italic || os2?.fsSelection?.oblique || font.italicAngle);
    font.glyphForCodePoint(0x41);
  } catch (error: any) {
    if (error instanceof CardTemplateError) throw error;
    throw new CardTemplateError(`asset ${name} cannot be read as a font (${error?.message || error})`);
  }
  if (glyphs < 2) throw new CardTemplateError(`asset ${name} has no glyphs`);
  return {
    postscriptName: String(font.postscriptName || ''),
    family: family || path.parse(name).name,
    subfamily,
    weight: rawWeight >= 1 && rawWeight <= 1000 ? rawWeight : 400,
    style: italic ? 'italic' : 'normal',
    format,
    glyphs,
  };
}

/** Resolves the declared fonts against the uploaded files (defaults from the files themselves). */
export function buildFontFaces(decls: FontFaceDecl[] | null | undefined, files: Map<string, Buffer>): FontFace[] {
  return (decls || []).map((decl) => {
    const bytes = files.get(decl.file);
    if (!bytes) throw new CardTemplateError(`fonts: ${decl.file} is not an asset of this push`);
    const info = describeFont(bytes, decl.file);
    const family = decl.family ?? info.family;
    if (!FONT_FAMILY.test(family)) {
      throw new CardTemplateError(`fonts: the family name of ${decl.file} ("${family}") needs a "family" of letters, digits and spaces`);
    }
    return { file: decl.file, family, weight: decl.weight ?? info.weight, style: decl.style ?? info.style, format: info.format };
  });
}

/** The @font-face rules of a version's fonts. */
export function fontFaceCss(template: Pick<CardTemplateVersion, 'name' | 'assets' | 'fonts'>, apiUri: string): string {
  return (template.fonts || [])
    .filter((f) => template.assets[f.file])
    .map(
      (f) =>
        `@font-face {\n    font-family: '${f.family}';\n    src: url('${assetUrl(apiUri, template.name, template.assets[f.file])}') format('${f.format}');\n` +
        `    font-weight: ${f.weight};\n    font-style: ${f.style};\n    font-display: block;\n}\n`
    )
    .join('');
}

async function storeAsset(name: string, file: string, bytes: Buffer): Promise<void> {
  const dir = assetDir(name);
  const target = path.join(dir, file);
  if (existsSync(target)) return;
  await fs.mkdir(dir, { recursive: true });
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, target);
}

// ---------------------------------------------------------------- Liquid

interface Compiled {
  css: Template[];
  front: Template[];
  back: Template[];
  engine: Liquid;
}

/**
 * One engine per template version, because the `asset` filter is bound to
 * that version's files. No file system (`templates: {}` makes include,
 * render and layout find nothing), own properties only, every output
 * HTML-escaped like EJS's <%= (`| raw` opts out), JavaScript truthiness,
 * and LiquidJS's own limits against a
 * template that loops forever or builds huge strings.
 */
function makeEngine(name: string, assets: Record<string, string>, apiUri: string): Liquid {
  const engine = new Liquid({
    templates: {},
    strictFilters: true,
    strictVariables: true,
    lenientIf: true,
    ownPropertyOnly: true,
    outputEscape: 'escape',
    // Conditions follow JavaScript, as in the pdf_*.ejs templates: '' and 0
    // are false, and `x | default: y` is `x || y`.
    jsTruthy: true,
    cache: false,
    parseLimit: 1_000_000,
    renderLimit: 2_000,
    memoryLimit: 50_000_000,
  });
  engine.registerFilter('asset', (file: unknown) => {
    const stored = assets[String(file)];
    if (!stored) throw new Error(`no asset "${String(file)}" in template ${name}`);
    return assetUrl(apiUri, name, stored);
  });
  return engine;
}

function compile(template: CardTemplateVersion, apiUri: string): Compiled {
  const engine = makeEngine(template.name, template.assets || {}, apiUri);
  const parse = (field: 'css' | 'front' | 'back') => {
    try {
      return engine.parse(template[field]);
    } catch (error: any) {
      throw new CardTemplateError(`${field}: ${error?.message || error}`);
    }
  };
  return { engine, css: parse('css'), front: parse('front'), back: parse('back') };
}

const compiledCache = new Map<string, Compiled>();

function compiled(template: CardTemplateVersion, apiUri: string, cacheable: boolean): Compiled {
  if (!cacheable) return compile(template, apiUri);
  const key = `${template.name}@${template.version}@${apiUri}`;
  let hit = compiledCache.get(key);
  if (hit) {
    // Least recently used goes first.
    compiledCache.delete(key);
    compiledCache.set(key, hit);
    return hit;
  }
  hit = compile(template, apiUri);
  compiledCache.set(key, hit);
  if (compiledCache.size > COMPILED_CACHE_SIZE) compiledCache.delete(compiledCache.keys().next().value as string);
  return hit;
}

// ---------------------------------------------------------------- what a template sees

export interface RenderInput {
  /** The order line: design 1 plus order fields (paymentHasPlaylistId, printerType, doubleSided). */
  php: Record<string, any>;
  /** deckDesigns(php, extras): designs[0] is the order line itself. */
  designs: Record<string, any>[];
  /** Design index per track, as the route computes it. */
  cardDesignIndexes: number[];
  tracks: Record<string, any>[];
  /** Folder of the QR images under /public/qr/; null uses the sample QR (proofs without an order). */
  subdir: string | null;
  eco: boolean;
  startIndex: number;
  batchNumber: string;
  apiUri: string;
}

export interface RenderedCards {
  css: string;
  cards: { front: string; back: string }[];
  designFont: boolean;
}

const TRACK_FIELDS = ['trackId', 'artist', 'name', 'year', 'extraArtistAttribute', 'extraNameAttribute'] as const;

/** A plain copy (own properties, no functions, no prototypes): all Liquid ever gets. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function designView(design: Record<string, any>, apiUri: string): Record<string, any> {
  const view: Record<string, any> = {};
  for (const column of CARD_DESIGN_COLUMNS) view[column] = design[column] ?? null;
  view.yearFontSize = getYearFontSize(design.selectedFont);
  // The same fallbacks the pdf_*.ejs templates write out.
  view.backgroundUrl = design.background
    ? `${apiUri}/public/background/${design.background}`
    : `${apiUri}/assets/images/background_brand.png`;
  view.backgroundBackUrl = design.backgroundBack ? `${apiUri}/public/background/${design.backgroundBack}` : null;
  view.logoUrl = design.logo ? `${apiUri}/public/logo/${design.logo}` : null;
  return plain(view);
}

// The qrcode package's quiet zone (qr.ts): every QR picture has this many
// transparent modules around the code.
const QR_QUIET_ZONE = 4;

/**
 * QR pictures for the sample cards of a proof, made the way the generator
 * makes an order's (qr.ts generateQR: transparent, quiet zone 4, level H) in
 * one colour, with a link of the usual length so qrGeometry matches. Kept
 * under PUBLIC_DIR/qr/card-template-proof/<colour>/; returns that subdir.
 */
export async function sampleQrSubdir(apiUri: string, qrColor: string): Promise<string> {
  if (!QR_COLOUR.test(qrColor)) throw new CardTemplateError('qrColor must be #rrggbb');
  const subdir = `card-template-proof/${qrColor.slice(1).toLowerCase()}`;
  const dir = path.join(process.env['PUBLIC_DIR'] as string, 'qr', subdir);
  await fs.mkdir(dir, { recursive: true });
  const qr = new Qr();
  for (const track of SAMPLE_TRACKS) {
    const file = path.join(dir, `${track.trackId}.png`);
    if (!existsSync(file)) await qr.generateQR(`${apiUri}/qr2/1000000/100000`, file, qrColor);
  }
  return subdir;
}

/**
 * The module grid of a card's QR picture, so a template can place the code
 * itself exactly (the picture is the code plus a transparent quiet zone):
 * `modules` is the code, `totalModules` the picture. It follows the link the
 * generator encodes (/qr2/<track>/<line>); sample cards use a link of the
 * usual length.
 */
function qrGeometry(apiUri: string, trackDbId: unknown, lineId: unknown) {
  const id = Number(trackDbId) || 1_000_000;
  const line = Number(lineId) || 100_000;
  const total = getQrTotalModules(`${apiUri}/qr2/${id}/${line}`);
  return { modules: total - 2 * QR_QUIET_ZONE, quietZone: QR_QUIET_ZONE, totalModules: total };
}

/** Renders the css once and every card's front and back. */
export function renderCards(template: CardTemplateVersion, input: RenderInput, opts: { cacheable?: boolean } = {}): RenderedCards {
  const { apiUri } = input;
  const c = compiled(template, apiUri, opts.cacheable ?? true);
  const designs = input.designs.length ? input.designs : [input.php];
  const designViews = designs.map((d) => designView(d, apiUri));
  const order = plain({
    lineId: input.php.paymentHasPlaylistId ?? input.php.id ?? null,
    printerType: input.php.printerType ?? null,
    doubleSided: !!input.php.doubleSided,
  });
  const meta = {
    name: template.name,
    version: template.version,
    cardSizeMm: template.cardSizeMm ?? printerCardSizeMm(input.php.printerType),
  };
  const shared = {
    order,
    eco: !!input.eco,
    batchNumber: String(input.batchNumber ?? ''),
    template: meta,
    data: plain(template.data ?? {}),
  };

  const run = (field: 'css' | 'front' | 'back', parsed: Template[], scope: Record<string, any>, where: string) => {
    try {
      return String(c.engine.renderSync(parsed, scope));
    } catch (error: any) {
      throw new CardTemplateError(`${field} (${where}): ${error?.message || error}`);
    }
  };

  const css =
    fontFaceCss(template, apiUri) + run('css', c.css, { ...shared, design: designViews[0], designs: designViews }, 'the stylesheet');
  const cards = input.tracks.map((raw, i) => {
    const track: Record<string, any> = {};
    for (const field of TRACK_FIELDS) track[field] = raw[field] ?? null;
    const designIndex = input.cardDesignIndexes[i] ?? 0;
    const qrUrl = input.subdir
      ? `${apiUri}/public/qr/${input.subdir}/${raw.trackId}.png`
      : `${apiUri}/assets/images/qr_example.png`; // only when no sample QR folder is given
    const scope = {
      ...shared,
      track: plain(track),
      qrUrl,
      qr: qrGeometry(apiUri, raw.id, order.lineId),
      card: { index: input.startIndex + i, number: input.startIndex + i + 1, designIndex, designClass: designIndex ? `d${designIndex}` : '' },
      design: designViews[designIndex] ?? designViews[0],
    };
    const where = `card ${input.startIndex + i + 1}`;
    return { front: run('front', c.front, scope, where), back: run('back', c.back, scope, where) };
  });
  return { css, cards, designFont: template.designFont !== false };
}

// ---------------------------------------------------------------- the page

/**
 * The Content-Security-Policy of a stored-template page. No default source,
 * pictures and fonts from this API (its uploads, QR codes, assets) and
 * Google Fonts, inline styles, and only the script carrying this response's
 * nonce: the fit script of views/stored_card_page.ejs.
 */
export function cardTemplateCsp(apiUri: string, nonce: string): string {
  const api = new URL(apiUri).origin;
  return [
    "default-src 'none'",
    `img-src 'self' ${api} data:`,
    `font-src 'self' ${api} https://fonts.gstatic.com data:`,
    `style-src 'self' 'unsafe-inline' ${api} https://fonts.googleapis.com`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * The fit building block, run by views/stored_card_page.ejs once the fonts are in
 * (the PDF Lambda waits for document.fonts.ready and then 500 ms more).
 *
 * An element with `data-fit` gets the largest font size at which its content
 * stays inside its own box, measured by Chromium itself: the boxes of its
 * child elements and the lines of text directly in it (not the ink, so a
 * block trimmed with text-box-trim counts as trimmed), and a word too long
 * for a child's line. The box needs a fixed width and height from the css.
 * Sizes to try, in px:
 *   data-fit-sizes="16 15 14 12"            exactly these, in this order
 *   data-fit-max="16" data-fit-min="9" [data-fit-step="0.5"]
 * (max defaults to the element's own font size, min to 6, step to 0.5).
 * The size is set as font-size, as the unitless variable --fit-size, so
 * children can follow it (`font-size: calc(var(--fit-size) * 2.4px)`), and
 * as the attribute data-fit-size, for exact values per size
 * (`[data-fit-size="15"] .year { font-size: 32px }`).
 * When nothing fits, the smallest size stays.
 */
export const FIT_SCRIPT = `(function () {
  // The content's extent: the boxes of the child elements (trimmed by
  // text-box-trim where the template asks for it), and the line boxes of text
  // directly inside. Not the ink: glyphs may reach past a trimmed line box.
  function extent(el) {
    var rects = [];
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) {
        rects.push(n.getBoundingClientRect());
      } else if (n.nodeType === 3 && /\S/.test(n.nodeValue)) {
        var range = document.createRange();
        range.selectNodeContents(n);
        rects.push(range.getBoundingClientRect());
      }
    }
    var r = null;
    for (var i = 0; i < rects.length; i++) {
      var x = rects[i];
      if (!x.width && !x.height) continue;
      r = r ? { top: Math.min(r.top, x.top), bottom: Math.max(r.bottom, x.bottom), left: Math.min(r.left, x.left), right: Math.max(r.right, x.right) } : { top: x.top, bottom: x.bottom, left: x.left, right: x.right };
    }
    return r;
  }
  function overflows(el) {
    // A word too long for its line sticks out of its block sideways.
    for (var k = el.firstElementChild; k; k = k.nextElementSibling) {
      if (k.scrollWidth > k.clientWidth + 0.5) return true;
    }
    var box = el.getBoundingClientRect();
    var r = extent(el);
    if (!r) return false;
    return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.left < box.left - 0.5 || r.right > box.right + 0.5;
  }
  function sizes(el) {
    var list = (el.getAttribute('data-fit-sizes') || '').split(/[\\s,]+/).map(parseFloat).filter(function (n) { return n > 0; });
    if (list.length) return list;
    var max = parseFloat(el.getAttribute('data-fit-max')) || parseFloat(getComputedStyle(el).fontSize) || 16;
    var min = parseFloat(el.getAttribute('data-fit-min')) || 6;
    var step = parseFloat(el.getAttribute('data-fit-step')) || 0.5;
    var out = [];
    for (var s = max; s >= min - 1e-9; s -= step) out.push(Math.round(s * 1000) / 1000);
    return out.length ? out : [min];
  }
  function apply(el, size) {
    el.style.fontSize = size + 'px';
    el.style.setProperty('--fit-size', String(size));
    el.setAttribute('data-fit-size', String(size));
  }
  function fit(el) {
    var list = sizes(el);
    apply(el, list[0]);
    if (!overflows(el)) return;
    // The first size that fits; larger text never fits better, so search.
    var lo = 1, hi = list.length - 1, best = list.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      apply(el, list[mid]);
      if (overflows(el)) { lo = mid + 1; } else { best = mid; hi = mid - 1; }
    }
    apply(el, list[best]);
  }
  function run() {
    var els = document.querySelectorAll('[data-fit]');
    for (var i = 0; i < els.length; i++) fit(els[i]);
    document.documentElement.setAttribute('data-fit-done', String(els.length));
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run); else window.addEventListener('load', run);
})();`;

// ---------------------------------------------------------------- sample data

/** Cards for a proof without an order, chosen to stress a layout. */
export const SAMPLE_TRACKS = [
  { trackId: 'sample1', artist: 'ABBA', name: 'Dancing Queen', year: 1976, extraArtistAttribute: null, extraNameAttribute: null },
  {
    trackId: 'sample2',
    artist: 'Earth, Wind & Fire with The Emotions',
    name: 'Boogie Wonderland - Single Version Remastered 2010',
    year: 1979,
    extraArtistAttribute: null,
    extraNameAttribute: null,
  },
  { trackId: 'sample3', artist: 'Doe Maar', name: 'Is Dit Alles', year: 1983, extraArtistAttribute: 'Nederpop', extraNameAttribute: 'Bonus' },
  { trackId: 'sample4', artist: 'Beyoncé', name: 'Crazy In Love (feat. JAY-Z)', year: 2003, extraArtistAttribute: null, extraNameAttribute: null },
  { trackId: 'sample5', artist: 'Måneskin', name: 'ZITTI E BUONI', year: 2021, extraArtistAttribute: null, extraNameAttribute: null },
  {
    trackId: 'sample6',
    artist: 'Wolfgang Amadeus Mozart, Berliner Philharmoniker, Herbert von Karajan',
    name: 'Eine kleine Nachtmusik, K. 525: I. Allegro',
    year: 1787,
    extraArtistAttribute: null,
    extraNameAttribute: null,
  },
];

export function sampleDesign(): Record<string, any> {
  return {
    emoji: '',
    background: null,
    logo: null,
    selectedFont: 'Arial, sans-serif',
    selectedFontSize: '16px',
    hideCircle: true,
    qrBackgroundType: 'none',
    qrColor: '#000000',
    qrBackgroundColor: '#ffffff',
    qrLogo: null,
    qrLogoScale: 25,
    backgroundFrontType: 'image',
    backgroundFrontColor: '#ffffff',
    useFrontGradient: false,
    gradientFrontColor: '#ffffff',
    gradientFrontDegrees: 180,
    gradientFrontPosition: 50,
    frontOpacity: 100,
    backgroundBackType: 'image',
    backgroundBack: null,
    backgroundBackColor: '#ffffff',
    fontColor: '#000000',
    useGradient: false,
    gradientBackgroundColor: '#ffffff',
    gradientDegrees: 180,
    gradientPosition: 50,
    backOpacity: 100,
    sameAsFront: false,
    addHowToCard: false,
    printerType: 'schneiders',
    doubleSided: true,
    paymentHasPlaylistId: 0,
  };
}

/**
 * Renders a source against the sample cards in a few designs (default,
 * solid colours with gradients, eco, QR square and circle), so a template
 * that errors on some design is refused at upload, not at the printer.
 */
export function trialRender(template: CardTemplateVersion, apiUri = process.env['API_URI'] || 'https://api.qrsong.io'): void {
  const base = sampleDesign();
  const variants: Record<string, any>[] = [
    base,
    {
      ...base,
      backgroundFrontType: 'solid',
      useFrontGradient: true,
      backgroundBackType: 'solid',
      useGradient: true,
      qrBackgroundType: 'square',
      logo: 'sample.png',
      background: 'sample.png',
    },
    {
      ...base,
      qrBackgroundType: 'circle',
      hideCircle: false,
      backgroundBack: 'sample.png',
      selectedFont: "'Pacifico', cursive",
      printerType: 'tromp',
    },
  ];
  variants.forEach((php, k) =>
    renderCards(
      template,
      {
        php,
        designs: [php],
        cardDesignIndexes: SAMPLE_TRACKS.map(() => 0),
        tracks: SAMPLE_TRACKS,
        subdir: null,
        eco: k === 2,
        startIndex: 0,
        batchNumber: '0',
        apiUri,
      },
      { cacheable: false }
    )
  );
}

// ---------------------------------------------------------------- proof links

export const QR_COLOUR = /^#[0-9a-f]{6}$/i;

function proofSignature(name: string, version: number, phpId: number, count: number, qrColor: string, exp: number): string {
  return crypto
    .createHmac('sha256', process.env['JWT_SECRET'] || '')
    .update(`card-template-proof|${name}|${version}|${phpId}|${count}|${qrColor}|${exp}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The query of the signed proof page the PDF Lambda prints (it has no
 * session). `qrColor` colours the sample QR codes of a proof without an order.
 */
export function proofQuery(name: string, version: number, phpId: number, count: number, qrColor = '#000000', ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return new URLSearchParams({
    php: String(phpId),
    n: String(count),
    qc: qrColor,
    exp: String(exp),
    sig: proofSignature(name, version, phpId, count, qrColor, exp),
  }).toString();
}

export function verifyProof(
  name: string,
  version: number,
  phpId: number,
  count: number,
  qrColor: string,
  exp: number,
  sig: unknown
): boolean {
  if (typeof sig !== 'string' || sig.length !== 32 || !(exp > Date.now() / 1000) || !QR_COLOUR.test(qrColor)) return false;
  const expected = Buffer.from(proofSignature(name, version, phpId, count, qrColor, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------- the store

function toVersion(row: any): CardTemplateVersion {
  return {
    name: row.name,
    version: row.version,
    cardSizeMm: row.cardSizeMm,
    css: row.css,
    front: row.front,
    back: row.back,
    assets: (row.assets as Record<string, string>) || {},
    data: (row.data as Record<string, unknown>) ?? null,
    designFont: row.designFont !== false,
    fonts: (row.fonts as FontFace[] | null) ?? null,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

class CardTemplates {
  private static instance: CardTemplates;
  private prisma = PrismaInstance.getInstance();

  public static getInstance(): CardTemplates {
    if (!CardTemplates.instance) CardTemplates.instance = new CardTemplates();
    return CardTemplates.instance;
  }

  /**
   * Stores a new version: checks the source, the assets and a trial render,
   * writes the assets (content-addressed, so a re-upload costs nothing) and
   * then the row. Every asset the template uses must be in this push.
   */
  public async push(
    name: string,
    source: CardTemplateSource & { note?: string | null },
    uploads: UploadedAsset[],
    createdBy: string | null,
    opts: { checkOnly?: boolean } = {}
  ): Promise<{ template: CardTemplateVersion; warnings: string[]; fontFiles: (FontInfo & { file: string })[]; stored: boolean }> {
    if (!STORED_NAME.test(name)) {
      throw new CardTemplateError('a template name is 2-40 characters: a-z first, then a-z, 0-9 and _');
    }
    if (isFileTemplate(name)) {
      throw new CardTemplateError(`"${name}" is a template file in the API (views/pdf_${name}.ejs); pick another name`, 409);
    }
    const errors = checkSource(source);
    if (errors.length) throw new CardTemplateError(errors.join('\n'));

    if (uploads.length > MAX_ASSETS) throw new CardTemplateError(`at most ${MAX_ASSETS} assets`);
    const total = uploads.reduce((sum, a) => sum + a.bytes.length, 0);
    if (total > MAX_ASSETS_BYTES) throw new CardTemplateError('the assets together are larger than 60 MB');
    const assets: Record<string, string> = {};
    for (const upload of uploads) {
      if (assets[upload.name]) throw new CardTemplateError(`asset ${upload.name} is in the push twice`);
      assets[upload.name] = await checkAsset(upload);
    }
    const files = new Map(uploads.map((u) => [u.name, u.bytes]));
    const fonts = buildFontFaces(source.fonts, files);
    const fontFiles = uploads
      .filter((u) => !ASSET_TYPES[detectAssetType(u.bytes) as string]?.image)
      .map((u) => ({ file: u.name, ...describeFont(u.bytes, u.name) }));
    const missing = referencedAssets(source).filter((a) => !assets[a]);
    if (missing.length) throw new CardTemplateError(`the template uses assets that are not in this push: ${missing.join(', ')}`);
    const declared = new Set(fonts.map((f) => f.file));
    const warnings = Object.keys(assets)
      .filter((a) => !referencedAssets(source).includes(a) && !declared.has(a))
      .map((a) => `asset ${a} is not named literally in the template (fine if it is picked with a variable)`);

    const draft: CardTemplateVersion = {
      name,
      version: 0,
      cardSizeMm: source.cardSizeMm,
      css: source.css,
      front: source.front,
      back: source.back,
      data: source.data ?? null,
      designFont: source.designFont !== false,
      fonts,
      assets,
    };
    try {
      trialRender(draft);
    } catch (error: any) {
      throw new CardTemplateError(error instanceof CardTemplateError ? error.message : String(error?.message || error));
    }

    // A check runs everything above and stores nothing.
    if (opts.checkOnly) return { template: draft, warnings, fontFiles, stored: false };

    for (const upload of uploads) await storeAsset(name, assets[upload.name], upload.bytes);

    // The unique (name, version) index settles two pushes at the same moment.
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.prisma.cardTemplate.findFirst({ where: { name }, orderBy: { version: 'desc' }, select: { version: true } });
      try {
        const row = await this.prisma.cardTemplate.create({
          data: {
            name,
            version: (latest?.version ?? 0) + 1,
            cardSizeMm: source.cardSizeMm,
            css: source.css,
            front: source.front,
            back: source.back,
            assets,
            data: (source.data ?? undefined) as any,
            designFont: source.designFont !== false,
            fonts: fonts as any,
            note: source.note ? String(source.note).slice(0, 500) : null,
            createdBy,
          },
        });
        return { template: toVersion(row), warnings, fontFiles, stored: true };
      } catch (error: any) {
        if (error?.code !== 'P2002' || attempt === 2) throw error;
      }
    }
    throw new CardTemplateError('could not store the template', 500);
  }

  /** A version, or the latest with `version` null/undefined. */
  public async get(name: string, version?: number | null): Promise<CardTemplateVersion | null> {
    if (!STORED_NAME.test(name)) return null;
    const row = version
      ? await this.prisma.cardTemplate.findUnique({ where: { name_version: { name, version } } })
      : await this.prisma.cardTemplate.findFirst({ where: { name }, orderBy: { version: 'desc' } });
    return row ? toVersion(row) : null;
  }

  /** Every stored template (latest version) and every file template. */
  public async list() {
    const rows = await this.prisma.cardTemplate.groupBy({
      by: ['name'],
      _max: { version: true, createdAt: true },
    });
    const usage = await this.prisma.paymentHasPlaylist.groupBy({
      by: ['template'],
      where: { template: { in: rows.map((r) => r.name) } },
      _count: { _all: true },
    });
    const used = new Map(usage.map((u) => [u.template, u._count._all]));
    const latest = await Promise.all(rows.map((r) => this.get(r.name, r._max.version)));
    let files: string[] = [];
    try {
      files = (await fs.readdir(viewsDir()))
        .filter((f) => /^pdf_[a-z0-9_]+\.ejs$/.test(f))
        .map((f) => f.slice(4, -4))
        .sort();
    } catch {
      files = [];
    }
    return {
      stored: latest
        .filter((t): t is CardTemplateVersion => !!t)
        .map((t) => ({
          name: t.name,
          version: t.version,
          cardSizeMm: t.cardSizeMm,
          updatedAt: t.createdAt,
          note: t.note ?? null,
          orderLines: used.get(t.name) ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      files,
    };
  }

  /** Versions of one template and the order lines that use it. */
  public async history(name: string) {
    const versions = await this.prisma.cardTemplate.findMany({
      where: { name },
      orderBy: { version: 'desc' },
      select: { version: true, cardSizeMm: true, note: true, createdBy: true, createdAt: true, assets: true },
    });
    if (!versions.length) return null;
    const lines = await this.prisma.paymentHasPlaylist.findMany({
      where: { template: name },
      select: { id: true, templateVersion: true, payment: { select: { paymentId: true, orderId: true } } },
      orderBy: { id: 'desc' },
      take: 200,
    });
    return {
      name,
      versions,
      orderLines: lines.map((l) => ({
        paymentHasPlaylistId: l.id,
        paymentId: l.payment?.paymentId ?? null,
        orderId: l.payment?.orderId ?? null,
        templateVersion: l.templateVersion,
      })),
    };
  }

  /**
   * What an order line stores for a template it is given: a file template by
   * name, a stored one by name and pinned version (the latest, or the version
   * asked for). Undefined changes nothing; null or '' is the regular layout.
   */
  public async resolveAssignment(
    template: string | null | undefined,
    version?: number | null
  ): Promise<{ template: string | null; templateVersion: number | null } | undefined> {
    if (template === undefined) return undefined;
    if (template === null || template === '') return { template: null, templateVersion: null };
    if (typeof template !== 'string' || !TEMPLATE_NAME.test(template)) {
      throw new CardTemplateError(`"${template}" is not a template name (a-z, 0-9, _)`);
    }
    if (isFileTemplate(template)) return { template, templateVersion: null };
    const stored = await this.get(template, version ?? null);
    if (!stored) {
      throw new CardTemplateError(
        version
          ? `stored template ${template} has no version ${version}`
          : `no card template "${template}" (no views/pdf_${template}.ejs and no stored template)`
      );
    }
    return { template, templateVersion: stored.version };
  }

  /**
   * resolveAssignment for an existing order line. Without an explicit version
   * a line that already has this stored template keeps its pinned version:
   * saving the dashboard's production settings (which always sends the
   * template) must not move an order to a newer version. 'latest' re-pins.
   */
  public async resolveForLine(
    phpId: number,
    template: string | null | undefined,
    version?: number | 'latest' | null,
    printerType?: string | null
  ): Promise<{ template: string | null; templateVersion: number | null } | undefined> {
    if (version !== undefined && version !== null && version !== 'latest' && !(Number.isInteger(version) && version > 0)) {
      throw new CardTemplateError('templateVersion must be a version number or "latest"');
    }
    const current = await this.prisma.paymentHasPlaylist.findUnique({
      where: { id: phpId },
      select: { template: true, templateVersion: true, printerType: true },
    });
    let assignment = await this.resolveAssignment(template, typeof version === 'number' ? version : null);
    if (
      assignment &&
      assignment.templateVersion !== null &&
      version === undefined &&
      current?.template === assignment.template &&
      current.templateVersion
    ) {
      assignment = { template: assignment.template, templateVersion: current.templateVersion };
    }
    // The card the line prints after this change, on the printer it will have.
    const name = assignment ? assignment.template : current?.template;
    const pinned = assignment ? assignment.templateVersion : current?.templateVersion;
    if (name && pinned) {
      const stored = await this.get(name, pinned);
      if (stored) checkCardSize(stored, printerType ?? current?.printerType);
    }
    return assignment;
  }

  /**
   * The stored template a PDF of this order line renders with, or null for a
   * file template (or none). `pinned` is the line's templateVersion when the
   * requested template is the line's own; the latest otherwise.
   */
  public async forRender(template: string, pinned: number | null | undefined): Promise<CardTemplateVersion | null> {
    if (!TEMPLATE_NAME.test(template) || isFileTemplate(template)) return null;
    return this.get(template, pinned ?? null);
  }

  /**
   * Card size of a stored template version; null when `template` is not one
   * or follows the printer (printerPageSizeMm then decides, as for a file).
   */
  public async cardSizeMm(template: string, pinned: number | null | undefined): Promise<number | null> {
    const stored = await this.forRender(template, pinned);
    return stored ? stored.cardSizeMm : null;
  }
}

export default CardTemplates;

/**
 * Answers a PDF page request with a stored template: the cards rendered by
 * Liquid inside views/stored_card_page.ejs, under cardTemplateCsp. `view`
 * carries what the page's partials read (php, designs, howtoTranslations and
 * the font helpers), as for a pdf_*.ejs view.
 */
export async function sendStoredPage(
  reply: any,
  template: CardTemplateVersion,
  input: RenderInput,
  view: Record<string, any>,
  opts: { cacheable?: boolean } = {}
): Promise<void> {
  const stored = renderCards(template, input, opts);
  const nonce = newNonce();
  reply.header('Content-Security-Policy', cardTemplateCsp(input.apiUri, nonce));
  await reply.view('stored_card_page.ejs', { ...view, startIndex: input.startIndex, stored, fitNonce: nonce, fitScript: FIT_SCRIPT });
}
