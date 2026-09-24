import path from 'path';
import { promises as fs } from 'fs';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import { ChatGPT } from './chatgpt';
import PDF from './pdf';
import { resolveQrSubDir } from './qrPaths';

export type FinalCheckFailureReason =
  | 'pdf-missing'
  | 'design-mismatch'
  | 'hitster'
  | 'unreadable';

export interface FinalCheckFlaggedImage {
  // i18n label key, resolved to a human name in the design-alter mail
  key: 'cardFront' | 'cardBack' | 'boxFront' | 'boxBack';
  // attachment filename (e.g. 'card-front.png')
  filename: string;
  // the rendered page PNG, kept in-memory so the mail layer is self-contained
  // (the temp render dir is deleted before the mail is built)
  buffer: Buffer;
  // Which of the deck's alternating designs it shows (1-based, see
  // src/cardDesigns.ts); null for a single-design deck and the box inlay.
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
 * the deck has a single design, for the box inlay, and for a text hit on a
 * sheet (whose page holds every design). Stored with the hold
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
      // Populated only for Hitster visual hits: the offending rendered page(s),
      // attached inline to the customer email.
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

/** One design's front and back, as page images. */
interface DesignSides {
  // 1-based design number; null for a single-design deck
  design: number | null;
  front: string;
  back: string;
}

// The printer_sheets layout (views/pdf_printer_sheets.ejs): an A4 page with
// 15mm margins holding rows of three 60mm cards; the back page mirrors every
// row for duplex printing.
const SHEET = { widthMm: 210, marginMm: 15, cardMm: 60, perRow: 3, perPage: 12 };

// Both flagged → 'card'. The card is the primary product, and the tab bar
// keeps the box one click away.
export function correctionTabForFlaggedKeys(
  keys: FinalCheckFlaggedImage['key'][]
): FinalCheckCorrectionTab {
  const hasCard = keys.some((k) => k === 'cardFront' || k === 'cardBack');
  return hasCard ? 'card' : 'box';
}

class FinalCheck {
  private static instance: FinalCheck;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private chatgpt = new ChatGPT();
  private pdf = new PDF();

