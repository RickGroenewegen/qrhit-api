import sharp from 'sharp';
import path from 'path';
import jsQR from 'jsqr';
import { color } from 'console-log-colors';
import Logger from './logger';
import { getQrTotalModules } from './qr';

/**
 * Centre-logo support for QR cards.
 *
 * A logo laid over a QR code cannot simply be *covered*: the QR is a 600px
 * bitmap that the PDF renderer resamples down to the card size (~127 CSS px on
 * screen, ~397px at 300dpi), so every module edge becomes a soft band about a
 * pixel wide while the overlay's edge stays crisp. The averaged module colour
 * then bleeds out from under the overlay and reads as thin ragged lines of QR
 * squares, however precisely the overlay is aligned.
 *
 * So the modules under the logo are not covered, they are removed from the
 * bitmap before it is ever scaled - the same thing qrcode-with-logos does with
 * its `inLogoRange()` check, which skips painting those dots altogether.
 *
 * Scanners are unaffected: those modules were already hidden behind an opaque
 * patch, and error correction level H recovers ~30% while the designer caps the
 * logo at MAX_SCALE.
 */

/** Logo width as a percentage of the QR when a design does not specify one. */
export const DEFAULT_SCALE = 25;
/** Smallest width the designer offers. */
export const MIN_SCALE = 15;
/**
 * Largest width the designer offers.
 *
 * This is a share of the QR's *width*, but what costs error correction is the
 * *area* the logo clears, which grows with width x height. A wide wordmark at
 * 40% clears ~9% of the symbol and scans fine; a square logo at the same 40%
 * would clear ~22% and not decode at all. So the slider goes to 40 and
 * MAX_AREA_FRACTION does the actual safety work.
 */
export const MAX_SCALE = 40;

/**
 * Fallback ceiling on how much of the symbol the logo may clear.
 *
 * This is only a first guess. It cannot be the real safety mechanism: how much
 * a code tolerates depends on its symbol version, which follows the link length
 * and so differs per card and per environment. Measured: a 19x7 rect clears
 * just 7.9% of a 41-module grid and still will not decode, because at that
 * width it clips version 4's alignment pattern - while the same rect is fine on
 * a 45-module grid. So applyQrLogo decodes what it produced and shrinks until
 * it scans, and this only keeps the starting point sane.
 */
export const MAX_AREA_FRACTION = 0.145;

/**
 * Filenames the logo upload produces: a 32-char random id plus an extension.
 * Anything with a path separator, or that is not an image we serve, is not one
 * of ours.
 */
const LOGO_FILENAME = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;

/**
 * Accept a client-supplied logo filename, or null if it is not a plain
 * filename in the logo directory.
 *
 * qrLogo arrives from the card designer and ends up as a path sharp reads, so
 * an unchecked value ("../../private/invoices/x.png") would pull an arbitrary
 * file into a generated PDF. Persist only what this returns.
 */
export function sanitizeLogoFilename(
  value?: string | null
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !LOGO_FILENAME.test(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

/**
 * Absolute path of a logo, or null when the name is not a plain filename that
 * stays inside the logo directory.
 */
export function resolveLogoPath(
  publicDir: string,
  filename?: string | null
): string | null {
  const safe = sanitizeLogoFilename(filename);
  if (!safe) return null;

  const logoDir = path.resolve(publicDir, 'logo');
  const resolved = path.resolve(logoDir, safe);
  // Belt and braces: the regex already excludes separators, but containment is
  // what actually guarantees we never read outside the directory.
  if (resolved !== path.join(logoDir, safe)) return null;
  if (!resolved.startsWith(logoDir + path.sep)) return null;

  return resolved;
}

export interface QrLogoRect {
  /** Left edge in modules, measured from the QR image's left edge. */
  x: number;
  /** Top edge in modules, measured from the QR image's top edge. */
  y: number;
  width: number;
  height: number;
}

export function clampScale(scale?: number | null): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return DEFAULT_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale)));
}

/**
 * Rect the centre logo occupies, in whole QR modules.
 *
 * Single source of truth: the generator clears exactly this rect and the
 * qr_center_logo partial paints its backing patch over exactly this rect, so
 * the two can never drift apart.
 *
 * Spans share the grid's parity because a centred box only lands on module
 * boundaries when it does - an even span on an odd grid sits half a module off
 * and slices the squares it borders.
 *
 * `aspect` is the logo's height / width.
 */
export function getQrLogoRect(
  totalModules: number,
  scale: number,
  aspect: number
): QrLogoRect {
  const snap = (spanModules: number): number => {
    // The logo plus a module of quiet space on either side.
    let modules = Math.ceil(spanModules + 2);
    if (modules % 2 !== totalModules % 2) modules += 1;
    return modules;
  };

  let logoWidthModules = (totalModules * clampScale(scale)) / 100;
  let width = snap(logoWidthModules);
  let height = snap(logoWidthModules * aspect);

  // The slider is a width, but error correction pays for area. Step the logo
  // back until the rect fits the budget, so a tall or square logo at a high
  // scale can never produce a code that will not scan.
  const budget = totalModules * totalModules * MAX_AREA_FRACTION;
  while (width * height > budget && logoWidthModules > 1) {
    logoWidthModules -= 1;
    width = snap(logoWidthModules);
    height = snap(logoWidthModules * aspect);
  }

  return {
    x: (totalModules - width) / 2,
    y: (totalModules - height) / 2,
    width,
    height,
  };
}

