import { color } from 'console-log-colors';
import { Prisma } from '@prisma/client';
import { serviceColumnMap } from '../providers/MusicProviderFactory';
import { DataDeps } from './types';
import { updateTrackYear } from './trackYears';
import { clearPlaylistCache } from './misc';
import { getLink } from './musicLinks';
import { checkUnfinalizedPayments } from './users';

export async function sanitizeTitleOrArtist(
  deps: DataDeps,
  text: string,
  type: 'artist' | 'title'
): Promise<string> {
  if (!text) return text;

  // Check if any word in the text is >= 25 characters
  const words = text.split(/\s+/);
  const hasLongWord = words.some((word) => word.length >= 20);

  if (!hasLongWord) {
    return text;
  }

  // Found a long word, log it and split using ChatGPT
  const longWords = words.filter((word) => word.length >= 20);
  deps.logger.log(
    color.yellow.bold(
      `Found long ${type} word(s) >= 20 characters: ${color.white.bold(
        longWords.join(', ')
      )} in "${color.white.bold(text)}"`
    )
  );

  // Process each long word
  let sanitizedText = text;
  for (const longWord of longWords) {
    const segments = await deps.openai.splitArtistOrString(longWord, type);
    const splitWord = segments.join(' ');

    deps.logger.log(
      color.green.bold(
        `Split long ${type} word "${color.white.bold(
          longWord
        )}" into: "${color.white.bold(splitWord)}"`
      )
    );

    // Replace the long word with the split version
    sanitizedText = sanitizedText.replace(longWord, splitWord);
  }

  return sanitizedText;
}

