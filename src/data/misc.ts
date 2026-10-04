import { color } from 'console-log-colors';
import { promises as fs } from 'fs';
import path from 'path';
import * as ExcelJS from 'exceljs';
import Translation from '../translation';
import Blog from '../blog';
import { Prisma, genre as GenrePrismaModel } from '@prisma/client';
import {
  CACHE_KEY_PLAYLIST,
  CACHE_KEY_PLAYLIST_DB,
  CACHE_KEY_TRACKS,
  CACHE_KEY_TRACK_COUNT,
} from '../spotify';
import { CACHE_KEY_FEATURED_PLAYLISTS } from './featuredPlaylists';
import { LOCALE_PRIMARY_COUNTRY, occasionSlug } from './giftOccasions';
import { isProductPageIndexable } from './productPageLocales';
import { DataDeps } from './types';

export async function getPDFFilepath(
  deps: DataDeps,
  clientIp: string,
  paymentId: string,
  userHash: string,
  playlistId: string,
  type: string
): Promise<{ fileName: string; filePath: string } | null> {
  if (type == 'printer' && !deps.utils.isTrustedIp(clientIp)) {
    return null;
  }

  const cacheKey = `pdfFilePath:${paymentId}:${playlistId}:${type}`;
  const cachedFilePath = await deps.cache.get(cacheKey);

  if (cachedFilePath) {
    return JSON.parse(cachedFilePath);
  }

  const result: any[] = await deps.prisma.$queryRaw`
    SELECT
      php.filename,
      php.filenameDigital,
      php.filenameDigitalDoubleSided,
      pl.name
    FROM
      payment_has_playlist php
    INNER JOIN
      payments pm ON php.paymentId = pm.id
    INNER JOIN
      playlists pl ON php.playlistId = pl.id
    INNER JOIN
      users u ON pm.userid = u.id
    WHERE
      pm.paymentId = ${paymentId}
    AND
      pl.playlistId = ${playlistId}
    AND
      u.hash = ${userHash}
    AND
      pm.status = 'paid'
  `;

  if (result.length === 0) {
    return null;
  }

  const paymentHasPlaylist = result[0];
  let filename = '';
  let sanitizedFileName = deps.utils.generateFilename(
    paymentHasPlaylist.name
  );

  if (type == 'printer') {
    filename = paymentHasPlaylist.filename!;
    sanitizedFileName = `printer_${sanitizedFileName}`;
  } else {
    filename = paymentHasPlaylist.filenameDigital!;
  }

  const filePath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
  const finalResult = {
    fileName: sanitizedFileName + '.pdf',
    filePath: filePath,
  };
  await deps.cache.set(cacheKey, JSON.stringify(finalResult));
  return finalResult;
}

export async function getLastPlays(deps: DataDeps): Promise<any[]> {
  const ipInfoListKey = 'ipInfoList';
  const ipInfoList = await deps.cache.executeCommand(
    'lrange',
    ipInfoListKey,
    0,
    -1
  );

  const trackIds = ipInfoList
    .map((ipInfoJson: any) => {
      const ipInfo = JSON.parse(ipInfoJson);
      return parseInt(ipInfo.trackId);
    })
    .filter((trackId: number) => !isNaN(trackId));

  const phpIds = ipInfoList
    .map((ipInfoJson: any) => {
      const ipInfo = JSON.parse(ipInfoJson);
      return ipInfo.php ? parseInt(ipInfo.php) : null;
    })
    .filter((phpId: number | null) => phpId !== null);

  // Fetch tracks
  const tracks = await deps.prisma.track.findMany({
    where: { id: { in: trackIds } },
    select: { id: true, name: true, artist: true, trackId: true },
  });

  // Fetch payment_has_playlist data with playlist names and user display names in a single query
  const phpData =
    phpIds.length > 0
      ? await deps.prisma.paymentHasPlaylist.findMany({
          where: { id: { in: phpIds } },
          select: {
            id: true,
            playlist: {
              select: {
                id: true,
                name: true,
                image: true,
                customImage: true,
              },
            },
            payment: {
              select: {
                user: {
                  select: {
                    displayName: true,
                  },
                },
              },
            },
          },
        })
      : [];

  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const phpMap = new Map(phpData.map((php) => [php.id, php]));

  const lastPlays = ipInfoList
    .map((ipInfoJson: any) => {
      const ipInfo = JSON.parse(ipInfoJson);
      const track = trackMap.get(parseInt(ipInfo.trackId));

      if (track) {
        const result: any = {
          title: track.name,
          artist: track.artist,
          city: ipInfo.city,
          region: ipInfo.region,
          country: ipInfo.country_code,
          latitude: ipInfo.latitude,
          longitude: ipInfo.longitude,
          timestamp: ipInfo.timestamp,
          trackId: track.trackId,
        };

        // Add playlist and user info if php is available
        if (ipInfo.php) {
          const phpInfo = phpMap.get(parseInt(ipInfo.php));
          if (phpInfo) {
            result.php = phpInfo.id;
            result.playlistId = phpInfo.playlist.id;
            result.playlistName = phpInfo.playlist.name;
            result.playlistImage = phpInfo.playlist.image || null;
            result.playlistCustomImage = phpInfo.playlist.customImage || null;
            result.displayName = phpInfo.payment.user?.displayName || null;
          }
        }

        return result;
      }
    })
    .filter(Boolean);

  return lastPlays;
}

