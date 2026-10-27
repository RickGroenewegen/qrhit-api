import path from 'path';
import { promises as fs } from 'fs';
import { gunzipSync } from 'zlib';
import sharp from 'sharp';

/**
 * A playlist's product photo, made without Blender: the approved scene's
 * passes (scripts/product-photo/export-passes.py) with the playlist's own card
 * pictures (cards.ts) put onto the six card faces that show one. Per face and
 * pixel the photo is base + (card - 1) * light, where the base is the render
 * with those faces white and the light is what fell on them (the gloss stays
 * in the base). The cards come out exactly as printed, the QR code included,
 * in about a second of CPU.
 */

// ASSETS_DIR is the repository's assets folder; a path from __dirname would
// differ between `tsc -w` (build/src/) and the scripts run with tsx (src/)
export const SCENES_DIR = path.join(process.env['ASSETS_DIR'] || path.join(__dirname, '../../assets'), 'product-photo');
export const SCENE_DIR = path.join(SCENES_DIR, 'scene-1');

/** The faces of scene-1, the product photo. The format tiles have their own (tiles.ts). */
export type FaceRole = 'hero' | 'answer' | 'deck' | 'fan' | 'songs' | 'song';

/** The picture (PNG) each face shows, by role: a card side as printed, or a page (pages.ts). */
export type FacePictures = Record<string, Buffer>;

/**
 * Which card of the photo's songs each face of scene-1 shows: card 0 is the
 * hero, front and back; then the backs lying in front, then the fronts
 * behind it. Scenes exported since name it per face (`card`).
 */
export const FACE_CARDS: Record<FaceRole, number> = { hero: 0, answer: 0, songs: 1, song: 2, fan: 3, deck: 4 };

export interface SceneFace {
  role: string;
  /** a card side, or a page laid out from card pictures (pages.ts) */
  side: 'front' | 'back' | 'page';
  file: string;
  /** x, y, width, height in the frame */
  box: [number, number, number, number];
  /** picture size (px per side) matching the face's size on screen */
  texPx: number;
  /** which of the cards a card face shows (scene-1: FACE_CARDS) */
  card?: number;
  /** a page's layout (PAGE_LAYOUTS) and the pixels it needs across and down */
  page?: string;
  texW?: number;
  texH?: number;
}

/** Which of the cards a card face shows. */
export function cardOf(face: SceneFace): number {
  return face.card ?? FACE_CARDS[face.role as FaceRole] ?? 0;
}

export interface SceneManifest {
  version: number;
  width: number;
  height: number;
  exposure: number;
  view: string;
  base: string;
  faces: SceneFace[];
  /** the day the passes were exported */
  exported: string;
}

export interface Scene {
  manifest: SceneManifest;
  /** RGBA, linear, premultiplied */
  base: Float32Array;
  /** per face role: u*w, v*w, w, light r, g, b over its box */
  faces: Map<string, Float32Array>;
}

// float16 to float32, for the passes
const HALF = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    table[h] =
      exponent === 0
        ? sign * mantissa * 2 ** -24
        : exponent === 31
          ? mantissa
            ? NaN
            : sign * Infinity
          : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }
  return table;
})();

function linearToSrgb8(value: number): number {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value;
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

async function readHalfs(file: string): Promise<Float32Array> {
  const raw = gunzipSync(await fs.readFile(file));
  const halfs = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const out = new Float32Array(halfs.length);
  for (let i = 0; i < halfs.length; i++) out[i] = HALF[halfs[i]];
  return out;
}

const loaded = new Map<string, { scene: Promise<Scene>; release: NodeJS.Timeout }>();
// the photo's passes take about 50 MB, a tile's 2; a worker that made no
// photo for this long lets them go
const KEEP_SCENE_MS = 10 * 60_000;

/** A scene's passes (scene-1 by default), read once and kept while photos are being made. */
export function loadScene(dir = SCENE_DIR): Promise<Scene> {
  const kept = loaded.get(dir);
  if (kept) clearTimeout(kept.release);
  const scene =
    kept?.scene ??
    readScene(dir).catch((error) => {
      loaded.delete(dir);
      throw error;
    });
  const release = setTimeout(() => loaded.delete(dir), KEEP_SCENE_MS);
  release.unref();
  loaded.set(dir, { scene, release });
  return scene;
}

async function readScene(dir: string): Promise<Scene> {
  const manifest: SceneManifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.view !== 'Standard') throw new Error(`product photo scene: view transform ${manifest.view} is not supported`);
  const base = await readHalfs(path.join(dir, manifest.base));
  const faces = new Map<string, Float32Array>();
  for (const face of manifest.faces) faces.set(face.role, await readHalfs(path.join(dir, face.file)));
  return { manifest, base, faces };
}

