import { PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';
import { clampScale, sanitizeLogoFilename } from './qr-logo';

/**
 * Alternating card designs.
 *
 * A deck normally has one design: the design columns on payment_has_playlist.
 * A customer can give it up to MAX_CARD_DESIGNS; card 1 then gets design 1,
 * card 2 design 2, and so on, starting again after the last one. Design 1
 * stays on payment_has_playlist either way, so everything that reads the order
 * line (app design, admin thumbnails, how-to card, company templates) keeps
 * seeing it. Designs 2..N are rows in payment_has_playlist_designs, and a
 * single-design order has none.
 *
 * "Card i" is the i-th track in data.getTracks() order
 * (playlist_has_tracks.order). QR generation and the PDF route both read that
 * query, so a card's QR colour and its artwork always come from the same
 * design.
 */

export const MAX_CARD_DESIGNS = 10;
export const MAX_EXTRA_DESIGNS = MAX_CARD_DESIGNS - 1;

export interface CardDesign {
  emoji: string | null;
  background: string | null;
  logo: string | null;
  selectedFont: string;
  selectedFontSize: string;
  hideCircle: boolean;
  qrBackgroundType: string;
  qrColor: string;
  qrBackgroundColor: string;
  qrLogo: string | null;
  qrLogoScale: number;
  backgroundFrontType: string;
  backgroundFrontColor: string;
  useFrontGradient: boolean;
  gradientFrontColor: string;
  gradientFrontDegrees: number;
  gradientFrontPosition: number;
  frontOpacity: number;
  backgroundBackType: string;
  backgroundBack: string | null;
  backgroundBackColor: string;
  fontColor: string;
  useGradient: boolean;
  gradientBackgroundColor: string;
  gradientDegrees: number;
  gradientPosition: number;
  backOpacity: number;
  sameAsFront: boolean;
}

/**
 * The per-design columns, shared by payment_has_playlist (design 1) and
 * payment_has_playlist_designs (designs 2..N). eco and doubleSided are not
 * here: they belong to the order line, not to a design.
 */
export const CARD_DESIGN_COLUMNS: readonly (keyof CardDesign)[] = [
  'emoji',
  'background',
  'logo',
  'selectedFont',
  'selectedFontSize',
  'hideCircle',
  'qrBackgroundType',
  'qrColor',
  'qrBackgroundColor',
  'qrLogo',
  'qrLogoScale',
  'backgroundFrontType',
  'backgroundFrontColor',
  'useFrontGradient',
  'gradientFrontColor',
  'gradientFrontDegrees',
  'gradientFrontPosition',
  'frontOpacity',
  'backgroundBackType',
  'backgroundBack',
  'backgroundBackColor',
  'fontColor',
  'useGradient',
  'gradientBackgroundColor',
  'gradientDegrees',
  'gradientPosition',
  'backOpacity',
  'sameAsFront',
];

/** A Prisma `select` of the design columns, for nested reads of extraDesigns. */
export const CARD_DESIGN_SELECT = Object.fromEntries(
  CARD_DESIGN_COLUMNS.map((column) => [column, true])
) as { [K in keyof CardDesign]: true };

type DesignClient = Pick<PrismaClient, 'paymentHasPlaylistDesign' | '$transaction'>;

// An uploaded image is a bare filename in PUBLIC_DIR/background or /logo, and
// the templates put it inside url('...') and src="...". Anything else is
// dropped rather than escaped. finalCheck checks every picture this lets
// through, so it uses the same rule.
export const IMAGE_FILENAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// A CSS font-family list as the designer writes it ('"Fira Sans", Arial,
// sans-serif'). It lands in a <style> block, so no ; { } < > ( ) or escapes.
const FONT_FAMILY = /^[A-Za-z0-9 ,"'._-]{1,120}$/;
const FONT_SIZE = /^\d{1,2}(?:\.\d{1,2})?px$/;

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === '1';
  }
  return false;
}