export interface PlayRankingRow {
  /** Equal plays share a rank. */
  rank: number;
  php: number;
  plays: number;
  /** False when the order line has been deleted since it was played. */
  found: boolean;
  playlistId: number | null;
  playlistName: string | null;
  playlistImage: string | null;
  playlistCustomImage: string | null;
  type: string | null;
  numberOfTracks: number | null;
  orderId: string | null;
  customerName: string | null;
  business: boolean;
  orderedAt: Date | null;
}

export interface PlayRankingWindow {
  plays: number;
  orders: number;
  top: PlayRankingRow[];
}

export interface PlaylistPlayRanking {
  group: 'order';
  since: string | null;
  day: PlayRankingWindow;
  week: PlayRankingWindow;
  total: PlayRankingWindow;
}

/** One playlist in the per-playlist ranking: all its order lines added up. */
export interface PlaylistRankingRow {
  /** Equal plays share a rank. */
  rank: number;
  playlistId: number;
  plays: number;
  /** Order lines of this playlist played in the window. */
  orders: number;
  found: boolean;
  playlistName: string | null;
  playlistImage: string | null;
  playlistCustomImage: string | null;
}

export interface PlaylistRankingWindow {
  plays: number;
  orders: number;
  playlists: number;
  top: PlaylistRankingRow[];
}

export interface PlaylistPlayRankingPerPlaylist {
  group: 'playlist';
  since: string | null;
  day: PlaylistRankingWindow;
  week: PlaylistRankingWindow;
  total: PlaylistRankingWindow;
}

export type PlayRankingGroup = 'order' | 'playlist';

const PLAYLIST_RANKING_LIMIT = 50;
// Order lines per `IN (...)` when every played line's playlist is looked up.
const PHP_LOOKUP_CHUNK = 5000;

/** Competition ranking over rows sorted by plays: equal plays share a rank. */
function withRanks<T extends { plays: number }>(rows: T[]): (T & { rank: number })[] {
  let rank = 0;
  return rows.map((row, index) => {
    if (index === 0 || rows[index - 1].plays !== row.plays) {
      rank = index + 1;
    }
    return { ...row, rank };
  });
}

/**
 * The play rankings of the admin Analytics page. Per order line by default,
 * so the same playlist bought by two customers is two rows; per playlist adds
 * those order lines up. The counts live in the analytics Redis database
 * (AnalyticsClient), per order line only; the rest is read here.
 */
