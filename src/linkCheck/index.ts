import cluster from 'cluster';
import { CronJob } from 'cron';
import { color, white } from 'console-log-colors';
import { Prisma } from '@prisma/client';
import PrismaInstance from '../prisma';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';
import PushoverClient from '../pushover';
import SpotifyApi from '../spotify_api';
import TidalApi from '../tidal_api';
import AppleMusicProvider from '../providers/AppleMusicProvider';
import { CACHE_KEY_FEATURED_PLAYLISTS, CACHE_KEY_PRODUCT_PAGE_LOCALE } from '../data/featuredPlaylists';
import { ProbeContext, axiosHttp, probeLink } from './probes';
import {
  LINK_CHECK_RULES,
  LinkCheckDeps,
  LinkCheckOptions,
  LinkCheckPlaylist,
  LinkCheckReport,
  Strike,
  runLinkCheck,
} from './run';

/**
 * The nightly link check of the featured playlists (Rick, 2026-11-03): is
 * the playlist each one was made from still on its music service? One that
 * is gone (deleted, or private) two nights in a row gets `linkBroken`, which
 * keeps it out of the Channable and Merchant Center feeds, out of the public
 * playlist lists (the featured list, the related rows, the occasion pages,
 * the playlist suggestions) and the sitemap, and makes its product page a
 * 404. It stays featured; the first check that finds it again clears the
 * flag, and so does the reset on the Featured page. The rules are in run.ts,
 * what counts as gone per service in probes.ts.
 *
 * 02:15 Amsterdam time, on the cluster primary of the main server, never in
 * development: well before the 05:00 Channable build, and a dry run by hand
 * is `npm run link-check` (scripts/featured-link-check.ts).
 */

const LOCK = 'featured-link-check';
const LOCK_TTL_SECONDS = 3 * 60 * 60;
const STRIKE_KEY = 'featuredLinkGone:';
const strikeKey = (id: number) => `${STRIKE_KEY}${id}`;

/** What the Featured page shows of the link check, per playlist. */
export interface LinkState {
  linkBroken: boolean;
  linkBrokenAt: Date | null;
  linkCheckedAt: Date | null;
}
const CHECKED_CHUNK = 500;
/** The cached public lists that read linkBroken; the playlist list is the first. */
const LIST_CACHE_PATTERNS = [
  `${CACHE_KEY_FEATURED_PLAYLISTS}*`,
  'occasion_v1_*',
  'occasions_list_v1_*',
  'seasonal_v1_*',
];

class FeaturedLinkCheck {
  private static instance: FeaturedLinkCheck;
  private prisma = PrismaInstance.getInstance();
  private cache = Cache.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private pushover = new PushoverClient();

  private constructor() {
    if (cluster.isPrimary && process.env['ENVIRONMENT'] !== 'development') {
      this.utils
        .isMainServer()
        .then((isMainServer) => {
          if (!isMainServer) return;
          new CronJob(
            '15 2 * * *',
            async () => {
              try {
                await this.run({ dryRun: false });
              } catch (error: any) {
                this.logger.log(
                  color.red.bold('[') +
                    white.bold('link-check') +
                    color.red.bold(`] The nightly check failed, nothing more changed: ${error?.message || error}`)
                );
              }
            },
            null,
            true,
            'Europe/Amsterdam'
          );
          this.logger.log(
            color.blue.bold('[') +
              white.bold('link-check') +
              color.blue.bold('] Featured link check scheduled at ') +
              white.bold('02:15')
          );
        })
        .catch(() => {});
    }
  }

  public static getInstance(): FeaturedLinkCheck {
    if (!FeaturedLinkCheck.instance) {
      FeaturedLinkCheck.instance = new FeaturedLinkCheck();
    }
    return FeaturedLinkCheck.instance;
  }

