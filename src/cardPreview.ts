import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Data from './data';
import Cache from './cache';
import PDF, { printerTemplateFor } from './pdf';
import CardTemplates, { isFileTemplate, viewsDir } from './cardTemplates';
import { getExtraDesigns } from './cardDesigns';
import { computePrintFingerprint } from './printFingerprint';
import { RenderedPage, renderPdfPages } from './pdfRaster';
import { resolveQrSubDir } from './qrPaths';

/**
 * The first card of an order line as the printer gets it, front and back as
 * PNGs, for the admin dashboard. Its in-browser preview (app-deck-designs)
 * draws the card from the design columns and knows nothing about card
 * templates, so for a line with one (a views/pdf_*.ejs file or a stored
 * template, src/cardTemplates.ts) it shows another card than the one printed.
 *
 * Two sources. The line's stored printer PDF when it is current: its
 * pdfFingerprint (src/printFingerprint.ts) still matches the design and the
 * cards. Otherwise one card rendered now through the PDF Lambda from the
 * /qr/pdf route, the way the generator renders it. Each side comes twice:
 * the card as cut (the 3 mm bleed off, for the order list) and the page with
 * its bleed and the printer's guides on it (die line, bleed edge, safe zone,
 * as `qrsong design cut-check --sheet` draws them for a customer; Rick,
 * 2026-10-15), for the larger view.
 *
 * Pictures are kept in PUBLIC_DIR/card-previews under a name that hashes
 * everything they show (source, template and version, the design, the first
 * card's track and year, the PDF's mtime), so any change gives a new picture
 * and a browser may cache one for good. The hash is an HMAC on JWT_SECRET:
 * the files are public and the inputs partly guessable. A line keeps only its
 * newest set.
 *
 * Nothing waits for the PDF Lambda (Rick, 2026-10-15): a picture that is not
 * there yet is made in the background, one at a time per line (in the worker,
 * plus a Redis lock across workers), and the answer says `generating` until
 * it is; the dashboard asks again. A stored PDF renders in about a second,
 * so the request waits that long (`inlineWaitMs`) before it says so.
 */

export const BLEED_MM = 3;
// Nothing that matters within this much inside the die line
export const SAFE_MM = 3;
// Schneiders' die (the qrsong toolkit's reference/printers/schneiders/
// kaart-56x56.json, measured from their template): corners of 4.35 mm on the
// 56 mm card. Only that die is measured; a 60 mm card gets the same corner in
// proportion.
export const DIE_RADIUS_PER_CARD_MM = 4.35 / 56;
// pixels per point: a 62 mm page (a 56 mm card with bleed) is 879 px
const RENDER_SCALE = 5;
// side of the card as cut, and of the page with the guides, in pixels
export const PREVIEW_PX = 720;
export const DIE_PX = 900;
// bump to make every preview again
const PREVIEW_VERSION = 1;
const DIR = 'card-previews';
const SIDES = ['front', 'back', 'front-die', 'back-die'] as const;
// a render holds its line this long at most (a worker that dies frees it)
const LOCK_SECONDS = 120;
// a render that failed is not tried again for this long, unless asked to
const FAILED_SECONDS = 600;
// a stored printer PDF that does not render is passed over for this long
const UNREADABLE_PDF_SECONDS = 86_400;

export type CardPreviewSource = 'pdf' | 'render';

export interface CardPreview {
  source: CardPreviewSource;
  cardSizeMm: number;
  // paths under the API, e.g. /public/card-previews/<name>-front.png: the
  // card as cut, and the page with bleed and the printer's guides
  front: string;
  back: string;
  frontDie: string;
  backDie: string;
}

/**
 * What GET /admin/playlist/:id/card-preview answers: the pictures when they
 * are there; else they are being made in the background (`generating`, ask
 * again) or the last try failed (`failed`, ask with retry to try again).
 */
