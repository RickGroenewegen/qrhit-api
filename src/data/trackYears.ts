import { color } from 'console-log-colors';
import { Prisma } from '@prisma/client';
import { Track } from '../interfaces/Track';
import { DataDeps } from './types';
import { findAndUpdateTrackByISRC } from './tracks';

export interface TrackNeedingYearUpdate {
  id: number;
  isrc: string | null;
  trackId: string;
  name: string;
  artist: string;
}

export async function updateTrackYear(
  deps: DataDeps,
  trackIds: string[],
  tracks: Track[]
): Promise<void> {
  // Maximum number of concurrent getReleaseDate calls
  const MAX_CONCURRENT_RELEASE_DATE = 3;

  // Fetch tracks that need year update
  const tracksNeedingYearUpdate = await deps.prisma.$queryRaw<
    TrackNeedingYearUpdate[]
  >`
    SELECT id, isrc, trackId, name, artist
    FROM tracks
    WHERE year IS NULL AND trackId IN (${Prisma.join(trackIds)})
  `;

  let updateCounter = 1;

  // Helper to process a single track
  const processTrack = async (track: TrackNeedingYearUpdate) => {
    // Check for existing track with same ISRC and update if found
    const { wasUpdated, method } = await findAndUpdateTrackByISRC(
      deps,
      track.isrc ?? '',
      track.id
    );

    if (wasUpdated) {
      if (method == 'isrc') {
        deps.logger.log(
          color.blue.bold(
            `Updated year for track '${color.white.bold(
              track.artist
            )} - ${color.white.bold(
              track.name
            )}' using data from another track with matching ISRC (${color.white.bold(
              updateCounter
            )} / ${color.white.bold(tracksNeedingYearUpdate.length)})`
          )
        );
      } else {
        deps.logger.log(
          color.blue.bold(
            `Updated year for track '${color.white.bold(
              track.artist
            )} - ${color.white.bold(
              track.name
            )}' using data from another track with matching artist and title (${color.white.bold(
              updateCounter
            )} / ${color.white.bold(tracksNeedingYearUpdate.length)})`
          )
        );
      }
      updateCounter++;
      return;
    }

    let spotifyYear = 0;
    const spotifyTrack = tracks.find((t: any) => t.id === track.trackId);
    if (spotifyTrack && spotifyTrack.releaseDate) {
      spotifyYear = parseInt(spotifyTrack.releaseDate.split('-')[0]);
    }

    const result = await deps.music.getReleaseDate(
      track.id,
      track.isrc ?? '',
      track.artist,
      track.name,
      spotifyYear
    );

    await deps.prisma.$executeRaw`
        UPDATE  tracks
        SET     year = ${result.year},
                spotifyYear = ${result.sources.spotify},
                discogsYear = ${result.sources.discogs},
                aiYear = ${result.sources.ai},
                musicBrainzYear = ${result.sources.mb},
                openPerplexYear = ${result.sources.openPerplex},
                googleResults = ${result.googleResults},
                standardDeviation = ${result.standardDeviation}
        WHERE   id = ${track.id}`;

    if (result.standardDeviation <= 1) {
      // Update the year with perplexYear and set manuallyChecked to true
      await deps.prisma.$executeRaw`
          UPDATE  tracks
          SET     manuallyChecked = true
          WHERE   id = ${track.id}
        `;

      deps.logger.log(
        color.green.bold(
          `Determined final year for named '${color.white.bold(
            track.artist
          )} - ${color.white.bold(track.name)}' with year ${color.white.bold(
            result.year
          )} (${color.white.bold(updateCounter)} / ${color.white.bold(
            tracksNeedingYearUpdate.length
          )})`
        )
      );
    } else {
      deps.logger.log(
        color.yellow.bold(
          `Could not determine final year for named '${color.white.bold(
            track.artist
          )} - ${color.white.bold(track.name)}' with year ${color.white.bold(
            result.year
          )} (${color.white.bold(updateCounter)} / ${color.white.bold(
            tracksNeedingYearUpdate.length
          )})`
        )
      );
    }
    updateCounter++;
  };

  // Rolling concurrency implementation
  const queue = [...tracksNeedingYearUpdate];
  let inFlight = 0;
  let nextIndex = 0;

  return new Promise<void>((resolve, reject) => {
    if (queue.length === 0) {
      resolve();
      return;
    }

    const launchNext = () => {
      if (nextIndex >= queue.length && inFlight === 0) {
        resolve();
        return;
      }
      while (
        inFlight < MAX_CONCURRENT_RELEASE_DATE &&
        nextIndex < queue.length
      ) {
        const track = queue[nextIndex++];
        inFlight++;
        processTrack(track)
          .catch((err) => {
            deps.logger.log(
              color.red.bold(
                `Error updating year for track '${color.white.bold(
                  track.artist
                )} - ${color.white.bold(track.name)}': ${err}`
              )
            );
          })
          .finally(() => {
            inFlight--;
            launchNext();
          });
      }
    };

    launchNext();
  });
}

