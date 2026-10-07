import path from 'path';
import { promises as fs } from 'fs';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import PDF from './pdf';
import { resolveQrSubDir } from './qrPaths';
import HitsterDetector, { HitsterClass } from './hitsterDetector';
import { hitsterHoldThreshold } from './hitsterThresholds';
import { IMAGE_FILENAME } from './cardDesigns';
import { measureDrift } from './designDrift';
import { isCardLink, readQr } from './qrRead';

/**
 * The last check of a physical order before it goes to the printer: is there
 * Hitster material on the cards or the box?
 *
 * First, did the design drift? The first card of every design is rendered
 * again from the live design route and compared with the stored PDF, pixel
 * by pixel (src/designDrift.ts). A drift holds the order for a person to
 * look, without a mail to the customer ("design-mismatch"); a live render
 * that fails skips the comparison.
 *
 * Then Hitster. The judge is our own Hitster detector (src/hitsterDetector.ts), run on every
 * picture the customer put on the order: each design's front and back
 * background, logo and QR logo, and the box's front, logo and back. Which
 * pictures print is decided as the print templates decide it (a card
 * background prints unless its type is "solid", a box background when it is
 * "image"; the filename rule is cardDesigns' IMAGE_FILENAME), so nothing
 * prints unchecked. Next to it, a plain text search of the PDFs for the word,
 * for text typed on the box. No language model is asked anything (Rick,
 * 2026-10-06: this replaced the GPT checks of design drift, Hitster and
 * readability).
 *
 * A hit at HITSTER_HOLD_THRESHOLD (src/hitsterThresholds.ts) puts the order on
 * hold and mails the customer the pictures with the reason (generator.ts,
 * handleFinalCheckFailure). The designers already warn when such a picture is
 * picked (POST /designer/screen); ordering anyway is allowed, and this is
 * where it is caught. A picture that cannot be checked (not on disk,
 * unreadable, too large) holds the order too, "picture-unchecked", without a
 * mail to the customer: it fails closed.
 */

export type FinalCheckFailureReason =
  | 'pdf-missing'
  | 'design-mismatch'
  | 'hitster'
  | 'unreadable'
  | 'picture-unchecked'
  | 'qr-unreadable';

export interface FinalCheckFlaggedImage {
  // i18n label key, resolved to a human name in the design-alter mail
  key: 'cardFront' | 'cardBack' | 'boxFront' | 'boxBack';
  // attachment filename (e.g. 'card-front.png')
  filename: string;
  // the flagged picture itself, as the customer uploaded it
  buffer: Buffer;
  // Which of the deck's alternating designs it is on (1-based, see
  // src/cardDesigns.ts); null for a single-design deck and the box.
  design: number | null;
}

export type FinalCheckPlace =
  | 'card-front'
  | 'card-back'
  | 'card'
  | 'box-front'
  | 'box-back'
  | 'box';

/**
 * One thing the check found, pinned to the design and side it is on. `design`
 * is the 1-based number of one of the deck's alternating designs; null when
 * the deck has a single design, for the box, and for a text hit on a sheet
 * (whose page holds every design). Stored with the hold
 * (Payment.printerHoldDetails) so the dashboard can show it per design.
 */
export interface FinalCheckProblem {
  check: Exclude<FinalCheckFailureReason, 'pdf-missing'>;
  design: number | null;
  place: FinalCheckPlace;
  message: string;
}

const PLACE_LABELS: Record<FinalCheckPlace, string> = {
  'card-front': 'Card front',
  'card-back': 'Card back',
  card: 'Card',
  'box-front': 'Box inlay front',
  'box-back': 'Box inlay back',
  box: 'Box inlay',
};

/** "Design 2 back: <message>" or "Card back: <message>" for Pushover, logs and details. */
export function describeFinalCheckProblem(problem: FinalCheckProblem): string {
  const side = problem.place.split('-')[1];
  const where = problem.design
    ? `Design ${problem.design}${side ? ` ${side}` : ''}`
    : PLACE_LABELS[problem.place];
  return `${where}: ${problem.message}`;
}

// Which tab of the user-suggestions correction page the customer should land
// on to fix the problem. Mapped onto the `?tab=` query param of the designer
// link in the design-alter mail.
export type FinalCheckCorrectionTab = 'tracks' | 'card' | 'box';