export async function findAndUpdateTrackByISRC(
  deps: DataDeps,
  isrc: string,
  trackId: number
): Promise<{ wasUpdated: boolean; method: string }> {
  // First try finding a track with matching ISRC (only if ISRC is provided)
  if (isrc) {
    const existingTrackByISRC = await deps.prisma.track.findFirst({
      where: {
        isrc: isrc,
        year: {
          not: null,
        },
        manuallyChecked: true,
      },
      select: {
        id: true,
        year: true,
        yearSource: true,
        certainty: true,
        reasoning: true,
        spotifyLink: true,
        deezerLink: true,
        youtubeMusicLink: true,
        appleMusicLink: true,
        amazonMusicLink: true,
        tidalLink: true,
        musicFetchLastAttempt: true,
        musicFetchAttempts: true,
      },
    });

    if (existingTrackByISRC) {
      // Check if target track has empty spotifyLink
      const targetTrack = await deps.prisma.track.findUnique({
        where: { id: trackId },
        select: { spotifyLink: true },
      });

      await deps.prisma.track.update({
        where: { id: trackId },
        data: {
          year: existingTrackByISRC.year,
          yearSource: 'otherTrack_' + existingTrackByISRC.yearSource,
          certainty: existingTrackByISRC.certainty,
          reasoning: existingTrackByISRC.reasoning,
          manuallyChecked: true,
          spotifyLink: !targetTrack?.spotifyLink
            ? existingTrackByISRC.spotifyLink
            : undefined,
          deezerLink: existingTrackByISRC.deezerLink,
          youtubeMusicLink: existingTrackByISRC.youtubeMusicLink,
          appleMusicLink: existingTrackByISRC.appleMusicLink,
          amazonMusicLink: existingTrackByISRC.amazonMusicLink,
          tidalLink: existingTrackByISRC.tidalLink,
          musicFetchLastAttempt: existingTrackByISRC.musicFetchLastAttempt,
          musicFetchAttempts: existingTrackByISRC.musicFetchAttempts,
        },
      });
      return { wasUpdated: true, method: 'isrc' };
    }
  }

  // If no ISRC or no ISRC match, try finding tracks with matching artist and title
  const currentTrack = await deps.prisma.track.findUnique({
    where: { id: trackId },
    select: { artist: true, name: true, spotifyLink: true },
  });

  if (currentTrack) {
    // Use case-insensitive matching for artist and title (normalized like TrackEnrichment)
    const artistLower = currentTrack.artist.toLowerCase().trim();
    const nameLower = currentTrack.name.toLowerCase().trim();

    // First, only fetch IDs and year to minimize data transfer
    // Using raw SQL for case-insensitive matching
    const existingTracksByMetadata = await deps.prisma.$queryRaw<
      { id: number; year: number }[]
    >`
      SELECT id, year
      FROM tracks
      WHERE LOWER(TRIM(artist)) = ${artistLower}
        AND LOWER(TRIM(name)) = ${nameLower}
        AND year IS NOT NULL
        AND manuallyChecked = true
        AND id != ${trackId}
    `;

    if (existingTracksByMetadata.length === 1) {
      // Only one match found, fetch full track details
      const matchedTrack = await deps.prisma.track.findUnique({
        where: { id: existingTracksByMetadata[0].id },
        select: {
          year: true,
          yearSource: true,
          certainty: true,
          reasoning: true,
          spotifyLink: true,
          deezerLink: true,
          youtubeMusicLink: true,
          appleMusicLink: true,
          amazonMusicLink: true,
          tidalLink: true,
          musicFetchLastAttempt: true,
          musicFetchAttempts: true,
        },
      });

      if (matchedTrack) {
        await deps.prisma.track.update({
          where: { id: trackId },
          data: {
            year: matchedTrack.year,
            yearSource: 'otherTrack_metadata_' + matchedTrack.yearSource,
            certainty: matchedTrack.certainty,
            reasoning: matchedTrack.reasoning,
            manuallyChecked: true,
            spotifyLink: !currentTrack.spotifyLink
              ? matchedTrack.spotifyLink
              : undefined,
            deezerLink: matchedTrack.deezerLink,
            youtubeMusicLink: matchedTrack.youtubeMusicLink,
            appleMusicLink: matchedTrack.appleMusicLink,
            amazonMusicLink: matchedTrack.amazonMusicLink,
            tidalLink: matchedTrack.tidalLink,
            musicFetchLastAttempt: matchedTrack.musicFetchLastAttempt,
            musicFetchAttempts: matchedTrack.musicFetchAttempts,
          },
        });
        return { wasUpdated: true, method: 'artistTitle' };
      }
    } else if (existingTracksByMetadata.length > 1) {
      // Check if all matches have the same year
      const years = new Set(existingTracksByMetadata.map((t) => t.year));
      if (years.size === 1) {
        // All matches have the same year, fetch full details for the first one
        const matchedTrack = await deps.prisma.track.findUnique({
          where: { id: existingTracksByMetadata[0].id },
          select: {
            year: true,
            yearSource: true,
            certainty: true,
            reasoning: true,
            spotifyLink: true,
            deezerLink: true,
            youtubeMusicLink: true,
            appleMusicLink: true,
            amazonMusicLink: true,
            tidalLink: true,
            musicFetchLastAttempt: true,
            musicFetchAttempts: true,
          },
        });

        if (matchedTrack) {
          await deps.prisma.track.update({
            where: { id: trackId },
            data: {
              year: matchedTrack.year,
              yearSource:
                'otherTrack_metadata_multiple_' + matchedTrack.yearSource,
              certainty: matchedTrack.certainty,
              reasoning: matchedTrack.reasoning,
              manuallyChecked: true,
              spotifyLink: !currentTrack.spotifyLink
                ? matchedTrack.spotifyLink
                : undefined,
              deezerLink: matchedTrack.deezerLink,
              youtubeMusicLink: matchedTrack.youtubeMusicLink,
              appleMusicLink: matchedTrack.appleMusicLink,
              amazonMusicLink: matchedTrack.amazonMusicLink,
              tidalLink: matchedTrack.tidalLink,
              musicFetchLastAttempt: matchedTrack.musicFetchLastAttempt,
              musicFetchAttempts: matchedTrack.musicFetchAttempts,
            },
          });
          return { wasUpdated: true, method: 'artistTitle_multiple' };
        }
      } else {
        // Multiple matches with different years - don't update but notify
        deps.logger.log(
          color.yellow.bold(
            `Same track with different years found (${color.white.bold(
              currentTrack.artist
            )} - ${color.white.bold(currentTrack.name)}).`
          )
        );
        console.log(existingTracksByMetadata);
      }
    }
  }

  return { wasUpdated: false, method: '' };
}