export async function getPlaylistPlayRanking(
  deps: DataDeps,
  group: PlayRankingGroup = 'order'
): Promise<PlaylistPlayRanking | PlaylistPlayRankingPerPlaylist> {
  if (group === 'playlist') {
    return getPlayRankingPerPlaylist(deps);
  }
  const ranking = await deps.analytics.getPlaylistPlayRanking();
  const windows = [ranking.day, ranking.week, ranking.total];
  const phpIds = [
    ...new Set(windows.flatMap((w) => w.top.map((entry) => entry.php))),
  ];

  const lines =
    phpIds.length > 0
      ? await deps.prisma.paymentHasPlaylist.findMany({
          where: { id: { in: phpIds } },
          select: {
            id: true,
            type: true,
            numberOfTracks: true,
            playlist: {
              select: { id: true, name: true, image: true, customImage: true },
            },
            payment: {
              select: {
                orderId: true,
                paymentId: true,
                fullname: true,
                vibe: true,
                createdAt: true,
              },
            },
          },
        })
      : [];
  const byId = new Map(lines.map((line) => [line.id, line]));

  const toWindow = (window: (typeof windows)[number]): PlayRankingWindow => {
    const top = withRanks(window.top).map((entry) => {
      const line = byId.get(entry.php);
      return {
        rank: entry.rank,
        php: entry.php,
        plays: entry.plays,
        found: !!line,
        playlistId: line?.playlist.id ?? null,
        playlistName: line?.playlist.name ?? null,
        playlistImage: line?.playlist.image || null,
        playlistCustomImage: line?.playlist.customImage || null,
        type: line?.type ?? null,
        numberOfTracks: line?.numberOfTracks ?? null,
        orderId: line ? line.payment.orderId || line.payment.paymentId : null,
        customerName: line?.payment.fullname || null,
        business: !!line?.payment.vibe,
        orderedAt: line?.payment.createdAt ?? null,
      };
    });
    return { plays: window.plays, orders: window.orders, top };
  };

  return {
    group: 'order',
    since: ranking.since,
    day: toWindow(ranking.day),
    week: toWindow(ranking.week),
    total: toWindow(ranking.total),
  };
}

/**
 * Adds every order line's plays up by playlist. Redis only knows order lines,
 * so this needs the playlist of every line played in a window, not only of
 * the top: one lookup for all of them.
 */
async function getPlayRankingPerPlaylist(
  deps: DataDeps
): Promise<PlaylistPlayRankingPerPlaylist> {
  const counts = await deps.analytics.getPlayCounts();
  const phpIds = [
    ...new Set([...counts.total.keys(), ...counts.week.keys(), ...counts.day.keys()]),
  ];
  const playlistOf = new Map<number, number>();
  for (let i = 0; i < phpIds.length; i += PHP_LOOKUP_CHUNK) {
    const lines = await deps.prisma.paymentHasPlaylist.findMany({
      where: { id: { in: phpIds.slice(i, i + PHP_LOOKUP_CHUNK) } },
      select: { id: true, playlistId: true },
    });
    for (const line of lines) {
      playlistOf.set(line.id, line.playlistId);
    }
  }

  const sumWindow = (window: Map<number, number>) => {
    let plays = 0;
    let orders = 0;
    const perPlaylist = new Map<number, { plays: number; orders: number }>();
    for (const [php, count] of window) {
      if (count <= 0) continue;
      plays += count;
      orders++;
      // A line deleted since it was played still counts in the window's
      // plays, but has no playlist to add them to.
      const playlistId = playlistOf.get(php);
      if (playlistId === undefined) continue;
      const entry = perPlaylist.get(playlistId) ?? { plays: 0, orders: 0 };
      entry.plays += count;
      entry.orders++;
      perPlaylist.set(playlistId, entry);
    }
    const top = [...perPlaylist.entries()]
      .map(([playlistId, entry]) => ({ playlistId, ...entry }))
      .sort((a, b) => b.plays - a.plays || a.playlistId - b.playlistId)
      .slice(0, PLAYLIST_RANKING_LIMIT);
    return { plays, orders, playlists: perPlaylist.size, top };
  };
  const day = sumWindow(counts.day);
  const week = sumWindow(counts.week);
  const total = sumWindow(counts.total);

  const playlistIds = [
    ...new Set([day, week, total].flatMap((w) => w.top.map((entry) => entry.playlistId))),
  ];
  const playlists =
    playlistIds.length > 0
      ? await deps.prisma.playlist.findMany({
          where: { id: { in: playlistIds } },
          select: { id: true, name: true, image: true, customImage: true },
        })
      : [];
  const byId = new Map(playlists.map((playlist) => [playlist.id, playlist]));

  const toWindow = (window: typeof day): PlaylistRankingWindow => ({
    plays: window.plays,
    orders: window.orders,
    playlists: window.playlists,
    top: withRanks(window.top).map((entry) => {
      const playlist = byId.get(entry.playlistId);
      return {
        rank: entry.rank,
        playlistId: entry.playlistId,
        plays: entry.plays,
        orders: entry.orders,
        found: !!playlist,
        playlistName: playlist?.name ?? null,
        playlistImage: playlist?.image || null,
        playlistCustomImage: playlist?.customImage || null,
      };
    }),
  });

  return {
    group: 'playlist',
    since: counts.since,
    day: toWindow(day),
    week: toWindow(week),
    total: toWindow(total),
  };
}

