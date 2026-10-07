import { describe, it, expect } from 'vitest';
import path from 'path';
import { existsSync } from 'fs';
import sharp from 'sharp';
import HitsterDetector, {
  HITSTER_CLASSES,
  SIZE,
  STRIDE,
  prepareHitsterInput,
  readHitsterCells,
} from '../../src/hitsterDetector';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const GRID = SIZE / STRIDE;
const plane = SIZE * SIZE;

/** The value the tensor holds for a grey level in channel c. */
const normalised = (grey: number, c: number) => (grey / 255 - MEAN[c]) / STD[c];

/** RGB of the tensor at (x, y), back in 0..255. */
function pixelAt(tensor: Float32Array, x: number, y: number): number[] {
  return [0, 1, 2].map((c) => Math.round((tensor[c * plane + y * SIZE + x] * STD[c] + MEAN[c]) * 255));
}

describe('prepareHitsterInput', () => {
  it('letterboxes a wide picture into the middle of a grey square', async () => {
    const picture = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 10, b: 10 } } })
      .png()
      .toBuffer();
    const box = await prepareHitsterInput(picture);
    expect(box.tensor.length).toBe(3 * plane);
    expect(box.scale).toBeCloseTo(SIZE / 200);
    expect([box.offsetX, box.offsetY]).toEqual([0, 128]);
    expect([box.width, box.height]).toEqual([200, 100]);
    // Above the picture: the pad grey, 114
    expect(box.tensor[0]).toBeCloseTo(normalised(114, 0), 4);
    // In the picture: its own red
    expect(pixelAt(box.tensor, 256, 256)).toEqual([200, 10, 10]);
  });

  it('puts a white logo on transparent onto dark grey, not white', async () => {
    const logo = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer(), left: 30, top: 30 }])
      .png()
      .toBuffer();
    const box = await prepareHitsterInput(logo);
    // A transparent corner became dark grey, the white square stayed white
    expect(pixelAt(box.tensor, 10, 10)).toEqual([32, 32, 32]);
    expect(pixelAt(box.tensor, 256, 256)).toEqual([255, 255, 255]);
  });

  it('refuses a picture over 50 megapixels from its header, before decoding it', async () => {
    // 9000 x 6000 of one colour compresses to almost nothing: the shape of a
    // decompression bomb sent to the public screen
    const bomb = await sharp({ create: { width: 9000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000);
    // sharp's own header check, or ours behind it
    await expect(prepareHitsterInput(bomb)).rejects.toThrow(/exceeds pixel limit|9000x6000 refused/);
  });

  it('works on a shrunk copy of a large picture but reports in its own pixels', async () => {
    const large = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: { r: 10, g: 200, b: 10 } } })
      .jpeg()
      .toBuffer();
    const box = await prepareHitsterInput(large);
    expect([box.width, box.height]).toEqual([4000, 2000]);
    expect(box.scale).toBeCloseTo(SIZE / 4000);
    expect([box.offsetX, box.offsetY]).toEqual([0, 128]);
  });

  it('puts a dark logo on transparent onto light grey', async () => {
    const logo = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } } }).png().toBuffer(), left: 30, top: 30 }])
      .png()
      .toBuffer();
    const box = await prepareHitsterInput(logo);
    expect(pixelAt(box.tensor, 10, 10)).toEqual([235, 235, 235]);
  });
});

describe('readHitsterCells', () => {
  const letterbox = { tensor: new Float32Array(0), scale: 0.5, offsetX: 0, offsetY: 64, width: 1024, height: 768 };

  it('gives the best cell per class as its score, and no mark below the threshold', () => {
    const probs = new Float32Array(HITSTER_CLASSES.length * GRID * GRID);
    probs[0 * GRID * GRID + 3] = 0.4;
    probs[1 * GRID * GRID + 7] = 0.2;
    const verdict = readHitsterCells(probs, letterbox, 0.5);
    expect(verdict.scores.word).toBeCloseTo(0.4);
    expect(verdict.scores.rings).toBeCloseTo(0.2);
    expect(verdict.marks).toEqual([]);
  });

  it('maps the hot cells of a mark back onto the picture', () => {
    const probs = new Float32Array(HITSTER_CLASSES.length * GRID * GRID);
    // "word" lit at cells (10..11, 8) of the 512 square
    probs[8 * GRID + 10] = 0.9;
    probs[8 * GRID + 11] = 0.6;
    const verdict = readHitsterCells(probs, letterbox, 0.5);
    expect(verdict.marks).toHaveLength(1);
    const mark = verdict.marks[0];
    expect(mark.class).toBe('word');
    expect(mark.score).toBeCloseTo(0.9);
    // Cells 10..11 are x 160..192 in the square, 320..384 in the picture;
    // row 8 is y 128..144, minus the 64 of padding, 128..160 in the picture
    expect(mark.box).toEqual({ x: 320, y: 128, width: 64, height: 32 });
  });
});

// The real model, when it is there (assets/hitster/hitster.onnx is shipped
// with the API; ml/hitster makes it).
const MODEL = path.resolve('assets/hitster/hitster.onnx');
const REFERENCE = path.resolve('assets/hitster_reference/hitster_box.png');

describe.skipIf(!existsSync(MODEL) || !existsSync(REFERENCE))('HitsterDetector with the shipped model', () => {
  process.env['HITSTER_MODEL'] = MODEL;
  const detector = HitsterDetector.getInstance();

  it('flags the Hitster box and says where the word is', async () => {
    const verdict = await detector.detect(await sharp(REFERENCE).toBuffer(), 0.5);
    expect(verdict.scores.word).toBeGreaterThan(0.5);
    const word = verdict.marks.find((m) => m.class === 'word');
    expect(word).toBeDefined();
    // The wordmark is in the top quarter of the box front
    expect(word!.box.y).toBeLessThan(2308 / 4);
  });

  it('passes a plain gradient', async () => {
    const plain = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 40, g: 120, b: 200 } } })
      .jpeg()
      .toBuffer();
    const verdict = await detector.detect(plain, 0.5);
    expect(verdict.marks).toEqual([]);
    for (const name of HITSTER_CLASSES) {
      expect(verdict.scores[name]).toBeLessThan(0.5);
    }
  });
});