/** Height / width of an image, used to shape the logo's backing patch. */
export async function getImageAspect(imagePath: string): Promise<number | null> {
  try {
    const { width, height } = await sharp(imagePath).metadata();
    if (!width || !height) return null;
    return height / width;
  } catch {
    return null;
  }
}

/**
 * Whether a rendered QR PNG still decodes.
 *
 * The QR's light modules are transparent, so it is flattened onto white first -
 * the same thing a card does when it prints the code onto its background.
 */
async function decodes(png: Buffer): Promise<boolean> {
  try {
    const { data, info } = await sharp(png)
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return !!jsQR(new Uint8ClampedArray(data), info.width, info.height);
  } catch {
    return false;
  }
}

export interface QrLogoOptions {
  /** Absolute path of the logo image to draw. */
  logoPath: string;
  /** Logo width as a percentage of the QR. */
  scale: number;
  /**
   * Colour painted behind the logo so it stays legible. The QR's own light
   * modules are transparent, so without this the card background shows through.
   */
  backingColor: string;
}

/**
 * Draw the centre logo into a generated QR PNG, in place.
 *
 * The modules it covers are cleared rather than painted over, and the logo is
 * composited into the same bitmap, so the logo and the code are resampled
 * together when the PDF scales them down - no overlay, and no seam.
 *
 * `link` must be the URL the QR was generated from - the symbol version, and
 * with it the module pitch, follows from its length.
 *
 * Never throws: a QR that could not be given its logo still renders, just
 * without one.
 */
export async function applyQrLogo(
  pngPath: string,
  link: string,
  options: QrLogoOptions,
  logger?: Logger
): Promise<boolean> {
  try {
    const totalModules = getQrTotalModules(link);
    const aspect = await getImageAspect(options.logoPath);
    if (aspect === null) {
      logger?.log(
        color.yellow.bold(
          `Could not read QR logo ${color.white.bold(
            options.logoPath
          )}; leaving the code untouched`
        )
      );
      return false;
    }

    const { data, info } = await sharp(pngPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    const pitch = width / totalModules;

    // The QR may have been rendered elsewhere (the Lambda path), so confirm the
    // grid before punching a hole in it: the quiet zone is 4 modules, and the
    // first painted column has to line up with that.
    let firstCol = -1;
    for (let x = 0; x < width && firstCol < 0; x++) {
      for (let y = 0; y < height; y++) {
        if (data[(y * width + x) * channels + 3] > 128) {
          firstCol = x;
          break;
        }
      }
    }
    if (firstCol < 0 || Math.abs(firstCol - pitch * 4) > pitch / 2) {
      logger?.log(
        color.yellow.bold(
          `Skipping QR logo clear for ${color.white.bold(
            pngPath
          )}: quiet zone at ${color.white.bold(
            firstCol
          )}px does not match a ${color.white.bold(totalModules)}-module grid`
        )
      );
      return false;
    }

    // Build the code at a given scale. Round outwards so the cleared area always
    // covers the whole backing patch rather than leaving a sliver of a module
    // along its edge.
    const render = async (scale: number): Promise<Buffer> => {
      const rect = getQrLogoRect(totalModules, scale, aspect);
      const left = Math.max(0, Math.floor(rect.x * pitch));
      const top = Math.max(0, Math.floor(rect.y * pitch));
      const right = Math.min(width, Math.ceil((rect.x + rect.width) * pitch));
      const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * pitch));

      const cleared = Buffer.from(data);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          cleared[(y * width + x) * channels + 3] = 0;
        }
      }

      // The logo sits inside the cleared rect, inset by the module of quiet
      // space getQrLogoRect added on each side.
      const logoWidth = Math.max(1, Math.round((rect.width - 2) * pitch));
      const logoHeight = Math.max(1, Math.round(logoWidth * aspect));
      const logo = await sharp(options.logoPath)
        .resize(logoWidth, logoHeight, { fit: 'inside' })
        .png()
        .toBuffer();

      const patch = await sharp({
        create: {
          width: right - left,
          height: bottom - top,
          channels: 4,
          background: options.backingColor,
        },
      })
        .composite([{ input: logo, gravity: 'centre' }])
        .png()
        .toBuffer();

      return sharp(cleared, { raw: { width, height, channels } })
        .composite([{ input: patch, left, top }])
        .png()
        .toBuffer();
    };

    // How much a code tolerates depends on its symbol version, which follows
    // the link length - so the requested scale is a wish, not a guarantee.
    // Step it down until the result actually decodes rather than shipping a
    // card nobody can scan.
    // Silent by design: this runs per card, so logging each reduction buries
    // the generation log under hundreds of identical lines.
    for (let scale = clampScale(options.scale); scale >= MIN_SCALE; scale -= 1) {
      const candidate = await render(scale);
      if (!(await decodes(candidate))) continue;

      await sharp(candidate).toFile(pngPath);
      return true;
    }

    logger?.log(
      color.yellow.bold(
        `QR logo left off ${color.white.bold(
          pngPath
        )}: no size down to ${color.white.bold(MIN_SCALE + '%')} decoded`
      )
    );
    return false;
  } catch (error: any) {
    logger?.log(
      color.red.bold(
        `Error applying QR logo to ${color.white.bold(pngPath)}: ${
          error.message
        }`
      )
    );
    return false;
  }
}
