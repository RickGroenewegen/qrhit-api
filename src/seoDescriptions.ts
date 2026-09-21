import PrismaInstance from './prisma';
import Logger from './logger';
import Cache from './cache';
import Data from './data';
import { ChatGPT, SeoDescriptionBrief } from './chatgpt';
import Translation from './translation';
import { CACHE_KEY_PLAYLIST } from './spotify';
import { color } from 'console-log-colors';

/**
 * The most tracks the description writer sees. 120 lines of
 * "artist - title (year)" is roughly 1.5k tokens, enough to read the genre
 * and the era off any list; a 1000-track list is sampled evenly so the
 * beginning does not stand in for the whole.
 */
const MAX_SAMPLE_TRACKS = 120;
const MAX_TOP_ARTISTS = 6;
/** Customer text longer than this is cut before it reaches the prompt. */
const MAX_SOURCE_TEXT = 1500;

const BULK_STATUS_KEY = 'seoDescriptions:bulk';
const BULK_LOCK_KEY = 'seoDescriptions:bulk';
/** Refreshed after every playlist, so a dead worker frees the run soon. */
const BULK_LOCK_TTL_SECONDS = 15 * 60;
const BULK_STATUS_TTL_SECONDS = 7 * 24 * 3600;

export interface SeoBulkStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  generated: number;
  failed: Array<{ slug: string; error: string }>;
  /** Slug of the playlist being written right now. */
  current: string | null;
}

interface TrackRow {
  artist: string | null;
  name: string | null;
  year: number | null;
}

interface CatalogueRow {
  id: number;
  playlistId: string;
  slug: string;
  name: string;
  promotionalDescription: string | null;
  description_en: string | null;
  seoDescriptionGenerated: boolean;
}

const EMPTY_STATUS: SeoBulkStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  generated: 0,
  failed: [],
  current: null,
};

/** Evenly spread `count` items over the list, keeping their order. */
export function spreadSample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(items[Math.floor(i * step)]);
  }
  return picked;
}

/**
 * Turn the stored tracks into the facts the writer is allowed to use. Pure,
 * so the prompt input can be unit-tested without a database.
 */
