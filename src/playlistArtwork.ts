import * as crypto from 'crypto';
import * as dns from 'dns/promises';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import PrismaInstance from './prisma';

/**
 * Loading and resizing playlist covers, shared by the brochure thumbnails
 * (playlistSuggestions.ts) and the product page cover below.
 *
 * `Playlist.image` is a URL on the streaming service's CDN, and Spotify
 * deletes the file when the owner changes the cover (see the cover repair in
 * data/playlistCovers.ts). The product page used to hand that URL straight to
 * search engines and social scrapers as og:image and Product.image, so every
 * cover change also broke the cached rich result and every earlier share.
 * getProductCover serves the same picture from our own domain instead, and
 * the disk cache is keyed on the source URL so a repaired cover simply yields
 * a new file.
 */

/** The product page shows the cover in a square deck; 640 is Spotify's own size. */
const PRODUCT_COVER_SIZE = 640;
const PRODUCT_COVER_QUALITY = 82;
const PRODUCT_COVER_DIR = 'product_covers';

/** Public URL of a product cover, relative to the API origin. */
export function productCoverPath(slug: string): string {
  return `/product-cover/${encodeURIComponent(slug)}.jpg`;
}

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80')
  );
}

/**
 * `Playlist.image` is filled from client-supplied cart items, so treat the
 * URL as untrusted: https only, a real hostname (no IP literals), and every
 * resolved address must be public. Redirects are not followed so a public
 * host cannot bounce us to an internal one.
 */
export async function isSafeImageUrl(source: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (net.isIP(url.hostname)) return false;
  try {
    const records = await dns.lookup(url.hostname, { all: true });
    return records.length > 0 && records.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

/** Resolve a stored "/public/<file>" path and refuse anything outside PUBLIC_DIR. */
export function resolveCustomImage(publicDir: string, customImage: string): string | null {
  if (customImage.includes('..') || customImage.includes('\0')) return null;
  const relative = customImage.replace(/^\/?public\//, '');
  const base = path.resolve(publicDir);
  const target = path.resolve(base, relative);
  return target.startsWith(base + path.sep) ? target : null;
}

/**
 * The original bytes of a playlist's cover: the admin upload when there is
 * one, otherwise the streaming service's file. Null when neither can be
 * read, which the callers turn into a 404.
 */
export async function loadArtworkSource(
  playlist: { image: string | null; customImage: string | null },
  publicDir: string
): Promise<Buffer | null> {
  try {
    if (playlist.customImage) {
      // Stored as "/public/playlist_images/<file>", served from PUBLIC_DIR.
      const file = resolveCustomImage(publicDir, playlist.customImage);
      if (!file) return null;
      return await fs.readFile(file);
    }
    if (!playlist.image) return null;
    if (!(await isSafeImageUrl(playlist.image))) return null;
    const response = await axios.get<ArrayBuffer>(playlist.image, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: 10 * 1024 * 1024,
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.warn('Could not load playlist artwork:', (error as Error).message);
    return null;
  }
}

/** Cache file for one rendering of one source, so a new cover is a new file. */
export function artworkCacheFile(
  publicDir: string,
  dir: string,
  key: string,
  source: string
): string {
  const hash = crypto.createHash('md5').update(source).digest('hex').slice(0, 12);
  return path.join(
    publicDir,
    dir,
    `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}_${hash}.jpg`
  );
}

/**
 * Square JPEG of a featured playlist's cover for the product page, its
 * share tags and its structured data. Cached on disk on first use.
 */
export async function getProductCover(slug: string): Promise<Buffer | null> {
  const prisma = PrismaInstance.getInstance();
  const playlist = await prisma.playlist.findFirst({
    where: { slug, featured: true },
    select: { image: true, customImage: true },
  });
  if (!playlist) return null;

  const source = playlist.customImage || playlist.image;
  if (!source) return null;

  const publicDir = process.env['PUBLIC_DIR'] as string;
  const cacheFile = artworkCacheFile(publicDir, PRODUCT_COVER_DIR, slug, source);

  try {
    return await fs.readFile(cacheFile);
  } catch {
    // not cached yet
  }

  const original = await loadArtworkSource(playlist, publicDir);
  if (!original) return null;

  const cover = await sharp(original)
    .resize(PRODUCT_COVER_SIZE, PRODUCT_COVER_SIZE, { fit: 'cover' })
    .flatten({ background: '#18565E' })
    .jpeg({ quality: PRODUCT_COVER_QUALITY, mozjpeg: true })
    .toBuffer();

  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, cover);
  } catch (error) {
    console.warn('Could not cache product cover:', (error as Error).message);
  }

  return cover;
}