interface Texture {
  /** linear RGB */
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * A face's picture at its size on screen times TEX_SCALE, linear RGB. Shrunk
 * in linear light, as Blender averages it: shrinking the sRGB values darkened
 * the QR code and every fine pattern by several levels. A card is square; a
 * page keeps its own shape, at the scale both its directions need.
 */
async function texture(png: Buffer, face: SceneFace): Promise<Texture> {
  let width = face.texPx * TEX_SCALE;
  let height = width;
  if (face.texW && face.texH) {
    const { width: w = 1, height: h = 1 } = await sharp(png).metadata();
    const scale = TEX_SCALE * Math.max(face.texW / w, face.texH / h);
    width = Math.round(w * scale);
    height = Math.round(h * scale);
    // a page laid out at its size already (pagePicture) is not resampled for a pixel of rounding
    if (Math.abs(width - w) <= 1 && Math.abs(height - h) <= 1) {
      width = w;
      height = h;
    }
  }
  // scrgb is libvips' linear light (rgb16 is still sRGB, only deeper)
  const raw = await sharp(png)
    .removeAlpha()
    .pipelineColourspace('scrgb')
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('scrgb')
    .raw({ depth: 'float' })
    .toBuffer();
  if (raw.byteLength !== width * height * 3 * 4) throw new Error(`product photo: unexpected picture layout (${raw.byteLength} bytes)`);
  return { data: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), width, height };
}

/**
 * The picture is shrunk to this many times the face's size on screen, so the
 * footprint's taps still find detail between screen pixels. A page is laid
 * out at that size straight away (pagePicture's scale).
 */
export const TEX_SCALE = 2;
// softness in screen pixels (sigma) that Blender's pixel filter and denoiser
// give the cards: fitted against a full render of scene-1, the same on every
// face (0.45 left a third of the error of a plain lookup, which looked
// jagged on foreshortened text)
const BLUR = 0.45;

interface Tap {
  dx: number;
  dy: number;
  weight: number;
}

/** A Gaussian footprint in screen pixels: a 5 x 5 grid over two sigma each way. */
function footprint(sigma: number): Tap[] {
  if (sigma < 0.05) return [{ dx: 0, dy: 0, weight: 1 }];
  const taps: Tap[] = [];
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const dx = a * sigma;
      const dy = b * sigma;
      taps.push({ dx, dy, weight: Math.exp(-(a * a + b * b) / 2) });
    }
  }
  const total = taps.reduce((sum, tap) => sum + tap.weight, 0);
  for (const tap of taps) tap.weight /= total;
  return taps;
}

/** Adds weight times the picture at (u, v) to colour; v runs up the picture. */
function bilinear({ data: tex, width, height }: Texture, u: number, v: number, weight: number, colour: number[]): void {
  const x = Math.min(Math.max(u * width - 0.5, 0), width - 1);
  const y = Math.min(Math.max((1 - v) * height - 0.5, 0), height - 1);
  const xi = Math.min(Math.floor(x), width - 2);
  const yi = Math.min(Math.floor(y), height - 2);
  const fx = x - xi;
  const fy = y - yi;
  const t00 = (yi * width + xi) * 3;
  const t10 = t00 + 3;
  const t01 = t00 + width * 3;
  const t11 = t01 + 3;
  for (let c = 0; c < 3; c++) {
    const top = tex[t00 + c] + (tex[t10 + c] - tex[t00 + c]) * fx;
    const bottom = tex[t01 + c] + (tex[t11 + c] - tex[t01 + c]) * fx;
    colour[c] += (top + (bottom - top) * fy) * weight;
  }
}

