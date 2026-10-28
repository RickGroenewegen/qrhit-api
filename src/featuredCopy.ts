import { color, white } from 'console-log-colors';
import { CronJob } from 'cron';
import cluster from 'cluster';
import { randomBytes } from 'crypto';
import Logger from './logger';
import PrismaInstance from './prisma';
import Spotify from './spotify';
import Cache from './cache';
import Utils from './utils';

/**
 * "Change the songs" on a featured playlist's product page (2026-10-28).
 *
 * A featured playlist is ours, so a visitor cannot change it. When they open
 * the modal, we copy it into our own Spotify account; they save that copy as
 * their own playlist, paste its link back and continue with a playlist they
 * can change and reload like any pasted one. Our copy is only there to be
 * copied: a cron unfollows it COPY_LIFETIME_MS after it was made.
 */

/** How long a copy stays in our account. The modal tells the visitor. */
export const COPY_LIFETIME_MS = 5 * 60 * 1000;

/** Sorted set of the copies still in our account, scored by when they expire. */
export const FEATURED_COPIES_KEY = 'featuredCopies';

// Payment statuses of an order that is still going (as in aiPlaylist.ts).
const ONGOING_PAYMENT_STATUSES = ['open', 'pending', 'authorized', 'paid'];

/**
 * How long a copy in an unfinished order waits before it is looked at again.
 * Only a paid order keeps a copy for good: keeping it for an open payment
 * meant an abandoned checkout (our copy pasted on the playlist step) left it
 * in our account forever.
 */
const ORDER_RECHECK_MS = 15 * 60 * 1000;

const SPOTIFY_TRACK_ID = /track\/([A-Za-z0-9]{22})/;

export interface FeaturedCopy {
  playlistId: string;
  playlistUrl: string;
  /** Epoch ms after which the cleanup unfollows the copy. */
  expiresAt: number;
  /** The same as a duration, for a browser whose clock is not ours. */
  expiresInMs: number;
  /** Songs in the copy. */
  trackCount: number;
  /** Songs of the featured playlist with no Spotify link, left out. */
  missing: number;
}

export type FeaturedCopyResult =
  | { success: true; data: FeaturedCopy }
  | { success: false; reason: 'not_found' | 'no_tracks' | 'spotify'; error: string };

class FeaturedCopies {
  private static instance: FeaturedCopies;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private spotify = Spotify.getInstance();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private cleanupJob: CronJob | null = null;

  private constructor() {}

  public static getInstance(): FeaturedCopies {
    if (!FeaturedCopies.instance) {
      FeaturedCopies.instance = new FeaturedCopies();
      FeaturedCopies.instance.scheduleCleanup();
    }
    return FeaturedCopies.instance;
  }

  /**
   * Every minute, like the AI cleanup only on the cluster primary of the
   * main server (or in dev), so the copies are unfollowed once.
   */
  private scheduleCleanup(): void {
    if (!cluster.isPrimary) return;
    this.utils
      .isMainServer()
      .then((isMain) => {
        const dev = process.env['ENVIRONMENT'] === 'development';
        if (!isMain && !dev) return;
        this.cleanupJob = new CronJob('* * * * *', async () => {
          try {
            await this.cleanupExpired();
          } catch (err) {
            this.logger.log(color.red.bold(`[Featured copy] cleanup crashed: ${err}`));
          }
        });
        this.cleanupJob.start();
        this.logger.log(color.blue.bold('[Featured copy] cleanup cron scheduled, every minute'));
      })
      .catch(() => {});
  }

