import path from 'path';
import sharp from 'sharp';
import type { InferenceSession } from 'onnxruntime-node';

/**
 * The Hitster detector: a small model of our own (ml/hitster, see its
 * README) that finds Hitster material in a picture: the word in any
 * lettering (near-spellings such as "Hitser" too), the rings of the back of a
 * Hitster card, the speaker and the "THE MUSIC CARD GAME" pill of the box.
 *
 * The picture is prepared exactly as the model was trained (ml/hitster/
 * preprocess.py; ml/hitster/node/parity.ts checks the two agree):
 *  1. EXIF orientation applied.
 *  2. Transparency flattened onto dark grey under light artwork, light grey
 *     under dark artwork. Never onto white: a white logo would vanish.
 *  3. Letterboxed: long side scaled to SIZE, centred on a SIZE x SIZE canvas
 *     of grey 114.
 *  4. RGB to 0..1, normalised with the ImageNet mean and std, as CHW.
 *
 * The model scores every 16 x 16 cell per class; the highest cell per class
 * is that class's score, and the cells around it say where the mark is.
 * About 70 ms per picture on one core. The model loads on the first picture
 * (HITSTER_MODEL, default ASSETS_DIR/hitster/hitster.onnx), once per process.
 */

export const SIZE = 512;
export const STRIDE = 16;
export const HITSTER_CLASSES = ['word', 'rings', 'speaker', 'pill'] as const;
export type HitsterClass = (typeof HITSTER_CLASSES)[number];

const GRID = SIZE / STRIDE;
const PAD = { r: 114, g: 114, b: 114 };
const DARK_UNDER = [32, 32, 32];
const LIGHT_UNDER = [235, 235, 235];
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface HitsterLetterbox {
  tensor: Float32Array;
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface HitsterMark {
  class: HitsterClass;
  score: number;
  /** Where it is, in pixels of the picture (after EXIF rotation). */
  box: { x: number; y: number; width: number; height: number };
}

export interface HitsterVerdict {
  /** The highest cell per class, 0..1. */
  scores: Record<HitsterClass, number>;
  /** Every class at or above the threshold, with where it is. */
  marks: HitsterMark[];
}

/** Python's round(): halves go to the even neighbour, as preprocess.py rounds. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Steps 1-2: the picture as raw RGB, transparency flattened by contrast. */
async function flatten(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input, { limitInputPixels: 200_000_000 })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const pixels = width * height;

  let transparent = false;
  let lumSum = 0;
  let drawn = 0;
  for (let i = 0; i < pixels; i++) {
    const a = data[i * 4 + 3];
    if (a < 255) transparent = true;
    if (a > 128) {
      lumSum += 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      drawn++;
    }
  }
  const under = drawn && lumSum / drawn > 140 ? DARK_UNDER : LIGHT_UNDER;
  const rgb = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const a = transparent ? data[i * 4 + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = transparent
        ? Math.round(data[i * 4 + c] * a + under[c] * (1 - a))
        : data[i * 4 + c];
    }
  }
  return { data: rgb, width, height };
}

/** Steps 1-4: the model input for one picture. */
export async function prepareHitsterInput(input: Buffer): Promise<HitsterLetterbox> {
  const flat = await flatten(input);
  const scale = SIZE / Math.max(flat.width, flat.height);
  const width = Math.max(1, roundHalfEven(flat.width * scale));
  const height = Math.max(1, roundHalfEven(flat.height * scale));
  const offsetX = Math.floor((SIZE - width) / 2);
  const offsetY = Math.floor((SIZE - height) / 2);

  const resized = await sharp(flat.data, {
    raw: { width: flat.width, height: flat.height, channels: 3 },
  })
    .resize(width, height, { kernel: 'linear', fit: 'fill' })
    .raw()
    .toBuffer();
  // composite() hands back RGBA whatever went in: drop the alpha again
  const { data: canvas, info } = await sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: PAD },
  })
    .composite([
      { input: resized, raw: { width, height, channels: 3 }, left: offsetX, top: offsetY },
    ])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || info.width !== SIZE || info.height !== SIZE) {
    throw new Error(`hitster: canvas is ${info.width}x${info.height}x${info.channels}`);
  }

  const plane = SIZE * SIZE;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      tensor[c * plane + i] = (canvas[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return { tensor, scale, offsetX, offsetY, width: flat.width, height: flat.height };
}

/** Scores and marks from the model's cell probabilities, (classes, GRID, GRID). */
export function readHitsterCells(
  probs: Float32Array,
  letterbox: HitsterLetterbox,
  threshold: number
): HitsterVerdict {
  const scores = {} as Record<HitsterClass, number>;
  const marks: HitsterMark[] = [];
  HITSTER_CLASSES.forEach((name, c) => {
    const cells = probs.subarray(c * GRID * GRID, (c + 1) * GRID * GRID);
    let best = 0;
    for (const p of cells) best = Math.max(best, p);
    scores[name] = best;
    if (best < threshold) return;
    // The region: every cell within half of the best, as one box
    let x0 = GRID;
    let y0 = GRID;
    let x1 = -1;
    let y1 = -1;
    cells.forEach((p, i) => {
      if (p < best / 2) return;
      const x = i % GRID;
      const y = Math.floor(i / GRID);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    });
    const toPicture = (v: number, offset: number) => (v * STRIDE - offset) / letterbox.scale;
    const left = Math.max(0, toPicture(x0, letterbox.offsetX));
    const top = Math.max(0, toPicture(y0, letterbox.offsetY));
    const right = Math.min(letterbox.width, toPicture(x1 + 1, letterbox.offsetX));
    const bottom = Math.min(letterbox.height, toPicture(y1 + 1, letterbox.offsetY));
    marks.push({
      class: name,
      score: best,
      box: {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
      },
    });
  });
  return { scores, marks };
}

class HitsterDetector {
  private static instance: HitsterDetector;
  private session: Promise<InferenceSession> | null = null;

  public static getInstance(): HitsterDetector {
    if (!HitsterDetector.instance) HitsterDetector.instance = new HitsterDetector();
    return HitsterDetector.instance;
  }

  public modelPath(): string {
    return (
      process.env['HITSTER_MODEL'] ||
      path.join(process.env['ASSETS_DIR'] || 'assets', 'hitster', 'hitster.onnx')
    );
  }

  /**
   * The ONNX session, created on first use. One thread: the API shares four
   * cores with the SSR processes, and a picture takes tens of ms on one.
   * A failed load is not kept, so the next picture tries again.
   */
  private load(): Promise<InferenceSession> {
    if (!this.session) {
      this.session = (async () => {
        const ort = await import('onnxruntime-node');
        return ort.InferenceSession.create(this.modelPath(), {
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
          executionMode: 'sequential',
          graphOptimizationLevel: 'all',
        });
      })();
      this.session.catch(() => {
        this.session = null;
      });
    }
    return this.session;
  }

  public async detect(input: Buffer, threshold: number): Promise<HitsterVerdict> {
    const [session, letterbox] = await Promise.all([this.load(), prepareHitsterInput(input)]);
    const ort = await import('onnxruntime-node');
    const output = await session.run({
      image: new ort.Tensor('float32', letterbox.tensor, [1, 3, SIZE, SIZE]),
    });
    return readHitsterCells(output['probs'].data as Float32Array, letterbox, threshold);
  }
}

export default HitsterDetector;