export type FinalCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: FinalCheckFailureReason;
      userActionable: boolean;
      details: string;
      paymentHasPlaylistId: number;
      playlistDbId: number;
      playlistId: string;
      // The flagged pictures, attached inline to the customer email.
      flaggedImages?: FinalCheckFlaggedImage[];
      // Set on user-actionable failures so the mail can deep-link the right
      // editor. When both the card and the box are at fault we send the user
      // to the card tab — the card is the primary product.
      correctionTab?: FinalCheckCorrectionTab;
      // How many alternating designs the deck has, and every problem the
      // failing check found, each pinned to its design and side.
      designCount: number;
      problems: FinalCheckProblem[];
    };

// Both flagged → 'card'. The card is the primary product, and the tab bar
// keeps the box one click away.
export function correctionTabForFlaggedKeys(
  keys: FinalCheckFlaggedImage['key'][]
): FinalCheckCorrectionTab {
  const hasCard = keys.some((k) => k === 'cardFront' || k === 'cardBack');
  return hasCard ? 'card' : 'box';
}

/** One picture of the order: where it is on the product and which file. */
interface OrderPicture {
  key: FinalCheckFlaggedImage['key'];
  place: FinalCheckPlace;
  design: number | null;
  // what it is, for the logs, the dashboard and the attachment name
  what: string;
  folder: 'background' | 'logo';
  filename: string;
}

const CLASS_LABELS: Record<HitsterClass, string> = {
  word: 'the word Hitster',
  rings: 'the Hitster card rings',
  speaker: 'the Hitster speaker',
  pill: 'the "THE MUSIC CARD GAME" pill',
};

// The printer_sheets layout (views/pdf_printer_sheets.ejs): an A4 page with
// 15mm margins holding rows of three 60mm cards; the back page mirrors every
// row for duplex printing.
const SHEET = { widthMm: 210, marginMm: 15, cardMm: 60, perRow: 3, perPage: 12 };

/** One design's front and back, as page pictures. */
interface DesignPages {
  // 1-based design number; null for a single-design deck
  design: number | null;
  front: Buffer;
  back: Buffer;
}

// The folder each card design field's uploads are in (src/designer.ts)
const IMAGE_FIELDS = {
  background: 'background',
  backgroundBack: 'background',
  logo: 'logo',
  qrLogo: 'logo',
} as const;

/**
 * The pictures that print on a php's cards and box, decided as the print
 * templates decide it (views/pdf_printer*.ejs, pdf_box_insert.ejs): a card
 * background prints unless its type is "solid", a box background only when
 * it is "image", a logo whenever it is set.
 */
export function orderPictures(php: any): OrderPicture[] {
  const designs = [
    { position: 1, ...php },
    ...[...(php.extraDesigns || [])].sort((a: any, b: any) => a.position - b.position),
  ];
  const several = designs.length > 1;
  const pictures: OrderPicture[] = [];
  const add = (picture: Omit<OrderPicture, 'filename'>, filename: unknown) => {
    const name = typeof filename === 'string' ? filename.trim() : '';
    if (name && IMAGE_FILENAME.test(name)) {
      pictures.push({ ...picture, filename: name });
    }
  };

  for (const design of designs) {
    const number = several ? design.position : null;
    const label = several ? `design ${design.position} ` : '';
    if (design.backgroundFrontType !== 'solid') {
      add({ key: 'cardFront', place: 'card-front', design: number, what: `${label}front background`, folder: IMAGE_FIELDS.background }, design.background);
    }
    if (design.backgroundBackType !== 'solid') {
      add({ key: 'cardBack', place: 'card-back', design: number, what: `${label}back background`, folder: IMAGE_FIELDS.backgroundBack }, design.backgroundBack);
    }
    add({ key: 'cardFront', place: 'card-front', design: number, what: `${label}logo`, folder: IMAGE_FIELDS.logo }, design.logo);
    add({ key: 'cardFront', place: 'card-front', design: number, what: `${label}QR logo`, folder: IMAGE_FIELDS.qrLogo }, design.qrLogo);
  }

  if (php.boxEnabled) {
    if (php.boxFrontBackgroundType === 'image') {
      add({ key: 'boxFront', place: 'box-front', design: null, what: 'box front background', folder: 'background' }, php.boxFrontBackground);
    }
    add({ key: 'boxFront', place: 'box-front', design: null, what: 'box logo', folder: 'logo' }, php.boxFrontLogo);
    if (php.boxBackBackgroundType === 'image') {
      add({ key: 'boxBack', place: 'box-back', design: null, what: 'box back background', folder: 'background' }, php.boxBackBackground);
    }
  }
  return pictures;
}