export async function getFirstUncheckedTrack(deps: DataDeps): Promise<{
  track: any;
  totalUnchecked: number;
  currentPlaylistId: number | null;
  serviceType: string | null;
}> {
  // Use a single optimized query to get both the track and count
  // Only include tracks that are associated with payments where processedFirstTime = true
  const result = await deps.prisma.$queryRaw<any[]>`
    SELECT
      (SELECT COUNT(DISTINCT t.id)
       FROM tracks t
       INNER JOIN playlist_has_tracks pht ON t.id = pht.trackId
       INNER JOIN playlists pl ON pht.playlistId = pl.id
       INNER JOIN payment_has_playlist php ON pl.id = php.playlistId
       INNER JOIN payments p ON php.paymentId = p.id
       WHERE (t.manuallyChecked = false OR t.year = 0)
       AND p.processedFirstTime = true) as totalUnchecked,
      t.id, t.name, t.spotifyLink, t.artist, t.year, t.yearSource,
      t.certainty, t.reasoning, t.spotifyYear, t.discogsYear, t.aiYear,
      t.musicBrainzYear, t.openPerplexYear, t.standardDeviation, t.googleResults,
      pl.id as playlistId,
      pl.serviceType as serviceType
    FROM tracks t
    INNER JOIN playlist_has_tracks pht ON t.id = pht.trackId
    INNER JOIN playlists pl ON pht.playlistId = pl.id
    INNER JOIN payment_has_playlist php ON pl.id = php.playlistId
    INNER JOIN payments p ON php.paymentId = p.id
    WHERE (t.manuallyChecked = false OR t.year = 0)
    AND p.processedFirstTime = true
    ORDER BY t.id ASC
    LIMIT 1
  `;

  if (result.length === 0) {
    return { track: null, totalUnchecked: 0, currentPlaylistId: null, serviceType: null };
  }

  const { totalUnchecked, playlistId, serviceType, ...track } = result[0];
  return {
    track,
    totalUnchecked: Number(totalUnchecked),
    currentPlaylistId: Number(playlistId),
    serviceType: serviceType || 'spotify',
  };
}

export async function getYearCheckQueue(deps: DataDeps): Promise<
  Array<{
    playlistId: number;
    playlistName: string;
    clientName: string;
    uncheckedCount: number;
    paymentId: string;
    totalPrice: number;
    createdAt: Date;
  }>
> {
  const result = await deps.prisma.$queryRaw<any[]>`
    SELECT
      pl.id as playlistId,
      pl.name as playlistName,
      p.fullname as clientName,
      COUNT(DISTINCT t.id) as uncheckedCount,
      p.paymentId,
      p.totalPrice,
      p.createdAt
    FROM tracks t
    INNER JOIN playlist_has_tracks pht ON t.id = pht.trackId
    INNER JOIN playlists pl ON pht.playlistId = pl.id
    INNER JOIN payment_has_playlist php ON pl.id = php.playlistId
    INNER JOIN payments p ON php.paymentId = p.id
    WHERE (t.manuallyChecked = false OR t.year = 0)
    AND p.processedFirstTime = true
    GROUP BY pl.id, pl.name, p.fullname, p.paymentId, p.totalPrice, p.createdAt
    ORDER BY p.createdAt ASC, pl.id ASC
  `;

  return result.map((row) => ({
    playlistId: Number(row.playlistId),
    playlistName: row.playlistName,
    clientName: row.clientName,
    uncheckedCount: Number(row.uncheckedCount),
    paymentId: row.paymentId,
    totalPrice: Number(row.totalPrice),
    createdAt: row.createdAt,
  }));
}

export async function updateTrackCheck(
  deps: DataDeps,
  trackId: number,
  year: number
): Promise<{ success: boolean; checkedPaymentIds?: string[] }> {
  const { checkUnfinalizedPayments } = await import('./users');
  try {
    await deps.prisma.track.update({
      where: {
        id: trackId,
      },
      data: {
        manuallyChecked: true,
        year,
      },
    });

    const checkedPaymentIds = await checkUnfinalizedPayments(deps);

    return {
      success: true,
      checkedPaymentIds,
    };
  } catch (error) {
    return {
      success: false,
    };
  }
}

export async function areAllTracksManuallyChecked(
  deps: DataDeps,
  paymentId: string
): Promise<boolean> {
  const { areAllTracksManuallyChecked: checkAll } = await import('./users');
  return checkAll(deps, paymentId);
}