export function buildSeoBrief(
  playlistName: string,
  customerDescription: string | null,
  serviceDescription: string | null,
  tracks: TrackRow[]
): SeoDescriptionBrief {
  const years = tracks
    .map((t) => t.year ?? 0)
    .filter((y) => y >= 1900 && y <= new Date().getFullYear() + 1);

  const yearRange =
    years.length > 0
      ? { from: Math.min(...years), to: Math.max(...years) }
      : null;

  const decadeCounts = new Map<number, number>();
  for (const year of years) {
    const decade = Math.floor(year / 10) * 10;
    decadeCounts.set(decade, (decadeCounts.get(decade) ?? 0) + 1);
  }
  const decadeSplit = [...decadeCounts.entries()]
    .map(([decade, count]) => ({
      label: `${decade}s`,
      percent: Math.round((count / years.length) * 100),
    }))
    .filter((d) => d.percent >= 3)
    .sort((a, b) => b.percent - a.percent);

  const artistCounts = new Map<string, number>();
  for (const track of tracks) {
    const artist = (track.artist ?? '').trim();
    if (!artist) continue;
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
  }
  const rankedArtists = [...artistCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  // Repeated artists define a list; on a list where nobody repeats the first
  // few are still worth naming, so the model has real names to pick from.
  const repeated = rankedArtists.filter((a) => a.count > 1);
  const topArtists = (repeated.length >= 3 ? repeated : rankedArtists).slice(
    0,
    MAX_TOP_ARTISTS
  );

  const lines = tracks
    .filter((t) => (t.name ?? '').trim() && (t.artist ?? '').trim())
    .map((t) =>
      t.year && t.year > 0
        ? `${t.artist} - ${t.name} (${t.year})`
        : `${t.artist} - ${t.name}`
    );
  const sampleTracks = spreadSample(lines, MAX_SAMPLE_TRACKS);

  const clip = (text: string | null): string | null => {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_SOURCE_TEXT
      ? trimmed.slice(0, MAX_SOURCE_TEXT)
      : trimmed;
  };

  return {
    playlistName,
    customerDescription: clip(customerDescription),
    serviceDescription: clip(serviceDescription),
    trackCount: tracks.length,
    yearRange,
    decadeSplit,
    topArtists,
    sampleTracks,
    sampleIsPartial: sampleTracks.length < lines.length,
  };
}

/**
 * Writes and localises the product-page description of featured playlists.
 *
 * The customer's text used to be translated as-is into the twelve
 * description_<locale> columns, and playlists without one fell back to the
 * raw streaming-service description in the meta tags. Both are replaced by
 * an English description written from the tracklist (see
 * ChatGPT.writeSeoPlaylistDescription) that is then localised. The row's
 * seoDescriptionGenerated flag records that this has happened.
 */
class SeoDescriptions {
  private static instance: SeoDescriptions;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private chatgpt = new ChatGPT();
  private translation = new Translation();

  private constructor() {}

  public static getInstance(): SeoDescriptions {
    if (!SeoDescriptions.instance) {
      SeoDescriptions.instance = new SeoDescriptions();
    }
    return SeoDescriptions.instance;
  }

  /**
   * Write, translate and store the description of one playlist, by its
   * service playlist id. Throws when the playlist has no tracks or the model
   * returns nothing, so the caller can report why.
   */
  public async generateForPlaylist(
    playlistId: string
  ): Promise<{ description: string }> {
    const playlist = (await this.prisma.playlist.findUnique({
      where: { playlistId },
      select: {
        id: true,
        playlistId: true,
        slug: true,
        name: true,
        promotionalDescription: true,
        description_en: true,
        seoDescriptionGenerated: true,
      },
    })) as CatalogueRow | null;

    if (!playlist) {
      throw new Error('Playlist not found');
    }

    const tracks = (await Data.getInstance().getTracks(playlist.id)) as TrackRow[];
    if (!tracks || tracks.length === 0) {
      throw new Error('Playlist has no stored tracks');
    }

    // The customer's own words: what they typed on submission, or, for lists
    // featured before there was a submission form, the English description
    // that was translated from it or typed in by hand. Once the SEO text has
    // been written it is no longer "the customer's", so it is not fed back in.
    const customerDescription =
      playlist.promotionalDescription ||
      (playlist.seoDescriptionGenerated ? null : playlist.description_en);

    const brief = buildSeoBrief(
      playlist.name,
      customerDescription,
      await this.readServiceDescription(playlist),
      tracks
    );

    this.logger.log(
      color.blue.bold(
        `Writing SEO description for ${color.white.bold(playlist.slug || playlistId)} (${brief.trackCount} tracks)`
      )
    );

    const english = await this.chatgpt.writeSeoPlaylistDescription(brief);
    if (!english) {
      throw new Error('The model returned no description');
    }

    const otherLocales = this.translation.allLocales.filter((l) => l !== 'en');
    const translations = await this.chatgpt.translateSeoDescription(
      english,
      playlist.name,
      otherLocales
    );

    const updateData: Record<string, unknown> = {
      description_en: english,
      seoDescriptionGenerated: true,
      markedForMerchantCenter: true,
    };
    const missing: string[] = [];
    for (const locale of otherLocales) {
      // A locale the translator skipped reads the English text rather than
      // whatever the product page would otherwise fall back to.
      if (translations[locale]) {
        updateData[`description_${locale}`] = translations[locale];
      } else {
        updateData[`description_${locale}`] = english;
        missing.push(locale);
      }
    }
    if (missing.length > 0) {
      this.logger.log(
        color.yellow.bold(
          `No translation for ${color.white.bold(missing.join(', '))} on ${color.white.bold(playlist.slug || playlistId)}, stored English instead`
        )
      );
    }

    await this.prisma.playlist.update({
      where: { id: playlist.id },
      data: updateData,
    });

    // The product page lookup of a featured playlist is cached forever.
    await Data.getInstance().clearPlaylistCache(playlist.playlistId, playlist.slug || undefined);

    this.logger.log(
      color.green.bold(
        `Stored SEO description for ${color.white.bold(playlist.slug || playlistId)} in ${color.white.bold(String(1 + otherLocales.length))} locales`
      )
    );

    return { description: english };
  }

  /**
   * The description on the streaming service is not stored in the catalogue;
   * the product-page cache holds the last one seen. Best effort only.
   */
  private async readServiceDescription(
    playlist: Pick<CatalogueRow, 'slug' | 'playlistId'>
  ): Promise<string | null> {
    for (const key of [playlist.slug, playlist.playlistId]) {
      if (!key) continue;
      try {
        const cached = await this.cache.get(`${CACHE_KEY_PLAYLIST}${key}`);
        if (!cached) continue;
        const parsed = JSON.parse(cached) as { description?: unknown };
        if (typeof parsed.description === 'string' && parsed.description.trim()) {
          return parsed.description;
        }
      } catch {
        // A cache miss or a stale shape is not worth failing the run over.
      }
    }
    return null;
  }

  public async getBulkStatus(): Promise<SeoBulkStatus> {
    try {
      const raw = await this.cache.get(BULK_STATUS_KEY);
      if (raw) return { ...EMPTY_STATUS, ...(JSON.parse(raw) as SeoBulkStatus) };
    } catch {
      // fall through to the empty status
    }
    return { ...EMPTY_STATUS };
  }

  private async writeBulkStatus(status: SeoBulkStatus): Promise<void> {
    await this.cache.set(
      BULK_STATUS_KEY,
      JSON.stringify(status),
      BULK_STATUS_TTL_SECONDS
    );
  }

  /**
   * How many featured playlists still carry a customer or service
   * description. What the bulk action shows before it is started.
   */
  public async countPending(): Promise<number> {
    return this.prisma.playlist.count({
      where: { featured: true, seoDescriptionGenerated: false },
    });
  }

  /**
   * Start writing descriptions for every featured playlist that has none
   * yet. Returns at once; the work continues in this process and reports
   * through getBulkStatus, which any worker can answer because the status
   * lives in Redis. A second start while one is running is refused.
   */
  public async startBulkRun(): Promise<
    { started: true; total: number } | { started: false; status: SeoBulkStatus }
  > {
    const locked = await this.cache.acquireLock(BULK_LOCK_KEY, BULK_LOCK_TTL_SECONDS);
    if (!locked) {
      return { started: false, status: await this.getBulkStatus() };
    }

    const pending = (await this.prisma.playlist.findMany({
      where: { featured: true, seoDescriptionGenerated: false },
      select: { playlistId: true, slug: true },
      orderBy: { id: 'asc' },
    })) as Array<{ playlistId: string; slug: string }>;

    const status: SeoBulkStatus = {
      running: pending.length > 0,
      startedAt: new Date().toISOString(),
      finishedAt: pending.length > 0 ? null : new Date().toISOString(),
      total: pending.length,
      done: 0,
      generated: 0,
      failed: [],
      current: null,
    };
    await this.writeBulkStatus(status);

    if (pending.length === 0) {
      await this.cache.releaseLock(BULK_LOCK_KEY);
      return { started: true, total: 0 };
    }

    this.logger.log(
      color.blue.bold(
        `SEO descriptions: writing ${color.white.bold(String(pending.length))} featured playlists`
      )
    );

    void this.runBulk(pending, status);

    return { started: true, total: pending.length };
  }

  private async runBulk(
    pending: Array<{ playlistId: string; slug: string }>,
    status: SeoBulkStatus
  ): Promise<void> {
    try {
      for (const item of pending) {
        status.current = item.slug || item.playlistId;
        await this.writeBulkStatus(status);
        try {
          await this.generateForPlaylist(item.playlistId);
          status.generated++;
        } catch (error: any) {
          const message = error?.message || String(error);
          status.failed.push({ slug: item.slug || item.playlistId, error: message });
          this.logger.log(
            color.red.bold(
              `SEO description failed for ${color.white.bold(item.slug || item.playlistId)}: ${message}`
            )
          );
        }
        status.done++;
        // Keep the lock alive for as long as the run is making progress.
        await this.cache.refreshLock(BULK_LOCK_KEY, BULK_LOCK_TTL_SECONDS);
      }
    } finally {
      status.running = false;
      status.current = null;
      status.finishedAt = new Date().toISOString();
      await this.writeBulkStatus(status);
      await this.cache.releaseLock(BULK_LOCK_KEY);
      this.logger.log(
        color.green.bold(
          `SEO descriptions: ${color.white.bold(String(status.generated))} written, ${color.white.bold(String(status.failed.length))} failed`
        )
      );
    }
  }
}

export default SeoDescriptions;