export async function translateGenres(deps: DataDeps): Promise<{
  processed: number;
  updated: number;
  errors: number;
}> {
  deps.logger.log(color.blue.bold('Starting genre translation process...'));
  const allLocales = new Translation().allLocales;
  const genres = await deps.prisma.genre.findMany();

  let processedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  for (const genre of genres) {
    processedCount++;
    if (!genre.name_en || genre.name_en.trim() === '') {
      deps.logger.log(
        color.yellow.bold(
          `Skipping genre ID ${genre.id} (${color.white.bold(
            genre.slug || 'no-slug'
          )}) as English name (name_en) is missing.`
        )
      );
      continue;
    }

    const localesToTranslate: string[] = [];
    const updateData: Prisma.genreUpdateInput = {};

    for (const locale of allLocales) {
      if (locale === 'en') continue; // Skip English itself

      const localeFieldName = `name_${locale}` as keyof GenrePrismaModel;
      // Check if the property exists on the genre object and if it's null or empty
      if (
        !(localeFieldName in genre) || // Property might not exist if schema changed
        (genre as any)[localeFieldName] === null ||
        ((genre as any)[localeFieldName] as string)?.trim() === ''
      ) {
        localesToTranslate.push(locale);
      }
    }

    if (localesToTranslate.length > 0) {
      deps.logger.log(
        color.blue.bold(
          `Genre ID ${color.white.bold(genre.id)} ("${color.white.bold(
            genre.name_en
          )}") needs translation for: ${color.white.bold(
            localesToTranslate.join(', ')
          )}`
        )
      );
      try {
        const translations = await deps.openai.translateGenreNames(
          genre.name_en,
          localesToTranslate
        );

        let translationsFound = false;
        for (const locale of localesToTranslate) {
          if (translations[locale] && translations[locale].trim() !== '') {
            const localeFieldName =
              `name_${locale}` as keyof Prisma.genreUpdateInput;
            (updateData as any)[localeFieldName] = translations[locale];
            translationsFound = true;
          } else {
            deps.logger.log(
              color.yellow.bold(
                `No valid translation received for genre ID ${color.white.bold(
                  genre.id
                )} ("${color.white.bold(
                  genre.name_en
                )}") in locale ${color.white.bold(locale)}.`
              )
            );
          }
        }

        if (translationsFound) {
          await deps.prisma.genre.update({
            where: { id: genre.id },
            data: updateData,
          });
          updatedCount++;
          deps.logger.log(
            color.blue.bold(
              `Successfully updated translations for genre ID ${color.white.bold(
                genre.id
              )} ("${color.white.bold(genre.name_en)}").`
            )
          );
        }
      } catch (error) {
        errorCount++;
        deps.logger.log(
          color.red.bold(
            `Error translating genre ID ${color.white.bold(
              genre.id
            )} ("${color.white.bold(genre.name_en)}"): ${
              (error as Error).message
            }`
          )
        );
        console.error(error);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      deps.logger.log(
        color.blue.bold(
          `Genre ID ${color.white.bold(genre.id)} ("${color.white.bold(
            genre.name_en
          )}") is already fully translated.`
        )
      );
    }
  }

  deps.logger.log(
    color.blue.bold(
      `Genre translation process finished. Processed: ${processedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`
    )
  );
  return {
    processed: processedCount,
    updated: updatedCount,
    errors: errorCount,
  };
}

/**
 * True for a product slug that carries no meaning as a URL.
 *
 * Playlist slugs come from customer-supplied playlist names, so a name made of
 * emoji, CJK or punctuation slugifies to nothing and the row ends up with a
 * bare counter. Those were being submitted in every locale's sitemap
 * (`/en/product/-2`, `/en/product/-3`, `/en/product/qr`, ...), asking Google
 * to crawl pages whose URL says nothing about them.
 *
 * Deliberately conservative: this drops counters and dash-only strings, not
 * short names. `pur`, `am` and `jk` are plausible band or album names, and
 * `1955-2026` is a decade playlist — excluding real products from the sitemap
 * would be a worse error than leaving a few ugly URLs in it. Nothing is
 * renamed either; these URLs stay reachable, they just stop being advertised.
 */
export function isDegenerateProductSlug(slug: string): boolean {
  if (!slug) return true;
  const stripped = slug.replace(/-/g, '');
  // Nothing but dashes, or nothing but a uniqueness counter.
  if (stripped === '') return true;
  if (/^\d{1,3}$/.test(stripped) && /^-/.test(slug)) return true;
  // A single character either side of the dashes says nothing.
  return stripped.length < 2;
}

export async function createSiteMap(
  deps: DataDeps
): Promise<{ locales: number; urls: number }> {
  // Get all available locales from Translation class
  const locales = deps.translate.allLocales;

  // Get featured playlists with non-empty slugs. A promotional submission
  // that has not been approved yet is not a product page anyone should be
  // sent to, so it waits for the approval (which rebuilds the sitemap).
  const featuredPlaylists = await deps.prisma.playlist.findMany({
    where: {
      featured: true,
      slug: {
        not: '',
      },
      OR: [{ promotionalActive: false }, { promotionalAccepted: true }],
    },
    select: {
      slug: true,
      updatedAt: true,
      featuredLocale: true,
    },
  });

  // Blog posts now come from the markdown store rather than the `blogs` table,
  // so the sitemap reflects what is actually on disk and shipped with the
  // deploy. Entries are per locale because a post only exists in the locales it
  // has been translated into: `growth blog gaps` reports which are missing, and
  // submitting a URL for a post that has no body in that locale would be a 404
  // in the sitemap.
  const blogEntriesByLocale = new Map<
    string,
    { slug: string; lastmod: string }[]
  >();
  for (const locale of locales) {
    blogEntriesByLocale.set(locale, await Blog.getInstance().getSitemapEntries(locale));
  }

  // Occasion landing pages: all base events + which countries each applies to
  // (a locale gets a page when its primary market has the occasion).
  const eventBases = await deps.prisma.eventBase.findMany();
  const eventCountryRows = await deps.prisma.calendarEvent.findMany({
    where: { baseEventId: { not: null } },
    select: { baseEventId: true, country: true },
    distinct: ['baseEventId', 'country'],
  });
  const countriesByBase = new Map<number, Set<string>>();
  for (const row of eventCountryRows) {
    if (row.baseEventId == null) continue;
    const set = countriesByBase.get(row.baseEventId) || new Set<string>();
    set.add(row.country);
    countriesByBase.set(row.baseEventId, set);
  }

  // Define standard paths with default values
  // Destinations only. `/reviews`, `/examples` and `/onzevibe` used to be
  // listed here, but all three redirect (302, 302 and 301), so every locale
  // submitted three URLs that are not the page — 36 of them — while the real
  // destinations appeared in no sitemap at all. `/en/reviews` even canonicals
  // to `/en/user/reviews`, contradicting its own sitemap entry.
  const standardPaths = [
    '/faq',
    '/pricing',
    '/user/reviews',
    '/blog',
    '/giftcard',
    '/gift-box',
    '/app-designer',
    '/music-match',
    '/music-bingo',
    '/music-quiz',
    '/music-timeline',
    '/user/examples',
    '/download-app',
    // '/generate/playlist' removed: it is the first step of checkout, is in
    // PRIVATE_PATH_PREFIXES and now serves X-Robots-Tag: noindex. Submitting
    // it for indexing contradicted that (it had ~450 impressions across
    // locales, ranking a checkout step instead of a landing page).
    '/contact',
    '/privacy-policy',
    '/terms-and-conditions',
    '/playlists',
    '/business',
    '/corporate-gifts',
    '/qr-cards-as-a-service',
    '/pubquiz',
    '/shipping-info',
    '/earn-discount',
    '/supported-platforms',
    '/hitster-alternative',
    '/make-hitster-cards',
    '/compare',
    '/hitster-without-spotify',
    '/qr-code-for-a-song'
  ];

  // Get current date in YYYY-MM-DD format for lastmod
  const currentDate = new Date().toISOString().split('T')[0];

  // Create sitemap index file that references language-specific sitemaps
  const sitemapIndexContent = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${locales
    .map(
      (locale) => `
  <sitemap>
    <loc>${process.env['FRONTEND_URI']}/sitemap_${locale}.xml</loc>
    <lastmod>${currentDate}</lastmod>
  </sitemap>`
    )
    .join('')}
</sitemapindex>`;

  const sitemapIndexPath = path.join(
    process.env['FRONTEND_ROOT']!,
    '/sitemap.xml'
  );

  await fs.writeFile(sitemapIndexPath, sitemapIndexContent, 'utf8');

  // Create language-specific sitemaps
  let totalUrls = 0;
  for (const locale of locales) {
    // Create paths with default properties for this locale
    const paths = [
      // Homepage has special properties
      {
        loc: `/${locale}`,
        lastmod: currentDate,
        changefreq: 'daily',
        priority: '1.0',
      },
      // Standard pages with common properties
      ...standardPaths.map((pagePath) => ({
        loc: `/${locale}${pagePath}`,
        lastmod: currentDate,
        changefreq: 'monthly',
        priority: '0.8',
      })),
      // Add product pages for featured playlists.
      //
      // Priority sits below the marketing pages (0.8) on purpose. These are
      // ~600 templated pages per locale and make up about 94% of the sitemap,
      // so ranking them above the pages we actually want found pointed crawl
      // budget at the least differentiated part of the site. `changefreq` is
      // weekly rather than daily for the same reason: a featured playlist's
      // content does not change daily, and claiming it does costs credibility
      // without buying anything. (Google ignores both hints, but Bing and
      // others still read them.)
      //
      // A playlist aimed at specific markets ("de", or "de,nl") is listed
      // in those locales' sitemaps and always in the English one; its page
      // renders in the other locales too but goes out noindex there. See
      // productPageLocales.ts.
      ...featuredPlaylists
        .filter((playlist) => !isDegenerateProductSlug(playlist.slug || ''))
        .filter((playlist) =>
          isProductPageIndexable(playlist.featuredLocale, locale, locales)
        )
        .map((playlist) => ({
          loc: `/${locale}/product/${playlist.slug}`,
          lastmod: playlist.updatedAt.toISOString().split('T')[0],
          changefreq: 'weekly',
          priority: '0.7',
        })),
      // Add blog pages for this locale
      ...(blogEntriesByLocale.get(locale) ?? []).map((entry) => ({
        loc: `/${locale}/blog/${entry.slug}`,
        lastmod: entry.lastmod,
        changefreq: 'weekly',
        priority: '0.7',
      })),
      // Add occasion landing pages applicable to this locale's primary market
      ...eventBases
        .filter((eb) =>
          countriesByBase.get(eb.id)?.has(LOCALE_PRIMARY_COUNTRY[locale] || '')
        )
        .map((eb) => ({
          loc: `/${locale}/occasion/${occasionSlug(eb, locale)}`,
          lastmod: eb.updatedAt.toISOString().split('T')[0],
          changefreq: 'weekly',
          priority: '0.7',
        })),
    ];

    const localeSitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${paths
    .map(
      (path) => `
  <url>
    <loc>${process.env['FRONTEND_URI']}${path.loc}</loc>
    <lastmod>${path.lastmod}</lastmod>
    <changefreq>${path.changefreq}</changefreq>
    <priority>${path.priority}</priority>
  </url>`
    )
    .join('')}
</urlset>`;

    const localeSitemapPath = path.join(
      process.env['FRONTEND_ROOT']!,
      `/sitemap_${locale}.xml`
    );

    await fs.writeFile(localeSitemapPath, localeSitemapContent, 'utf8');
    totalUrls += paths.length;
  }

  deps.logger.log(
    color.blue.bold(
      `Generated sitemap index with ${color.white.bold(
        locales.length
      )} language-specific sitemaps (${color.white.bold(totalUrls)} URLs)`
    )
  );

  return { locales: locales.length, urls: totalUrls };
}

