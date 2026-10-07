import sharp from 'sharp';

/**
 * Did a card's design change between the PDF we stored and what the design
 * route renders now? finalCheck compares the two renders of every design's
 * first card, front and back, before an order goes to the printer.
 *
 * What a design drift looks like is large: a wrong or missing background,
 * other artwork, other colours, a blank render. What must not count is small
 * or local: anti-aliasing, compression, a font hinted a pixel differently, a
 * card number in a corner, a QR code encoding another payload (Rick's rules
 * for the GPT check this replaced). So both pictures are compared small and
 * blurred, and a page drifted only when two things agree:
 *
 *  - CHANGED_SHARE of its area differs clearly (DRIFT_SHARE, default 0.3)
 *  - its colour mix moved (a 4x4x4 colour histogram, half its L1 distance,
 *    DRIFT_COLOURS, default 0.25)
 *
 * A QR code alone covers about a quarter of a card front and keeps its
 * colours, so a different payload passes; a wrong background changes both.
 * The measured values are logged with every comparison, so the thresholds
 * can be tuned from the logs.
 */

const SIDE = 64;
const PIXEL_DIFFERS = 60;
const BINS = 4;

export interface DriftMeasure {
  /** Share of the page (0..1) whose colour differs clearly. */
  changed: number;
  /** How far the colour mix moved, 0 (same) to 1 (nothing in common). */
  colours: number;
  drifted: boolean;
}

function threshold(name: string, fallback: number): number {
  const value = parseFloat(process.env[name] || '');
  return value > 0 && value < 1 ? value : fallback;
}

/** The page small, flattened on white and blurred, as raw RGB. */
async function small(page: Buffer): Promise<Buffer> {
  return sharp(page)
    .flatten({ background: '#ffffff' })
    .resize(SIDE, SIDE, { fit: 'fill' })
    .blur(1.2)
    .removeAlpha()
    .raw()
    .toBuffer();
}

function histogram(rgb: Buffer): Float64Array {
  const counts = new Float64Array(BINS * BINS * BINS);
  const pixels = rgb.length / 3;
  for (let i = 0; i < pixels; i++) {
    const r = Math.min(BINS - 1, rgb[i * 3] >> 6);
    const g = Math.min(BINS - 1, rgb[i * 3 + 1] >> 6);
    const b = Math.min(BINS - 1, rgb[i * 3 + 2] >> 6);
    counts[(r * BINS + g) * BINS + b] += 1 / pixels;
  }
  return counts;
}

export async function measureDrift(stored: Buffer, live: Buffer): Promise<DriftMeasure> {
  const [a, b] = await Promise.all([small(stored), small(live)]);
  const pixels = SIDE * SIDE;
  let differing = 0;
  for (let i = 0; i < pixels; i++) {
    const diff = Math.max(
      Math.abs(a[i * 3] - b[i * 3]),
      Math.abs(a[i * 3 + 1] - b[i * 3 + 1]),
      Math.abs(a[i * 3 + 2] - b[i * 3 + 2])
    );
    if (diff > PIXEL_DIFFERS) differing++;
  }
  const ha = histogram(a);
  const hb = histogram(b);
  let distance = 0;
  for (let i = 0; i < ha.length; i++) distance += Math.abs(ha[i] - hb[i]);

  const changed = differing / pixels;
  const colours = distance / 2;
  return {
    changed,
    colours,
    drifted: changed > threshold('DRIFT_SHARE', 0.3) && colours > threshold('DRIFT_COLOURS', 0.25),
  };
}
