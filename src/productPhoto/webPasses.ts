import { gzipSync } from 'zlib';
import sharp from 'sharp';
import { cardOf, Scene, SceneFace } from './compose';
import { cleanAlpha } from './outputs';
import { PAGE_LAYOUTS, PageLayout } from './pages';

/**
 * A light copy of a scene's passes for the site's browser compositor
 * (qrhit src/app/shared/card-photo/), which puts a customer's own design or a
 * pasted playlist into the photo without asking the server. Written into the
 * site by `scripts/product-photo.ts web-passes`, served by CloudFront.
 *
 * Per width:
 * - the base: the photo with the faces white, after the scene's exposure, in
 *   straight sRGB with the published photo's alpha (cleanAlpha), as WebP;
 * - per face in the manifest, u and v as cubic polynomials of the position in
 *   its box (UV_TERMS): the faces are flat or barely curved, and the fit is
 *   within 0.4 texels where the pixel planes cost 80% of the download;
 * - the faces, gzipped, per face over its box in the web frame: coverage
 *   (8 bit) and the light (8 bit per channel, square-root coded up to
 *   `lightScale`), each plane delta coded so gzip finds the runs.
 *
 * The light is stored as L * 2^exposure / alpha, so the browser works in
 * straight linear light: photo = base + sum over faces of
 * (card - 1) * light * share, with share as in composePhoto.
 *
 * A scene with pages (the format tiles' screen and sheet) carries their
 * layouts (pages.ts), so the browser lays the pages out as the server does.
 */

export interface WebFace {
  role: string;
  side: SceneFace['side'];
  /** which of the photo's cards a card face shows (cardOf) */
  card?: number;
  /** x, y, width, height in the web frame */
  box: [number, number, number, number];
  /** card picture size (px per side) matching the face's size on screen */
  texPx: number;
  /** a page's layout (manifest.pages) and the pixels it needs across and down */
  page?: string;
  texW?: number;
  texH?: number;
  /** u and v: coefficients of UV_TERMS over X, Y (-1 to 1 across the box, at pixel centres) */
  u: number[];
  v: number[];
}

/** The terms X^i * Y^j of a cubic, in coefficient order. */
export const UV_TERMS: Array<[number, number]> = [];
for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3 - i; j++) UV_TERMS.push([i, j]);

export interface WebPassesManifest {
  width: number;
  height: number;
  lightScale: number;
  faces: WebFace[];
  pages?: Record<string, PageLayout>;
}

export interface WebPasses {
  manifest: WebPassesManifest;
  /** WebP */
  base: Buffer;
  /** gzip */
  faces: Buffer;
}

/** For each output index along one axis: the source pixels it covers and their weights (summing to 1). */
function areaWeights(outStart: number, outCount: number, srcStart: number, srcCount: number, scale: number): Array<Array<[number, number]>> {
  const result: Array<Array<[number, number]>> = [];
  for (let i = 0; i < outCount; i++) {
    const from = (outStart + i) / scale - srcStart;
    const to = (outStart + i + 1) / scale - srcStart;
    const taps: Array<[number, number]> = [];
    for (let p = Math.max(0, Math.floor(from)); p < Math.min(srcCount, Math.ceil(to)); p++) {
      const overlap = Math.min(to, p + 1) - Math.max(from, p);
      if (overlap > 0) taps.push([p, overlap * scale]);
    }
    result.push(taps);
  }
  return result;
}

/**
 * Area-averages `src` (channels per pixel, srcW x srcH, its top left at
 * srcX/srcY in the full-size frame) into the web frame's rectangle
 * outX/outY/outW/outH. Outside the source counts as zero, which is right for
 * the passes: they are all premultiplied by coverage or alpha.
 */
