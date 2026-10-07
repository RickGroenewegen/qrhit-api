/**
 * The Hitster detector in Node: preprocessing exactly as ../preprocess.py
 * does it, then the ONNX model on onnxruntime-node. What the API's upload
 * screen would load once per process and ask per picture.
 *
 * Steps (see preprocess.py for why):
 *  1. EXIF orientation applied.
 *  2. Transparency flattened onto dark grey under light artwork, light grey
 *     under dark artwork (never onto white: a white logo would vanish).
 *  3. Letterboxed: long side scaled to SIZE, centred on a SIZE x SIZE canvas
 *     of PAD grey.
 *  4. RGB to 0..1, normalised with the ImageNet mean and std, as CHW.
 */
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

export const SIZE = 512;
export const STRIDE = 16;
export const CLASSES = ['word', 'rings', 'speaker', 'pill'] as const;
export type HitsterClass = (typeof CLASSES)[number];

const PAD = { r: 114, g: 114, b: 114 };
const DARK_UNDER = [32, 32, 32];
const LIGHT_UNDER = [235, 235, 235];
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const GRID = SIZE / STRIDE;

export interface Letterbox {
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
  /** Where the hot cells are, in pixels of the picture as given (after EXIF rotation) */
  box: { x: number; y: number; width: number; height: number };
}

export interface HitsterVerdict {
  /** The highest cell per class, 0..1 */
  scores: Record<HitsterClass, number>;
  marks: HitsterMark[];
  ms: number;
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Steps 1-2: an RGB raw buffer of the picture, transparency flattened by contrast. */
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
  const rgb = Buffer.alloc(pixels * 3);
  if (!transparent) {
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = data[i * 4];
      rgb[i * 3 + 1] = data[i * 4 + 1];
      rgb[i * 3 + 2] = data[i * 4 + 2];
    }
    return { data: rgb, width, height };
  }
  const under = drawn && lumSum / drawn > 140 ? DARK_UNDER : LIGHT_UNDER;
  for (let i = 0; i < pixels; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = Math.round(data[i * 4 + c] * a + under[c] * (1 - a));
    }
  }
  return { data: rgb, width, height };
}

/** Steps 1-4: the model input for one picture. */
export async function preprocess(input: Buffer): Promise<Letterbox> {
  const flat = await flatten(input);
  const scale = SIZE / Math.max(flat.width, flat.height);
  const width = Math.max(1, roundHalfEven(flat.width * scale));
  const height = Math.max(1, roundHalfEven(flat.height * scale));
  const offsetX = Math.floor((SIZE - width) / 2);
  const offsetY = Math.floor((SIZE - height) / 2);

  const resized = await sharp(flat.data, { raw: { width: flat.width, height: flat.height, channels: 3 } })
    .resize(width, height, { kernel: 'linear', fit: 'fill' })
    .raw()
    .toBuffer();
  // composite() hands back RGBA whatever went in: drop the alpha again
  const { data: canvas, info } = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: PAD } })
    .composite([{ input: resized, raw: { width, height, channels: 3 }, left: offsetX, top: offsetY }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || info.width !== SIZE || info.height !== SIZE) {
    throw new Error(`hitster: canvas is ${info.width}x${info.height}x${info.channels}, expected ${SIZE}x${SIZE}x3`);
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

export class HitsterDetector {
  private constructor(private session: ort.InferenceSession) {}

  /**
   * One session per process. `threads` stays 1 by default: the API runs
   * next to the SSR processes on four cores, and one picture is tens of ms
   * on one core anyway.
   */
  static async load(modelPath: string, threads = 1): Promise<HitsterDetector> {
    const session = await ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    });
    return new HitsterDetector(session);
  }

  /** The cell probabilities, (classes, GRID, GRID) flattened. */
  async probabilities(letterbox: Letterbox): Promise<Float32Array> {
    const input = new ort.Tensor('float32', letterbox.tensor, [1, 3, SIZE, SIZE]);
    const output = await this.session.run({ image: input });
    return output['probs'].data as Float32Array;
  }

  /** Scores per class and, for every class at or above `threshold`, where it is. */
  async detect(input: Buffer, threshold = 0.5): Promise<HitsterVerdict> {
    const started = performance.now();
    const letterbox = await preprocess(input);
    const probs = await this.probabilities(letterbox);
    const scores = {} as Record<HitsterClass, number>;
    const marks: HitsterMark[] = [];
    CLASSES.forEach((name, c) => {
      const cells = probs.subarray(c * GRID * GRID, (c + 1) * GRID * GRID);
      let best = 0;
      for (const p of cells) best = Math.max(best, p);
      scores[name] = best;
      if (best < threshold) return;
      // The region: every cell within half of the best, as a box
      let x0 = GRID, y0 = GRID, x1 = -1, y1 = -1;
      cells.forEach((p, i) => {
        if (p < best / 2) return;
        const x = i % GRID, y = Math.floor(i / GRID);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      });
      const toPicture = (v: number, offset: number) => (v * STRIDE - offset) / letterbox.scale;
      const left = Math.max(0, toPicture(x0, letterbox.offsetX));
      const top = Math.max(0, toPicture(y0, letterbox.offsetY));
      const right = Math.min(letterbox.width, toPicture(x1 + 1, letterbox.offsetX));
      const bottom = Math.min(letterbox.height, toPicture(y1 + 1, letterbox.offsetY));
      marks.push({
        class: name,
        score: best,
        box: { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) },
      });
    });
    return { scores, marks, ms: Math.round(performance.now() - started) };
  }
}