export type CardPreviewState =
  | ({ status: 'ready' } & CardPreview)
  | { status: 'generating'; source: CardPreviewSource; cardSizeMm: number }
  | { status: 'failed'; source: CardPreviewSource; cardSizeMm: number; error: string };

export class CardPreviewError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

/**
 * A rendered page as the printer gets it, with 3 mm bleed. pdf.ts addBleed
 * scales a card's content up to fill the page plus bleed, so a stored printer
 * PDF already is that page (`card + 6` mm) and a fresh render, the `card` mm
 * page from before addBleed, is scaled up by (card + 6) / card the same way.
 * Pass a fresh render's `pageMm` as the card size, not its own: Chromium's
 * page comes out a little larger (about 56.1 mm for 56) and the generator
 * scales it to the card exactly (resizePDFPages) before adding the bleed.
 */
export async function withBleed(page: Buffer, pageMm: number, hasBleed: boolean): Promise<{ png: Buffer; pageMm: number }> {
  if (hasBleed) return { png: page, pageMm };
  const { width = 0, height = 0 } = await sharp(page).metadata();
  const factor = (pageMm + 2 * BLEED_MM) / pageMm;
  const png = await sharp(page)
    .resize(Math.round(width * factor), Math.round(height * factor), { fit: 'fill' })
    .png()
    .toBuffer();
  return { png, pageMm: pageMm + 2 * BLEED_MM };
}

/** A page with bleed cut along the die (BLEED_MM off every side), as a `size` square PNG. */
export async function cropToCut(bled: Buffer, pageMm: number, size: number = PREVIEW_PX): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(bled).metadata();
  const left = Math.round((width * BLEED_MM) / pageMm);
  const top = Math.round((height * BLEED_MM) / pageMm);
  return sharp(bled)
    .extract({ left, top, width: width - 2 * left, height: height - 2 * top })
    .resize(size, size, { fit: 'fill' })
    .png()
    .toBuffer();
}

/** A square part of a page, in page mm from its top left corner, drawn `px` wide. */
export interface DieView {
  px: number;
  x?: number;
  y?: number;
  sizeMm?: number;
  // false: the page alone, for measuring (qrsong design cut-check)
  guides?: boolean;
}

/** A guide's line width: `mm` on the card, at least `minPx` on the picture. */
const STROKES = {
  die: { colour: '#ec008c', mm: 0.1, minPx: 2.5 },
  safe: { colour: '#00a0d2', mm: 0.07, minPx: 1.5 },
  bleed: { colour: '#5a5a5a', mm: 0.08, minPx: 1.5 },
} as const;

/**
 * The printer's guides on a `px` square picture of (part of) a `pageMm`
 * page, in the colours of `qrsong design cut-check`: the die line (magenta,
 * where the card is cut, rounded like the die), the bleed edge (grey,
 * dashed, BLEED_MM outside it) and the safe zone (cyan, SAFE_MM inside it).
 * The `cardMm` card sits in the middle of the page, whatever its margin.
 */
export function dieLinesSvg(px: number, pageMm: number, cardMm: number = pageMm - 2 * BLEED_MM, view: { x?: number; y?: number; sizeMm?: number } = {}): string {
  const sizeMm = view.sizeMm ?? pageMm;
  const ox = view.x ?? 0;
  const oy = view.y ?? 0;
  const s = px / sizeMm;
  const offset = (pageMm - cardMm) / 2;
  const radius = cardMm * DIE_RADIUS_PER_CARD_MM;
  const f = (n: number) => n.toFixed(2);
  const square = (insetMm: number, radiusMm: number, stroke: (typeof STROKES)[keyof typeof STROKES], dash = '') => {
    const side = (cardMm - 2 * insetMm) * s;
    const r = Math.max(0, radiusMm) * s;
    const width = Math.max(stroke.minPx, stroke.mm * s);
    return (
      `<rect x="${f((offset + insetMm - ox) * s)}" y="${f((offset + insetMm - oy) * s)}" width="${f(side)}" height="${f(side)}" ` +
      `rx="${f(r)}" ry="${f(r)}" fill="none" stroke="${stroke.colour}" stroke-width="${f(width)}"${dash}/>`
    );
  };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}">`,
    square(-BLEED_MM + 0.15, 0, STROKES.bleed, ` stroke-dasharray="${f(Math.max(6, 2 * s))}"`),
    square(SAFE_MM, radius - SAFE_MM, STROKES.safe),
    square(0, radius, STROKES.die),
    '</svg>',
  ].join('');
}