export async function getTracks(deps: DataDeps, playlistId: number, userId: number = 0): Promise<any> {
  // Note: COALESCE(NULLIF(tei.column, ''), tracks.column) is used for string fields
  // to handle cases where extra info might be an empty string instead of NULL.
  // For numeric fields like year, COALESCE(tei.year, tracks.year) is sufficient.
  const tracks = await deps.prisma.$queryRaw`
      SELECT
          tracks.id,
          tracks.trackId,
          COALESCE(NULLIF(tei.artist, ''), tracks.artist) as artist,
          COALESCE(tei.year, tracks.year) as year,
          COALESCE(NULLIF(tei.name, ''), tracks.name) as name,
          tei.extraNameAttribute,
          tei.extraArtistAttribute,
          (
              SELECT php.id
              FROM payment_has_playlist php
              INNER JOIN payments p ON php.paymentId = p.id
              WHERE
                  php.playlistId = playlist_has_tracks.playlistId
                  AND (${userId} > 0 AND p.userId = ${userId} OR ${userId} = 0)
              LIMIT 1
          ) as paymentHasPlaylistId
      FROM tracks
      INNER JOIN playlist_has_tracks ON tracks.id = playlist_has_tracks.trackId
      LEFT JOIN trackextrainfo tei ON tei.trackId = tracks.id AND tei.playlistId = ${playlistId}
      WHERE playlist_has_tracks.playlistId = ${playlistId}
      ORDER BY playlist_has_tracks.order ASC`;

  return tracks;
}

export async function getTrackById(deps: DataDeps, trackId: number): Promise<any> {
  const track = await deps.prisma.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      artist: true,
      name: true,
      year: true,
      spotifyLink: true,
      youtubeMusicLink: true,
      appleMusicLink: true,
      tidalLink: true,
      deezerLink: true,
      amazonMusicLink: true,
    },
  });
  return track;
}

