import { PrismaClient } from '@prisma/client';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import { CronJob } from 'cron';
import Logger from './logger';
import Utils from './utils';
import PrismaInstance from './prisma';

const CHANGED_TRACKS_OVERLAP_MS = 10 * 60 * 1000;

/**
 * Enrichment data structure for tracks
 */
export interface EnrichmentData {
  year?: number;
  name?: string;
  artist?: string;
  extraNameAttribute?: string;
  extraArtistAttribute?: string;
}

/**
 * TrackEnrichment service - handles enrichment of tracks from any music provider
 * using data from the database.
 *
 * This service maintains in-memory maps for fast lookup of track enrichment data.
 * It supports matching by:
 * - Spotify trackId
 * - ISRC code
 * - Artist + title hash (fallback for services without ISRC like YouTube Music)
 */
class TrackEnrichment {
  private static instance: TrackEnrichment;
  private prisma: PrismaClient;
  private logger: Logger;
  private utils: Utils;

  // In-memory maps for fast enrichment lookups
  private trackEnrichmentByTrackId: Map<string, EnrichmentData> = new Map();
  private trackEnrichmentByIsrc: Map<string, EnrichmentData> = new Map();
  private trackEnrichmentByArtistTitleHash: Map<string, EnrichmentData> = new Map();
  private mapsInitialized: boolean = false;
  private loadPromise: Promise<void> | null = null;
  private retryAttempt: number = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks written from this moment on may not be in the maps yet
  private changesSince: Date | null = null;

  private constructor() {
    this.prisma = PrismaInstance.getInstance();
    this.logger = new Logger();
    this.utils = new Utils();

    // Load enrichment maps on startup. Workers instead load via warmup()
    // after fastify.listen (plus the lazy trigger in the getters), keeping
    // the full-table scan out of the boot window where the cold pool
    // creates connections one at a time.
    if (cluster.isPrimary) {
      this.reload();
    }

    // Every process keeps its own maps. They used to reload all checked
    // tracks (423k) at :00 in every process at once, each holding a
    // connection for 40 s. Now each process has its own minute (primary
    // first, then one worker after the other), the hourly pass only reads
    // the tracks changed since the last one, and a nightly full reload
    // catches what that cannot see: deleted tracks and changed ISRCs.
    const slot = cluster.isPrimary
      ? 0
      : (parseInt(process.env['WORKER_ID'] ?? '', 10) || 0) + 1;
    const changedTracksJob = new CronJob(`${(7 + slot) % 60} * * * *`, async () => {
      await this.refreshChangedTracks();
    });
    changedTracksJob.start();
    const nightlyMinute = 10 + slot * 5;
    const fullReloadJob = new CronJob(
      `${nightlyMinute % 60} ${2 + Math.floor(nightlyMinute / 60)} * * *`,
      async () => {
        await this.refreshTrackEnrichmentMaps();
      }
    );
    fullReloadJob.start();
  }

  public static getInstance(): TrackEnrichment {
    if (!TrackEnrichment.instance) {
      TrackEnrichment.instance = new TrackEnrichment();
    }
    return TrackEnrichment.instance;
  }

  /**
   * Create a simple hash for artist+title matching
   */
  private createSimpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private artistTitleHash(artist: string, title: string): string {
    return this.createSimpleHash(`${artist.toLowerCase().trim()}|||${title.toLowerCase().trim()}`);
  }

  /**
   * Put a checked track in all three maps. Rows without year, name or
   * artist are left out.
   */
  private addTrack(track: {
    trackId: string | null;
    isrc: string | null;
    year: number | null;
    name: string | null;
    artist: string | null;
  }): void {
    if (!track.year || !track.name || !track.artist) {
      return;
    }

    const enrichmentData: EnrichmentData = {
      year: track.year,
      name: track.name,
      artist: track.artist,
    };

    // Map 1: By trackId
    if (track.trackId) {
      this.trackEnrichmentByTrackId.set(track.trackId, enrichmentData);
    }

    // Map 2: By ISRC
    if (track.isrc) {
      this.trackEnrichmentByIsrc.set(track.isrc, enrichmentData);
    }

    // Map 3: By artist+title hash (normalized, case-insensitive)
    this.trackEnrichmentByArtistTitleHash.set(
      this.artistTitleHash(track.artist, track.name),
      enrichmentData
    );
  }