function filename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return IMAGE_FILENAME.test(trimmed) ? trimmed : null;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value.trim())
    ? value.trim()
    : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function oneOf(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * One design as it may be stored: every column present, every value checked.
 * A missing or invalid value gets the column's default, the same default a
 * design 1 gets at checkout. Keys outside CARD_DESIGN_COLUMNS (the designer's
 * preview URLs, ids) are ignored.
 */
export function sanitizeCardDesign(input: unknown): CardDesign {
  const d: Record<string, unknown> =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  const hideCircle = bool(d['hideCircle']);
  const emoji =
    typeof d['emoji'] === 'string' ? d['emoji'].replace(/[<>]/g, '').slice(0, 32) : '';
  const selectedFont =
    typeof d['selectedFont'] === 'string' && FONT_FAMILY.test(d['selectedFont'].trim())
      ? d['selectedFont'].trim()
      : 'Arial, sans-serif';
  const selectedFontSize =
    typeof d['selectedFontSize'] === 'string' && FONT_SIZE.test(d['selectedFontSize'].trim())
      ? d['selectedFontSize'].trim()
      : '16px';

  return {
    emoji: emoji || null,
    background: filename(d['background']),
    logo: filename(d['logo']),
    selectedFont,
    selectedFontSize,
    hideCircle,
    qrBackgroundType: oneOf(
      d['qrBackgroundType'],
      ['square', 'circle', 'none'],
      hideCircle ? 'none' : 'square'
    ),
    qrColor: color(d['qrColor'], '#000000'),
    qrBackgroundColor: color(d['qrBackgroundColor'], '#ffffff'),
    qrLogo: sanitizeLogoFilename(d['qrLogo'] as string | null | undefined),
    qrLogoScale: clampScale(
      d['qrLogoScale'] === null || d['qrLogoScale'] === '' ? undefined : Number(d['qrLogoScale'])
    ),
    backgroundFrontType: oneOf(d['backgroundFrontType'], ['solid', 'image'], 'image'),
    backgroundFrontColor: color(d['backgroundFrontColor'], '#ffffff'),
    useFrontGradient: bool(d['useFrontGradient']),
    gradientFrontColor: color(d['gradientFrontColor'], '#ffffff'),
    gradientFrontDegrees: int(d['gradientFrontDegrees'], 180, 0, 360),
    gradientFrontPosition: int(d['gradientFrontPosition'], 50, 0, 100),
    frontOpacity: int(d['frontOpacity'], 100, 0, 100),
    backgroundBackType: oneOf(d['backgroundBackType'], ['solid', 'image'], 'image'),
    backgroundBack: filename(d['backgroundBack']),
    backgroundBackColor: color(d['backgroundBackColor'], '#ffffff'),
    fontColor: color(d['fontColor'], '#000000'),
    useGradient: bool(d['useGradient']),
    gradientBackgroundColor: color(d['gradientBackgroundColor'], '#ffffff'),
    gradientDegrees: int(d['gradientDegrees'], 180, 0, 360),
    gradientPosition: int(d['gradientPosition'], 50, 0, 100),
    backOpacity: int(d['backOpacity'], 50, 0, 100),
    sameAsFront: bool(d['sameAsFront']),
  };
}

/**
 * Designs 2..N from a request body: an array of at most MAX_EXTRA_DESIGNS
 * objects, each sanitised. Anything that is not an array means none.
 */
export function sanitizeExtraDesigns(input: unknown): CardDesign[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry) => entry && typeof entry === 'object')
    .slice(0, MAX_EXTRA_DESIGNS)
    .map(sanitizeCardDesign);
}

/** The design columns of a stored row, nothing else. */
export function pickCardDesign(row: Record<string, any>): CardDesign {
  const design = {} as Record<string, unknown>;
  for (const column of CARD_DESIGN_COLUMNS) {
    design[column] = row[column];
  }
  return design as unknown as CardDesign;
}

/** Rows for a nested `extraDesigns: { create }`, positions from 2 up. */
export function extraDesignRows(designs: CardDesign[]): (CardDesign & { position: number })[] {
  return designs.map((design, index) => ({ ...design, position: index + 2 }));
}

/**
 * Every design of a deck, in card order, for templates and QR generation.
 *
 * Design 1 is the order line itself, untouched, so a single-design deck
 * renders from exactly the object it always did. Each extra design is laid
 * over the line, so a template can read any line field (paymentHasPlaylistId,
 * addHowToCard, ...) from a card's design the same way it reads it from php.
 */
export function deckDesigns<T extends Record<string, any>>(
  php: T,
  extras: CardDesign[] = []
): T[] {
  return [php, ...extras.map((extra) => ({ ...php, ...pickCardDesign(extra) }))];
}

/** The design of card `index` (0-based, deck order). */
export function designIndexForCard(designCount: number, index: number): number {
  if (designCount <= 1) return 0;
  return ((index % designCount) + designCount) % designCount;
}

/** Designs 2..N of one order line, in position order. */
export async function getExtraDesigns(
  paymentHasPlaylistId: number,
  prisma: DesignClient = PrismaInstance.getInstance()
): Promise<CardDesign[]> {
  const rows = await prisma.paymentHasPlaylistDesign.findMany({
    where: { paymentHasPlaylistId },
    orderBy: { position: 'asc' },
  });
  return rows.map((row) => pickCardDesign(row));
}

/** Replace designs 2..N of one order line; an empty list means one design. */
export async function replaceExtraDesigns(
  paymentHasPlaylistId: number,
  designs: CardDesign[],
  prisma: DesignClient = PrismaInstance.getInstance()
): Promise<void> {
  const rows = extraDesignRows(designs.slice(0, MAX_EXTRA_DESIGNS)).map((row) => ({
    ...row,
    paymentHasPlaylistId,
  }));
  await prisma.$transaction([
    prisma.paymentHasPlaylistDesign.deleteMany({ where: { paymentHasPlaylistId } }),
    ...(rows.length ? [prisma.paymentHasPlaylistDesign.createMany({ data: rows })] : []),
  ]);
}