function shrink(
  src: Float32Array,
  channels: number,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  outX: number,
  outY: number,
  outW: number,
  outH: number,
  scale: number
): Float32Array {
  const columns = areaWeights(outX, outW, srcX, srcW, scale);
  const rows = areaWeights(outY, outH, srcY, srcH, scale);
  const across = new Float32Array(outW * srcH * channels);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < outW; x++) {
      const o = (y * outW + x) * channels;
      for (const [p, weight] of columns[x]) {
        const s = (y * srcW + p) * channels;
        for (let c = 0; c < channels; c++) across[o + c] += src[s + c] * weight;
      }
    }
  }
  const out = new Float32Array(outW * outH * channels);
  for (let y = 0; y < outH; y++) {
    for (const [q, weight] of rows[y]) {
      for (let x = 0; x < outW; x++) {
        const o = (y * outW + x) * channels;
        const s = (q * outW + x) * channels;
        for (let c = 0; c < channels; c++) out[o + c] += across[s + c] * weight;
      }
    }
  }
  return out;
}

function linearToSrgb8(value: number): number {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value;
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/** Solves A x = b (Gaussian elimination with partial pivoting); A and b are overwritten. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    [b[i], b[pivot]] = [b[pivot], b[i]];
    for (let r = i + 1; r < n; r++) {
      const factor = a[r][i] / a[i][i];
      for (let c = i; c < n; c++) a[r][c] -= factor * a[i][c];
      b[r] -= factor * b[i];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let c = i + 1; c < n; c++) sum -= a[i][c] * x[c];
    x[i] = sum / a[i][i];
  }
  return x;
}

/**
 * Least-squares cubic fits of a face's u and v (full size, inside the face
 * only) over the position of each pixel's centre in its web box.
 */
function fitUv(data: Float32Array, face: SceneFace, webBox: [number, number, number, number], scale: number): { u: number[]; v: number[] } {
  const [x0, y0, w] = face.box;
  const [ox, oy, ow, oh] = webBox;
  const terms = UV_TERMS.length;
  const normal = Array.from({ length: terms }, () => new Array<number>(terms).fill(0));
  const rhsU = new Array<number>(terms).fill(0);
  const rhsV = new Array<number>(terms).fill(0);
  const phi = new Array<number>(terms);
  for (let k = 0, i = 0; k < data.length; k += 6, i++) {
    const cover = data[k + 2];
    if (cover < 0.99) continue;
    // the full-size pixel's centre in web pixel coordinates, then -1..1 over the box
    const X = ((x0 + (i % w) + 0.5) * scale - 0.5 - ox - (ow - 1) / 2) / (ow / 2);
    const Y = ((y0 + Math.floor(i / w) + 0.5) * scale - 0.5 - oy - (oh - 1) / 2) / (oh / 2);
    for (let t = 0; t < terms; t++) phi[t] = X ** UV_TERMS[t][0] * Y ** UV_TERMS[t][1];
    const u = data[k] / cover;
    const v = data[k + 1] / cover;
    for (let r = 0; r < terms; r++) {
      rhsU[r] += phi[r] * u;
      rhsV[r] += phi[r] * v;
      for (let c = 0; c < terms; c++) normal[r][c] += phi[r] * phi[c];
    }
  }
  const round = (values: number[]) => values.map((value) => Number(value.toPrecision(9)));
  return {
    u: round(solve(normal.map((row) => row.slice()), rhsU)),
    v: round(solve(normal.map((row) => row.slice()), rhsV)),
  };
}

/** Each value minus the one before it, wrapped to the array's width. */
function deltaCode<T extends Uint8Array | Uint16Array>(plane: T): T {
  const out = plane.slice() as T;
  for (let i = plane.length - 1; i > 0; i--) out[i] = plane[i] - plane[i - 1];
  return out;
}

/**
 * The silhouette of what a scene shows (the cards, the laptop, the
 * scissors), from its base's alpha: a small PNG, black where something is,
 * transparent elsewhere, for the site's loading skeleton in the photo's shape
 * (a CSS mask). The shadow is left out: it never reaches 40% alpha, the
 * objects are opaque.
 */
export async function silhouetteMask(baseWebp: Buffer, width: number): Promise<Buffer> {
  const { data, info } = await sharp(baseWebp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const solid = Buffer.alloc(info.width * info.height);
  for (let p = 0; p < solid.length; p++) solid[p] = data[p * info.channels + 3] >= 204 ? 255 : 0;
  const small = await sharp(solid, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize({ width, kernel: 'lanczos3' })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(small.info.width * small.info.height * 4);
  for (let p = 0; p < small.info.width * small.info.height; p++) rgba[p * 4 + 3] = small.data[p * small.info.channels];
  return sharp(rgba, { raw: { width: small.info.width, height: small.info.height, channels: 4 } })
    .png({ palette: true, colours: 16, compressionLevel: 9, effort: 10 })
    .toBuffer();
}

export async function webPasses(scene: Scene, width: number): Promise<WebPasses> {
  const { manifest, base, faces } = scene;
  const scale = width / manifest.width;
  const height = Math.round(manifest.height * scale);
  const gain = 2 ** manifest.exposure;

  const small = shrink(base, 4, 0, 0, manifest.width, manifest.height, 0, 0, width, height, scale);
  const alpha = new Float32Array(width * height);
  const pixels = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const a = Math.min(Math.max(small[p * 4 + 3], 0), 1);
    alpha[p] = a;
    pixels[p * 4 + 3] = Math.round(a * 255);
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) pixels[p * 4 + c] = linearToSrgb8((small[p * 4 + c] / a) * gain);
  }
  cleanAlpha(pixels, width, height, 4);
  const baseWebp = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100, effort: 6 })
    .toBuffer();

  // the faces in the web frame, light as the browser uses it
  const webFaces: WebFace[] = [];
  const pages: Record<string, PageLayout> = {};
  const shrunk: Array<{ data: Float32Array; size: number }> = [];
  let lightScale = 0;
  for (const face of manifest.faces) {
    const [x0, y0, w, h] = face.box;
    const ox = Math.floor(x0 * scale);
    const oy = Math.floor(y0 * scale);
    const ow = Math.ceil((x0 + w) * scale) - ox;
    const oh = Math.ceil((y0 + h) * scale) - oy;
    const data = shrink(faces.get(face.role)!, 6, x0, y0, w, h, ox, oy, ow, oh, scale);
    for (let i = 0; i < ow * oh; i++) {
      const a = alpha[(oy + Math.floor(i / ow)) * width + ox + (i % ow)];
      for (let c = 3; c < 6; c++) {
        const light = a > 1e-3 ? (data[i * 6 + c] * gain) / a : 0;
        data[i * 6 + c] = light;
        if (data[i * 6 + 2] > 1e-4) lightScale = Math.max(lightScale, light);
      }
    }
    const box: [number, number, number, number] = [ox, oy, ow, oh];
    const { u, v } = fitUv(faces.get(face.role)!, face, box, scale);
    const texPx = Math.round(face.texPx * scale);
    if (face.side === 'page') {
      if (!face.page || !PAGE_LAYOUTS[face.page] || !face.texW || !face.texH) throw new Error(`web passes: no layout for the page ${face.page}`);
      pages[face.page] = PAGE_LAYOUTS[face.page];
      webFaces.push({ role: face.role, side: face.side, box, texPx, page: face.page, texW: Math.round(face.texW * scale), texH: Math.round(face.texH * scale), u, v });
    } else {
      webFaces.push({ role: face.role, side: face.side, card: cardOf(face), box, texPx, u, v });
    }
    shrunk.push({ data, size: ow * oh });
  }

  // as the manifest states it, so nothing codes above 255
  lightScale = Math.ceil(lightScale * 1e5) / 1e5;
  const planes: Buffer[] = [];
  for (const { data, size } of shrunk) {
    const cover = new Uint8Array(size);
    const light = [new Uint8Array(size), new Uint8Array(size), new Uint8Array(size)];
    for (let i = 0; i < size; i++) {
      const w = data[i * 6 + 2];
      if (w < 1e-4) continue;
      cover[i] = Math.round(Math.min(w, 1) * 255);
      for (let c = 0; c < 3; c++) light[c][i] = Math.round(Math.sqrt(Math.max(data[i * 6 + 3 + c], 0) / lightScale) * 255);
    }
    for (const plane of [cover, ...light]) planes.push(Buffer.from(deltaCode(plane).buffer));
  }

  return {
    manifest: { width, height, lightScale, faces: webFaces, ...(Object.keys(pages).length ? { pages } : {}) },
    base: baseWebp,
    faces: gzipSync(Buffer.concat(planes), { level: 9 }),
  };
}