export async function generatePlaylistExcel(
  deps: DataDeps,
  paymentId: string,
  paymentHasPlaylistId: number
): Promise<Buffer | null> {
  try {
    // Fetch the payment with its playlists and tracks
    const paymentHasPlaylist = await deps.prisma.paymentHasPlaylist.findFirst(
      {
        where: {
          id: paymentHasPlaylistId,
          payment: {
            paymentId: paymentId,
          },
        },
      }
    );

    if (!paymentHasPlaylist) {
      deps.logger.log(
        `PaymentHasPlaylist not found for payment ${paymentId} and id ${paymentHasPlaylistId}`
      );
      return null;
    }

    // Fetch the tracks for this playlist
    const playlistTracks = await deps.prisma.playlistHasTrack.findMany({
      where: {
        playlistId: paymentHasPlaylist.playlistId,
      },
      include: {
        track: true,
      },
      orderBy: {
        trackId: 'asc',
      },
    });

    if (!playlistTracks || playlistTracks.length === 0) {
      deps.logger.log(
        `No tracks found for playlistId ${paymentHasPlaylist.playlistId}`
      );
      return null;
    }

    const tracks = playlistTracks.map((pht: any) => pht.track);

    // Create a new workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Playlist Songs');

    // Add header row
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 15 },
      { header: 'Artist', key: 'artist', width: 30 },
      { header: 'Title', key: 'title', width: 30 },
      { header: 'Year', key: 'year', width: 10 },
      { header: 'Spotify Link', key: 'spotifyLink', width: 50 },
      { header: 'QRSong! Link', key: 'qrsongLink', width: 50 },
    ];

    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Add data rows
    tracks.forEach((track: any) => {
      const spotifyLink = track.trackId
        ? `https://open.spotify.com/track/${track.trackId}`
        : '';
      const qrsongLink = `https://api.qrsong.io/qr2/${track.id}/${paymentHasPlaylistId}`;

      worksheet.addRow({
        id: track.id,
        artist: track.artist || '',
        title: track.name || '',
        year: track.year || '',
        spotifyLink: spotifyLink,
        qrsongLink: qrsongLink,
      });
    });

    // Add borders to all cells
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  } catch (error) {
    deps.logger.log(`Error generating Excel file: ${error}`);
    return null;
  }
}