/** `view` of a `pageMm` page, with the guides of a `cardMm` card on it unless asked not to. */
export async function drawDieView(page: Buffer, pageMm: number, cardMm: number, view: DieView): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(page).metadata();
  const perMm = width / pageMm;
  const sizeMm = view.sizeMm ?? pageMm;
  const left = Math.max(0, Math.round((view.x ?? 0) * perMm));
  const top = Math.max(0, Math.round((view.y ?? 0) * perMm));
  const side = Math.min(Math.round(sizeMm * perMm), width - left, height - top);
  const picture = await sharp(page)
    .extract({ left, top, width: side, height: side })
    .resize(view.px, view.px, { fit: 'fill' })
    .png()
    .toBuffer();
  if (view.guides === false) return picture;
  return sharp(picture)
    .composite([{ input: Buffer.from(dieLinesSvg(view.px, pageMm, cardMm, { ...view, sizeMm })) }])
    .png()
    .toBuffer();
}

/** A page with bleed and the printer's guides on it, as a `size` square PNG. */
export function drawDieLines(bled: Buffer, pageMm: number, size: number = DIE_PX): Promise<Buffer> {
  return drawDieView(bled, pageMm, pageMm - 2 * BLEED_MM, { px: size });
}

const MAX_VIEWS = 12;
const MAX_PAGES = 8;
const MAX_VIEW_PX = 3000;
// pixels per point for a PDF upload: 25 is 70 px per mm
const MAX_UPLOAD_SCALE = 25;

/** The views a die-lines request asks for (JSON), checked; the whole page at DIE_PX when none. */
export function parseDieViews(raw: unknown): DieView[] {
  if (raw === undefined || raw === null || raw === '') return [{ px: DIE_PX }];
  let views: unknown;
  try {
    views = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new CardPreviewError('views is not valid JSON', 400);
  }
  if (!Array.isArray(views) || !views.length || views.length > MAX_VIEWS) {
    throw new CardPreviewError(`views must be a list of 1 to ${MAX_VIEWS} views`, 400);
  }
  return views.map((v: any, i) => {
    const px = Number(v?.px);
    if (!Number.isInteger(px) || px < 50 || px > MAX_VIEW_PX) throw new CardPreviewError(`view ${i + 1}: px must be 50 to ${MAX_VIEW_PX}`, 400);
    const view: DieView = { px };
    for (const key of ['x', 'y', 'sizeMm'] as const) {
      if (v[key] === undefined || v[key] === null) continue;
      const n = Number(v[key]);
      if (!Number.isFinite(n) || n < 0 || (key === 'sizeMm' && n <= 0)) throw new CardPreviewError(`view ${i + 1}: ${key} must be a positive number of mm`, 400);
      view[key] = n;
    }
    if (v.guides === false) view.guides = false;
    return view;
  });
}

/** "1,2" as page numbers. */
function parsePages(raw: unknown, fallback: number[]): number[] {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const pages = String(raw)
    .split(',')
    .map((p) => Number(p.trim()));
  if (!pages.length || pages.length > MAX_PAGES || pages.some((p) => !Number.isInteger(p) || p < 1)) {
    throw new CardPreviewError(`pages must be up to ${MAX_PAGES} page numbers, e.g. 1,2`, 400);
  }
  return pages;
}

function positive(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 500) throw new CardPreviewError(`${name} must be a size in mm`, 400);
  return n;
}

