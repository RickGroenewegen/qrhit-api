import { color } from 'console-log-colors';
import {
  CACHE_KEY_PLAYLIST,
  CACHE_KEY_PLAYLIST_DB,
  CACHE_KEY_TRACKS,
  CACHE_KEY_TRACK_COUNT,
} from '../spotify';
import { clearPlaylistCache, createSiteMap } from './misc';
import { DataDeps } from './types';

export const CACHE_KEY_FEATURED_PLAYLISTS = 'featuredPlaylists_v4_';

export async function getFeaturedPlaylists(
  deps: DataDeps,
  locale: string,
  skipLocaleFilter: boolean = false
): Promise<any> {
  let returnList: any[] = [];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // Validate locale for column names, default to 'en' if invalid
  if (!deps.translate.isValidLocale(locale)) {
    locale = 'en';
  }

  const cacheKey = `${CACHE_KEY_FEATURED_PLAYLISTS}${today}_${locale}${skipLocaleFilter ? '_all' : ''}`;
  const cachedPlaylists = await deps.cache.get(cacheKey);

  if (!cachedPlaylists) {
    // Query for featured playlists
    // If promotionalActive = 1, then promotionalAccepted must also be 1
    let query = `
    SELECT
      playlists.id,
      playlists.playlistId,
      playlists.name,
      playlists.slug,
      playlists.image,
      playlists.customImage,
      playlists.score,
      playlists.price,
      playlists.priceDigital,
      playlists.priceSheets,
      playlists.numberOfTracks,
      playlists.featuredLocale,
      playlists.decadePercentage2020,
      playlists.decadePercentage2010,
      playlists.decadePercentage2000,
      playlists.decadePercentage1990,
      playlists.decadePercentage1980,
      playlists.decadePercentage1970,
      playlists.decadePercentage1960,
      playlists.decadePercentage1950,
      playlists.decadePercentage1900,
      playlists.decadePercentage0,
      playlists.genreId,
      playlists.description_${locale} as description,
      playlists.description_en as descriptionEnFallback,
      g.name_${locale} as genreName,
      playlists.promotionalActive as isPromotional,
      playlists.promotionalTitle,
      playlists.promotionalDescription
    FROM
      playlists
    LEFT JOIN
      genres g ON playlists.genreId = g.id
    WHERE
      playlists.featured = 1
      AND playlists.featuredHidden = 0
      AND (playlists.promotionalActive = 0 OR playlists.promotionalAccepted = 1)
  `;

    // Add locale condition (skip if skipLocaleFilter is true to return all playlists)
    if (!skipLocaleFilter && locale) {
      query += ` AND (FIND_IN_SET('${locale}', playlists.featuredLocale) > 0 OR playlists.featuredLocale IS NULL)`;
    } else if (!skipLocaleFilter && !locale) {
      query += ` AND playlists.featuredLocale IS NULL`;
    }
    // When skipLocaleFilter is true, no locale filtering is applied

    // Add ordering: prioritize matching locale, then sort by score
    if (!skipLocaleFilter && locale) {
      query += `
      ORDER BY
        CASE
          WHEN FIND_IN_SET('${locale}', featuredLocale) > 0 THEN 0
          ELSE 1
        END,
        score DESC
    `;
    } else {
      query += ` ORDER BY score DESC`;
    }

    returnList = await deps.prisma.$queryRawUnsafe(query);

    returnList = returnList.map((playlist) => {
      // Ensure description is available, fallback to English if not
      if (!playlist.description && locale !== 'en') {
        playlist.description = playlist.descriptionEnFallback;
      }
      delete playlist.descriptionEnFallback;

      // Ensure genre name is available, fallback to English if not
      if (!playlist.genreName && playlist.genreId && locale !== 'en') {
        // We'll need to fetch this separately since we're already in the map function
        // This is a fallback scenario
        playlist.genreName = playlist.genreName || 'Unknown';
      }

      // For promotional playlists, use promotional data if available
      if (playlist.isPromotional === 1) {
        playlist.isPromotional = true;
        if (playlist.promotionalTitle) {
          playlist.name = playlist.promotionalTitle;
        }
        if (playlist.promotionalDescription) {
          playlist.description = playlist.promotionalDescription;
        }
      } else {
        playlist.isPromotional = false;
      }

      // Replace brand terms in name and description
      if (playlist.name) {
        playlist.name = deps.utils.replaceBrandTerms(playlist.name);
      }
      if (playlist.description) {
        playlist.description = deps.utils.replaceBrandTerms(playlist.description);
      }

      return {
        ...playlist,
      };
    });

    deps.cache.set(cacheKey, JSON.stringify(returnList));
  } else {
    returnList = JSON.parse(cachedPlaylists);
  }
  return returnList;
}