export async function updateTrack(
  deps: DataDeps,
  id: number,
  artist: string,
  name: string,
  year: number,
  spotifyLink: string,
  youtubeMusicLink: string,
  appleMusicLink: string,
  tidalLink: string,
  deezerLink: string,
  amazonMusicLink: string,
  clientIp: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const sanitizedTitle = await sanitizeTitleOrArtist(deps, name, 'title');
    const sanitizedArtist = await sanitizeTitleOrArtist(
      deps,
      artist,
      'artist'
    );

    await deps.prisma.track.update({
      where: { id },
      data: {
        artist: sanitizedArtist,
        name: sanitizedTitle,
        year,
        spotifyLink,
        youtubeMusicLink,
        appleMusicLink,
        tidalLink,
        deezerLink,
        amazonMusicLink,
        manuallyCorrected: true,
      },
    });
    // Get the link again, but without the cache
    await getLink(deps, id, clientIp, false);
    await checkUnfinalizedPayments(deps);

    // Clear cache for any featured playlists containing this track
    const featuredPlaylistsWithTrack = await deps.prisma.playlist.findMany({
      where: {
        featured: true,
        tracks: {
          some: {
            trackId: id,
          },
        },
      },
      select: {
        playlistId: true,
      },
    });

    for (const playlist of featuredPlaylistsWithTrack) {
      await clearPlaylistCache(deps, playlist.playlistId);
      deps.logger.log(
        color.blue.bold(
          `Cleared featured playlist cache for ${playlist.playlistId} after track ${id} update`
        )
      );
    }

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Failed to update track ${id}: ${error?.message}`)
    );
    return {
      success: false,
      error: error?.message || 'Unknown database error',
    };
  }
}

export async function storeTracks(
  deps: DataDeps,
  playlistDatabaseId: number,
  playlistId: string,
  tracks: any,
  trackOrder?: Map<string, number>,
  serviceType: string = 'spotify'
): Promise<any> {
  // Filter out any tracks with null/undefined artists or episode URLs (podcast episodes)
  const validTracks = tracks.filter((track: any) => {
    if (!track.artist) {
      deps.logger.log(
        color.yellow.bold(
          `Skipping track '${track.name || track.id}' - missing artist`
        )
      );
      return false;
    }
    // Filter out podcast episodes
    if (track.link?.includes('/episode/') || track.spotifyLink?.includes('/episode/')) {
      deps.logger.log(
        color.yellow.bold(
          `Skipping episode '${track.name || track.id}' - not a music track`
        )
      );
      return false;
    }
    return true;
  });

  const providedTrackIds = validTracks.map((track: any) => track.id);

  deps.logger.log(
    color.blue.bold(
      `Deleting removed tracks from playlist ${color.white.bold(playlistId)}`
    )
  );

  // Remove tracks that are no longer in the provided tracks list
  await deps.prisma.$executeRaw`
    DELETE FROM playlist_has_tracks
    WHERE playlistId = ${playlistDatabaseId}
    AND trackId NOT IN (
      SELECT id FROM tracks
      WHERE trackId IN (${Prisma.join(providedTrackIds)})
    )
  `;

  deps.logger.log(
    color.blue.bold(
      `Bulk upsert tracks for playlist ${color.white.bold(playlistId)}`
    )
  );

  // Step 1: Identify existing tracks with full data
  const existingTracks = await deps.prisma.track.findMany({
    where: {
      trackId: { in: providedTrackIds },
    },
    select: {
      trackId: true,
      name: true,
      isrc: true,
      artist: true,
      spotifyLink: true,
      album: true,
      preview: true,
      manuallyCorrected: true,
    },
  });

  deps.logger.log(
    color.blue.bold(
      `Existing tracks: ${color.white.bold(existingTracks.length)}`
    )
  );

  // Convert existing tracks to a Map for quick lookup
  const existingTrackMap = new Map(
    existingTracks.map((track) => [track.trackId, track])
  );

  // Map service types to their corresponding link field names
  const serviceLinkFieldMap: Record<string, string> = {
    spotify: 'spotifyLink',
    youtube_music: 'youtubeMusicLink',
    apple_music: 'appleMusicLink',
    deezer: 'deezerLink',
    tidal: 'tidalLink',
    amazon_music: 'amazonMusicLink',
  };
  const linkField = serviceLinkFieldMap[serviceType] || 'spotifyLink';

  // Step 2: Separate new and existing tracks, and check for changes
  const newTracks = [];
  const tracksToUpdate = [];

  for (const track of validTracks) {
    const existingTrack = existingTrackMap.get(track.id);
    if (existingTrack) {
      // Check if any data has changed (only compare spotifyLink for Spotify tracks)
      const linkChanged = linkField === 'spotifyLink'
        ? existingTrack.spotifyLink !== (track.link || track.serviceLink)
        : false;

      if (
        existingTrack.name !== deps.utils.cleanTrackName(track.name) ||
        existingTrack.isrc !== track.isrc ||
        existingTrack.album !== deps.utils.cleanTrackName(track.album) ||
        existingTrack.preview !== track.preview ||
        existingTrack.artist !== track.artist ||
        linkChanged
      ) {
        if (!existingTrack.manuallyCorrected) {
          tracksToUpdate.push(track);
        }
      }
    } else {
      newTracks.push(track);
    }
  }

  deps.logger.log(
    color.blue.bold(
      `Inserting new tracks: ${color.white.bold(newTracks.length)}`
    )
  );

  // Step 3: Insert new tracks
  if (newTracks.length > 0) {
    // First sanitize and create the tracks
    const sanitizedTracksData = await Promise.all(
      newTracks.map(async (track) => {
        const sanitizedTitle = await sanitizeTitleOrArtist(
          deps,
          deps.utils.cleanTrackName(track.name),
          'title'
        );
        const sanitizedArtist = await sanitizeTitleOrArtist(
          deps,
          track.artist,
          'artist'
        );

        // Determine the service link from track data
        const serviceLink = track.serviceLink || track.link;

        return {
          trackId: track.id,
          name: sanitizedTitle,
          isrc: track.isrc,
          artist: sanitizedArtist,
          // Store link in the appropriate field based on service type
          [linkField]: serviceLink,
          album: deps.utils.cleanTrackName(track.album),
          preview: track.preview,
        };
      })
    );

    await deps.prisma.track.createMany({
      data: sanitizedTracksData,
      skipDuplicates: true,
    });
  }

  deps.logger.log(
    color.blue.bold(
      `Updating tracks: ${color.white.bold(tracksToUpdate.length)}`
    )
  );

  // Update existing tracks
  for (const track of tracksToUpdate) {
    if (!track.manuallyCorrected) {
      const existingTrack = await deps.prisma.track.findUnique({
        where: { trackId: track.id },
        select: { youtubeLink: true },
      });

      const sanitizedTitle = await sanitizeTitleOrArtist(
        deps,
        deps.utils.cleanTrackName(track.name),
        'title'
      );
      const sanitizedArtist = await sanitizeTitleOrArtist(
        deps,
        track.artist,
        'artist'
      );

      const updateData: any = {
        name: sanitizedTitle,
        isrc: track.isrc,
        artist: sanitizedArtist,
        spotifyLink: track.link,
        album: deps.utils.cleanTrackName(track.album),
        preview: track.preview,
      };

      await deps.prisma.track.update({
        where: { trackId: track.id },
        data: updateData,
      });
    }
  }

  deps.logger.log(
    color.blue.bold(
      `Creating playlist_has_tracks records for playlist ${color.white.bold(
        playlistId
      )}`
    )
  );

  // Bulk insert playlist_has_tracks with order
  if (trackOrder && trackOrder.size > 0) {
    // Build CASE statement for order
    const orderCases: Prisma.Sql[] = [];
    for (const [trackId, order] of trackOrder.entries()) {
      orderCases.push(Prisma.sql`WHEN trackId = ${trackId} THEN ${order}`);
    }

    await deps.prisma.$executeRaw`
      INSERT IGNORE INTO playlist_has_tracks (playlistId, trackId, \`order\`)
      SELECT ${playlistDatabaseId}, id,
        CASE
          ${Prisma.join(orderCases, ' ')}
          ELSE 0
        END as \`order\`
      FROM tracks
      WHERE trackId IN (${Prisma.join(providedTrackIds)})
    `;

    // Update order for existing tracks (INSERT IGNORE skips these)
    // Need qualified column names for UPDATE with JOIN
    const updateOrderCases: Prisma.Sql[] = [];
    for (const [trackId, order] of trackOrder.entries()) {
      updateOrderCases.push(
        Prisma.sql`WHEN t.trackId = ${trackId} THEN ${order}`
      );
    }
    await deps.prisma.$executeRaw`
      UPDATE playlist_has_tracks pht
      INNER JOIN tracks t ON pht.trackId = t.id
      SET pht.\`order\` = CASE
        ${Prisma.join(updateOrderCases, ' ')}
        ELSE pht.\`order\`
      END
      WHERE pht.playlistId = ${playlistDatabaseId}
        AND t.trackId IN (${Prisma.join(providedTrackIds)})
    `;

    deps.logger.log(
      color.green.bold(
        `Stored playlist_has_tracks with track order for ${color.white.bold(
          providedTrackIds.length
        )} tracks`
      )
    );
  } else {
    // Original behavior without order
    await deps.prisma.$executeRaw`
      INSERT IGNORE INTO playlist_has_tracks (playlistId, trackId)
      SELECT ${playlistDatabaseId}, id
      FROM tracks
      WHERE trackId IN (${Prisma.join(providedTrackIds)})
    `;
  }

  deps.logger.log(
    color.blue.bold(
      `Updating years for playlist ${color.white.bold(playlistId)}`
    )
  );

  await updateTrackYear(deps, providedTrackIds, tracks);
}

