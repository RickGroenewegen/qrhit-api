import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { color, white } from 'console-log-colors';
import Logger from '../logger';
import Cache from '../cache';
import PrismaInstance from '../prisma';
import { readQrCodes } from '../qrRead';
import { showcaseDesign } from './design';
import { renderShowcaseCards, ShowcaseCard, ShowcaseFaces } from './cards';
import { cardOf, composePhoto, FacePictures, loadScene, Scene } from './compose';
import { CREAM, PhotoFile, PHOTO_WIDTHS, photoOutputs } from './outputs';
import { PhotoTrack, PickSource, photoCandidates, pickPhotoSongs, tracksByIds } from './songs';
import { composeTile, loadTileScenes, TILE_KINDS, TILE_WIDTHS, TileKind, tileOutputs } from './tiles';

/**
 * The product photo of a featured playlist: its own cards, in its design
 * (or the standard one) and with its best-known songs, put into the approved
 * scene without Blender (compose.ts), checked (the hero's QR code has to read
 * at the smallest size) and written as the files the product page and the
 * feeds use (outputs.ts) under PUBLIC_DIR/product_photos/<key>/. The format
 * tiles in its design (tiles.ts) are made from the same cards and go in the
 * same folder.
 *
 * The key is a fingerprint of everything the photo shows, so a photo is only
 * made again when its design, its songs or their printed text changed, or
 * when a scene or the drawing changed (PHOTO_VERSION). The files of the
 * photo before stay KEEP_PREVIOUS_DAYS for pages and feeds cached with them;
 * cleanupPhotoFiles removes what nothing points at any more.
 */

// raise when compose.ts, outputs.ts, tiles.ts or the card template change how a photo looks
const PHOTO_VERSION = 3;
// card pictures twice the largest face on screen; compose shrinks them
const CARD_PX = 1024;
const KEEP_PREVIOUS_DAYS = 7;
const LOOKUP_SECONDS = 300;
const KEY = /^[0-9a-f]{16}$/;
// what the page asks for, with the slug in front for search engines
const FILE = /^[a-z0-9-]*?-(?:(720|1080|1440|cream|feed|og)\.(avif|webp|jpg)|(tile-(?:digital|sheets|cards)-(?:160|320|640))\.(avif|webp|png))$/;

export type GenerateStatus = 'ready' | 'unchanged' | 'skipped';

/** A format tile's files: srcsets by width (TILE_WIDTHS), and the smallest PNG for the <img>. */
export interface TileUrls {
  avif: string;
  webp: string;
  png: string;
  src: string;
}

/** The URLs of a photo, as the product page uses them (the site's ProductPhoto). */
export interface ProductPhotoUrls {
  avif: string;
  webp: string;
  fallback: string;
  og: string;
  feed: string;
  /** the format tiles in the playlist's design, those that were made */
  tiles?: Partial<Record<TileKind, TileUrls>>;
}

const logger = new Logger();
const prisma = () => PrismaInstance.getInstance();
const photoRoot = () => path.join(process.env['PUBLIC_DIR'] as string, 'product_photos');
const lookupKey = (slug: string) => `product-photo:${slug}`;
const exists = (file: string) => fs.access(file).then(() => true, () => false);

export function photoUrls(key: string, slug: string): ProductPhotoUrls {
  const base = `${process.env['API_URI']}/product-photo/${key}/${slug}-qr-music-cards`;
  const srcset = (ext: string) => PHOTO_WIDTHS.map((width) => `${base}-${width}.${ext} ${width}w`).join(', ');
  return {
    avif: srcset('avif'),
    webp: srcset('webp'),
    fallback: `${base}-cream.jpg`,
    og: `${base}-og.jpg`,
    feed: `${base}-feed.jpg`,
  };
}

/** The format tiles a photo's folder holds (photos made before PHOTO_VERSION 3 have none). */
async function photoTiles(key: string, slug: string): Promise<ProductPhotoUrls['tiles'] | undefined> {
  const base = `${process.env['API_URI']}/product-photo/${key}/${slug}-qr-music-cards-tile`;
  const tiles: ProductPhotoUrls['tiles'] = {};
  for (const kind of TILE_KINDS) {
    if (!(await exists(path.join(photoRoot(), key, `tile-${kind}-${TILE_WIDTHS[0]}.png`)))) continue;
    const srcset = (ext: string) => TILE_WIDTHS.map((width) => `${base}-${kind}-${width}.${ext} ${width}w`).join(', ');
    tiles[kind] = { avif: srcset('avif'), webp: srcset('webp'), png: srcset('png'), src: `${base}-${kind}-${TILE_WIDTHS[0]}.png` };
  }
  return Object.keys(tiles).length ? tiles : undefined;
}

/** The file behind GET /product-photo/:key/:file, or null for a name that is not one. */
export function photoFilePath(key: string, file: string): string | null {
  const match = file.match(FILE);
  if (!KEY.test(key) || !match) return null;
  const [, size, ext, tile, tileExt] = match;
  if (tile) return path.join(photoRoot(), key, `${tile}.${tileExt}`);
  const sized = /^\d+$/.test(size);
  if (sized === (ext === 'jpg')) return null;
  return path.join(photoRoot(), key, `photo-${size}.${ext}`);
}