// ── Playlist suggestions (admin PDF) ─────────────────────────────

export interface PlaylistSuggestionOptions {
  /** Playlist markets to include; empty = every market. International (untagged) playlists are always included. */
  locales: string[];
  /** Genre ids to include; empty = every genre. */
  genreIds: number[];
  /** Cards per box; only playlists with at least this many tracks qualify. */
  cardCount: number;
}

function playlistLocales(featuredLocale: unknown): string[] {
  return String(featuredLocale || '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Pure filter over the cached featured list, so the admin document can
 * combine several markets and genres without a second raw SQL query.
 * Mirrors the `FIND_IN_SET(locale) OR featuredLocale IS NULL` rule of
 * getFeaturedPlaylists for every selected locale at once.
 */
export function filterPlaylistSuggestions(
  playlists: any[],
  opts: PlaylistSuggestionOptions
): any[] {
  const wantedLocales = new Set(opts.locales);
  const wantedGenres = new Set(opts.genreIds);

  const matchesLocale = (p: any): boolean => {
    if (wantedLocales.size === 0) return true;
    const own = playlistLocales(p.featuredLocale);
    if (own.length === 0) return true;
    return own.some((l) => wantedLocales.has(l));
  };

  return playlists
    .filter((p) => matchesLocale(p))
    .filter((p) => wantedGenres.size === 0 || wantedGenres.has(Number(p.genreId)))
    .filter((p) => Number(p.numberOfTracks) >= opts.cardCount)
    .sort((a, b) => {
      // Explicitly localised playlists first, then by popularity.
      const aLocal =
        wantedLocales.size > 0 &&
        playlistLocales(a.featuredLocale).some((l) => wantedLocales.has(l))
          ? 0
          : 1;
      const bLocal =
        wantedLocales.size > 0 &&
        playlistLocales(b.featuredLocale).some((l) => wantedLocales.has(l))
          ? 0
          : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      const score = Number(b.score || 0) - Number(a.score || 0);
      if (score !== 0) return score;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

export async function getPlaylistSuggestions(
  deps: DataDeps,
  docLocale: string,
  opts: PlaylistSuggestionOptions
): Promise<any[]> {
  const all = await getFeaturedPlaylists(deps, docLocale, true);
  return filterPlaylistSuggestions(all, opts);
}

/** Genres for the suggestions modal, with how many visible featured playlists each has. */
export async function getGenresWithFeaturedCount(
  deps: DataDeps
): Promise<{ id: number; slug: string | null; name: string; featuredCount: number }[]> {
  const genres = await deps.prisma.genre.findMany({
    select: {
      id: true,
      slug: true,
      name_en: true,
      _count: {
        select: {
          Playlist: { where: { featured: true, featuredHidden: false } },
        },
      },
    },
    orderBy: { name_en: 'asc' },
  });
  return genres.map((g) => ({
    id: g.id,
    slug: g.slug,
    name: g.name_en,
    featuredCount: g._count.Playlist,
  }));
}

/** Decade columns, weighted against each other to measure musical overlap. */
const DECADE_KEYS = [
  'decadePercentage2020',
  'decadePercentage2010',
  'decadePercentage2000',
  'decadePercentage1990',
  'decadePercentage1980',
  'decadePercentage1970',
  'decadePercentage1960',
  'decadePercentage1950',
  'decadePercentage1900',
] as const;

/**
 * Playlists similar to `slug`, for the "you might also like" row on a product
 * page.
 *
 * Why this exists: every product page used to be an orphan. The catalogue is
 * ~600 pages that between them had no internal links at all, reachable only
 * from the sitemap, and averaging ~13 impressions a month each. Linking
 * siblings turns the catalogue into a connected graph a crawler can walk from
 * any entry point, and gives each page inbound links from topically related
 * pages rather than none.
 *
 * It reads the same cached list `getFeaturedPlaylists` builds and ranks in
 * memory, so it costs no extra database work.
 */
export async function getRelatedFeaturedPlaylists(
  deps: DataDeps,
  locale: string,
  slug: string,
  limit: number = 6
): Promise<any[]> {
  const all = await getFeaturedPlaylists(deps, locale, true);
  const source = all.find((p: any) => p.slug === slug);

  // Most product pages are for playlists that were never featured, so the
  // source is usually absent from this list. Returning nothing there left the
  // majority of product pages with no related row at all — the opposite of the
  // point, which is to link orphaned product pages to something. With no
  // source to compare against, every affinity term below evaluates to 0 and
  // the ordering falls through to `score`, i.e. the most popular featured
  // playlists. That is a reasonable row for a page we know nothing else about.
  const decadeVector = (p: any): number[] =>
    DECADE_KEYS.map((k) => Number(p[k]) || 0);
  const sourceDecades = source ? decadeVector(source) : DECADE_KEYS.map(() => 0);

  const scored = all
    .filter((p: any) => p.slug && p.slug !== slug)
    .map((p: any) => {
      // Same genre is the strongest signal a listener would agree with.
      let affinity =
        source && p.genreId && p.genreId === source.genreId ? 100 : 0;

      // Then era overlap: sum of the smaller share in each decade, so two
      // playlists that are both mostly 80s score near 100 and a 60s/2020s
      // pair scores near 0.
      const theirs = decadeVector(p);
      affinity += sourceDecades.reduce(
        (sum, share, i) => sum + Math.min(share, theirs[i]),
        0
      );

      // A nudge toward playlists in the visitor's own market.
      if (
        source?.featuredLocale &&
        p.featuredLocale === source.featuredLocale
      ) {
        affinity += 25;
      }

      return { playlist: p, affinity, score: Number(p.score) || 0 };
    }) as Array<{ playlist: any; affinity: number; score: number }>;

  scored.sort(
    (a, b) =>
      b.affinity - a.affinity ||
      b.score - a.score ||
      // Stable final tiebreak so server and client agree and the row does not
      // reshuffle between renders.
      String(a.playlist.slug).localeCompare(String(b.playlist.slug))
  );

  return scored.slice(0, limit).map((s) => s.playlist);
}

/**
 * Project a set of playlist ids into the same card shape as
 * getFeaturedPlaylists, preserving the given id order. Reused by the occasion
 * landing pages and the seasonal /playlists row so playlist-card renders them
 * unchanged. Takes prisma + utils directly (no DataDeps) so CalendarService can
 * call it.
 */
export async function projectPlaylistsByIds(
  prisma: any,
  utils: any,
  ids: number[],
  locale: string
): Promise<any[]> {
  const cleanIds = (ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n));
  if (cleanIds.length === 0) return [];
  const safeLocale = /^[a-z]{2}$/.test(locale) ? locale : 'en';
  const idList = cleanIds.join(',');

  const query = `
    SELECT
      playlists.id,
      playlists.playlistId,
      playlists.name,
      playlists.slug,
      playlists.image,
      playlists.customImage,
      playlists.score,
      playlists.price,
      playlists.priceDigital,
      playlists.priceSheets,
      playlists.numberOfTracks,
      playlists.featuredLocale,
      playlists.decadePercentage2020,
      playlists.decadePercentage2010,
      playlists.decadePercentage2000,
      playlists.decadePercentage1990,
      playlists.decadePercentage1980,
      playlists.decadePercentage1970,
      playlists.decadePercentage1960,
      playlists.decadePercentage1950,
      playlists.decadePercentage1900,
      playlists.decadePercentage0,
      playlists.genreId,
      playlists.description_${safeLocale} as description,
      playlists.description_en as descriptionEnFallback,
      g.name_${safeLocale} as genreName,
      playlists.promotionalActive as isPromotional,
      playlists.promotionalTitle,
      playlists.promotionalDescription
    FROM playlists
    LEFT JOIN genres g ON playlists.genreId = g.id
    WHERE playlists.id IN (${idList})
  `;

  let rows: any[] = await prisma.$queryRawUnsafe(query);
  rows = rows.map((p) => {
    if (!p.description && safeLocale !== 'en') p.description = p.descriptionEnFallback;
    delete p.descriptionEnFallback;
    if (p.isPromotional === 1) {
      p.isPromotional = true;
      if (p.promotionalTitle) p.name = p.promotionalTitle;
      if (p.promotionalDescription) p.description = p.promotionalDescription;
    } else {
      p.isPromotional = false;
    }
    if (p.name) p.name = utils.replaceBrandTerms(p.name);
    if (p.description) p.description = utils.replaceBrandTerms(p.description);
    return p;
  });

  // Preserve the requested order (the caller passes ids in sortOrder).
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return cleanIds.map((id) => byId.get(id)).filter(Boolean);
}

export async function getAllFeaturedPlaylists(deps: DataDeps): Promise<any[]> {
  try {
    const playlists = await deps.prisma.playlist.findMany({
      where: {
        featured: true,
        // Exclude playlists that are pending promotional approval
        NOT: {
          promotionalActive: true,
          promotionalAccepted: false,
        },
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
        slug: true,
        image: true,
        customImage: true,
        featuredHidden: true,
        featuredLocale: true,
        promotionalActive: true,
        promotionalAccepted: true,
        promotionalTitle: true,
        promotionalDescription: true,
        promotionalUserId: true,
      },
      orderBy: [{ id: 'desc' }],
    });

    // Get purchase counts for all playlists in one query
    const playlistIds = playlists.map((p) => p.id);
    const purchaseCounts = await deps.prisma.paymentHasPlaylist.groupBy({
      by: ['playlistId'],
      where: {
        playlistId: { in: playlistIds },
        payment: {
          status: 'paid',
        },
      },
      _count: {
        playlistId: true,
      },
    });

    // Create a map for quick lookup
    const purchaseCountMap = new Map<number, number>();
    for (const pc of purchaseCounts) {
      purchaseCountMap.set(pc.playlistId, pc._count.playlistId);
    }

    // Get user info for each playlist
    const playlistsWithUsers = await Promise.all(
      playlists.map(async (p) => {
        let user: { email: string; displayName: string } | null = null;
        if (p.promotionalUserId) {
          user = await deps.prisma.user.findUnique({
            where: { id: p.promotionalUserId },
            select: { email: true, displayName: true },
          });
        }

        // Get total purchases and subtract 1 if this is a promotional playlist
        // (to exclude the original owner's purchase)
        let purchaseCount = purchaseCountMap.get(p.id) || 0;
        if (p.promotionalActive && p.promotionalAccepted && purchaseCount > 0) {
          purchaseCount = Math.max(0, purchaseCount - 1);
        }

        return {
          id: p.id,
          playlistId: p.playlistId,
          name: p.promotionalTitle || p.name,
          slug: p.slug,
          image: p.image,
          customImage: p.customImage,
          description: p.promotionalDescription || '',
          featuredHidden: p.featuredHidden,
          featuredLocale: p.featuredLocale,
          isPromotional: p.promotionalActive && p.promotionalAccepted,
          userEmail: user?.email || null,
          userDisplayName: user?.displayName || null,
          purchaseCount,
        };
      })
    );

    return playlistsWithUsers;
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error getting all featured playlists: ${error.message}`)
    );
    return [];
  }
}

export async function searchFeaturedPlaylists(
  deps: DataDeps,
  searchTerm: string = '',
  locale: string | null = null,
  page: number = 1,
  limit: number = 20,
  sortColumn: string = 'id',
  sortDirection: string = 'desc'
): Promise<{
  pending: any[];
  approved: { data: any[]; total: number; page: number; totalPages: number };
}> {
  try {
    const hasSearch = searchTerm && searchTerm.trim().length > 0;

    // --- Pending playlists (no pagination, always return all) ---
    const pendingWhere: any = {
      promotionalActive: true,
      promotionalAccepted: false,
      promotionalHide: false,
    };
    if (hasSearch) {
      pendingWhere.OR = [
        { name: { contains: searchTerm } },
        { promotionalTitle: { contains: searchTerm } },
      ];
    }
    if (locale) {
      pendingWhere.featuredLocale = locale;
    }

    const pendingPlaylists = await deps.prisma.playlist.findMany({
      where: pendingWhere,
      select: {
        id: true,
        playlistId: true,
        name: true,
        slug: true,
        image: true,
        customImage: true,
        promotionalTitle: true,
        promotionalDescription: true,
        promotionalLocale: true,
        promotionalUserId: true,
      },
      orderBy: { id: 'desc' },
    });

    const pendingWithUsers = await Promise.all(
      pendingPlaylists.map(async (p) => {
        let user: { email: string; displayName: string } | null = null;
        if (p.promotionalUserId) {
          user = await deps.prisma.user.findUnique({
            where: { id: p.promotionalUserId },
            select: { email: true, displayName: true },
          });
        }
        return {
          id: p.id,
          playlistId: p.playlistId,
          name: p.promotionalTitle || p.name,
          slug: p.slug,
          image: p.image,
          customImage: p.customImage,
          description: p.promotionalDescription || '',
          locale: p.promotionalLocale,
          userEmail: user?.email || null,
          userDisplayName: user?.displayName || null,
        };
      })
    );

    // --- Approved playlists (paginated) ---
    // Removed playlists stay in the overview so they can be brought back.
    const approvedWhere: any = {
      AND: [{ OR: [{ featured: true }, { unfeaturedAt: { not: null } }] }],
      NOT: {
        promotionalActive: true,
        promotionalAccepted: false,
      },
    };
    if (hasSearch) {
      approvedWhere.AND.push({
        OR: [
          { name: { contains: searchTerm } },
          { promotionalTitle: { contains: searchTerm } },
        ],
      });
    }
    if (locale) {
      approvedWhere.featuredLocale = locale;
    }

    // Build orderBy
    const allowedSortColumns: Record<string, string> = {
      id: 'id',
      name: 'name',
    };
    const safeColumn = allowedSortColumns[sortColumn] || 'id';
    const safeDirection = sortDirection === 'asc' ? 'asc' : 'desc';

    const offset = (page - 1) * limit;

    const [approvedPlaylists, totalCount] = await Promise.all([
      deps.prisma.playlist.findMany({
        where: approvedWhere,
        select: {
          id: true,
          playlistId: true,
          name: true,
          slug: true,
          image: true,
          customImage: true,
          featuredHidden: true,
          featuredLocale: true,
          unfeaturedAt: true,
          promotionalActive: true,
          promotionalAccepted: true,
          promotionalTitle: true,
          promotionalDescription: true,
          promotionalUserId: true,
          baseEventsTagged: true,
        },
        orderBy: { [safeColumn]: safeDirection },
        skip: offset,
        take: limit,
      }),
      deps.prisma.playlist.count({ where: approvedWhere }),
    ]);

    // Get purchase counts
    const playlistIds = approvedPlaylists.map((p) => p.id);

    // Base-event links (occasion tags) for the visible playlists.
    const baseLinks =
      playlistIds.length > 0
        ? await deps.prisma.eventBasePlaylist.findMany({
            where: { playlistId: { in: playlistIds } },
            select: {
              playlistId: true,
              baseEvent: { select: { id: true, key: true, name_en: true } },
            },
            orderBy: { baseEvent: { name_en: 'asc' } },
          })
        : [];
    const baseEventsMap = new Map<number, { id: number; key: string; name: string }[]>();
    for (const link of baseLinks) {
      const arr = baseEventsMap.get(link.playlistId) || [];
      // Expose the English name as `name` for the admin UI.
      arr.push({ id: link.baseEvent.id, key: link.baseEvent.key, name: link.baseEvent.name_en });
      baseEventsMap.set(link.playlistId, arr);
    }
    const purchaseCounts = playlistIds.length > 0
      ? await deps.prisma.paymentHasPlaylist.groupBy({
          by: ['playlistId'],
          where: {
            playlistId: { in: playlistIds },
            payment: { status: 'paid' },
          },
          _count: { playlistId: true },
        })
      : [];

    const purchaseCountMap = new Map<number, number>();
    for (const pc of purchaseCounts) {
      purchaseCountMap.set(pc.playlistId, pc._count.playlistId);
    }

    // Sort by purchaseCount requires post-processing since it's a computed field
    let approvedWithUsers = await Promise.all(
      approvedPlaylists.map(async (p) => {
        let user: { email: string; displayName: string } | null = null;
        if (p.promotionalUserId) {
          user = await deps.prisma.user.findUnique({
            where: { id: p.promotionalUserId },
            select: { email: true, displayName: true },
          });
        }
        let purchaseCount = purchaseCountMap.get(p.id) || 0;
        if (p.promotionalActive && p.promotionalAccepted && purchaseCount > 0) {
          purchaseCount = Math.max(0, purchaseCount - 1);
        }
        return {
          id: p.id,
          playlistId: p.playlistId,
          name: p.promotionalTitle || p.name,
          slug: p.slug,
          image: p.image,
          customImage: p.customImage,
          description: p.promotionalDescription || '',
          featuredHidden: p.featuredHidden,
          featuredLocale: p.featuredLocale,
          unfeaturedAt: p.unfeaturedAt,
          isPromotional: p.promotionalActive && p.promotionalAccepted,
          userEmail: user?.email || null,
          userDisplayName: user?.displayName || null,
          purchaseCount,
          baseEvents: baseEventsMap.get(p.id) || [],
          baseEventsTagged: p.baseEventsTagged,
        };
      })
    );

    // If sorting by purchaseCount, we need to handle it in-memory
    // since it's a computed field (not a direct DB column)
    if (sortColumn === 'purchaseCount') {
      approvedWithUsers.sort((a, b) => {
        const diff = a.purchaseCount - b.purchaseCount;
        return safeDirection === 'asc' ? diff : -diff;
      });
    }

    return {
      pending: pendingWithUsers,
      approved: {
        data: approvedWithUsers,
        total: totalCount,
        page,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error searching featured playlists: ${error.message}`)
    );
    return {
      pending: [],
      approved: { data: [], total: 0, page: 1, totalPages: 1 },
    };
  }
}

export async function getPendingPromotionalPlaylists(deps: DataDeps): Promise<any[]> {
  try {
    const playlists = await deps.prisma.playlist.findMany({
      where: {
        promotionalActive: true,
        promotionalAccepted: false,
        promotionalHide: false,
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
        slug: true,
        image: true,
        customImage: true,
        promotionalTitle: true,
        promotionalDescription: true,
        promotionalLocale: true,
        promotionalUserId: true,
      },
      orderBy: { id: 'desc' },
    });

    // Get user info for each playlist
    const playlistsWithUsers = await Promise.all(
      playlists.map(async (p) => {
        let user: { email: string; displayName: string } | null = null;
        if (p.promotionalUserId) {
          user = await deps.prisma.user.findUnique({
            where: { id: p.promotionalUserId },
            select: { email: true, displayName: true },
          });
        }
        return {
          id: p.id,
          playlistId: p.playlistId,
          name: p.promotionalTitle || p.name,
          slug: p.slug,
          image: p.image,
          customImage: p.customImage,
          description: p.promotionalDescription || '',
          locale: p.promotionalLocale,
          userEmail: user?.email || null,
          userDisplayName: user?.displayName || null,
        };
      })
    );

    return playlistsWithUsers;
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error getting pending promotional playlists: ${error.message}`)
    );
    return [];
  }
}

export async function getAcceptedPromotionalPlaylists(deps: DataDeps): Promise<any[]> {
  try {
    const playlists = await deps.prisma.playlist.findMany({
      where: {
        promotionalActive: true,
        promotionalAccepted: true,
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
        slug: true,
        image: true,
        customImage: true,
        promotionalTitle: true,
        promotionalDescription: true,
        promotionalLocale: true,
        promotionalUserId: true,
        featuredLocale: true,
      },
      orderBy: { id: 'desc' },
    });

    // Get user info for each playlist
    const playlistsWithUsers = await Promise.all(
      playlists.map(async (p) => {
        let user: { email: string; displayName: string } | null = null;
        if (p.promotionalUserId) {
          user = await deps.prisma.user.findUnique({
            where: { id: p.promotionalUserId },
            select: { email: true, displayName: true },
          });
        }
        return {
          id: p.id,
          playlistId: p.playlistId,
          name: p.promotionalTitle || p.name,
          slug: p.slug,
          image: p.image,
          customImage: p.customImage,
          description: p.promotionalDescription || '',
          locale: p.promotionalLocale,
          featuredLocale: p.featuredLocale,
          userEmail: user?.email || null,
          userDisplayName: user?.displayName || null,
        };
      })
    );

    return playlistsWithUsers;
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error getting accepted promotional playlists: ${error.message}`)
    );
    return [];
  }
}

