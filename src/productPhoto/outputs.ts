import sharp from 'sharp';

/**
 * The files a product photo is published as, from its master (a transparent
 * PNG, 16:10, the cards with their soft shadow, 1600 px wide or more; the
 * aspect is kept, only the width is set):
 *
 * - `<name>-<w>.avif` / `.webp` at PHOTO_WIDTHS: the transparent cutout the
 *   product page shows (srcset with w descriptors, qrhit product-photo.ts);
 * - `<name>-cream.jpg`: on the page's cream, the <img> fallback;
 * - `<name>-feed.jpg`: the cards filling the frame on crisp white, for Google
 *   Shopping (the Channable feed) and the Product's JSON-LD. The soft shadow
 *   and the card edges keep the white cards apart from the white ground;
 *   past the shadow the ground is pure white (cleanShadow);
 * - `<name>-og.jpg`: 1200x630 on cream, for og:image and twitter:image.
 *
 * Shared by the pilot's CLI (scripts/product-photo.ts tiers) and the
 * per-playlist photos, so both publish exactly the same set.
 */
export const PHOTO_WIDTHS = [720, 1080, 1440];
export const PHOTO_WIDTH = 1600;
export const CREAM = '#feefe5';
const WHITE = '#ffffff';
const OG = { width: 1200, height: 630, margin: 20 };
// white around the cards in the feed photo, as a share of its longer side:
// Google wants the product to fill most of the frame
const FEED_MARGIN = 0.04;
// share of the width over which the frame's edge fades to transparent
const FEATHER = 0.02;
// shadow alpha below this is dropped (0-255)
const SHADOW_FLOOR = 6;

export interface PhotoFile {
  file: string;
  data: Buffer;
}

/**
 * Keeps the frame from showing on the page's cream. The big soft lights lay
 * a faint veil (1 to 2%) over the whole floor, and the cards' soft shadow can
 * reach the frame's edge: either way the photo's rectangle shows as a
 * slightly darker box or a straight line. So the veil is taken out (alpha
 * below SHADOW_FLOOR, the rest rescaled; the cards are opaque and keep
 * theirs) and the alpha fades out towards the edge, which the cards stay
 * clear of.
 */
async function cleanShadow(image: sharp.Sharp): Promise<Buffer> {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  cleanAlpha(data, width, height, channels);
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** cleanShadow on raw 8-bit pixels with alpha last, in place (also the browser's scene base, webPasses.ts). */
export function cleanAlpha(data: Uint8Array, width: number, height: number, channels: number): void {
  const band = Math.round(width * FEATHER);
  const ramp = (distance: number) => {
    if (distance >= band) return 1;
    const t = distance / band;
    return t * t * (3 - 2 * t);
  };
  const lifted = (alpha: number) => Math.max(0, ((alpha - SHADOW_FLOOR) * 255) / (255 - SHADOW_FLOOR));
  for (let y = 0; y < height; y++) {
    const fy = ramp(Math.min(y, height - 1 - y));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels + 3;
      if (data[i] === 255) continue;
      data[i] = Math.round(lifted(data[i]) * fy * ramp(Math.min(x, width - 1 - x)));
    }
  }
}

export async function photoOutputs(master: Buffer, name: string): Promise<PhotoFile[]> {
  // one 8-bit master at the published size; a light sharpen after the
  // downscale keeps the QR modules and the years crisp
  const base = await cleanShadow(
    sharp(master).resize({ width: PHOTO_WIDTH, kernel: 'lanczos3' }).sharpen({ sigma: 0.5 })
  );

  const files: PhotoFile[] = [];
  for (const width of PHOTO_WIDTHS) {
    const scaled = sharp(base).resize({ width, kernel: 'lanczos3' });
    files.push({ file: `${name}-${width}.avif`, data: await scaled.clone().avif({ quality: 58, effort: 5 }).toBuffer() });
    files.push({ file: `${name}-${width}.webp`, data: await scaled.clone().webp({ quality: 84, alphaQuality: 90 }).toBuffer() });
  }
  const onGround = (colour: string) =>
    sharp(base).flatten({ background: colour }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  files.push({ file: `${name}-cream.jpg`, data: await onGround(CREAM) });

  // the cards (and their shadow) without the empty margin
  const trimmed = await sharp(base).trim({ threshold: 4 }).png().toBuffer();

  const { width: trimmedWidth = PHOTO_WIDTH, height: trimmedHeight = 0 } = await sharp(trimmed).metadata();
  const pad = Math.round(Math.max(trimmedWidth, trimmedHeight) * FEED_MARGIN);
  files.push({
    file: `${name}-feed.jpg`,
    // sharp flattens before it extends, whatever the order here, so the
    // margin is white itself (a transparent one came out black)
    data: await sharp(trimmed)
      .flatten({ background: WHITE })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: WHITE })
      // full colour resolution, so the year and the QR modules stay crisp
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  });

  // og: the cards as large as fits, on cream
  const fitted = await sharp(trimmed)
    .resize(OG.width - 2 * OG.margin, OG.height - 2 * OG.margin, { fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer();
  files.push({
    file: `${name}-og.jpg`,
    data: await sharp({ create: { width: OG.width, height: OG.height, channels: 4, background: CREAM } })
      .composite([{ input: fitted, gravity: 'center' }])
      .flatten({ background: CREAM })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer(),
  });
  return files;
}
