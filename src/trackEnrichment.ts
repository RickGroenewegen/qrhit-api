import { PrismaClient } from '@prisma/client';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import { CronJob } from 'cron';
import Logger from './logger';
import Utils from './utils';

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

  private constructor() {
    this.prisma = new PrismaClient();
    this.logger = new Logger();
    this.utils = new Utils();

    // Load enrichment maps on startup
    this.loadTrackEnrichmentMaps();

    // Set up hourly refresh cron job
    const enrichmentRefreshJob = new CronJob('0 * * * *', async () => {
      await this.refreshTrackEnrichmentMaps();
    });
    enrichmentRefreshJob.start();
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

  /**
   * Load track enrichment maps from database
   */
  private async loadTrackEnrichmentMaps(): Promise<void> {
    const isPrimary = cluster.isPrimary;

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
        if (!track.year || !track.name || !track.artist) {
          continue; // Skip tracks without required data
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
        const artistTitleKey = `${track.artist.toLowerCase().trim()}|||${track.name.toLowerCase().trim()}`;
        const hash = this.createSimpleHash(artistTitleKey);
        this.trackEnrichmentByArtistTitleHash.set(hash, enrichmentData);
      }

      if (isPrimary) {
        this.utils.isMainServer().then(async (isMainServer) => {
          if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
            this.logger.log(
              color.green.bold(
                `[TrackEnrichment] Maps loaded: ${color.white.bold(
                  this.trackEnrichmentByTrackId.size
                )} by trackId, ${color.white.bold(
                  this.trackEnrichmentByIsrc.size
                )} by ISRC, ${color.white.bold(
                  this.trackEnrichmentByArtistTitleHash.size
                )} by artist+title`
              )
            );
          }
        });
      }
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`[TrackEnrichment] Failed to load maps: ${e.message || e}`)
      );
    }
  }

  /**
   * Refresh track enrichment maps
   */
  public async refreshTrackEnrichmentMaps(): Promise<void> {
    this.logger.log(color.blue.bold('[TrackEnrichment] Refreshing maps...'));
    await this.loadTrackEnrichmentMaps();
  }

  /**
   * Get enrichment data by Spotify trackId
   */
  public getByTrackId(trackId: string): EnrichmentData | undefined {
    return this.trackEnrichmentByTrackId.get(trackId);
  }

  /**
   * Get enrichment data by ISRC
   */
  public getByIsrc(isrc: string): EnrichmentData | undefined {
    return this.trackEnrichmentByIsrc.get(isrc);
  }

  /**
   * Get enrichment data by artist + title hash
   */
  public getByArtistTitle(artist: string, title: string): EnrichmentData | undefined {
    const artistTitleKey = `${artist.toLowerCase().trim()}|||${title.toLowerCase().trim()}`;
    const hash = this.createSimpleHash(artistTitleKey);
    return this.trackEnrichmentByArtistTitleHash.get(hash);
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