export interface DieLinesPage {
  page: number;
  pageMm: number;
  views: (Required<Omit<DieView, 'guides'>> & { guides: boolean; png: Buffer })[];
}

/** The stored printer PDF when it is current, else a fresh render. */
export function previewSource(pdfExists: boolean, storedFingerprint: string | null | undefined, currentFingerprint: string): CardPreviewSource {
  return pdfExists && !!storedFingerprint && storedFingerprint === currentFingerprint ? 'pdf' : 'render';
}

/** The file name (without side) of the preview that shows exactly `parts`. */
export function previewName(paymentHasPlaylistId: number, parts: Record<string, unknown>): string {
  const key = JSON.stringify({ v: PREVIEW_VERSION, ...parts });
  const hash = crypto
    .createHmac('sha256', process.env['JWT_SECRET'] || '')
    .update(key)
    .digest('hex')
    .slice(0, 32);
  return `${paymentHasPlaylistId}-${hash}`;
}

class CardPreviews {
  private static instance: CardPreviews;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private data = Data.getInstance();
  private cache = Cache.getInstance();
  private pdf = new PDF();
  private running = new Map<string, Promise<CardPreviewState | null>>();
  // how long a request waits for a picture it started before it answers `generating`
  public inlineWaitMs = 1500;

  public static getInstance(): CardPreviews {
    if (!CardPreviews.instance) CardPreviews.instance = new CardPreviews();
    return CardPreviews.instance;
  }

  private dir(): string {
    return path.join(process.env['PUBLIC_DIR'] as string, DIR);
  }

  private log(phpId: number, message: string, tone: 'blue' | 'yellow' = 'blue') {
    const line = `[${white.bold('cardPreview')}] php=${white.bold(phpId.toString())} ${message}`;
    this.logger.log(tone === 'yellow' ? color.yellow.bold(line) : color.blue.bold(line));
  }

