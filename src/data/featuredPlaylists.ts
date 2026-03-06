import { color } from 'console-log-colors';
import {
  CACHE_KEY_PLAYLIST,
  CACHE_KEY_PLAYLIST_DB,
  CACHE_KEY_TRACKS,
  CACHE_KEY_TRACK_COUNT,
} from '../spotify';
import { clearPlaylistCache } from './misc';
import { DataDeps } from './types';

export const CACHE_KEY_FEATURED_PLAYLISTS = 'featuredPlaylists_v3_';

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
        const descriptionField = `description_en`;
        playlist.description = playlist[descriptionField];
      }

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
    const approvedWhere: any = {
      featured: true,
      NOT: {
        promotionalActive: true,
        promotionalAccepted: false,
      },
    };
    if (hasSearch) {
      approvedWhere.OR = [
        { name: { contains: searchTerm } },
        { promotionalTitle: { contains: searchTerm } },
      ];
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
          promotionalActive: true,
          promotionalAccepted: true,
          promotionalTitle: true,
          promotionalDescription: true,
          promotionalUserId: true,
        },
        orderBy: { [safeColumn]: safeDirection },
        skip: offset,
        take: limit,
      }),
      deps.prisma.playlist.count({ where: approvedWhere }),
    ]);

    // Get purchase counts
    const playlistIds = approvedPlaylists.map((p) => p.id);
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
          isPromotional: p.promotionalActive && p.promotionalAccepted,
          userEmail: user?.email || null,
          userDisplayName: user?.displayName || null,
          purchaseCount,
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
      data: { featured },
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
      data: { featuredHidden },
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

export async function updateFeaturedLocale(
  deps: DataDeps,
  playlistId: string,
  featuredLocale: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    await deps.prisma.playlist.update({
      where: { playlistId },
      data: { featuredLocale },
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
      data: { promotionalAccepted: true },
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
