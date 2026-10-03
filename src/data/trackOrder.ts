import { color } from 'console-log-colors';
import { Prisma } from '@prisma/client';
import { DataDeps } from './types';
import { mixTrackOrder } from '../trackMix';

/**
 * Puts a playlist's cards in the year-mixed order of src/trackMix.ts and
 * returns the tracks.id values in that order. The mix reads the year and
 * artist the card prints: the per-playlist trackextrainfo override first, as
 * getTracks does.
 *
 * Its own module because storeTracks (tracks.ts) and the admin "Mix years"
 * endpoint (playlists.ts) both call it, and tracks.ts already reaches
 * playlists.ts through musicLinks.ts.
 */
export async function writeMixedTrackOrder(
  deps: DataDeps,
  playlistDatabaseId: number,
  seed: number
): Promise<number[]> {
  const rows = await deps.prisma.$queryRaw<
    { id: number; year: number | null; artist: string | null }[]
  >`
    SELECT
      tracks.id,
      COALESCE(tei.year, tracks.year) as year,
      COALESCE(NULLIF(tei.artist, ''), tracks.artist) as artist
    FROM playlist_has_tracks pht
    INNER JOIN tracks ON tracks.id = pht.trackId
    LEFT JOIN trackextrainfo tei ON tei.trackId = tracks.id AND tei.playlistId = ${playlistDatabaseId}
    WHERE pht.playlistId = ${playlistDatabaseId}
  `;

  if (rows.length === 0) return [];

  const order = mixTrackOrder(
    rows.map((row) => ({
      id: Number(row.id),
      year: row.year === null ? null : Number(row.year),
      artist: row.artist,
    })),
    seed
  );

  const orderCases = order.map(
    (trackId, index) => Prisma.sql`WHEN ${trackId} THEN ${index}`
  );
  await deps.prisma.$executeRaw`
    UPDATE playlist_has_tracks
    SET \`order\` = CASE trackId
      ${Prisma.join(orderCases, ' ')}
      ELSE \`order\`
    END
    WHERE playlistId = ${playlistDatabaseId}
  `;

  deps.logger.log(
    color.green.bold(
      `Mixed the years of ${color.white.bold(
        order.length
      )} cards for playlist ${color.white.bold(playlistDatabaseId)}`
    )
  );

  return order;
}