  public async forLine(paymentHasPlaylistId: number, opts: { retry?: boolean } = {}): Promise<CardPreviewState> {
    const line = await this.line(paymentHasPlaylistId);
    const { php, cardSizeMm } = line;
    const previewOf = (from: CardPreviewSource): { name: string; preview: CardPreview } => {
      const name = previewName(php.id, {
        source: from,
        ...line.parts,
        pdf: from === 'pdf' && line.pdfStat ? `${php.filename}:${line.pdfStat.mtimeMs}:${line.pdfStat.size}` : null,
      });
      const url = (side: (typeof SIDES)[number]) => `/public/${DIR}/${name}-${side}.png`;
      return {
        name,
        preview: { source: from, cardSizeMm, front: url('front'), back: url('back'), frontDie: url('front-die'), backDie: url('back-die') },
      };
    };

    const wanted = previewOf(line.source);
    if (await this.exists(wanted.name)) return { status: 'ready', ...wanted.preview };

    // A render that failed is remembered for a while, so that asking again
    // (the dashboard polls) does not start one on every request
    const failedKey = `card-preview-failed:${wanted.name}`;
    if (opts.retry) {
      await this.cache.del(failedKey).catch(() => {});
    } else {
      const failed = await this.cache.get(failedKey, false).catch(() => null);
      if (failed) return { status: 'failed', source: line.source, cardSizeMm, error: failed };
    }

    let job = this.running.get(wanted.name);
    if (!job) {
      job = this.make(line, wanted, previewOf, failedKey);
      this.running.set(wanted.name, job);
      job.finally(() => this.running.delete(wanted.name)).catch(() => {});
    }
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.inlineWaitMs);
    });
    const done = await Promise.race([job, waited]);
    clearTimeout(timer);
    return done ?? { status: 'generating', source: line.source, cardSizeMm };
  }

  /**
   * Makes the pictures of `wanted` unless another worker already is (null
   * then; its pictures will be there when asked again). Never throws: a
   * failure is logged, remembered under `failedKey` and answered as `failed`.
   */
  private async make(
    line: Awaited<ReturnType<CardPreviews['line']>>,
    wanted: { name: string; preview: CardPreview },
    previewOf: (from: CardPreviewSource) => { name: string; preview: CardPreview },
    failedKey: string
  ): Promise<CardPreviewState | null> {
    const { php, cardSizeMm } = line;
    const lock = `card-preview:${php.id}`;
    const locked = await this.cache.acquireLock(lock, LOCK_SECONDS).catch(() => true);
    if (!locked) return null;
    try {
      if (await this.exists(wanted.name)) return { status: 'ready', ...wanted.preview };
      const { source, pages } = await this.firstCardPages(line, RENDER_SCALE);
      const made = source === line.source ? wanted : previewOf(source);
      const [front, back] = await Promise.all(
        pages.map(async (page) => {
          const bled = await withBleed(page.png, source === 'pdf' ? page.widthMm : cardSizeMm, source === 'pdf');
          return { cut: await cropToCut(bled.png, bled.pageMm), die: await drawDieLines(bled.png, bled.pageMm) };
        })
      );
      await this.store(php.id, made.name, [front.cut, back.cut, front.die, back.die]);
      this.log(php.id, `first card from ${source === 'pdf' ? `the printer PDF ${white.bold(php.filename || '')}` : 'a fresh render'} ✓`);
      return { status: 'ready', ...made.preview };
    } catch (e) {
      const error = `The card could not be rendered: ${(e as Error).message}`;
      this.log(php.id, error, 'yellow');
      await this.cache.set(failedKey, error, FAILED_SECONDS).catch(() => {});
      return { status: 'failed', source: line.source, cardSizeMm, error };
    } finally {
      if (locked) await this.cache.releaseLock(lock).catch(() => {});
    }
  }

  /**
   * Pictures with the printer's guides (POST /admin/card-preview/die-lines),
   * for the qrsong toolkit's `design cut-check`: of an uploaded card (a PDF,
   * whose pages are taken as they are, or a PNG/JPEG canvas of `pageMm`,
   * card plus bleed by default) or of an order line's first card as the
   * printer gets it (pages 1 and 2 are its front and back). The card sits in
   * the middle of the page; `views` are the parts drawn (parseDieViews).
   */
  public async dieLines(input: {
    file?: Buffer | null;
    paymentHasPlaylistId?: number | null;
    pages?: unknown;
    cardMm?: unknown;
    pageMm?: unknown;
    views?: unknown;
  }): Promise<{ cardMm: number; source: CardPreviewSource | 'upload'; pages: DieLinesPage[] }> {
    const views = parseDieViews(input.views);
    let cardMm = positive(input.cardMm, 'cardMm', 56);
    let source: CardPreviewSource | 'upload' = 'upload';
    let pages: { page: number; png: Buffer; pageMm: number }[];
    // pixels per mm the sharpest view needs, on a page of about card plus bleed
    const perMm = (pageMm: number) => Math.max(...views.map((v) => v.px / (v.sizeMm ?? pageMm)));
    const scaleFor = (pageMm: number) => Math.min(MAX_UPLOAD_SCALE, Math.max(1, ((perMm(pageMm) * 25.4) / 72) * 1.1));

    if (input.paymentHasPlaylistId) {
      const line = await this.line(input.paymentHasPlaylistId);
      cardMm = line.cardSizeMm;
      const numbers = parsePages(input.pages, [1, 2]);
      if (numbers.some((n) => n > 2)) throw new CardPreviewError('an order line has pages 1 (front) and 2 (back)', 400);
      const first = await this.firstCardPages(line, scaleFor(cardMm + 2 * BLEED_MM));
      source = first.source;
      pages = await Promise.all(
        numbers.map(async (n) => {
          const page = first.pages[n - 1];
          const bled = await withBleed(page.png, first.source === 'pdf' ? page.widthMm : cardMm, first.source === 'pdf');
          return { page: n, png: bled.png, pageMm: bled.pageMm };
        })
      );
    } else if (input.file?.length) {
      const file = input.file;
      if (file.subarray(0, 5).toString('latin1') === '%PDF-') {
        const numbers = parsePages(input.pages, [1]);
        const scale = scaleFor(cardMm + 2 * BLEED_MM);
        let rendered: RenderedPage[];
        try {
          rendered = await renderPdfPages(file, numbers, scale);
        } catch (e) {
          throw new CardPreviewError(`the PDF does not render (${(e as Error).message})`, 400);
        }
        pages = rendered.map((page, i) => ({ page: numbers[i], png: page.png, pageMm: page.widthMm }));
      } else {
        const meta = await sharp(file)
          .metadata()
          .catch(() => null);
        if (!meta || !['png', 'jpeg', 'webp'].includes(meta.format || '')) {
          throw new CardPreviewError('send a PDF, PNG or JPEG', 400);
        }
        pages = [{ page: 1, png: await sharp(file).png().toBuffer(), pageMm: positive(input.pageMm, 'pageMm', cardMm + 2 * BLEED_MM) }];
      }
    } else {
      throw new CardPreviewError('send a file or a paymentHasPlaylistId', 400);
    }

    const out: DieLinesPage[] = [];
    for (const page of pages) {
      if (page.pageMm < cardMm) throw new CardPreviewError(`page ${page.page} is ${page.pageMm.toFixed(1)} mm, smaller than the ${cardMm} mm card`, 400);
      const drawn: DieLinesPage['views'] = [];
      for (const view of views) {
        const sizeMm = view.sizeMm ?? page.pageMm;
        const x = view.x ?? 0;
        const y = view.y ?? 0;
        if (x + sizeMm > page.pageMm + 0.05 || y + sizeMm > page.pageMm + 0.05) {
          throw new CardPreviewError(`a view of ${sizeMm} mm at ${x},${y} runs off the ${page.pageMm.toFixed(1)} mm page`, 400);
        }
        drawn.push({ x, y, sizeMm, px: view.px, guides: view.guides !== false, png: await drawDieView(page.png, page.pageMm, cardMm, view) });
      }
      out.push({ page: page.page, pageMm: Math.round(page.pageMm * 100) / 100, views: drawn });
    }
    return { cardMm, source, pages: out };
  }

  /** An order line as the generator and the PDF route read it, and where its first card comes from. */
  private async line(paymentHasPlaylistId: number) {
    const php = await this.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: {
        id: true,
        type: true,
        subType: true,
        filename: true,
        pdfFingerprint: true,
        payment: { select: { paymentId: true, qrSubDir: true } },
        playlist: { select: { playlistId: true } },
      },
    });
    if (!php) throw new CardPreviewError('Order line not found', 404);
    if (php.type !== 'physical' || (php.subType || 'none') === 'sheets') {
      throw new CardPreviewError('Only a line of printed single cards has a printer card', 400);
    }

    const rows = await this.data.getPlaylistsByPaymentId(php.payment.paymentId, php.playlist.playlistId);
    const row = rows.find((r: any) => Number(r.paymentHasPlaylistId) === php.id);
    if (!row) throw new CardPreviewError('Order line not found', 404);
    const tracks: any[] = (await this.data.getTracks(row.id, 0, php.id)) || [];
    if (!tracks.length) throw new CardPreviewError('This line has no cards yet', 409);

    const pdfPath = php.filename ? path.join(process.env['PUBLIC_DIR'] as string, 'pdf', php.filename) : null;
    const pdfStat = pdfPath ? await fs.stat(pdfPath).catch(() => null) : null;
    const current = computePrintFingerprint(row, tracks, await getExtraDesigns(php.id, this.prisma));
    let source = previewSource(!!pdfStat, php.pdfFingerprint, current);
    const unreadableKey = pdfStat ? `card-preview-unreadable:${php.filename}:${pdfStat.mtimeMs}` : null;
    if (source === 'pdf' && unreadableKey && (await this.cache.get(unreadableKey, false).catch(() => null))) source = 'render';

    const template = printerTemplateFor(row.orderTemplate, row.printerType);
    const pinned = template === row.orderTemplate ? row.orderTemplateVersion : null;
    const stored = await CardTemplates.getInstance().forRender(template, pinned);
    const cardSizeMm = await this.pdf.printerPageSize(template, row.printerType, row);
    const parts = {
      template,
      version: stored?.version ?? null,
      // a file template changes with a deploy
      file: !stored && isFileTemplate(template) ? await this.mtime(path.join(viewsDir(), `pdf_${template}.ejs`)) : null,
      cardSizeMm,
      // the design and the first card's track and year
      card: computePrintFingerprint(row, tracks.slice(0, 1)),
    };
    return { php, row, pdfPath, pdfStat, source, unreadableKey, template, cardSizeMm, parts };
  }

  /**
   * The first card's front and back as PNGs at `scale`: from the stored
   * printer PDF (with bleed) when it is current, else rendered now through
   * the PDF Lambda (without). A stored PDF that does not render falls back to
   * a render; `source` says which it was.
   */
  private async firstCardPages(
    line: Awaited<ReturnType<CardPreviews['line']>>,
    scale: number
  ): Promise<{ source: CardPreviewSource; pages: RenderedPage[] }> {
    const { php, row, template, cardSizeMm } = line;
    const firstCardPage = row.addHowToCard ? 3 : 1;
    if (line.source === 'pdf') {
      try {
        const pdf = await fs.readFile(line.pdfPath as string);
        return { source: 'pdf', pages: await renderPdfPages(pdf, [firstCardPage, firstCardPage + 1], scale) };
      } catch (e) {
        // A PDF that does not read is no reason to show nothing; it is passed
        // over until it changes, or the next request would try it again
        this.log(php.id, `stored PDF ${php.filename} did not render (${(e as Error).message}), rendering the card instead`, 'yellow');
        if (line.unreadableKey) await this.cache.set(line.unreadableKey, '1', UNREADABLE_PDF_SECONDS).catch(() => {});
      }
    }
    const subdir = await resolveQrSubDir(php.payment.qrSubDir, php.id);
    // One card, as the generator asks for item 1 of the line
    const url = `${process.env['API_URI']}/qr/pdf/${php.playlist.playlistId}/${php.payment.paymentId}/${template}/0/0/${subdir}/0/0/1`;
    const rendered = await this.pdf.renderUrlToPdfBuffer(url, {
      width: cardSizeMm,
      height: cardSizeMm,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: `${firstCardPage}-${firstCardPage + 1}`,
    });
    return { source: 'render', pages: await renderPdfPages(rendered, [1, 2], scale) };
  }

  private async exists(name: string): Promise<boolean> {
    const dir = this.dir();
    try {
      await Promise.all(SIDES.map((side) => fs.access(path.join(dir, `${name}-${side}.png`))));
      return true;
    } catch {
      return false;
    }
  }

  /** Writes every picture (temp file, then rename), in SIDES order, and drops the line's older ones. */
  private async store(phpId: number, name: string, pictures: Buffer[]): Promise<void> {
    const dir = this.dir();
    await fs.mkdir(dir, { recursive: true });
    const keep = new Set(SIDES.map((side) => `${name}-${side}.png`));
    for (const [index, side] of SIDES.entries()) {
      const file = path.join(dir, `${name}-${side}.png`);
      const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(temp, pictures[index]);
      await fs.rename(temp, file);
    }
    const prefix = `${phpId}-`;
    for (const file of await fs.readdir(dir)) {
      if (file.startsWith(prefix) && file.endsWith('.png') && !keep.has(file)) {
        await fs.unlink(path.join(dir, file)).catch(() => {});
      }
    }
  }

  private async mtime(file: string): Promise<number | null> {
    const stat = await fs.stat(file).catch(() => null);
    return stat ? stat.mtimeMs : null;
  }
}

export default CardPreviews;