/** The photo of a featured playlist's product page, or null. Cached a few minutes. */
export async function productPhotoFor(slug: string): Promise<ProductPhotoUrls | null> {
  if (!slug) return null;
  const cache = Cache.getInstance();
  const cached = await cache.get(lookupKey(slug)).catch(() => null);
  if (cached) return cached === 'none' ? null : JSON.parse(cached);
  let urls: ProductPhotoUrls | null = null;
  try {
    const row = await prisma().productPhoto.findFirst({
      where: { playlist: { slug, featured: true }, photoKey: { not: null } },
      select: { photoKey: true },
    });
    if (row?.photoKey) {
      urls = photoUrls(row.photoKey, slug);
      const tiles = await photoTiles(row.photoKey, slug);
      if (tiles) urls.tiles = tiles;
    }
  } catch (error: any) {
    // P2021: the table is not there yet (a deploy before its db push)
    if (error?.code !== 'P2021') throw error;
  }
  await cache.set(lookupKey(slug), urls ? JSON.stringify(urls) : 'none', LOOKUP_SECONDS).catch(() => {});
  return urls;
}

/** The QR link of a card: the streaming link itself, played straight away by the app. */
function qrUrl(link: string): string {
  return `${process.env['API_URI']}/qr_url2?link=${encodeURIComponent(link)}`;
}

/**
 * The format tiles' files from the photo's card pictures (card numbers past
 * them wrap around). A tile that fails is left out with a warning: the page
 * then shows the standard one, and the photo is still made.
 */
async function tileFiles(scenes: Partial<Record<TileKind, Scene>>, cards: ShowcaseFaces[]): Promise<PhotoFile[]> {
  const files: PhotoFile[] = [];
  for (const kind of TILE_KINDS) {
    const scene = scenes[kind];
    if (!scene) continue;
    try {
      const master = await composeTile(scene, (card, side) => cards[card % cards.length][side]);
      files.push(...(await tileOutputs(master, kind)));
    } catch (error: any) {
      logger.log(color.yellow.bold(`Format tile ${white.bold(kind)} not made: ${white.bold(error?.message || error)}`));
    }
  }
  return files;
}

function showcaseCard(track: PhotoTrack): ShowcaseCard {
  return {
    trackId: String(track.id),
    artist: track.artist,
    name: track.name,
    year: track.year,
    qrUrl: qrUrl(track.link),
    extraArtistAttribute: track.extraArtistAttribute,
    extraNameAttribute: track.extraNameAttribute,
  };
}

/**
 * Makes (or keeps) the photo of a featured playlist. `force` makes it again
 * even when nothing changed; `repick` lets the model choose the songs again,
 * also over an admin's choice. Throws when the cards cannot be drawn or the
 * hero's QR code does not read; the row then says why and the old photo stays.
 */
