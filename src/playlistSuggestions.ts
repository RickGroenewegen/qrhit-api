import * as crypto from 'crypto';
import * as dns from 'dns/promises';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import Translation from './translation';
import PrismaInstance from './prisma';
import { PlaylistSuggestionOptions } from './data/featuredPlaylists';

/** Box sizes the admin can pick a suggestion list for. */
export const SUGGESTION_CARD_COUNTS = [48, 96, 192, 200] as const;

const MAX_GENRE_IDS = 50;

/**
 * Artwork in the brochure is a 26 mm square, so 240 px is already ~2.3x
 * print density. Spotify mosaics are 640 px JPEGs and admin uploads are
 * 1600 px PNGs; embedding those made a 300-playlist PDF weigh 50 MB+.
 */
const ART_SIZE = 240;
const ART_QUALITY = 74;
const ART_DIR = 'suggestion_art';

/** Public path of the thumbnail; the HTML view points every card here. */
export function suggestionArtPath(playlistId: string): string {
  return `/vibe/playlist-suggestions/art/${encodeURIComponent(playlistId)}`;
}

/** True for loopback, private, link-local and other non-public addresses. */
function isPrivateAddress(address: string): boolean {
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
async function isSafeImageUrl(source: string): Promise<boolean> {
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
function resolveCustomImage(publicDir: string, customImage: string): string | null {
  if (customImage.includes('..') || customImage.includes('\0')) return null;
  const relative = customImage.replace(/^\/?public\//, '');
  const base = path.resolve(publicDir);
  const target = path.resolve(base, relative);
  return target.startsWith(base + path.sep) ? target : null;
}

/**
 * Returns a small JPEG for a playlist's artwork, generating and caching it
 * on first use. The cache file is keyed on the source URL, so a new custom
 * image yields a new file and stale thumbnails are simply never requested
 * again. Returns null when the playlist or its image cannot be resolved.
 */
export async function getSuggestionArtwork(
  playlistId: string
): Promise<Buffer | null> {
  const prisma = PrismaInstance.getInstance();
  const playlist = await prisma.playlist.findUnique({
    where: { playlistId },
    select: { image: true, customImage: true },
  });
  if (!playlist) return null;

  const source = playlist.customImage || playlist.image;
  if (!source) return null;

  const publicDir = process.env['PUBLIC_DIR'] as string;
  const cacheDir = path.join(publicDir, ART_DIR);
  const hash = crypto.createHash('md5').update(source).digest('hex').slice(0, 12);
  const cacheFile = path.join(
    cacheDir,
    `${playlistId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${hash}.jpg`
  );

  try {
    return await fs.readFile(cacheFile);
  } catch {
    // not cached yet
  }

  let original: Buffer;
  try {
    if (playlist.customImage) {
      // Stored as "/public/playlist_images/<file>", served from PUBLIC_DIR.
      const file = resolveCustomImage(publicDir, playlist.customImage);
      if (!file) return null;
      original = await fs.readFile(file);
    } else {
      if (!(await isSafeImageUrl(source))) return null;
      const response = await axios.get<ArrayBuffer>(source, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 10 * 1024 * 1024,
      });
      original = Buffer.from(response.data);
    }
  } catch (error) {
    console.warn(`Could not load artwork for playlist ${playlistId}:`, (error as Error).message);
    return null;
  }

  const thumbnail = await sharp(original)
    .resize(ART_SIZE, ART_SIZE, { fit: 'cover' })
    .flatten({ background: '#18565E' })
    .jpeg({ quality: ART_QUALITY, mozjpeg: true })
    .toBuffer();

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, thumbnail);
  } catch (error) {
    console.warn('Could not cache suggestion artwork:', (error as Error).message);
  }

  return thumbnail;
}

export interface ParsedPlaylistSuggestionOptions extends PlaylistSuggestionOptions {
  /** Business locale the document itself is written in (nl / de / en). */
  locale: string;
}

/**
 * Reads the suggestion filters from a query string or a JSON body. The
 * unauthenticated HTML view is screenshotted by Lambda, so everything has to
 * travel as plain comma-separated scalars that are validated here and never
 * reach SQL. Returns an error message instead of throwing so routes can 400.
 */
export function parsePlaylistSuggestionOptions(
  source: Record<string, unknown> | undefined,
  translation: Translation
): { ok: true; opts: ParsedPlaylistSuggestionOptions } | { ok: false; error: string } {
  const src = source || {};

  const cardCount = Number(src['cardCount'] ?? 96);
  if (!(SUGGESTION_CARD_COUNTS as readonly number[]).includes(cardCount)) {
    return { ok: false, error: 'Invalid cardCount' };
  }

  const locales = toStringList(src['locales'])
    .map((l) => l.toLowerCase())
    .filter((l) => /^[a-z]{2}$/.test(l) && Translation.ALL_LOCALES.includes(l));

  const genreIds = toStringList(src['genreIds'])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_GENRE_IDS);

  return {
    ok: true,
    opts: {
      locale: translation.resolveBusinessLocale(
        typeof src['locale'] === 'string' ? src['locale'] : null
      ),
      locales: Array.from(new Set(locales)),
      genreIds: Array.from(new Set(genreIds)),
      cardCount,
    },
  };
}

/** Query string for the HTML view, so the PDF route and the count endpoint agree. */
export function playlistSuggestionQuery(opts: ParsedPlaylistSuggestionOptions): string {
  const params = new URLSearchParams({
    locale: opts.locale,
    cardCount: String(opts.cardCount),
  });
  if (opts.locales.length) params.set('locales', opts.locales.join(','));
  if (opts.genreIds.length) params.set('genreIds', opts.genreIds.join(','));
  return params.toString();
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}