  private get hitsterRefImages(): string[] {
    const base = process.env['ASSETS_DIR'] || '';
    return [
      path.join(base, 'hitster_reference', 'hitster_box.png'),
      path.join(base, 'hitster_reference', 'hitster_card.png'),
    ];
  }

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
        extraDesigns: { select: { position: true }, orderBy: { position: 'asc' } },
      },
    });

    if (phps.length === 0) {
      return { ok: true };
    }

    for (const php of phps) {
      const result = await this.checkOnePlaylist(payment, php);
      if (!result.ok) return result;
    }

    return { ok: true };
  }

  private logVision(paymentId: string, phpId: number, message: string) {
    this.logger.log(
      color.blue.bold(
        `[${white.bold('finalCheck')}] ${white.bold(paymentId)} php=${white.bold(
          phpId.toString()
        )} ${message}`
      )
    );
  }

  private async checkOnePlaylist(
    payment: { id: number; paymentId: string; qrSubDir: string | null },
    php: any
  ): Promise<FinalCheckResult> {
    // Alternating card designs (src/cardDesigns.ts): card k has design
    // k % designCount, so the first card of every design is checked.
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

    const tmpDir = `${process.env['PUBLIC_DIR']}/pdf/_finalcheck/${payment.paymentId}_${php.id}`;
    await fs.mkdir(tmpDir, { recursive: true });

    const cleanup = async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    try {
      this.logVision(
        payment.paymentId,
        php.id,
        `starting checks (filename=${filename}, subType=${
          php.subType || 'none'
        })`
      );

      const isSheets = (php.subType || 'none') === 'sheets';
      // A printer PDF opens with the how-to card when there is one; sheets
      // never carry it.
      const firstCardPage = !isSheets && php.addHowToCard ? 3 : 1;

      this.logVision(
        payment.paymentId,
        php.id,
        `rendering the first card of ${designCount} design(s) → PNG`
      );
      const pdfSides = await this.designSides(
        pdfPath,
        tmpDir,
        'pdf',
        isSheets,
        designCount,
        firstCardPage
      );

      const liveBuffer = await this.renderLivePdf(
        payment,
        php,
        isSheets,
        designCount,
        firstCardPage
      ).catch((e) => {
        this.logger.log(
          color.yellow.bold(
            `finalCheck: live re-render failed for ${white.bold(
              payment.paymentId
            )} php ${white.bold(php.id)}: ${(e as Error).message}`
          )
        );
        return null as Buffer | null;
      });

      let liveSides: DesignSides[] | null = null;

      if (liveBuffer) {
        this.logVision(
          payment.paymentId,
          php.id,
          `live re-render OK (${liveBuffer.length} bytes), rasterizing ${designCount} design(s)`
        );
        const livePdfPath = path.join(tmpDir, `live.pdf`);
        await fs.writeFile(livePdfPath, liveBuffer);
        liveSides = await this.designSides(
          livePdfPath,
          tmpDir,
          'live',
          isSheets,
          designCount,
          firstCardPage
        );
      } else {
        this.logVision(
          payment.paymentId,
          php.id,
          'live re-render unavailable → skipping design-match check'
        );
      }

      if (liveSides) {
        const designPrompt =`You are verifying that a printed PDF page broadly reflects the user's intended card design. Image A is one page from the PDF stored on disk. Image B is a freshly-rendered version of the same page from the live design route.

Decide whether the two images show the SAME OVERALL DESIGN. Be lenient — we only want to catch cases where the user's actual visual design has clearly drifted (wrong background, wrong artwork, wrong layout, wrong fonts, missing major elements, wrong colors, broken/blank rendering).

You MUST IGNORE all of the following — these are NOT mismatches:
- Small identifier text, batch numbers, sequence/copy numbers, order numbers (e.g. "#1552" vs "#1552-1"), version indicators, or any other tiny numeric/text differences in margins or corners.
- Differences in image scaling, anti-aliasing, compression artifacts, font hinting, or sub-pixel positioning.
- Different image dimensions or aspect ratios as long as the design itself is the same.
- QR code pixel patterns differing (QR codes can encode different payloads while remaining "the same design").
- Trim marks, bleed marks, or other print-only artifacts present on one but not the other.

Only set match=false when a HUMAN looking at the two images would say "those are clearly different designs."

Reply STRICTLY as JSON: {"match": true|false, "reason": "string"}`;

        const mismatches: FinalCheckProblem[] = [];
        for (const [index, stored] of pdfSides.entries()) {
          const live = liveSides[index];
          for (const side of ['front', 'back'] as const) {
            const label = `design-match ${this.sideLabel(stored.design, side)}`;
            this.logVision(payment.paymentId, php.id, `${label} → asking GPT`);
            const r = await this.chatgpt.askWithImages(designPrompt, [
              stored[side],
              live[side],
            ]);
            this.logVision(
              payment.paymentId,
              php.id,
              `${label} → match=${r?.match} ${r?.reason ? `reason="${r.reason}"` : ''}`
            );
            if (r?.match === false) {
              mismatches.push({
                check: 'design-mismatch',
                design: stored.design,
                place: side === 'front' ? 'card-front' : 'card-back',
                message: r.reason || 'mismatch',
              });
            }
          }
        }

        if (mismatches.length) {
          return this.failure('design-mismatch', false, mismatches, failBase);
        }
      }

      // Resolve the box inlay PDF (if any) so it is Hitster-checked alongside
      // the playing card. Only present for physical orders with a box enabled.
      let boxPdfPath: string | null = null;
      if (php.boxEnabled && php.boxFilename) {
        const candidate = `${process.env['PUBLIC_DIR']}/box-insert/${php.boxFilename}`;
        try {
          await fs.access(candidate);
          boxPdfPath = candidate;
        } catch {
          this.logVision(
            payment.paymentId,
            php.id,
            `box inlay PDF missing on disk (${php.boxFilename}) → skipping box checks`
          );
        }
      }

      const hitsterPrompt = `The first two attached images are reference photos of the Hitster product (a competing music game). The final attached image is one side of a printed card or box insert from another product.

Decide whether it infringes on Hitster. Be SPECIFIC:

REASONS TO FLAG (clean: false):
- The literal word "Hitster" appears anywhere on it (textual or stylized).
- Distinctive Hitster visual elements are reproduced — for example: the Hitster logo, Hitster's specific speaker/loudspeaker imagery as seen in the reference photos, or a clear copy of their cover-art / box-art style.

REASONS NOT TO FLAG (clean: true):
- It is simply a music-trivia card with a QR code, song year, and artist/title. That format is generic across the category and is not by itself an infringement.
- The product has a name that rhymes with or puns on "Hitster" (e.g. "Shipster", "Listster"). Rhyming/punning names alone are NOT a reason to flag — only the literal name "Hitster" is.
- Generic icons (musical notes, headphones) that are not the specific speaker imagery from the Hitster reference images.

Reply STRICTLY as JSON: {"clean": true|false, "evidence": "string"}`;

      // Check each rendered page individually so we know exactly which page
      // infringes and can attach it (name + image) to the customer email.
      const hitsterPages: {
        key: FinalCheckFlaggedImage['key'];
        path: string;
        filename: string;
        label: string;
        design: number | null;
        place: FinalCheckPlace;
      }[] = pdfSides.flatMap((sides) =>
        (['front', 'back'] as const).map((side) => ({
          key: side === 'front' ? ('cardFront' as const) : ('cardBack' as const),
          path: sides[side],
          filename: sides.design
            ? `card-${side}-design-${sides.design}.png`
            : `card-${side}.png`,
          label: this.sideLabel(sides.design, side),
          design: sides.design,
          place: side === 'front' ? ('card-front' as const) : ('card-back' as const),
        }))
      );

      if (boxPdfPath) {
        try {
          this.logVision(payment.paymentId, php.id, 'rendering box inlay pages 1-2 → PNG');
          const [boxPage1, boxPage2] = await this.pdfToPngPages(
            boxPdfPath,
            tmpDir,
            'box'
          );
          hitsterPages.push({
            key: 'boxFront',
            path: boxPage1,
            filename: 'box-front.png',
            label: 'box inlay front',
            design: null,
            place: 'box-front',
          });
          hitsterPages.push({
            key: 'boxBack',
            path: boxPage2,
            filename: 'box-back.png',
            label: 'box inlay back',
            design: null,
            place: 'box-back',
          });
        } catch (e) {
          this.logVision(
            payment.paymentId,
            php.id,
            `box inlay rasterization failed: ${
              (e as Error).message
            } → box still text-scanned`
          );
        }
      }

      const flaggedImages: FinalCheckFlaggedImage[] = [];
      const hitsterProblems: FinalCheckProblem[] = [];
      for (const page of hitsterPages) {
        this.logVision(
          payment.paymentId,
          php.id,
          `Hitster look-alike (${page.label}) → asking GPT (with 2 reference images)`
        );
        const verdict = await this.chatgpt.askWithImages(hitsterPrompt, [
          ...this.hitsterRefImages,
          page.path,
        ]);
        this.logVision(
          payment.paymentId,
          php.id,
          `Hitster look-alike (${page.label}) → clean=${verdict?.clean} ${
            verdict?.evidence ? `evidence="${verdict.evidence}"` : ''
          }`
        );
        if (verdict && verdict.clean === false) {
          flaggedImages.push({
            key: page.key,
            filename: page.filename,
            buffer: await fs.readFile(page.path),
            design: page.design,
          });
          hitsterProblems.push({
            check: 'hitster',
            design: page.design,
            place: page.place,
            message: verdict.evidence || 'Hitster-like elements detected',
          });
        }
      }

      if (flaggedImages.length > 0) {
        return {
          ...this.failure('hitster', true, hitsterProblems, failBase),
          flaggedImages,
          correctionTab: correctionTabForFlaggedKeys(
            flaggedImages.map((i) => i.key)
          ),
        };
      }

      // The printed text. A printer PDF has pages of its own per design, so a
      // hit names the design; a sheet page holds every design at once.
      const textTargets: {
        label: string;
        path: string;
        pages: number[];
        design: number | null;
        place: FinalCheckPlace;
        tab: FinalCheckCorrectionTab;
      }[] = [
        ...(isSheets
          ? [{ label: 'card', path: pdfPath, pages: [1, 2], design: null, place: 'card' as const, tab: 'card' as const }]
          : pdfSides.map((sides, index) => {
              const front = firstCardPage + 2 * index;
              return {
                label: this.sideLabel(sides.design, null),
                path: pdfPath,
                pages: [front, front + 1],
                design: sides.design,
                place: 'card' as const,
                tab: 'card' as const,
              };
            })),
        ...(boxPdfPath
          ? [{ label: 'box inlay', path: boxPdfPath, pages: [1, 2], design: null, place: 'box' as const, tab: 'box' as const }]
          : []),
      ];
      const textProblems: FinalCheckProblem[] = [];
      let textTab: FinalCheckCorrectionTab | null = null;
      for (const target of textTargets) {
        try {
          this.logVision(
            payment.paymentId,
            php.id,
            `Hitster textual scan (${target.label}) → extracting PDF text (pages ${target.pages.join(', ')})`
          );
          const { matched, chars } = await this.pdfContainsHitsterText(
            target.path,
            target.pages
          );
          this.logVision(
            payment.paymentId,
            php.id,
            `Hitster textual scan (${target.label}) → matched=${matched} (${chars} chars scanned)`
          );
          if (matched) {
            textProblems.push({
              check: 'hitster',
              design: target.design,
              place: target.place,
              message: 'the word "Hitster" is in the printed text',
            });
            // The card is the primary product: it wins the correction tab.
            textTab = textTab === 'card' ? 'card' : target.tab;
          }
        } catch (e) {
          this.logger.log(
            color.yellow.bold(
              `finalCheck: pdf-parse failed for ${white.bold(
                target.path
              )}: ${(e as Error).message}`
            )
          );
        }
      }

      if (textProblems.length > 0) {
        return {
          ...this.failure('hitster', true, textProblems, failBase),
          correctionTab: textTab ?? 'card',
        };
      }

      const readabilityPrompt =`You are checking whether the artist / title / year text on a printed music-trivia card is readable by a human at arm's length.

You will receive two images. Each image is one page of a PDF. Depending on the product type, a page may show:
  (a) ONE single card filling the page, or
  (b) a SHEET containing many small cards arranged in a grid.

Either way, find every place where the artist name, song title, or year is printed and judge ONLY whether the text has enough contrast against whatever is directly behind it (solid color, gradient, or background photo).

FLAG (readable: false) only for CLEAR contrast failures that a normal human would struggle to read:
- Dark text on a dark background (e.g. black/navy text on a dark photo or dark solid).
- Light text on a light background (e.g. white/cream text on a pale/washed-out photo or light solid).
- Text whose color is so close to the background color that it visually disappears.
- Text laid over a busy area of a background image where the specific letters become unreadable because foreground and background share the same tonal range.

DO NOT FLAG:
- Text that is small but has good contrast — small-but-legible is fine.
- Stylistic choices (unusual fonts, italics, mixed case) as long as contrast is OK.
- Slightly low contrast that is still comfortably readable.
- QR codes, decorative elements, logos, or non-text graphics.
- Anti-aliasing / rendering softness from the rasterizer.

If even ONE card on the page has unreadable artist/title/year text due to poor contrast, set readable=false and describe which text and what the contrast problem is. If all text is legible, set readable=true.

Reply STRICTLY as JSON: {"readable": true|false, "details": "string"}`;

      // The artist, title and year are on the back, so that is where a
      // problem is pinned.
      const unreadable: FinalCheckProblem[] = [];
      for (const sides of pdfSides) {
        const label = `readability/contrast ${this.sideLabel(sides.design, null)}`;
        this.logVision(payment.paymentId, php.id, `${label} → asking GPT`);
        const readResult = await this.chatgpt.askWithImages(readabilityPrompt, [
          sides.front,
          sides.back,
        ]);
        this.logVision(
          payment.paymentId,
          php.id,
          `${label} → readable=${readResult?.readable} ${
            readResult?.details ? `details="${readResult.details}"` : ''
          }`
        );
        if (readResult && readResult.readable === false) {
          unreadable.push({
            check: 'unreadable',
            design: sides.design,
            place: 'card-back',
            message:
              readResult.details ||
              'Artist/title/year text has insufficient contrast against its background.',
          });
        }
      }

      if (unreadable.length) {
        return this.failure('unreadable', false, unreadable, failBase);
      }

      this.logVision(payment.paymentId, php.id, 'all checks passed ✓');
      return { ok: true };
    } finally {
      await cleanup();
    }
  }

  /** A failed check with its problems, described one by one in `details`. */
  private failure(
    reason: FinalCheckProblem['check'],
    userActionable: boolean,
    problems: FinalCheckProblem[],
    failBase: {
      paymentHasPlaylistId: number;
      playlistDbId: number;
      playlistId: string;
      designCount: number;
    }
  ): Extract<FinalCheckResult, { ok: false }> {
    return {
      ok: false,
      reason,
      userActionable,
      details: problems.map(describeFinalCheckProblem).join(' | '),
      ...failBase,
      problems,
    };
  }

  /** "design 2 back" / "card back" / "design 2" / "card", for the logs. */
  private sideLabel(design: number | null, side: 'front' | 'back' | null): string {
    const what = design ? `design ${design}` : 'card';
    return side ? `${what} ${side}` : what;
  }

  /**
   * The front and back of the first card of every design, as PNGs.
   *
   * A printer PDF has one card per page pair: design d is on the pages of
   * card d (after the how-to card, when there is one). A sheet holds twelve
   * cards per page, fronts on page 1 and backs on page 2, so a deck with
   * several designs gets each design's card cut out of the sheet; a
   * single-design sheet is checked as the whole page, as it always was.
   */
  private async designSides(
    pdfPath: string,
    saveDir: string,
    prefix: string,
    isSheets: boolean,
    designCount: number,
    firstCardPage: number
  ): Promise<DesignSides[]> {
    const numberOf = (index: number) => (designCount > 1 ? index + 1 : null);

    if (isSheets) {
      const [front, back] = await this.pdfToPngPageList(pdfPath, saveDir, prefix, [1, 2]);
      if (designCount === 1) {
        return [{ design: null, front, back }];
      }
      const sides: DesignSides[] = [];
      for (let card = 0; card < Math.min(designCount, SHEET.perPage); card++) {
        const row = Math.floor(card / SHEET.perRow);
        const column = card % SHEET.perRow;
        sides.push({
          design: numberOf(card),
          front: await this.cropSheetCard(front, row, column, `${prefix}_design${card + 1}_front.png`),
          // The back page mirrors each row for duplex printing
          back: await this.cropSheetCard(
            back,
            row,
            SHEET.perRow - 1 - column,
            `${prefix}_design${card + 1}_back.png`
          ),
        });
      }
      return sides;
    }

    const pages = Array.from({ length: designCount }, (_, index) => firstCardPage + 2 * index);
    const images = await this.pdfToPngPageList(
      pdfPath,
      saveDir,
      prefix,
      pages.flatMap((front) => [front, front + 1])
    );
    return pages.map((_, index) => ({
      design: numberOf(index),
      front: images[2 * index],
      back: images[2 * index + 1],
    }));
  }

  /** One 60mm card cut out of a rendered sheet page (see SHEET). */
  private async cropSheetCard(
    pagePng: string,
    row: number,
    column: number,
    filename: string
  ): Promise<string> {
    const page = await fs.readFile(pagePng);
    const { width } = await sharp(page).metadata();
    const pxPerMm = (width || 0) / SHEET.widthMm;
    const size = Math.floor(SHEET.cardMm * pxPerMm);
    const out = path.join(path.dirname(pagePng), filename);
    await fs.writeFile(
      out,
      await sharp(page)
        .extract({
          left: Math.round((SHEET.marginMm + column * SHEET.cardMm) * pxPerMm),
          top: Math.round((SHEET.marginMm + row * SHEET.cardMm) * pxPerMm),
          width: size,
          height: size,
        })
        .png()
        .toBuffer()
    );
    return out;
  }

  private async pdfToPngPages(
    pdfPath: string,
    saveDir: string,
    prefix: string
  ): Promise<[string, string]> {
    const buf = await fs.readFile(pdfPath);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getScreenshot({
        first: 2,
        scale: 2.0,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const pages = result.pages || [];
      if (pages.length < 2 || !pages[0]?.data || !pages[1]?.data) {
        throw new Error(
          `pdf-parse getScreenshot returned ${pages.length} page(s) with usable data; expected 2`
        );
      }
      const out1 = path.join(saveDir, `${prefix}_page1.png`);
      const out2 = path.join(saveDir, `${prefix}_page2.png`);
      await fs.writeFile(out1, Buffer.from(pages[0].data as Uint8Array));
      await fs.writeFile(out2, Buffer.from(pages[1].data as Uint8Array));
      return [out1, out2];
    } finally {
      try {
        await parser.destroy();
      } catch {}
    }
  }

  /** pdfToPngPages for any list of (1-based) pages, in the order asked. */
  private async pdfToPngPageList(
    pdfPath: string,
    saveDir: string,
    prefix: string,
    pageNumbers: number[]
  ): Promise<string[]> {
    const buf = await fs.readFile(pdfPath);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getScreenshot({
        partial: pageNumbers,
        scale: 2.0,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const pages = result.pages || [];
      const files: string[] = [];
      for (const pageNumber of pageNumbers) {
        const page = pages.find((p) => p.pageNumber === pageNumber);
        if (!page?.data) {
          throw new Error(
            `pdf-parse getScreenshot returned no usable data for page ${pageNumber}`
          );
        }
        const file = path.join(saveDir, `${prefix}_page${pageNumber}.png`);
        await fs.writeFile(file, Buffer.from(page.data as Uint8Array));
        files.push(file);
      }
      return files;
    } finally {
      try {
        await parser.destroy();
      } catch {}
    }
  }

  private async pdfContainsHitsterText(
    pdfPath: string,
    pages: number[]
  ): Promise<{ matched: boolean; chars: number }> {
    const buf = await fs.readFile(pdfPath);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const parsed = await parser.getText({ partial: pages });
      const text = parsed.pages?.map((p) => p.text).join(' ') || '';
      return { matched: /hitster/i.test(text), chars: text.length };
    } finally {
      try {
        await parser.destroy();
      } catch {}
    }
  }

  /**
   * The first pages of the order as the live design route draws them now.
   * A printer render runs to the first card of the last design (past the
   * how-to card, when there is one), so every design has pages to compare
   * against; a sheet holds them all on its first two pages.
   */
  private async renderLivePdf(
    payment: { paymentId: string; qrSubDir: string | null },
    php: any,
    isSheets: boolean,
    designCount: number = 1,
    firstCardPage: number = 1
  ): Promise<Buffer> {
    const template = isSheets ? 'printer_sheets' : 'printer';
    const startIndex = 0;
    const endIndex = isSheets ? 11 : designCount - 1;
    const subdir = await resolveQrSubDir(payment.qrSubDir, php.id);
    const ecoInt = php.eco ? 1 : 0;
    const itemIndex = 0;

    const url = `${process.env['API_URI']}/qr/pdf/${php.playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}/${subdir}/${ecoInt}/0/${itemIndex}`;

    const lambdaOptions: any = {
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: isSheets ? '1-2' : `1-${firstCardPage + 2 * designCount - 1}`,
    };

    if (isSheets) {
      lambdaOptions.format = 'a4';
    } else {
      lambdaOptions.width = 60;
      lambdaOptions.height = 60;
    }

    return await this.pdf.renderUrlToPdfBuffer(url, lambdaOptions);
  }
}

export default FinalCheck;
