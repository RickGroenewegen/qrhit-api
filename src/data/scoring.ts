import { color } from 'console-log-colors';
import { CACHE_KEY_FEATURED_PLAYLISTS } from './featuredPlaylists';
import { computeMarketRankings, scoreForPlace } from './marketRanking';
import { DataDeps } from './types';

export async function calculatePlaylistScores(deps: DataDeps): Promise<{
  success: boolean;
  processed: number;
  updated: Array<{ playlistId: string; name: string; downloads: number; score: number }>;
  error?: string;
}> {
  try {
    deps.logger.log(
      color.blue.bold('Starting playlist score calculation...')
    );

    // Get all featured playlists
    const featuredPlaylists = await deps.prisma.playlist.findMany({
      where: {
        featured: true,
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
        createdAt: true,
      },
    });

    deps.logger.log(
      color.blue.bold(
        `Found ${color.white.bold(featuredPlaylists.length)} featured playlists`
      )
    );

    const updated: Array<{ playlistId: string; name: string; downloads: number; score: number }> = [];

    // All-time paid orders per playlist: the admin's figure, not what ranks.
    const counts = await deps.prisma.paymentHasPlaylist.groupBy({
      by: ['playlistId'],
      where: {
        playlistId: { in: featuredPlaylists.map((p) => p.id) },
        payment: { status: 'paid' },
      },
      _count: { _all: true },
    });
    const downloads = new Map(counts.map((c) => [c.playlistId, c._count._all]));

    // The stored score is the playlist's place in the world ranking (100 for
    // the first). Every market's own ranking is stored in Redis by the same
    // call; see marketRanking.ts.
    const { world } = await computeMarketRankings(deps);
    const place = new Map(world.map((r, i) => [r.id, i]));

    for (const playlist of featuredPlaylists) {
      const downloadCount = downloads.get(playlist.id) ?? 0;
      const at = place.get(playlist.id);
      const score =
        at === undefined ? 0 : Math.round(scoreForPlace(at, world.length));

      await deps.prisma.playlist.update({
        where: { id: playlist.id },
        data: {
          downloads: downloadCount,
          score: score,
        },
      });

      updated.push({
        playlistId: playlist.playlistId,
        name: playlist.name,
        downloads: downloadCount,
        score: score,
      });
    }

    // Clear featured playlists cache after updating scores
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

    deps.logger.log(
      color.green.bold(
        `Playlist score calculation complete. Updated ${color.white.bold(updated.length)} playlists.`
      )
    );

    return {
      success: true,
      processed: updated.length,
      updated,
    };
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error calculating playlist scores: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    );
    return {
      success: false,
      processed: 0,
      updated: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function calculateSinglePlaylistDecadePercentages(
  deps: DataDeps,
  playlistId: number
): Promise<{ success: boolean; error?: string; percentages?: Record<string, number> }> {
  try {
    // Get all tracks for this playlist with their years
    const playlistTracks = await deps.prisma.playlistHasTrack.findMany({
      where: { playlistId },
      include: {
        track: {
          select: { year: true },
        },
      },
    });

    const totalTracks = playlistTracks.length;
    if (totalTracks === 0) {
      return { success: true, percentages: {} };
    }

    // Count tracks by decade
    const decadeCounts: Record<string, number> = {
      '2020': 0,
      '2010': 0,
      '2000': 0,
      '1990': 0,
      '1980': 0,
      '1970': 0,
      '1960': 0,
      '1950': 0,
      '1900': 0, // Pre-1950
      '0': 0, // Unknown/null year
    };

    for (const pt of playlistTracks) {
      const year = pt.track.year;
      if (year === null || year === undefined || year === 0) {
        decadeCounts['0']++;
      } else if (year >= 2020) {
        decadeCounts['2020']++;
      } else if (year >= 2010) {
        decadeCounts['2010']++;
      } else if (year >= 2000) {
        decadeCounts['2000']++;
      } else if (year >= 1990) {
        decadeCounts['1990']++;
      } else if (year >= 1980) {
        decadeCounts['1980']++;
      } else if (year >= 1970) {
        decadeCounts['1970']++;
      } else if (year >= 1960) {
        decadeCounts['1960']++;
      } else if (year >= 1950) {
        decadeCounts['1950']++;
      } else {
        decadeCounts['1900']++;
      }
    }

    // Calculate percentages
    const percentages: Record<string, number> = {
      '2020s': Math.round((decadeCounts['2020'] / totalTracks) * 100),
      '2010s': Math.round((decadeCounts['2010'] / totalTracks) * 100),
      '2000s': Math.round((decadeCounts['2000'] / totalTracks) * 100),
      '1990s': Math.round((decadeCounts['1990'] / totalTracks) * 100),
      '1980s': Math.round((decadeCounts['1980'] / totalTracks) * 100),
      '1970s': Math.round((decadeCounts['1970'] / totalTracks) * 100),
      '1960s': Math.round((decadeCounts['1960'] / totalTracks) * 100),
      '1950s': Math.round((decadeCounts['1950'] / totalTracks) * 100),
      'pre-1950': Math.round((decadeCounts['1900'] / totalTracks) * 100),
      'unknown': Math.round((decadeCounts['0'] / totalTracks) * 100),
    };

    // Update the playlist
    await deps.prisma.playlist.update({
      where: { id: playlistId },
      data: {
        decadePercentage2020: percentages['2020s'],
        decadePercentage2010: percentages['2010s'],
        decadePercentage2000: percentages['2000s'],
        decadePercentage1990: percentages['1990s'],
        decadePercentage1980: percentages['1980s'],
        decadePercentage1970: percentages['1970s'],
        decadePercentage1960: percentages['1960s'],
        decadePercentage1950: percentages['1950s'],
        decadePercentage1900: percentages['pre-1950'],
        decadePercentage0: percentages['unknown'],
        decadesCalculated: true,
      },
    });

    return { success: true, percentages };
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error calculating decade percentages for playlist ${playlistId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function calculateDecadePercentages(deps: DataDeps): Promise<{
  success: boolean;
  processed: number;
  error?: string;
}> {
  try {
    deps.logger.log(
      color.blue.bold('Starting decade percentage calculation...')
    );

    // Get all featured playlists that haven't had decades calculated yet
    const featuredPlaylists = await deps.prisma.playlist.findMany({
      where: {
        featured: true,
        decadesCalculated: false,
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
      },
    });

    deps.logger.log(
      color.blue.bold(
        `Found ${color.white.bold(featuredPlaylists.length)} featured playlists needing decade calculation`
      )
    );

    let processed = 0;

    for (const playlist of featuredPlaylists) {
      const result = await calculateSinglePlaylistDecadePercentages(deps, playlist.id);
      if (result.success) {
        processed++;
        // Format percentages for logging (only show non-zero values)
        const pctStr = result.percentages
          ? Object.entries(result.percentages)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${k}: ${v}%`)
              .join(', ')
          : 'no tracks';
        deps.logger.log(
          color.blue.bold(
            `Updated decade percentages for ${color.white.bold(playlist.name)}: ${color.white.bold(pctStr)}`
          )
        );
      }
    }

    // Clear featured playlists cache after updating percentages
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

    deps.logger.log(
      color.green.bold(
        `Decade percentage calculation complete. Updated ${color.white.bold(processed)} playlists.`
      )
    );

    return {
      success: true,
      processed,
    };
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error calculating decade percentages: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    );
    return {
      success: false,
      processed: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function updateFeaturedPlaylistStats(deps: DataDeps): Promise<{
  success: boolean;
  scoresProcessed: number;
  decadesProcessed: number;
  error?: string;
}> {
  try {
    deps.logger.log(
      color.blue.bold('Starting featured playlist stats update...')
    );

    // Scores: the world ranking, and every market's own
    const scoresResult = await calculatePlaylistScores(deps);

    // Calculate decade percentages
    const decadesResult = await calculateDecadePercentages(deps);

    const success = scoresResult.success && decadesResult.success;
    const errors: string[] = [];
    if (scoresResult.error) errors.push(`Scores: ${scoresResult.error}`);
    if (decadesResult.error) errors.push(`Decades: ${decadesResult.error}`);

    deps.logger.log(
      color.green.bold(
        `Featured playlist stats update complete. Scores: ${color.white.bold(scoresResult.processed)}, Decades: ${color.white.bold(decadesResult.processed)}`
      )
    );

    return {
      success,
      scoresProcessed: scoresResult.processed,
      decadesProcessed: decadesResult.processed,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error updating featured playlist stats: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    );
    return {
      success: false,
      scoresProcessed: 0,
      decadesProcessed: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