  /**
   * Take a track out of the maps, by the entry its trackId holds. The ISRC
   * and artist+title entries go only where they still hold that same entry:
   * another track with the same ISRC or title may have taken the key. An
   * ISRC the track no longer has stays until the nightly full reload.
   */
  private removeTrack(trackId: string, isrc: string | null): void {
    const previous = this.trackEnrichmentByTrackId.get(trackId);
    if (!previous) {
      return;
    }
    this.trackEnrichmentByTrackId.delete(trackId);
    if (isrc && this.trackEnrichmentByIsrc.get(isrc) === previous) {
      this.trackEnrichmentByIsrc.delete(isrc);
    }
    const hash = this.artistTitleHash(previous.artist!, previous.name!);
    if (this.trackEnrichmentByArtistTitleHash.get(hash) === previous) {
      this.trackEnrichmentByArtistTitleHash.delete(hash);
    }
  }

  private logOnMainServer(message: string): void {
    if (!cluster.isPrimary) {
      return;
    }
    this.utils.isMainServer().then((isMainServer) => {
      if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
        this.logger.log(message);
      }
    });
  }

  /**
   * Load track enrichment maps from database
   */
  private async loadTrackEnrichmentMaps(): Promise<void> {
    const startedAt = new Date();

    try {
      // Query all manually-checked tracks from database
      const tracks = await this.prisma.track.findMany({
        where: { manuallyChecked: true },
        select: {
          trackId: true,
          isrc: true,
          year: true,
          name: true,
          artist: true,
        },
      });

      // Clear existing maps
      this.trackEnrichmentByTrackId.clear();
      this.trackEnrichmentByIsrc.clear();
      this.trackEnrichmentByArtistTitleHash.clear();

      // Populate all three maps
      for (const track of tracks) {
        this.addTrack(track);
      }

      this.mapsInitialized = true;
      this.retryAttempt = 0;
      this.changesSince = startedAt;

      this.logOnMainServer(
        color.blue.bold(
          `[${color.white.bold('TrackEnrichment')}] Maps loaded: ${color.white.bold(
            this.trackEnrichmentByTrackId.size
          )} by trackId, ${color.white.bold(
            this.trackEnrichmentByIsrc.size
          )} by ISRC, ${color.white.bold(
            this.trackEnrichmentByArtistTitleHash.size
          )} by artist+title`
        )
      );
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`[TrackEnrichment] Failed to load maps: ${e.message || e}`)
      );
      this.scheduleRetry();
    }
  }

  /**
   * Load the maps once, deduplicating concurrent triggers.
   */
  private ensureLoaded(): Promise<void> {
    if (this.mapsInitialized) {
      return Promise.resolve();
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    if (this.retryTimer) {
      // Backoff in progress; only the timer may start the next attempt,
      // otherwise every request would relaunch the failed query instantly.
      return Promise.resolve();
    }
    return this.reload();
  }

  /**
   * Run a full load, or join the one already running.
   */
  private reload(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadTrackEnrichmentMaps().finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    const delays = [5000, 15000, 60000];
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensureLoaded();
    }, delay);
    this.retryTimer.unref();
  }

  /**
   * Kick off the initial load outside the boot window. Called by workers
   * after fastify.listen; a no-op once maps are loaded.
   */
  public warmup(delayMs: number = 0): void {
    setTimeout(() => {
      this.ensureLoaded();
    }, delayMs).unref();
  }

  /**
   * Reload the maps from scratch
   */
  public async refreshTrackEnrichmentMaps(): Promise<void> {
    await this.reload();
  }

  /**
   * Bring the maps up to date with the tracks written since the last load
   * or refresh: a track that is checked (again) goes in with its current
   * data, one that is no longer checked comes out. The window reaches back
   * CHANGED_TRACKS_OVERLAP_MS before that moment, for clock differences
   * between servers and writes that committed late; reading a track twice
   * is harmless. Before the first load there is nothing to update, so that
   * load runs instead.
   */
  public async refreshChangedTracks(): Promise<void> {
    if (this.loadPromise) {
      return;
    }
    if (!this.mapsInitialized || !this.changesSince) {
      return this.ensureLoaded();
    }

    const startedAt = new Date();
    try {
      const tracks = await this.prisma.track.findMany({
        where: {
          updatedAt: {
            gte: new Date(this.changesSince.getTime() - CHANGED_TRACKS_OVERLAP_MS),
          },
        },
        select: {
          trackId: true,
          isrc: true,
          year: true,
          name: true,
          artist: true,
          manuallyChecked: true,
        },
      });

      // A full load that started meanwhile has newer data than this read
      if (this.loadPromise) {
        return;
      }

      for (const track of tracks) {
        this.removeTrack(track.trackId, track.isrc);
        if (track.manuallyChecked) {
          this.addTrack(track);
        }
      }
      if (startedAt > this.changesSince) {
        this.changesSince = startedAt;
      }

      if (tracks.length > 0) {
        this.logOnMainServer(
          color.blue.bold(
            `[${color.white.bold('TrackEnrichment')}] Refreshed ${color.white.bold(
              tracks.length
            )} recently changed tracks`
          )
        );
      }
    } catch (e: any) {
      // changesSince stays put, so the next refresh reads this window too
      this.logger.log(
        color.red.bold(`[TrackEnrichment] Failed to refresh changed tracks: ${e.message || e}`)
      );
    }
  }

  /**
   * Get enrichment data by Spotify trackId
   */
  public getByTrackId(trackId: string): EnrichmentData | undefined {
    if (!this.mapsInitialized) {
      this.ensureLoaded();
    }
    return this.trackEnrichmentByTrackId.get(trackId);
  }

  /**
   * Get enrichment data by ISRC
   */
  public getByIsrc(isrc: string): EnrichmentData | undefined {
    if (!this.mapsInitialized) {
      this.ensureLoaded();
    }
    return this.trackEnrichmentByIsrc.get(isrc);
  }

  /**
   * Get enrichment data by artist + title hash
   */
  public getByArtistTitle(artist: string, title: string): EnrichmentData | undefined {
    if (!this.mapsInitialized) {
      this.ensureLoaded();
    }
    return this.trackEnrichmentByArtistTitleHash.get(this.artistTitleHash(artist, title));
  }

  /**
   * Enrich tracks from external providers using waterfall matching (ISRC -> artist+title).
   * This allows non-Spotify tracks to get year and other enrichment data from the database.
   *
   * @param tracks - Array of tracks with at least { name, artist } properties, optionally with isrc
   * @returns The same tracks with enrichment data added (trueYear, etc.)
   */
  public enrichTracksByArtistTitle<T extends { name: string; artist: string; isrc?: string }>(
    tracks: T[]
  ): (T & { trueYear?: number; enrichedName?: string; enrichedArtist?: string })[] {
    return tracks.map((track) => {
      let enrichmentData: EnrichmentData | undefined = undefined;

      // Priority 1: ISRC match (if available)
      if (track.isrc) {
        enrichmentData = this.getByIsrc(track.isrc);
      }

      // Priority 2: Artist + Title match (fallback)
      if (!enrichmentData) {
        enrichmentData = this.getByArtistTitle(track.artist, track.name);
      }

      if (enrichmentData) {
        return {
          ...track,
          trueYear: enrichmentData.year,
          enrichedName: enrichmentData.name,
          enrichedArtist: enrichmentData.artist,
        };
      }

      return track;
    });
  }

  /**
   * Enrich a single track using waterfall matching (trackId -> ISRC -> artist+title)
   *
   * @param track - Track data with optional id, isrc, name, artist
   * @returns Enrichment data if found, undefined otherwise
   */
  public enrichTrack(track: {
    id?: string;
    isrc?: string;
    name?: string;
    artist?: string;
  }): EnrichmentData | undefined {
    // Priority 1: Exact trackId match
    if (track.id) {
      const byTrackId = this.getByTrackId(track.id);
      if (byTrackId) return byTrackId;
    }

    // Priority 2: ISRC match
    if (track.isrc) {
      const byIsrc = this.getByIsrc(track.isrc);
      if (byIsrc) return byIsrc;
    }

    // Priority 3: Artist + Title match
    if (track.artist && track.name) {
      return this.getByArtistTitle(track.artist, track.name);
    }

    return undefined;
  }

  /**
   * Get the count of enriched tracks by type
   */
  public getStats(): { byTrackId: number; byIsrc: number; byArtistTitle: number } {
    return {
      byTrackId: this.trackEnrichmentByTrackId.size,
      byIsrc: this.trackEnrichmentByIsrc.size,
      byArtistTitle: this.trackEnrichmentByArtistTitleHash.size,
    };
  }
}

export default TrackEnrichment;
