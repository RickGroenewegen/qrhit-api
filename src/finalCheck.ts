import path from 'path';
import { promises as fs } from 'fs';
import { PDFParse } from 'pdf-parse';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import { ChatGPT } from './chatgpt';
import PDF from './pdf';

export type FinalCheckFailureReason =
  | 'pdf-missing'
  | 'design-mismatch'
  | 'inappropriate'
  | 'hitster'
  | 'unreadable';

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
    };

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
      include: { playlist: true },
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
    const failBase = {
      paymentHasPlaylistId: php.id,
      playlistDbId: php.playlist.id,
      playlistId: php.playlist.playlistId,
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

      this.logVision(
        payment.paymentId,
        php.id,
        'rendering PDF pages 1-2 → PNG'
      );
      const [pdfPage1, pdfPage2] = await this.pdfToPngPages(
        pdfPath,
        tmpDir,
        'pdf'
      );

      const isSheets = (php.subType || 'none') === 'sheets';

      const liveBuffer = await this.renderLivePdf(
        payment,
        php,
        isSheets
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

      let livePage1: string | null = null;
      let livePage2: string | null = null;

      if (liveBuffer) {
        this.logVision(
          payment.paymentId,
          php.id,
          `live re-render OK (${liveBuffer.length} bytes), rasterizing pages 1-2`
        );
        const livePdfPath = path.join(tmpDir, `live.pdf`);
        await fs.writeFile(livePdfPath, liveBuffer);
        const [p1, p2] = await this.pdfToPngPages(livePdfPath, tmpDir, 'live');
        livePage1 = p1;
        livePage2 = p2;
      } else {
        this.logVision(
          payment.paymentId,
          php.id,
          'live re-render unavailable → skipping design-match check'
        );
      }

      if (livePage1 && livePage2) {
        const designPrompt = `You are verifying that a printed PDF page broadly reflects the user's intended card design. Image A is one page from the PDF stored on disk. Image B is a freshly-rendered version of the same page from the live design route.

Decide whether the two images show the SAME OVERALL DESIGN. Be lenient — we only want to catch cases where the user's actual visual design has clearly drifted (wrong background, wrong artwork, wrong layout, wrong fonts, missing major elements, wrong colors, broken/blank rendering).

You MUST IGNORE all of the following — these are NOT mismatches:
- Small identifier text, batch numbers, sequence/copy numbers, order numbers (e.g. "#1552" vs "#1552-1"), version indicators, or any other tiny numeric/text differences in margins or corners.
- Differences in image scaling, anti-aliasing, compression artifacts, font hinting, or sub-pixel positioning.
- Different image dimensions or aspect ratios as long as the design itself is the same.
- QR code pixel patterns differing (QR codes can encode different payloads while remaining "the same design").
- Trim marks, bleed marks, or other print-only artifacts present on one but not the other.

Only set match=false when a HUMAN looking at the two images would say "those are clearly different designs."

Reply STRICTLY as JSON: {"match": true|false, "reason": "string"}`;

        this.logVision(payment.paymentId, php.id, 'design-match page 1 → asking GPT');
        const r1 = await this.chatgpt.askWithImages(designPrompt, [
          pdfPage1,
          livePage1,
        ]);
        this.logVision(
          payment.paymentId,
          php.id,
          `design-match page 1 → match=${r1?.match} ${r1?.reason ? `reason="${r1.reason}"` : ''}`
        );

        this.logVision(payment.paymentId, php.id, 'design-match page 2 → asking GPT');
        const r2 = await this.chatgpt.askWithImages(designPrompt, [
          pdfPage2,
          livePage2,
        ]);
        this.logVision(
          payment.paymentId,
          php.id,
          `design-match page 2 → match=${r2?.match} ${r2?.reason ? `reason="${r2.reason}"` : ''}`
        );

        if (r1?.match === false || r2?.match === false) {
          return {
            ok: false,
            reason: 'design-mismatch',
            userActionable: false,
            details: `Page 1: ${
              r1?.match === false ? r1.reason || 'mismatch' : 'ok'
            } | Page 2: ${
              r2?.match === false ? r2.reason || 'mismatch' : 'ok'
            }`,
            ...failBase,
          };
        }
      }

      const profPrompt = `Inspect the two card pages for profanity, hate speech, racism, sexual content, harassment, or anything illegal in the EU. Be strict but reasonable: do NOT flag ordinary song titles, artist names, or album artwork that is otherwise innocuous. Reply STRICTLY as JSON: {"clean": true|false, "categories": ["string"], "details": "string"}`;
      this.logVision(payment.paymentId, php.id, 'profanity/illegality → asking GPT');
      const profResult = await this.chatgpt.askWithImages(profPrompt, [
        pdfPage1,
        pdfPage2,
      ]);
      this.logVision(
        payment.paymentId,
        php.id,
        `profanity/illegality → clean=${profResult?.clean} categories=[${(profResult?.categories || []).join(', ')}] ${profResult?.details ? `details="${profResult.details}"` : ''}`
      );
      if (profResult && profResult.clean === false) {
        return {
          ok: false,
          reason: 'inappropriate',
          userActionable: true,
          details: `Categories: ${(profResult.categories || []).join(
            ', '
          )}. ${profResult.details || ''}`,
          ...failBase,
        };
      }

      const hitsterPrompt = `The first two attached images are reference photos of the Hitster product (a competing music game). The next two attached images are pages of a printed card from another product.

Decide whether the card infringes on Hitster. Be SPECIFIC:

REASONS TO FLAG (clean: false):
- The literal word "Hitster" appears anywhere on the card (textual or stylized).
- Distinctive Hitster visual elements are reproduced — for example: the Hitster logo, Hitster's specific speaker/loudspeaker imagery as seen in the reference photos, or a clear copy of their cover-art / box-art style.

REASONS NOT TO FLAG (clean: true):
- The card is simply a music-trivia card with a QR code, song year, and artist/title. That format is generic across the category and is not by itself an infringement.
- The product has a name that rhymes with or puns on "Hitster" (e.g. "Shipster", "Listster"). Rhyming/punning names alone are NOT a reason to flag — only the literal name "Hitster" is.
- Generic icons (musical notes, headphones) that are not the specific speaker imagery from the Hitster reference images.

Reply STRICTLY as JSON: {"clean": true|false, "evidence": "string"}`;
      this.logVision(payment.paymentId, php.id, 'Hitster look-alike → asking GPT (with 2 reference images)');
      const hitsterVisual = await this.chatgpt.askWithImages(hitsterPrompt, [
        ...this.hitsterRefImages,
        pdfPage1,
        pdfPage2,
      ]);
      this.logVision(
        payment.paymentId,
        php.id,
        `Hitster look-alike → clean=${hitsterVisual?.clean} ${hitsterVisual?.evidence ? `evidence="${hitsterVisual.evidence}"` : ''}`
      );
      if (hitsterVisual && hitsterVisual.clean === false) {
        return {
          ok: false,
          reason: 'hitster',
          userActionable: true,
          details: `Visual: ${
            hitsterVisual.evidence || 'Hitster-like elements detected'
          }`,
          ...failBase,
        };
      }

      try {
        this.logVision(payment.paymentId, php.id, 'Hitster textual scan → extracting PDF text (pages 1-2)');
        const buf = await fs.readFile(pdfPath);
        const parser = new PDFParse({ data: new Uint8Array(buf) });
        const parsed = await parser.getText({ first: 2 });
        await parser.destroy();
        const text = parsed.pages?.map((p) => p.text).join(' ') || '';
        const matched = /hitster/i.test(text);
        this.logVision(
          payment.paymentId,
          php.id,
          `Hitster textual scan → matched=${matched} (${text.length} chars scanned)`
        );
        if (matched) {
          return {
            ok: false,
            reason: 'hitster',
            userActionable: true,
            details:
              'The word "Hitster" was found in the printed text of pages 1-2.',
            ...failBase,
          };
        }
      } catch (e) {
        this.logger.log(
          color.yellow.bold(
            `finalCheck: pdf-parse failed for ${white.bold(
              filename
            )}: ${(e as Error).message}`
          )
        );
      }

      const readabilityPrompt = `You are checking whether the artist / title / year text on a printed music-trivia card is readable by a human at arm's length.

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

      this.logVision(
        payment.paymentId,
        php.id,
        'readability/contrast → asking GPT (pages 1+2)'
      );
      const readResult = await this.chatgpt.askWithImages(readabilityPrompt, [
        pdfPage1,
        pdfPage2,
      ]);
      this.logVision(
        payment.paymentId,
        php.id,
        `readability/contrast → readable=${readResult?.readable} ${
          readResult?.details ? `details="${readResult.details}"` : ''
        }`
      );
      if (readResult && readResult.readable === false) {
        return {
          ok: false,
          reason: 'unreadable',
          userActionable: false,
          details:
            readResult.details ||
            'Artist/title/year text has insufficient contrast against its background.',
          ...failBase,
        };
      }

      this.logVision(payment.paymentId, php.id, 'all checks passed ✓');
      return { ok: true };
    } finally {
      await cleanup();
    }
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

  private async renderLivePdf(
    payment: { paymentId: string; qrSubDir: string | null },
    php: any,
    isSheets: boolean
  ): Promise<Buffer> {
    const template = isSheets ? 'printer_sheets' : 'printer';
    const startIndex = 0;
    const endIndex = isSheets ? 11 : 0;
    const subdir = payment.qrSubDir || '';
    const ecoInt = php.eco ? 1 : 0;
    const itemIndex = 0;

    const url = `${process.env['API_URI']}/qr/pdf/${php.playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}/${subdir}/${ecoInt}/0/${itemIndex}`;

    const lambdaOptions: any = {
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: '1-2',
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