export async function searchTracks(
  deps: DataDeps,
  searchTerm: string,
  missingService?: string,
  playlistItemId?: number,
  page: number = 1,
  limit: number = 50
): Promise<{ tracks: any[]; total: number; page: number; totalPages: number }> {
  const conditions: Prisma.Sql[] = [];
  const hasSearch = searchTerm && searchTerm.trim().length > 0;
  const validService = missingService && serviceColumnMap[missingService];
  const safePlaylistItemId = playlistItemId ? Number(playlistItemId) : 0;

  if (hasSearch) {
    const likePattern = `%${searchTerm}%`;
    conditions.push(Prisma.sql`(t.artist LIKE ${likePattern} OR t.name LIKE ${likePattern})`);
  }

  if (validService) {
    const col = serviceColumnMap[missingService!];
    conditions.push(Prisma.sql`(${Prisma.raw(`t.${col}`)} IS NULL OR ${Prisma.raw(`t.${col}`)} = '')`);
  }

  let joinFragment = Prisma.sql``;
  if (safePlaylistItemId) {
    joinFragment = Prisma.sql`JOIN playlist_has_tracks pht ON pht.trackId = t.id
      AND pht.playlistId = (SELECT playlistId FROM payment_has_playlist WHERE id = ${safePlaylistItemId})`;
  }

  const whereFragment = conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.sql``;

  const offset = (page - 1) * limit;

  const [tracks, countResult] = await Promise.all([
    deps.prisma.$queryRaw<any[]>`
      SELECT DISTINCT t.id, t.artist, t.name, t.year, t.youtubeLink, t.spotifyLink, t.youtubeMusicLink, t.appleMusicLink, t.tidalLink, t.deezerLink, t.amazonMusicLink, t.spotifyLinkIgnored
      FROM tracks t
      ${joinFragment}
      ${whereFragment}
      ORDER BY t.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    deps.prisma.$queryRaw<any[]>`
      SELECT COUNT(DISTINCT t.id) as total
      FROM tracks t
      ${joinFragment}
      ${whereFragment}
    `,
  ]);

  const total = Number(countResult[0]?.total || 0);

  return {
    tracks,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getTracksMissingSpotifyLink(
  deps: DataDeps,
  searchTerm: string = ''
): Promise<any[]> {
  if (searchTerm && searchTerm.trim().length > 0) {
    const likePattern = `%${searchTerm}%`;
    const tracks = await deps.prisma.$queryRaw<any[]>`
      SELECT id, artist, name, year, spotifyLink, youtubeMusicLink, appleMusicLink, tidalLink, deezerLink, spotifyLinkIgnored
      FROM tracks
      WHERE (spotifyLink IS NULL OR spotifyLink = '')
      AND spotifyLinkIgnored = false
      AND (artist LIKE ${likePattern} OR name LIKE ${likePattern})
      ORDER BY id DESC
      LIMIT 100
    `;
    return tracks;
  } else {
    const tracks = await deps.prisma.$queryRaw<any[]>`
      SELECT id, artist, name, year, spotifyLink, youtubeMusicLink, appleMusicLink, tidalLink, deezerLink, spotifyLinkIgnored
      FROM tracks
      WHERE (spotifyLink IS NULL OR spotifyLink = '')
      AND spotifyLinkIgnored = false
      ORDER BY id DESC
      LIMIT 100
    `;
    return tracks;
  }
}

export async function getTracksMissingSpotifyLinkCount(deps: DataDeps): Promise<number> {
  const result = await deps.prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) as count
    FROM tracks
    WHERE (spotifyLink IS NULL OR spotifyLink = '')
    AND spotifyLinkIgnored = false
  `;
  return Number(result[0]?.count ?? 0);
}

export async function toggleSpotifyLinkIgnored(deps: DataDeps, trackId: number): Promise<{ spotifyLinkIgnored: boolean }> {
  const track = await deps.prisma.track.findUnique({ where: { id: trackId }, select: { spotifyLinkIgnored: true } });
  if (!track) throw new Error('Track not found');
  const updated = await deps.prisma.track.update({
    where: { id: trackId },
    data: { spotifyLinkIgnored: !track.spotifyLinkIgnored },
    select: { spotifyLinkIgnored: true },
  });
  return updated;
}