export async function generateProductPhoto(
  playlistId: number,
  options: { force?: boolean; repick?: boolean } = {}
): Promise<{ status: GenerateStatus; key?: string; reason?: string }> {
  const playlist = await prisma().playlist.findUnique({
    where: { id: playlistId },
    select: {
      id: true,
      slug: true,
      name: true,
      featured: true,
      featuredLocale: true,
      design: true,
      promotionalShareDesign: true,
      featuredDesignHidden: true,
    },
  });
  if (!playlist || !playlist.featured || !playlist.slug) {
    await dropProductPhoto(playlistId);
    return { status: 'skipped', reason: 'not a featured playlist' };
  }
  const row = await prisma().productPhoto.upsert({
    where: { playlistId },
    create: { playlistId },
    update: {},
  });

  try {
    const candidates = await photoCandidates(playlist.id);
    let tracks = options.repick ? null : tracksByIds(row.trackIds, candidates);
    let source = row.pickSource as PickSource;
    if (!tracks) {
      const picked = await pickPhotoSongs(playlist, candidates);
      if (!picked) {
        const reason = 'fewer than 5 songs with a year, a link and a short title';
        await prisma().productPhoto.update({ where: { id: row.id }, data: { status: 'skipped', error: reason } });
        return { status: 'skipped', reason };
      }
      tracks = picked.tracks;
      source = picked.source;
    }

    const { design } = showcaseDesign(playlist);
    const cards = tracks.map(showcaseCard);
    const scene = await loadScene();
    const tileScenes = await loadTileScenes();
    const tilesExported = Object.entries(tileScenes).map(([kind, tile]) => [kind, tile.manifest.exported]);
    const key = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          version: PHOTO_VERSION,
          scene: [scene.manifest.version, scene.manifest.exported],
          tiles: tilesExported,
          design,
          cards,
        })
      )
      .digest('hex')
      .slice(0, 16);
    const done = {
      trackIds: tracks.map((track) => track.id),
      pickSource: source,
      status: 'ready',
      error: null,
    };

    const target = path.join(photoRoot(), key);
    if (key === row.photoKey && !options.force && (await exists(target))) {
      await prisma().productPhoto.update({ where: { id: row.id }, data: done });
      return { status: 'unchanged', key };
    }

    const started = Date.now();
    const faces = await renderShowcaseCards({ design, cards }, CARD_PX);
    const pictures: FacePictures = {};
    for (const face of scene.manifest.faces) {
      if (face.side !== 'page') pictures[face.role] = faces[cardOf(face)][face.side];
    }
    const master = await composePhoto(pictures, scene);
    const smallest = await sharp(master).resize({ width: PHOTO_WIDTHS[0] }).flatten({ background: CREAM }).png().toBuffer();
    if (!(await readQrCodes(smallest)).includes(cards[0].qrUrl)) {
      throw new Error(`the hero card's QR code does not read at ${PHOTO_WIDTHS[0]} px`);
    }

    if (!(await exists(target))) {
      const files = [...(await photoOutputs(master, 'photo')), ...(await tileFiles(tileScenes, faces))];
      const tmp = path.join(photoRoot(), `.${key}-${process.pid}-${Date.now()}`);
      await fs.mkdir(tmp, { recursive: true });
      try {
        for (const { file, data } of files) await fs.writeFile(path.join(tmp, file), data);
        await fs.rename(tmp, target);
      } catch (error) {
        await fs.rm(tmp, { recursive: true, force: true });
        // another run wrote the same photo first
        if (!(await exists(target))) throw error;
      }
    }

    const replaced = row.photoKey && row.photoKey !== key ? row.photoKey : null;
    await prisma().productPhoto.update({
      where: { id: row.id },
      data: {
        ...done,
        photoKey: key,
        ...(replaced
          ? { previousKey: replaced, previousUntil: new Date(Date.now() + KEEP_PREVIOUS_DAYS * 86_400_000) }
          : {}),
        sceneVersion: scene.manifest.version,
        generatedAt: new Date(),
      },
    });
    await Cache.getInstance().del(lookupKey(playlist.slug)).catch(() => {});
    logger.log(
      color.green.bold(
        `Product photo of ${white.bold(playlist.name)} made in ${white.bold(Date.now() - started)} ms (${white.bold(source)} songs, key ${white.bold(key)})`
      )
    );
    return { status: 'ready', key };
  } catch (error: any) {
    await prisma()
      .productPhoto.update({
        where: { id: row.id },
        data: { status: 'failed', error: String(error?.message || error).slice(0, 255) },
      })
      .catch(() => {});
    throw error;
  }
}

/** The admin's choice of songs (tracks.id in the scene's order), used from the next photo on. */
export async function setPhotoSongs(playlistId: number, trackIds: number[]): Promise<boolean> {
  const tracks = tracksByIds(trackIds, await photoCandidates(playlistId));
  if (!tracks) return false;
  await prisma().productPhoto.upsert({
    where: { playlistId },
    create: { playlistId, trackIds: tracks.map((track) => track.id), pickSource: 'admin' },
    update: { trackIds: tracks.map((track) => track.id), pickSource: 'admin' },
  });
  return true;
}

/** Takes the photo off a playlist that is no longer featured; cleanupPhotoFiles removes its files. */
export async function dropProductPhoto(playlistId: number): Promise<void> {
  const row = await prisma()
    .productPhoto.findUnique({ where: { playlistId }, select: { id: true, playlist: { select: { slug: true } } } })
    .catch(() => null);
  if (!row) return;
  await prisma().productPhoto.delete({ where: { id: row.id } });
  if (row.playlist.slug) await Cache.getInstance().del(lookupKey(row.playlist.slug)).catch(() => {});
}

/**
 * Removes the folders no photo points at: replaced photos after their grace
 * period, photos of unfeatured playlists, half-written folders. A folder
 * younger than an hour is left alone, its row may not be written yet.
 */
export async function cleanupPhotoFiles(): Promise<number> {
  const root = photoRoot();
  const names = await fs.readdir(root).catch(() => [] as string[]);
  if (!names.length) return 0;
  const rows = await prisma().productPhoto.findMany({
    select: { photoKey: true, previousKey: true, previousUntil: true },
  });
  const now = Date.now();
  const kept = new Set<string>();
  for (const row of rows) {
    if (row.photoKey) kept.add(row.photoKey);
    if (row.previousKey && row.previousUntil && row.previousUntil.getTime() > now) kept.add(row.previousKey);
  }
  let removed = 0;
  for (const name of names) {
    const key = name.replace(/^\./, '').slice(0, 16);
    if (kept.has(name)) continue;
    const stat = await fs.stat(path.join(root, name)).catch(() => null);
    if (!stat || now - stat.mtimeMs < 3_600_000) continue;
    if (!KEY.test(key)) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    removed++;
  }
  if (removed) logger.log(color.blue.bold(`Removed ${white.bold(removed)} old product photo folders`));
  return removed;
}