export async function clearPlaylistCache(
  deps: DataDeps,
  playlistId: string,
  oldSlug?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get playlist to find the current slug
    const playlist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { slug: true },
    });

    // Clear all relevant caches
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);
    await deps.cache.del(`${CACHE_KEY_PLAYLIST}${playlistId}`);
    await deps.cache.del(`${CACHE_KEY_PLAYLIST_DB}${playlistId}`);
    // Clear tracks and track count caches (use pattern since they include track count in key)
    await deps.cache.delPattern(`${CACHE_KEY_TRACKS}${playlistId}*`);
    await deps.cache.delPattern(`${CACHE_KEY_TRACK_COUNT}${playlistId}*`);
    if (playlist?.slug) {
      await deps.cache.del(`${CACHE_KEY_PLAYLIST}${playlist.slug}`);
      await deps.cache.del(`${CACHE_KEY_PLAYLIST_DB}${playlist.slug}`);
    }
    // Clear old slug cache if provided and different from current
    if (oldSlug && oldSlug !== playlist?.slug) {
      await deps.cache.del(`${CACHE_KEY_PLAYLIST}${oldSlug}`);
      await deps.cache.del(`${CACHE_KEY_PLAYLIST_DB}${oldSlug}`);
    }

    deps.logger.log(
      color.green.bold(`Cleared cache for playlist ${color.white.bold(playlistId)}`)
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(color.red.bold(`Error clearing playlist cache: ${error.message}`));
    return { success: false, error: error.message };
  }
}

export async function clearNonFeaturedPlaylistCaches(
  deps: DataDeps
): Promise<{ success: boolean; processed: number; error?: string }> {
  try {
    // Get all non-featured playlists that have been accessed (have cache entries)
    const nonFeaturedPlaylists = await deps.prisma.playlist.findMany({
      where: {
        featured: false,
      },
      select: {
        playlistId: true,
        slug: true,
      },
    });

    let processed = 0;
    for (const playlist of nonFeaturedPlaylists) {
      await clearPlaylistCache(deps, playlist.playlistId, playlist.slug || undefined);
      processed++;
    }

    deps.logger.log(
      color.green.bold(`Cleared cache for ${color.white.bold(processed)} non-featured playlists`)
    );

    return { success: true, processed };
  } catch (error: any) {
    deps.logger.log(color.red.bold(`Error clearing non-featured playlist caches: ${error.message}`));
    return { success: false, processed: 0, error: error.message };
  }
}