  /**
   * One run. A run that writes holds a lock, so the cron and a run by hand
   * never overlap; null when another one is going. A dry run takes no lock:
   * it writes nothing.
   */
  public async run(options: LinkCheckOptions): Promise<LinkCheckReport | null> {
    if (!options.dryRun) {
      const locked = await this.cache.acquireLock(LOCK, LOCK_TTL_SECONDS);
      if (!locked) {
        this.logger.log(
          color.yellow.bold('[') +
            white.bold('link-check') +
            color.yellow.bold('] Another check is running, this one is skipped')
        );
        return null;
      }
    }
    try {
      return await runLinkCheck(this.deps(), options);
    } finally {
      if (!options.dryRun) await this.cache.releaseLock(LOCK).catch(() => {});
    }
  }

  /**
   * The Featured page's undo (Rick, 2026-11-03): clears `linkBroken` and the
   * playlist's strike, so it needs two new nights of "gone" before the check
   * marks it again. Raw SQL, so `updatedAt` (the sitemap's lastmod) stays.
   * When it was broken, the product page, lists, sitemap and feed get it back
   * as on a recovery (the feed rebuild is not waited for). Null for an
   * unknown playlist.
   *
   * @param playlistId the playlist's service id (`playlists.playlistId`), as
   *   the other /admin/featured/:playlistId routes take it
   */
  public async resetLinkBroken(playlistId: string): Promise<LinkState | null> {
    const playlist = await this.prisma.playlist.findUnique({
      where: { playlistId },
      select: { id: true, playlistId: true, slug: true, linkBroken: true },
    });
    if (!playlist) return null;

    await this.prisma.$executeRaw`UPDATE playlists SET linkBroken = 0, linkBrokenAt = NULL, markedForMerchantCenter = 1 WHERE id = ${playlist.id}`;
    await this.cache.del(strikeKey(playlist.id));
    this.logger.log(
      color.blue.bold('[') +
        white.bold('link-check') +
        color.blue.bold('] Reset by an admin: ') +
        white.bold(playlist.slug || playlist.playlistId) +
        color.blue.bold(playlist.linkBroken ? ', back in the feeds and lists' : ', its strike cleared')
    );
    if (playlist.linkBroken) {
      await this.afterFlagChange([{ playlistId: playlist.playlistId, slug: playlist.slug }], {
        waitForFeed: false,
      });
    }

    const state = await this.prisma.playlist.findUnique({
      where: { id: playlist.id },
      select: { linkBroken: true, linkBrokenAt: true, linkCheckedAt: true },
    });
    return state ?? { linkBroken: false, linkBrokenAt: null, linkCheckedAt: null };
  }

  /**
   * After a flag changed (marked, recovered, reset): the product page answer
   * and the by-slug playlist caches of those playlists, the cached lists, the
   * sitemap and the Channable feed. Data is loaded here and not at the top: a
   * dry run must not start it (in development it writes the sitemap and
   * fills Redis when it starts).
   */
  private async afterFlagChange(
    changed: { playlistId: string; slug: string }[],
    options: { waitForFeed: boolean }
  ): Promise<void> {
    const { default: Data } = await import('../data');
    const data = Data.getInstance();
    for (const playlist of changed) {
      if (playlist.slug) {
        await this.cache.del(`${CACHE_KEY_PRODUCT_PAGE_LOCALE}${playlist.slug}`).catch(() => {});
      }
      // The playlist by id and by slug; its tracks are still right.
      await data.clearPlaylistCache(playlist.playlistId, undefined, { tracks: false });
    }
    for (const pattern of LIST_CACHE_PATTERNS) {
      await this.cache.delPattern(pattern).catch(() => {});
    }
    try {
      await data.createSiteMap();
    } catch (error: any) {
      this.warn(`Sitemap rebuild failed: ${error?.message || error}`);
    }
    // The feed is otherwise rebuilt at 05:00; a change by hand should not
    // leave a broken playlist in it (or a reset one out) until then.
    const feed = this.rebuildFeed();
    if (options.waitForFeed) await feed;
  }

  private async rebuildFeed(): Promise<void> {
    try {
      const { channable } = await import('../channable');
      await channable.generateFeed();
    } catch (error: any) {
      this.warn(`Channable feed rebuild failed, the 05:00 build will catch up: ${error?.message || error}`);
    }
  }

