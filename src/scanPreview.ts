import { color } from 'console-log-colors';
import Cache from './cache';
import Logger from './logger';
import { AppleMusicProvider } from './providers';

/**
 * Finds a 30-second preview for a card, for the web scanner (`/:lang/scan`
 * on the site). A card only carries streaming links, and Spotify stopped
 * handing out preview URLs through its Web API in November 2024, so the
 * scanner asks here instead of each service itself.
 *
 * Sources, all keyed on the id in a link the card already has:
 * - Spotify: the `audioPreview` its own embed page carries
 * - Deezer: the `preview` of the public track API (signed, expires in 15 min)
 * - Apple Music: `previews[0]` of the catalog song, with our developer token
 *
 * The preferred service is asked first, then the others: the clip is the same
 * recording wherever it comes from, so a Tidal or YouTube Music player still
 * hears the song. Only these fixed hosts are ever called, with ids that passed
 * a strict pattern, so a caller cannot point the server anywhere else.
 */

export type PreviewSource = 'spotify' | 'deezer' | 'apple_music';

export interface PreviewLinks {
  link?: string | null;
  am?: string | null;
  dz?: string | null;
}

export interface PreviewResult {
  url: string;
  source: PreviewSource;
}

const CACHE_PREFIX = 'scan_preview_v1';
// Deezer's URLs stop working 15 minutes after they are handed out
const TTL_SECONDS: Record<PreviewSource, number> = {
  spotify: 6 * 3600,
  deezer: 10 * 60,
  apple_music: 6 * 3600,
};
// A track without a preview is asked again after this, not on every scan
const MISS_TTL_SECONDS = 30 * 60;
const MISS = '-';
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_ORDER: PreviewSource[] = ['spotify', 'deezer', 'apple_music'];
// Long enough for any real link, short enough to keep junk out of the regexes
const MAX_LINK_LENGTH = 512;

interface SourceId {
  source: PreviewSource;
  id: string;
  storefront?: string;
}

export function spotifyTrackId(link: string | null | undefined): string | null {
  if (!link || link.length > MAX_LINK_LENGTH) return null;
  const match =
    link.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})/) ||
    link.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  return match ? match[1] : null;
}

export function deezerTrackId(link: string | null | undefined): string | null {
  if (!link || link.length > MAX_LINK_LENGTH) return null;
  const match = link.match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d{1,15})/);
  return match ? match[1] : null;
}

export function appleSongId(
  link: string | null | undefined
): { id: string; storefront: string } | null {
  if (!link || link.length > MAX_LINK_LENGTH) return null;
  if (!/music\.apple\.com\//i.test(link)) return null;
  // On an album link the song is the `i=` parameter, the path id is the album
  const iParam = link.match(/[?&]i=(\d{1,15})/);
  const songPath = link.match(/\/song\/(?:[^/?]+\/)?(\d{1,15})/);
  const id = iParam?.[1] || songPath?.[1];
  if (!id) return null;
  const storefront = link.match(/music\.apple\.com\/([a-z]{2})\//i)?.[1]?.toLowerCase() || 'us';
  return { id, storefront };
}

/** Maps a service name as the site or the API writes it onto a source. */
function preferredSource(prefer: string | null | undefined): PreviewSource | null {
  switch ((prefer || '').toLowerCase().replace(/-/g, '_')) {
    case 'spotify':
      return 'spotify';
    case 'deezer':
      return 'deezer';
    case 'apple_music':
      return 'apple_music';
    default:
      return null;
  }
}

export function previewOrder(prefer: string | null | undefined): PreviewSource[] {
  const first = preferredSource(prefer);
  if (!first) return DEFAULT_ORDER;
  return [first, ...DEFAULT_ORDER.filter((source) => source !== first)];
}

export default class ScanPreview {
  private static instance: ScanPreview;
  private cache = Cache.getInstance();
  private logger = new Logger();

  public static getInstance(): ScanPreview {
    if (!ScanPreview.instance) {
      ScanPreview.instance = new ScanPreview();
    }
    return ScanPreview.instance;
  }

  public async resolve(
    links: PreviewLinks | null | undefined,
    prefer?: string | null
  ): Promise<PreviewResult | null> {
    const ids = this.sourceIds(links || {});
    for (const source of previewOrder(prefer)) {
      const sourceId = ids.find((candidate) => candidate.source === source);
      if (!sourceId) continue;
      const url = await this.cached(sourceId);
      if (url) return { url, source };
    }
    return null;
  }

  private sourceIds(links: PreviewLinks): SourceId[] {
    const ids: SourceId[] = [];
    const spotify = spotifyTrackId(links.link);
    if (spotify) ids.push({ source: 'spotify', id: spotify });
    const deezer = deezerTrackId(links.dz);
    if (deezer) ids.push({ source: 'deezer', id: deezer });
    const apple = appleSongId(links.am);
    if (apple) ids.push({ source: 'apple_music', id: apple.id, storefront: apple.storefront });
    return ids;
  }

  private async cached(sourceId: SourceId): Promise<string | null> {
    const key = `${CACHE_PREFIX}:${sourceId.source}:${sourceId.id}`;
    try {
      const hit = await this.cache.get(key);
      if (hit) return hit === MISS ? null : hit;
    } catch {
      // Redis down: ask the service itself
    }

    const url = await this.fetchPreview(sourceId);
    try {
      await this.cache.set(
        key,
        url || MISS,
        url ? TTL_SECONDS[sourceId.source] : MISS_TTL_SECONDS
      );
    } catch {
      // Not cached this time; the next scan asks again
    }
    return url;
  }

  private async fetchPreview(sourceId: SourceId): Promise<string | null> {
    try {
      switch (sourceId.source) {
        case 'spotify':
          return await this.spotifyPreview(sourceId.id);
        case 'deezer':
          return await this.deezerPreview(sourceId.id);
        case 'apple_music':
          return await AppleMusicProvider.getInstance().getSongPreviewUrl(
            sourceId.id,
            sourceId.storefront
          );
      }
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `[${color.white.bold('scan')}] Preview lookup failed on ${color.white.bold(sourceId.source)} for ${color.white.bold(sourceId.id)}: ${color.white.bold((error as Error).message)}`
        )
      );
      return null;
    }
  }

  private async spotifyPreview(id: string): Promise<string | null> {
    const response = await fetch(`https://open.spotify.com/embed/track/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QRSong)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/"audioPreview":\{"url":"(https:\/\/p\.scdn\.co\/[^"]+)"/);
    return match ? match[1] : null;
  }

  private async deezerPreview(id: string): Promise<string | null> {
    const response = await fetch(`https://api.deezer.com/track/${id}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { preview?: string; error?: unknown };
    if (data.error || !data.preview) return null;
    return /^https:\/\/[a-z0-9.-]+\.dzcdn\.net\//.test(data.preview) ? data.preview : null;
  }
}