export async function updatePlaylistFeatured(
  deps: DataDeps,
  playlistId: string,
  featured: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const playlist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { id: true },
    });

    if (!playlist) {
      return { success: false, error: 'Playlist not found' };
    }

    await deps.prisma.playlist.update({
      where: { playlistId },
      data: { featured, markedForMerchantCenter: true },
    });

    // Clear all Spotify cache for this playlist
    await deps.cache.delPattern(`${CACHE_KEY_PLAYLIST}${playlistId}*`);
    await deps.cache.delPattern(`${CACHE_KEY_PLAYLIST_DB}${playlistId}*`);
    await deps.cache.delPattern(`${CACHE_KEY_TRACKS}${playlistId}*`);
    await deps.cache.delPattern(`${CACHE_KEY_TRACK_COUNT}${playlistId}*`);
    // Clear featured playlists cache across all locales and dates
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

    deps.logger.log(
      color.blue.bold(
        `Updated featured status for playlist ${color.white.bold(
          playlistId
        )} to ${color.white.bold(featured)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating featured status for playlist ${color.white.bold(
          playlistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updateFeaturedHidden(
  deps: DataDeps,
  playlistId: string,
  featuredHidden: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    await deps.prisma.playlist.update({
      where: { playlistId },
      data: { featuredHidden, markedForMerchantCenter: true },
    });

    // Clear featured playlists cache
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error updating featured hidden: ${error.message}`)
    );
    return { success: false, error: error.message };
  }
}