  private warn(message: string): void {
    this.logger.log(color.yellow.bold('[') + white.bold('link-check') + color.yellow.bold(`] ${message}`));
  }

  private probeContext(): ProbeContext {
    const spotifyApi = new SpotifyApi();
    const apple = AppleMusicProvider.getInstance();
    const scraperUrl = process.env['SPOTIFY_SCRAPER_URL'];
    return {
      http: axiosHttp,
      tokens: {
        spotify: () => spotifyApi.getAccessToken(),
        apple: () => apple.getDeveloperToken(),
        tidal: () => TidalApi.getInstance().getAccessToken(),
      },
      scraper: scraperUrl ? { url: scraperUrl, apiKey: process.env['SPOTIFY_SCRAPER_API_KEY'] || '' } : null,
      // The list's own market first, then where the product page asks by
      // default (nl) and the biggest catalogue (us).
      appleStorefronts: (featuredLocale) => {
        const locales = (featuredLocale || '')
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean);
        const storefronts = [...locales.map((l) => apple.getStorefrontForLocale(l)), 'nl', 'us'];
        return [...new Set(storefronts)].slice(0, 4);
      },
    };
  }

  private deps(): LinkCheckDeps {
    const ctx = this.probeContext();
    return {
      loadPlaylists: async (): Promise<LinkCheckPlaylist[]> => {
        const rows = await this.prisma.playlist.findMany({
          where: { featured: true, slug: { not: '' } },
          select: {
            id: true,
            playlistId: true,
            serviceType: true,
            slug: true,
            name: true,
            promotionalTitle: true,
            featuredLocale: true,
            linkBroken: true,
          },
          orderBy: { id: 'asc' },
        });
        return rows.map((row) => ({
          id: row.id,
          playlistId: row.playlistId,
          serviceType: row.serviceType || 'spotify',
          slug: row.slug,
          name: row.promotionalTitle || row.name,
          featuredLocale: row.featuredLocale,
          linkBroken: row.linkBroken,
        }));
      },
      probe: (playlist, options) => probeLink(playlist, ctx, options),
      strikes: {
        get: async (id) => {
          const raw = await this.cache.get(strikeKey(id), false);
          if (!raw) return null;
          try {
            return JSON.parse(raw) as Strike;
          } catch {
            return null;
          }
        },
        set: (id, strike) =>
          this.cache.set(strikeKey(id), JSON.stringify(strike), LINK_CHECK_RULES.strikeTtlSeconds),
        clear: (id) => this.cache.del(strikeKey(id)),
      },
      // markedForMerchantCenter: the next Merchant Center push takes a broken
      // playlist's products down and puts a recovered one's back.
      markBroken: async (ids, at) => {
        await this.prisma.playlist.updateMany({
          where: { id: { in: ids } },
          data: { linkBroken: true, linkBrokenAt: at, markedForMerchantCenter: true },
        });
      },
      clearBroken: async (ids) => {
        await this.prisma.playlist.updateMany({
          where: { id: { in: ids } },
          data: { linkBroken: false, linkBrokenAt: null, markedForMerchantCenter: true },
        });
      },
      // Raw SQL: Prisma would move updatedAt, the sitemap's lastmod, on every
      // featured playlist every night.
      markChecked: async (ids, at) => {
        for (let i = 0; i < ids.length; i += CHECKED_CHUNK) {
          const chunk = ids.slice(i, i + CHECKED_CHUNK);
          await this.prisma.$executeRaw`UPDATE playlists SET linkCheckedAt = ${at} WHERE id IN (${Prisma.join(chunk)})`;
        }
      },
      afterFlagChange: (changed) => this.afterFlagChange(changed, { waitForFeed: true }),
      notify: (notice) => this.pushover.sendMessage({ title: notice.title, message: notice.message }, '', true),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log: (line) => this.logger.log(line),
    };
  }
}

export default FeaturedLinkCheck;