class FinalCheck {
  private static instance: FinalCheck;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private detector = HitsterDetector.getInstance();
  private pdf = new PDF();

  public static getInstance(): FinalCheck {
    if (!FinalCheck.instance) FinalCheck.instance = new FinalCheck();
    return FinalCheck.instance;
  }

  public async runCheck(payment: {
    id: number;
    paymentId: string;
    qrSubDir: string | null;
  }): Promise<FinalCheckResult> {
    const phps = await this.prisma.paymentHasPlaylist.findMany({
      where: { paymentId: payment.id, type: 'physical' },
      include: {
        playlist: true,
        extraDesigns: {
          select: {
            position: true,
            background: true,
            backgroundFrontType: true,
            backgroundBack: true,
            backgroundBackType: true,
            logo: true,
            qrLogo: true,
          },
          orderBy: { position: 'asc' },
        },
      },
    });

    for (const php of phps) {
      const result = await this.checkOnePlaylist(payment, php);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private log(paymentId: string, phpId: number, message: string, tone: 'blue' | 'yellow' = 'blue') {
    const line = `[${white.bold('finalCheck')}] ${white.bold(paymentId)} php=${white.bold(
      phpId.toString()
    )} ${message}`;
    this.logger.log(tone === 'yellow' ? color.yellow.bold(line) : color.blue.bold(line));
  }

  private async checkOnePlaylist(
    payment: { id: number; paymentId: string; qrSubDir: string | null },
    php: any
  ): Promise<FinalCheckResult> {
    const designCount = 1 + (php.extraDesigns?.length ?? 0);
    const failBase = {
      paymentHasPlaylistId: php.id,
      playlistDbId: php.playlist.id,
      playlistId: php.playlist.playlistId,
      designCount,
      problems: [] as FinalCheckProblem[],
    };

    const filename = php.filename;
    if (!filename) {
      return {
        ok: false,
        reason: 'pdf-missing',
        userActionable: false,
        details: `paymentHasPlaylist ${php.id} has no filename`,
        ...failBase,
      };
    }
    const pdfPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
    try {
      await fs.access(pdfPath);
    } catch {
      return {
        ok: false,
        reason: 'pdf-missing',
        userActionable: false,
        details: `PDF missing on disk: ${pdfPath}`,
        ...failBase,
      };
    }

    // Did the design drift since the PDF was made?
    const storedPdf = await fs.readFile(pdfPath);
    const drift = await this.driftProblems(payment, php, storedPdf);
    // Does the QR code on the print read, and lead to this order line?
    const qr = await this.qrProblems(payment, php, storedPdf);

    // The pictures, each through the model once (one file can sit in
    // several places)
    const problems: FinalCheckProblem[] = [];
    const unchecked: FinalCheckProblem[] = [];
    const flaggedImages: FinalCheckFlaggedImage[] = [];
    type Verdict = { buffer: Buffer; found: string[] } | { unchecked: string };
    const verdicts = new Map<string, Promise<Verdict>>();
    const threshold = hitsterHoldThreshold();
    for (const picture of orderPictures(php)) {
      const file = path.join(process.env['PUBLIC_DIR'] as string, picture.folder, picture.filename);
      if (!verdicts.has(file)) {
        verdicts.set(
          file,
          (async (): Promise<Verdict> => {
            let buffer: Buffer;
            try {
              buffer = await fs.readFile(file);
            } catch {
              return { unchecked: 'is not on disk' };
            }
            const started = Date.now();
            try {
              const verdict = await this.detector.detect(buffer, threshold);
              const found = verdict.marks.map((m) => `${CLASS_LABELS[m.class]} (${m.score.toFixed(2)})`);
              this.log(
                payment.paymentId,
                php.id,
                `${picture.what} ${white.bold(picture.filename)}: ${
                  found.length ? white.bold(found.join(', ')) : 'clean'
                } in ${Date.now() - started} ms`,
                found.length ? 'yellow' : 'blue'
              );
              return { buffer, found };
            } catch (e) {
              return { unchecked: `could not be checked (${(e as Error).message})` };
            }
          })()
        );
      }
      const verdict = await verdicts.get(file)!;
      // A picture that prints but cannot be checked holds the order
      if ('unchecked' in verdict) {
        this.log(payment.paymentId, php.id, `${picture.what} ${white.bold(picture.filename)} ${verdict.unchecked}`, 'yellow');
        unchecked.push({
          check: 'picture-unchecked',
          design: picture.design,
          place: picture.place,
          message: `the ${picture.what.replace(/^design \d+ /, '')} ${picture.filename} ${verdict.unchecked}`,
        });
        continue;
      }
      if (!verdict.found.length) continue;
      problems.push({
        check: 'hitster',
        design: picture.design,
        place: picture.place,
        message: `${verdict.found.join(', ')} in the ${picture.what.replace(/^design \d+ /, '')}`,
      });
      const slug = picture.what.replace(/\s+/g, '-');
      flaggedImages.push({
        key: picture.key,
        filename: `${slug}${path.extname(picture.filename).toLowerCase() || '.png'}`,
        buffer: verdict.buffer,
        design: picture.design,
      });
    }

    // The printed text: a typed "Hitster" (box texts) is no picture
    const textProblems = await this.textProblems(payment.paymentId, php, pdfPath);
    problems.push(...textProblems);

    if (problems.length === 0 && unchecked.length === 0 && drift.length === 0 && qr.length === 0) {
      this.log(payment.paymentId, php.id, 'design as stored, no Hitster material ✓');
      return { ok: true };
    }

    // Nothing Hitster, but the design drifted or not everything could be
    // looked at: on hold for a person to look, without a mail to the customer
    if (problems.length === 0) {
      const held = [...drift, ...qr, ...unchecked];
      return {
        ok: false,
        reason: drift.length ? 'design-mismatch' : qr.length ? 'qr-unreadable' : 'picture-unchecked',
        userActionable: false,
        details: held.map(describeFinalCheckProblem).join(' | '),
        ...failBase,
        problems: held,
      };
    }

    // Hitster is what the customer can fix, so it is what they are mailed
    // about; the rest is listed beside it for the dashboard. The card wins
    // the correction tab when both are at fault.
    const onCard = problems.some((p) => p.place.startsWith('card'));
    const correctionTab: FinalCheckCorrectionTab = onCard ? 'card' : 'box';
    const all = [...problems, ...drift, ...qr, ...unchecked];
    return {
      ok: false,
      reason: 'hitster',
      userActionable: true,
      details: all.map(describeFinalCheckProblem).join(' | '),
      ...failBase,
      problems: all,
      flaggedImages,
      correctionTab,
    };
  }

  /**
   * The first card of every design in the stored PDF against a fresh render
   * of the live design route, front and back (src/designDrift.ts). A live
   * render that fails (the Lambda) skips the comparison; a stored PDF that
   * cannot be rasterised throws, which holds the order (generator.ts).
   */
  private async driftProblems(
    payment: { paymentId: string; qrSubDir: string | null },
    php: any,
    storedPdf: Buffer
  ): Promise<FinalCheckProblem[]> {
    const { designCount, isSheets, firstCardPage } = this.layout(php);
    let live: Buffer;
    try {
      live = await this.renderLivePdf(payment, php, isSheets, designCount, firstCardPage);
    } catch (e) {
      this.log(payment.paymentId, php.id, `live render failed (${(e as Error).message}), design comparison skipped`, 'yellow');
      return [];
    }
    const stored = await this.designPages(storedPdf, isSheets, designCount, firstCardPage);
    const fresh = await this.designPages(live, isSheets, designCount, firstCardPage);

    const problems: FinalCheckProblem[] = [];
    for (const [index, pages] of stored.entries()) {
      for (const side of ['front', 'back'] as const) {
        const measure = await measureDrift(pages[side], fresh[index][side]);
        const changed = Math.round(measure.changed * 100);
        const colours = Math.round(measure.colours * 100);
        this.log(
          payment.paymentId,
          php.id,
          `design comparison ${pages.design ? `design ${pages.design} ` : ''}${side}: ${changed}% of the card differs, colours moved ${colours}%${
            measure.drifted ? white.bold(' → drifted') : ''
          }`,
          measure.drifted ? 'yellow' : 'blue'
        );
        if (measure.drifted) {
          problems.push({
            check: 'design-mismatch',
            design: pages.design,
            place: side === 'front' ? 'card-front' : 'card-back',
            message: `${changed}% of the card differs from a fresh render, colours moved ${colours}%`,
          });
        }
      }
    }
    return problems;
  }

  /**
   * The QR code on the front of every design's first card, as it prints: it
   * has to read (light on dark too, as the app scans it) and lead to this
   * order line (generator.ts: /qr2/<track>/<php>). Rendered at three times
   * the size of the comparison, so the modules are several pixels wide.
   * Rick, 2026-10-07: a code that does not read on the print holds the
   * order, without a mail to the customer.
   */
  private async qrProblems(payment: { paymentId: string }, php: any, storedPdf: Buffer): Promise<FinalCheckProblem[]> {
    const { designCount, isSheets, firstCardPage } = this.layout(php);
    const pages = await this.designPages(storedPdf, isSheets, designCount, firstCardPage, 3);
    const problems: FinalCheckProblem[] = [];
    for (const page of pages) {
      const text = await readQr(page.front);
      const label = page.design ? `design ${page.design} ` : '';
      if (text && isCardLink(text, php.id)) {
        this.log(payment.paymentId, php.id, `QR code ${label}front reads ✓`);
        continue;
      }
      const message = text
        ? `the QR code reads as ${text.slice(0, 80)}, not a card link of this order line`
        : 'the QR code on the card does not scan';
      this.log(payment.paymentId, php.id, `QR code ${label}front: ${message}`, 'yellow');
      problems.push({ check: 'qr-unreadable', design: page.design, place: 'card-front', message });
    }
    return problems;
  }

  /** How many designs, sheet or printer PDF, and where the first card starts. */
  private layout(php: any): { designCount: number; isSheets: boolean; firstCardPage: number } {
    const isSheets = (php.subType || 'none') === 'sheets';
    return {
      designCount: 1 + (php.extraDesigns?.length ?? 0),
      isSheets,
      // A printer PDF opens with the how-to card when there is one; sheets
      // never carry it.
      firstCardPage: !isSheets && php.addHowToCard ? 3 : 1,
    };
  }

  /**
   * The front and back of the first card of every design, as PNGs. A printer
   * PDF has one card per page pair; a sheet holds twelve cards per page,
   * fronts on page 1 and backs on page 2, so a deck with several designs gets
   * each design's card cut out of the sheet.
   */
  private async designPages(pdf: Buffer, isSheets: boolean, designCount: number, firstCardPage: number, scale = 1): Promise<DesignPages[]> {
    const numberOf = (index: number) => (designCount > 1 ? index + 1 : null);
    if (isSheets) {
      const [front, back] = await this.screenshots(pdf, [1, 2], scale);
      if (designCount === 1) return [{ design: null, front, back }];
      const pages: DesignPages[] = [];
      for (let card = 0; card < Math.min(designCount, SHEET.perPage); card++) {
        const row = Math.floor(card / SHEET.perRow);
        const column = card % SHEET.perRow;
        pages.push({
          design: numberOf(card),
          front: await this.cropSheetCard(front, row, column),
          // The back page mirrors each row for duplex printing
          back: await this.cropSheetCard(back, row, SHEET.perRow - 1 - column),
        });
      }
      return pages;
    }
    const fronts = Array.from({ length: designCount }, (_, index) => firstCardPage + 2 * index);
    const images = await this.screenshots(pdf, fronts.flatMap((front) => [front, front + 1]), scale);
    return fronts.map((_, index) => ({ design: numberOf(index), front: images[2 * index], back: images[2 * index + 1] }));
  }

  /** One 60mm card cut out of a rendered sheet page (see SHEET). */
  private async cropSheetCard(page: Buffer, row: number, column: number): Promise<Buffer> {
    const { width } = await sharp(page).metadata();
    const pxPerMm = (width || 0) / SHEET.widthMm;
    const size = Math.floor(SHEET.cardMm * pxPerMm);
    return sharp(page)
      .extract({
        left: Math.round((SHEET.marginMm + column * SHEET.cardMm) * pxPerMm),
        top: Math.round((SHEET.marginMm + row * SHEET.cardMm) * pxPerMm),
        width: size,
        height: size,
      })
      .png()
      .toBuffer();
  }

  /** The (1-based) pages of a PDF as PNGs, in the order asked. */
  private async screenshots(pdf: Buffer, pageNumbers: number[], scale = 1): Promise<Buffer[]> {
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    try {
      const result = await parser.getScreenshot({ partial: pageNumbers, scale, imageBuffer: true, imageDataUrl: false });
      return pageNumbers.map((pageNumber) => {
        const page = (result.pages || []).find((p) => p.pageNumber === pageNumber);
        if (!page?.data) {
          throw new Error(`pdf-parse getScreenshot returned no usable data for page ${pageNumber}`);
        }
        return Buffer.from(page.data as Uint8Array);
      });
    } finally {
      try {
        await parser.destroy();
      } catch {}
    }
  }

  /**
   * The first pages of the order as the live design route draws them now.
   * A printer render runs to the first card of the last design (past the
   * how-to card, when there is one); a sheet holds them all on its first two
   * pages.
   */
  private async renderLivePdf(
    payment: { paymentId: string; qrSubDir: string | null },
    php: any,
    isSheets: boolean,
    designCount: number,
    firstCardPage: number
  ): Promise<Buffer> {
    const template = isSheets ? 'printer_sheets' : 'printer';
    const endIndex = isSheets ? 11 : designCount - 1;
    const subdir = await resolveQrSubDir(payment.qrSubDir, php.id);
    const eco = php.eco ? 1 : 0;
    const url = `${process.env['API_URI']}/qr/pdf/${php.playlist.playlistId}/${payment.paymentId}/${template}/0/${endIndex}/${subdir}/${eco}/0/0`;
    const options: any = {
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: isSheets ? '1-2' : `1-${firstCardPage + 2 * designCount - 1}`,
    };
    if (isSheets) {
      options.format = 'a4';
    } else {
      options.width = 60;
      options.height = 60;
    }
    return this.pdf.renderUrlToPdfBuffer(url, options);
  }

  /**
   * "Hitster" in the PDFs' text: the first card of every design, and the box
   * inlay. A printer PDF has one card per page pair, after the how-to card
   * when there is one; a sheet (views/pdf_printer_sheets.ejs) has every
   * front on page 1 and every back on page 2.
   */
  private async textProblems(paymentId: string, php: any, pdfPath: string): Promise<FinalCheckProblem[]> {
    const designCount = 1 + (php.extraDesigns?.length ?? 0);
    const isSheets = (php.subType || 'none') === 'sheets';
    const firstCardPage = !isSheets && php.addHowToCard ? 3 : 1;
    const targets: { path: string; pages: number[]; design: number | null; place: FinalCheckPlace }[] = isSheets
      ? [{ path: pdfPath, pages: [1, 2], design: null, place: 'card' }]
      : Array.from({ length: designCount }, (_, index) => ({
          path: pdfPath,
          pages: [firstCardPage + 2 * index, firstCardPage + 2 * index + 1],
          design: designCount > 1 ? index + 1 : null,
          place: 'card' as const,
        }));
    if (php.boxEnabled && php.boxFilename) {
      const boxPdf = `${process.env['PUBLIC_DIR']}/box-insert/${php.boxFilename}`;
      try {
        await fs.access(boxPdf);
        targets.push({ path: boxPdf, pages: [1, 2], design: null, place: 'box' });
      } catch {
        this.log(paymentId, php.id, `box inlay PDF missing on disk (${php.boxFilename}), its text not searched`, 'yellow');
      }
    }

    const problems: FinalCheckProblem[] = [];
    for (const target of targets) {
      try {
        if (await this.pdfContainsHitsterText(target.path, target.pages)) {
          problems.push({
            check: 'hitster',
            design: target.design,
            place: target.place,
            message: 'the word "Hitster" is in the printed text',
          });
        }
      } catch (e) {
        this.log(paymentId, php.id, `text search of ${path.basename(target.path)} failed: ${(e as Error).message}`, 'yellow');
      }
    }
    return problems;
  }

  private async pdfContainsHitsterText(pdfPath: string, pages: number[]): Promise<boolean> {
    const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(pdfPath)) });
    try {
      const parsed = await parser.getText({ partial: pages });
      return /hitster/i.test(parsed.pages?.map((p) => p.text).join(' ') || '');
    } finally {
      try {
        await parser.destroy();
      } catch {}
    }
  }
}

export default FinalCheck;
