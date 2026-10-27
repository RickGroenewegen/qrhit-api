import path from 'path';
import sharp from 'sharp';
import { cardOf, composePhoto, FacePictures, loadScene, Scene, SCENES_DIR, TEX_SCALE } from './compose';
import { cleanAlpha, PhotoFile } from './outputs';
import { PAGE_LAYOUTS, pagePicture } from './pages';

/**
 * The format tiles of the product page (Digital, Sheets, Cards in the site's
 * app-product-type-selector), in the playlist's design: three small scenes
 * rendered in Blender like the photo (qrhit/studio/product-photo/tile-*.blend,
 * passes in assets/product-photo/tile-<kind>), composed from the same card
 * pictures in the photo job (photos.ts). Digital is the PDF on a laptop's
 * screen and Sheets an A4 sheet of cards to cut out: both are pages laid out
 * from card pictures (pages.ts).
 *
 * The standard design's tiles are static in the site
 * (src/assets/images/format-tiles/standard-<fingerprint>/), made the same way
 * by `scripts/product-photo.ts tiles`.
 */

export const TILE_KINDS = ['digital', 'sheets', 'cards'] as const;
export type TileKind = (typeof TILE_KINDS)[number];

/**
 * Published widths (5:4, as the scenes): the option buttons' 56 to 96 px boxes
 * at 1x and 2x, and the info modal's ~320 px at 2x (the master itself).
 */
export const TILE_WIDTHS = [160, 320, 640] as const;

export const tileSceneDir = (kind: TileKind) => path.join(SCENES_DIR, `tile-${kind}`);

/** A card side as printed (PNG) by card number; the caller decides how numbers past its cards wrap. */
export type CardPicture = (card: number, side: 'front' | 'back') => Buffer;

/** The tile scenes there are. One that is missing is left out: the page then shows the standard tile. */
export async function loadTileScenes(): Promise<Partial<Record<TileKind, Scene>>> {
  const scenes: Partial<Record<TileKind, Scene>> = {};
  for (const kind of TILE_KINDS) {
    const scene = await loadScene(tileSceneDir(kind)).catch(() => null);
    if (scene) scenes[kind] = scene;
  }
  return scenes;
}

/** A tile's master (transparent PNG at the scene's size) with `picture` on its cards and pages. */
export async function composeTile(scene: Scene, picture: CardPicture): Promise<Buffer> {
  const pictures: FacePictures = {};
  // pages of one layout (the two sheets) share a picture, laid out at the largest scale they need
  const scales = new Map<string, number>();
  for (const face of scene.manifest.faces) {
    if (face.side !== 'page') {
      pictures[face.role] = picture(cardOf(face), face.side);
      continue;
    }
    const layout = PAGE_LAYOUTS[face.page ?? ''];
    if (!layout || !face.texW || !face.texH) throw new Error(`format tile: no layout for the page ${face.page}`);
    const scale = TEX_SCALE * Math.max(face.texW / layout.width, face.texH / layout.height);
    scales.set(face.page!, Math.max(scales.get(face.page!) ?? 0, scale));
  }
  for (const [page, scale] of scales) {
    const laidOut = await pagePicture(PAGE_LAYOUTS[page], picture, scale);
    for (const face of scene.manifest.faces) if (face.page === page) pictures[face.role] = laidOut;
  }
  // the master is shrunk to a quarter (tileOutputs), which smooths it more than Blender's pixel filter
  return composePhoto(pictures, scene, 0);
}

/** A tile's published files, the transparent cutout: tile-<kind>-<width>.<avif|webp|png>. */
export async function tileOutputs(master: Buffer, kind: TileKind): Promise<PhotoFile[]> {
  // the faint veil and the frame's edge out, as in the photo (cleanShadow)
  const { data, info } = await sharp(master).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  cleanAlpha(data, info.width, info.height, info.channels);
  const clean = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();

  const files: PhotoFile[] = [];
  for (const width of TILE_WIDTHS) {
    const scaled = width < info.width ? sharp(clean).resize({ width, kernel: 'lanczos3' }).sharpen({ sigma: 0.5 }) : sharp(clean).resize({ width });
    const name = `tile-${kind}-${width}`;
    files.push({ file: `${name}.avif`, data: await scaled.clone().avif({ quality: 58, effort: 5 }).toBuffer() });
    files.push({ file: `${name}.webp`, data: await scaled.clone().webp({ quality: 84, alphaQuality: 90 }).toBuffer() });
    files.push({ file: `${name}.png`, data: await scaled.clone().png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer() });
  }
  return files;
}