/**
 * The product photo (or a format tile, from its scene) as a transparent PNG
 * (sRGB, the scene's size), ready for photoOutputs. Throws when a face has no
 * picture.
 *
 * One approximation remains: what a face reflects onto the others (the hero
 * in the glossy cards lying in front of it, its bounce light on the stack
 * edges) stays as the white card of the base. Against the full render that
 * is about 3 levels of 255 on the lying cards, invisible at 1:1.
 */
export async function composePhoto(
  pictures: FacePictures,
  scene?: Scene,
  // softness in screen pixels; a tile's master is shrunk to a quarter afterwards and needs none
  blur = BLUR
): Promise<Buffer> {
  const { manifest, base, faces } = scene ?? (await loadScene());
  const { width, height } = manifest;
  const out = Float32Array.from(base);

  // where two faces share an edge pixel, each gets its share of the light
  const coverage = new Float32Array(width * height);
  for (const face of manifest.faces) {
    const data = faces.get(face.role)!;
    const [x0, y0, w] = face.box;
    for (let k = 0, i = 0; k < data.length; k += 6, i++) {
      coverage[(y0 + Math.floor(i / w)) * width + x0 + (i % w)] += data[k + 2];
    }
  }

  for (const face of manifest.faces) {
    const picture = pictures[face.role];
    if (!picture) throw new Error(`product photo: no picture for the ${face.role} card`);
    const tex = await texture(picture, face);
    const data = faces.get(face.role)!;
    const [x0, y0, w, h] = face.box;
    const taps = footprint(blur);

    // u and v per pixel of the box (NaN off the face)
    const u = new Float32Array(w * h).fill(NaN);
    const v = new Float32Array(w * h).fill(NaN);
    for (let k = 0, i = 0; k < data.length; k += 6, i++) {
      const cover = data[k + 2];
      if (cover < 1e-4) continue;
      u[i] = data[k] / cover;
      v[i] = data[k + 1] / cover;
    }
    // how u and v change per screen pixel, one-sided at the face's edge
    const slope = (values: Float32Array, i: number, step: number, inside: boolean, before: boolean): number => {
      const ahead = inside ? values[i + step] : NaN;
      const behind = before ? values[i - step] : NaN;
      if (!Number.isNaN(ahead) && !Number.isNaN(behind)) return (ahead - behind) / 2;
      if (!Number.isNaN(ahead)) return ahead - values[i];
      if (!Number.isNaN(behind)) return values[i] - behind;
      return 0;
    };

    const colour = [0, 0, 0];
    for (let i = 0; i < w * h; i++) {
      if (Number.isNaN(u[i])) continue;
      const bx = i % w;
      const by = (i - bx) / w;
      const dudx = slope(u, i, 1, bx < w - 1, bx > 0);
      const dvdx = slope(v, i, 1, bx < w - 1, bx > 0);
      const dudy = slope(u, i, w, by < h - 1, by > 0);
      const dvdy = slope(v, i, w, by < h - 1, by > 0);
      colour[0] = colour[1] = colour[2] = 0;
      for (const { dx, dy, weight } of taps) {
        bilinear(tex, u[i] + dudx * dx + dudy * dy, v[i] + dvdx * dx + dvdy * dy, weight, colour);
      }
      const k = i * 6;
      const p = (y0 + by) * width + x0 + bx;
      const share = data[k + 2] / Math.max(coverage[p], data[k + 2]);
      for (let c = 0; c < 3; c++) out[p * 4 + c] += (colour[c] - 1) * data[k + 3 + c] * share;
    }
  }

  // the scene's view: exposure, then the sRGB curve ("Standard"), straight alpha
  const gain = 2 ** manifest.exposure;
  const pixels = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const alpha = Math.min(Math.max(out[p * 4 + 3], 0), 1);
    pixels[p * 4 + 3] = Math.round(alpha * 255);
    if (alpha <= 0) continue;
    for (let c = 0; c < 3; c++) pixels[p * 4 + c] = linearToSrgb8((out[p * 4 + c] / alpha) * gain);
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