  /**
   * Copies a featured playlist's songs, in the product page's order, into a
   * new playlist in our account. Each copy gets a name of its own:
   * createOrUpdatePlaylist refills a playlist with the same name instead of
   * making one, so two visitors would otherwise share a copy and the first
   * one's cleanup would take it from the second.
   */
  public async createCopy(slug: string): Promise<FeaturedCopyResult> {
    const playlist = await this.prisma.playlist.findFirst({
      where: { slug, featured: true },
      select: { id: true, name: true },
    });
    if (!playlist) {
      return { success: false, reason: 'not_found', error: 'Not a featured playlist' };
    }

    const rows = await this.prisma.playlistHasTrack.findMany({
      where: { playlistId: playlist.id },
      orderBy: { order: 'asc' },
      select: { track: { select: { spotifyLink: true } } },
    });
    const trackIds: string[] = [];
    const seen = new Set<string>();
    let missing = 0;
    for (const row of rows) {
      const id = row.track?.spotifyLink?.match(SPOTIFY_TRACK_ID)?.[1];
      if (!id) {
        missing += 1;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      trackIds.push(id);
    }
    if (trackIds.length === 0) {
      return { success: false, reason: 'no_tracks', error: 'No songs with a Spotify link' };
    }

    const name = `${this.shortName(playlist.name)} (QRSong! copy ${this.shortId()})`;
    const result = await this.spotify.createOrUpdatePlaylist(name, trackIds, {
      description:
        'Temporary copy from qrsong.io, removed after 5 minutes. Save it as your own playlist: select all songs, Add to playlist, New playlist.',
    });
    if (!result?.success || !result.data?.playlistId) {
      this.logger.log(
        color.yellow.bold(
          `[Featured copy] Spotify refused a copy of ${white.bold(slug)}: ${result?.error || 'unknown'}`
        )
      );
      return { success: false, reason: 'spotify', error: result?.error || 'Spotify refused the copy' };
    }

    const expiresAt = Date.now() + COPY_LIFETIME_MS;
    // A copy the set does not hear about stays in our account for good, so a
    // Redis failure is logged loudly; the visitor still gets their copy.
    try {
      await this.cache.addToSortedSet(FEATURED_COPIES_KEY, expiresAt, result.data.playlistId);
    } catch (err) {
      this.logger.log(
        color.red.bold(
          `[Featured copy] could not schedule the cleanup of ${white.bold(result.data.playlistId)}: ${err}`
        )
      );
    }

    this.logger.log(
      color.green.bold(
        `[Featured copy] copied ${white.bold(slug)} to ${white.bold(result.data.playlistId)} (${white.bold(
          trackIds.length.toString()
        )} songs, ${white.bold(missing.toString())} without Spotify)`
      )
    );

    return {
      success: true,
      data: {
        playlistId: result.data.playlistId,
        playlistUrl: result.data.playlistUrl,
        expiresAt,
        expiresInMs: COPY_LIFETIME_MS,
        trackCount: trackIds.length,
        missing,
      },
    };
  }

  /**
   * Unfollows every copy whose time is up. A copy that went into an order
   * that is still going (pasted on the playlist step instead of the
   * visitor's own) is kept and leaves the set: generating that order reads
   * it. A failed unfollow stays in the set for the next run.
   */
  public async cleanupExpired(): Promise<{
    deleted: number;
    kept: number;
    waiting: number;
    errors: number;
  }> {
    const now = Date.now();
    const due = (await this.cache.getSortedSetWithScores(FEATURED_COPIES_KEY)).filter(
      (entry) => entry.score <= now
    );
    let deleted = 0;
    let kept = 0;
    let waiting = 0;
    let errors = 0;

    for (const { member: spotifyId } of due) {
      try {
        const orders = await this.prisma.paymentHasPlaylist.findMany({
          where: {
            playlist: { playlistId: spotifyId },
            payment: { status: { in: ONGOING_PAYMENT_STATUSES } },
          },
          select: { payment: { select: { status: true } } },
        });
        if (orders.some((order) => order.payment?.status === 'paid')) {
          await this.cache.removeFromSortedSet(FEATURED_COPIES_KEY, spotifyId);
          kept += 1;
          this.logger.log(
            color.yellow.bold(`[Featured copy] kept ${white.bold(spotifyId)}: it is in a paid order`)
          );
          continue;
        }
        if (orders.length > 0) {
          await this.cache.addToSortedSet(FEATURED_COPIES_KEY, now + ORDER_RECHECK_MS, spotifyId);
          waiting += 1;
          this.logger.log(
            color.yellow.bold(
              `[Featured copy] ${white.bold(spotifyId)} is in an unpaid order: looked at again later`
            )
          );
          continue;
        }
        const result = await this.spotify.deletePlaylist(spotifyId);
        if (!result?.success) {
          errors += 1;
          this.logger.log(
            color.yellow.bold(
              `[Featured copy] could not unfollow ${white.bold(spotifyId)}: ${result?.error || 'unknown'}`
            )
          );
          continue;
        }
        await this.cache.removeFromSortedSet(FEATURED_COPIES_KEY, spotifyId);
        deleted += 1;
      } catch (err) {
        errors += 1;
        this.logger.log(color.red.bold(`[Featured copy] error cleaning ${white.bold(spotifyId)}: ${err}`));
      }
    }

    if (due.length > 0) {
      this.logger.log(
        color.blue.bold(
          `[Featured copy] cleanup: deleted=${white.bold(deleted.toString())} kept=${white.bold(
            kept.toString()
          )} waiting=${white.bold(waiting.toString())} errors=${white.bold(errors.toString())}`
        )
      );
    }
    return { deleted, kept, waiting, errors };
  }

  private shortName(name: string): string {
    const clean = String(name || '').replace(/\s+/g, ' ').trim() || 'QRSong! playlist';
    return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
  }

  /** Six lowercase letters and digits, e.g. `k3x9q2`. */
  private shortId(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  }
}

export default FeaturedCopies;