async function setPlaylistFeatured(
  deps: DataDeps,
  playlistId: string,
  featured: boolean
): Promise<{ success: boolean; error?: string }> {
  const verb = featured ? 'Restored' : 'Removed';
  try {
    const playlist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { id: true, slug: true },
    });

    if (!playlist) {
      return { success: false, error: 'Playlist not found' };
    }

    await deps.prisma.playlist.update({
      where: { playlistId },
      data: {
        featured,
        unfeaturedAt: featured ? null : new Date(),
        markedForMerchantCenter: true,
      },
    });

    // The product page lookup of a featured playlist is cached forever, and
    // a miss is cached too, so the page would keep its old answer without this.
    await clearPlaylistCache(deps, playlistId, playlist.slug || undefined);
    // The sitemap is otherwise only rebuilt at boot.
    await createSiteMap(deps);

    deps.logger.log(
      color.blue.bold(`${verb} featured playlist ${color.white.bold(playlistId)}`)
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error ${verb.toLowerCase()} featured playlist ${playlistId}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

/**
 * Takes a playlist out of the catalogue: off the list, the product page, the
 * sitemap and Merchant Center. "Hidden" only drops it from the list and keeps
 * the product page, which is the wrong tool for a playlist that no longer
 * exists on Spotify. The row itself stays, because orders and tracks
 * reference it, and `unfeaturedAt` keeps it in the admin overview so it can
 * be brought back with `refeaturePlaylist`.
 */
export function unfeaturePlaylist(deps: DataDeps, playlistId: string) {
  return setPlaylistFeatured(deps, playlistId, false);
}

export function refeaturePlaylist(deps: DataDeps, playlistId: string) {
  return setPlaylistFeatured(deps, playlistId, true);
}

export async function updateFeaturedLocale(
  deps: DataDeps,
  playlistId: string,
  featuredLocale: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    await deps.prisma.playlist.update({
      where: { playlistId },
      data: { featuredLocale, markedForMerchantCenter: true },
    });

    // Clear featured playlists cache
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error updating featured locale: ${error.message}`)
    );
    return { success: false, error: error.message };
  }
}

export async function updatePromotionalPlaylist(
  deps: DataDeps,
  playlistId: string,
  data: {
    name: string;
    description: string;
    featuredLocale: string | null;
    slug?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const updateData: Record<string, any> = {
      name: data.name,
      promotionalTitle: data.name,
      description_en: data.description,
      promotionalDescription: data.description,
      featuredLocale: data.featuredLocale,
      markedForMerchantCenter: true,
    };

    // Handle slug update with duplicate check
    if (data.slug !== undefined && data.slug !== null) {
      const trimmedSlug = data.slug.trim().toLowerCase();
      if (trimmedSlug) {
        // Check if slug already exists for another playlist
        const existingPlaylist = await deps.prisma.playlist.findFirst({
          where: {
            slug: trimmedSlug,
            playlistId: { not: playlistId },
          },
          select: { playlistId: true, name: true },
        });

        if (existingPlaylist) {
          return {
            success: false,
            error: `Slug "${trimmedSlug}" is already in use by playlist "${existingPlaylist.name}"`,
          };
        }

        updateData.slug = trimmedSlug;
      }
    }

    // Get old slug before update for cache clearing
    const oldPlaylist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { slug: true },
    });

    await deps.prisma.playlist.update({
      where: { playlistId },
      data: updateData,
    });

    // Clear all relevant caches using central function
    await clearPlaylistCache(deps, playlistId, oldPlaylist?.slug || undefined);

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error updating promotional playlist: ${error.message}`)
    );
    return { success: false, error: error.message };
  }
}

export async function acceptPromotionalPlaylist(
  deps: DataDeps,
  playlistId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const playlist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { id: true },
    });

    if (!playlist) {
      return { success: false, error: 'Playlist not found' };
    }

    await deps.prisma.playlist.update({
      where: { playlistId },
      data: { promotionalAccepted: true, markedForMerchantCenter: true },
    });

    // Clear featured playlists cache
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

    deps.logger.log(
      color.blue.bold(
        `Accepted promotional playlist ${color.white.bold(playlistId)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error accepting promotional playlist ${playlistId}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function declinePromotionalPlaylist(
  deps: DataDeps,
  playlistId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const playlist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { id: true },
    });

    if (!playlist) {
      return { success: false, error: 'Playlist not found' };
    }

    await deps.prisma.playlist.update({
      where: { playlistId },
      data: {
        promotionalHide: true,
        promotionalDeclined: true,
        markedForMerchantCenter: true,
      },
    });

    deps.logger.log(
      color.blue.bold(
        `Declined promotional playlist ${color.white.bold(playlistId)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error declining promotional playlist ${playlistId}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}
