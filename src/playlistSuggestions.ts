import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import Translation from './translation';
import PrismaInstance from './prisma';
import { PlaylistSuggestionOptions } from './data/featuredPlaylists';
import { artworkCacheFile, loadArtworkSource } from './playlistArtwork';

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

/**
 * Returns a small JPEG for a playlist's artwork, generating and caching it
 * on first use. The cache file is keyed on the source URL, so a new custom
 * image yields a new file and stale thumbnails are simply never requested
 * again. Returns null when the playlist or its image cannot be resolved.
 * Source loading and its URL guards live in playlistArtwork.ts.
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
  const cacheFile = artworkCacheFile(publicDir, ART_DIR, playlistId, source);

  try {
    return await fs.readFile(cacheFile);
  } catch {
    // not cached yet
  }

  const original = await loadArtworkSource(playlist, publicDir);
  if (!original) return null;

  const thumbnail = await sharp(original)
    .resize(ART_SIZE, ART_SIZE, { fit: 'cover' })
    .flatten({ background: '#18565E' })
    .jpeg({ quality: ART_QUALITY, mozjpeg: true })
    .toBuffer();

  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
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
