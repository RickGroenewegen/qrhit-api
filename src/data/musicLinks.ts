import { color } from 'console-log-colors';
import { ApiResult } from '../interfaces/ApiResult';
import { serviceColumnMap, serviceCheckedColumnMap, serviceTypeMap } from '../providers/MusicProviderFactory';
import { DataDeps } from './types';

export const TRACK_LINKS_CACHE_PREFIX = 'track_links_v6';

export async function getYouTubeLink(
  deps: DataDeps,
  artist: string,
  name: string
): Promise<string | null> {
  return null;
  try {
    // First try YouTube Music API
    const ytMusicOptions = {
      method: 'GET',
      url: 'https://youtube-music-api-yt.p.rapidapi.com/search-songs',
      params: {
        q: `${artist} ${name}`,
      },
      headers: {
        'x-rapidapi-key': process.env['RAPID_API_KEY'],
        'x-rapidapi-host': 'youtube-music-api-yt.p.rapidapi.com',
      },
    };

    const ytMusicResponse = await deps.axiosInstance.request(ytMusicOptions);

    if (ytMusicResponse.data && ytMusicResponse.data.length > 0) {
      // Try to find exact match with artist and title
      const matchingVideo = ytMusicResponse.data.find((video: any) => {
        const videoArtist = video.artist?.name?.toLowerCase() || '';
        const videoTitle = video.name?.toLowerCase() || '';
        return (
          videoArtist.includes(artist.toLowerCase()) &&
          videoTitle.includes(name.toLowerCase())
        );
      });

      if (matchingVideo) {
        deps.logger.log(
          color.blue.bold(
            `Found YouTube Music link for '${color.white.bold(
              artist
            )} - ${color.white.bold(
              name
            )}' using YT Music API: ${color.white.bold(
              'https://music.youtube.com/watch?v=' + matchingVideo.videoId
            )}`
          )
        );
        return matchingVideo.videoId;
      }
    }

    // Fall back to original search if no match found
    const searchOptions = {
      method: 'GET',
      url: 'https://yt-search-and-download-mp3.p.rapidapi.com/search',
      params: {
        q: `${artist} - ${name}`,
        limit: 10,
      },
      headers: {
        'x-rapidapi-key': process.env['RAPID_API_KEY'],
        'x-rapidapi-host': 'yt-search-and-download-mp3.p.rapidapi.com',
      },
    };

    const response = await deps.axiosInstance.request(searchOptions);

    if (
      response.data &&
      response.data.videos &&
      response.data.videos.length > 0
    ) {
      // Find first video where both artist and name appear in the video title
      const matchingVideo = response.data.videos.find(
        (video: any) =>
          video.name.toLowerCase().includes(artist.toLowerCase()) &&
          video.name.toLowerCase().includes(name.toLowerCase())
      );

      if (matchingVideo) {
        deps.logger.log(
          color.blue.bold(
            `Found YouTube Movie link for '${color.white.bold(
              artist
            )} - ${color.white.bold(name)}': ${color.white.bold(
              'https://music.youtube.com/watch?v=' + matchingVideo.id
            )}`
          )
        );
        return matchingVideo.id;
      } else {
        deps.logger.log(
          color.yellow.bold(
            `No exact match found for '${color.white.bold(
              artist
            )} - ${color.white.bold(name)}'`
          )
        );
      }
    }
    return null;
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error getting YouTube link for track ${color.white.bold(
          artist
        )} - ${color.white.bold(name)}`
      )
    );
    console.log(error);
  }
  return null;
}

export async function addSpotifyLinks(deps: DataDeps): Promise<number> {
  let processed = 0;

  // Get all tracks without youtube links
  const tracks = await deps.prisma.track.findMany({
    where: {
      youtubeLink: null,
      spotifyLink: {
        not: null,
      },
    },
    select: {
      id: true,
      artist: true,
      name: true,
      spotifyLink: true,
    },
  });

  deps.logger.log(
    color.blue.bold(
      `Found ${color.white.bold(tracks.length)} tracks without YouTube links`
    )
  );

  for (const track of tracks) {
    try {
      // Extract Spotify track ID from link
      const spotifyId = track.spotifyLink!.split('/').pop()!;

      // Get YouTube Music URL
      const youtubeId = await getYouTubeLink(deps, track.artist, track.name);

      if (youtubeId) {
        await deps.prisma.track.update({
          where: { id: track.id },
          data: { youtubeLink: youtubeId },
        });
        processed++;
      }
    } catch (error) {
      deps.logger.log(
        color.red.bold(
          `Error processing track '${color.white.bold(
            track.artist
          )} - ${color.white.bold(track.name)}': ${error}`
        )
      );
    }

    // Add a small delay to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return processed;
}

export async function prefillLinkCache(deps: DataDeps): Promise<void> {
  // First, delete all old track_links_v* cache entries using non-blocking SCAN
  deps.logger.log(
    color.blue.bold('Deleting old track_links_v* cache entries...')
  );
  const deletedCount = await deps.cache.delPatternNonBlocking('track_links_v*');
  deps.logger.log(
    color.blue.bold(
      `Deleted ${color.white.bold(deletedCount)} old track_links_v* cache entries`
    )
  );

  const tracks = await deps.prisma.track.findMany({
    select: {
      id: true,
      spotifyLink: true,
      youtubeLink: true,
      youtubeMusicLink: true,
      appleMusicLink: true,
      amazonMusicLink: true,
      deezerLink: true,
      tidalLink: true,
    },
    where: {
      spotifyLink: {
        not: '',
      },
    },
  });

  let cacheCount = 0;
  for (const track of tracks) {
    if (track.spotifyLink) {
      const data = {
        link: track.spotifyLink,
        youtubeLink: track.youtubeLink,
        youtubeMusicLink: track.youtubeMusicLink,
        appleMusicLink: track.appleMusicLink,
        amazonMusicLink: track.amazonMusicLink,
        deezerLink: track.deezerLink,
        tidalLink: track.tidalLink,
      };
      await deps.cache.set(
        `${TRACK_LINKS_CACHE_PREFIX}:${track.id}`,
        JSON.stringify(data)
      );
      cacheCount++;
    }
  }
}

export async function logLink(
  deps: DataDeps,
  trackId: number,
  clientIp: string,
  php?: number
): Promise<void> {
  const ipInfo = await deps.utils.lookupIp(clientIp);
  const ipInfoWithTrackId = {
    ...ipInfo,
    trackId,
    timestamp: new Date().toISOString(),
    php,
  };
  // Store the IP info in a list and maintain only the last 100 entries
  const ipInfoListKey = 'ipInfoList';
  await deps.cache.executeCommand(
    'lpush',
    ipInfoListKey,
    JSON.stringify(ipInfoWithTrackId)
  );
  await deps.cache.executeCommand('ltrim', ipInfoListKey, 0, 999); // Keep only the last 100 entries
}

export async function getLink(
  deps: DataDeps,
  trackId: number,
  clientIp: string,
  useCache: boolean = true,
  userAgent?: string,
  php?: number
): Promise<ApiResult> {
  deps.analytics.increaseCounter('songs', 'played');
  logLink(deps, trackId, clientIp, php);

  // Log IP, trackId, and user agent
  deps.logger.log(
    color.blue.bold(
      `Link called for track ${color.white.bold(
        trackId
      )}${php ? `, php=${color.white.bold(php)}` : ''}, ip=${color.white.bold(clientIp)}, userAgent=${color.white.bold(
        userAgent || 'unknown'
      )}`
    )
  );

  // Wait for blocked playlists to be initialized
  if (!deps.blockedPlaylistsInitialized) {
    deps.logger.log(
      color.yellow.bold('Waiting for blocked playlists to initialize...')
    );
    // Poll until initialized (should be very quick)
    while (!deps.blockedPlaylistsInitialized) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  // Check if the playlist is blocked
  if (php && deps.blockedPlaylists.has(Number(php))) {
    deps.logger.log(
      color.red.bold(
        `Blocked playlist access attempt for PaymentHasPlaylist ID ${color.white.bold(
          php
        )}`
      )
    );
    return {
      success: false,
      error: 'This playlist has been blocked',
    };
  }

  const cacheKey = `${TRACK_LINKS_CACHE_PREFIX}:${trackId}`;
  const cachedData = await deps.cache.get(cacheKey);

  let data: any = null;

  if (cachedData && useCache) {
    data = JSON.parse(cachedData);
  } else {
    const linkQuery: any[] = await deps.prisma.$queryRaw`
      SELECT spotifyLink, youtubeLink, youtubeMusicLink, appleMusicLink, amazonMusicLink, deezerLink, tidalLink
      FROM tracks
      WHERE id = ${trackId}`;

    if (linkQuery.length > 0) {
      data = {
        link: linkQuery[0].spotifyLink,
        youtubeLink: linkQuery[0].youtubeLink,
        youtubeMusicLink: linkQuery[0].youtubeMusicLink,
        appleMusicLink: linkQuery[0].appleMusicLink,
        amazonMusicLink: linkQuery[0].amazonMusicLink,
        deezerLink: linkQuery[0].deezerLink,
        tidalLink: linkQuery[0].tidalLink,
      };

      if (data.link) {
        await deps.cache.set(cacheKey, JSON.stringify(data));
      }

      if (!useCache) {
        deps.logger.log(
          color.blue.bold(
            `Refreshed cache for track ${color.white.bold(
              trackId
            )}: ${color.white.bold(data.link)}`
          )
        );
      }
    }
  }


  if (data) {
    // Get theme and service type from in-memory mapping if php is provided



    if (php) {
      const themeData = deps.appTheme.getTheme(Number(php));


      if (themeData) {
        if (themeData.s) {
          data.t = { s: themeData.s, n: themeData.n };
        }
        data.st = themeData.st;
      }
    }

    return {
      success: true,
      data,
    };
  }

  return {
    success: false,
  };
}

export async function getPlaylistLinkCoverage(deps: DataDeps, playlistId: number): Promise<{
  spotify: number;
  appleMusic: number;
  youtubeMusic: number;
  tidal: number;
  deezer: number;
  totalTracks: number;
}> {
  const cacheKey = `playlist_link_coverage_v1:${playlistId}`;
  const cachedData = await deps.cache.get(cacheKey);

  if (cachedData) {
    return JSON.parse(cachedData);
  }

  const result = await deps.prisma.$queryRaw<
    {
      totalTracks: bigint;
      spotifyCount: bigint;
      appleMusicCount: bigint;
      youtubeMusicCount: bigint;
      tidalCount: bigint;
      deezerCount: bigint;
    }[]
  >`
    SELECT
      COUNT(*) as totalTracks,
      SUM(CASE WHEN t.spotifyLink IS NOT NULL AND t.spotifyLink != '' THEN 1 ELSE 0 END) as spotifyCount,
      SUM(CASE WHEN t.appleMusicLink IS NOT NULL AND t.appleMusicLink != '' THEN 1 ELSE 0 END) as appleMusicCount,
      SUM(CASE WHEN t.youtubeMusicLink IS NOT NULL AND t.youtubeMusicLink != '' THEN 1 ELSE 0 END) as youtubeMusicCount,
      SUM(CASE WHEN t.tidalLink IS NOT NULL AND t.tidalLink != '' THEN 1 ELSE 0 END) as tidalCount,
      SUM(CASE WHEN t.deezerLink IS NOT NULL AND t.deezerLink != '' THEN 1 ELSE 0 END) as deezerCount
    FROM playlist_has_tracks pht
    JOIN tracks t ON pht.trackId = t.id
    WHERE pht.playlistId = ${playlistId}
  `;

  if (!result || result.length === 0) {
    return {
      spotify: 0,
      appleMusic: 0,
      youtubeMusic: 0,
      tidal: 0,
      deezer: 0,
      totalTracks: 0,
    };
  }

  const data = result[0];
  const totalTracks = Number(data.totalTracks || 0);

  const coverage = {
    spotify: totalTracks > 0 ? Math.round((Number(data.spotifyCount || 0) / totalTracks) * 100) : 0,
    appleMusic: totalTracks > 0 ? Math.round((Number(data.appleMusicCount || 0) / totalTracks) * 100) : 0,
    youtubeMusic: totalTracks > 0 ? Math.round((Number(data.youtubeMusicCount || 0) / totalTracks) * 100) : 0,
    tidal: totalTracks > 0 ? Math.round((Number(data.tidalCount || 0) / totalTracks) * 100) : 0,
    deezer: totalTracks > 0 ? Math.round((Number(data.deezerCount || 0) / totalTracks) * 100) : 0,
    totalTracks,
  };

  // Cache for 1 hour
  await deps.cache.set(cacheKey, JSON.stringify(coverage), 3600);

  return coverage;
}

export async function getTracksWithoutMusicLinks(deps: DataDeps, limit: number = 100): Promise<any[]> {
  try {
    const tracks = await deps.prisma.track.findMany({
      where: {
        spotifyLink: { not: null },
        musicFetchAttempts: { lt: 3 },
        OR: [
          { deezerLink: null },
          { youtubeMusicLink: null },
          { appleMusicLink: null },
          { amazonMusicLink: null },
          { tidalLink: null },
        ],
      },
      select: {
        id: true,
        trackId: true,
        name: true,
        artist: true,
        spotifyLink: true,
        deezerLink: true,
        youtubeMusicLink: true,
        appleMusicLink: true,
        amazonMusicLink: true,
        tidalLink: true,
        musicFetchAttempts: true,
        musicFetchLastAttempt: true,
      },
      take: limit,
      orderBy: {
        musicFetchLastAttempt: 'asc', // Prioritize tracks never attempted or attempted longest ago
      },
    });

    return tracks;
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error getting tracks without music links: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
    );
    return [];
  }
}

export async function updateTrackMusicLinks(
  deps: DataDeps,
  trackId: number,
  links: {
    deezerLink?: string | null;
    youtubeMusicLink?: string | null;
    appleMusicLink?: string | null;
    amazonMusicLink?: string | null;
    tidalLink?: string | null;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    await deps.prisma.track.update({
      where: { id: trackId },
      data: {
        deezerLink: links.deezerLink,
        youtubeMusicLink: links.youtubeMusicLink,
        appleMusicLink: links.appleMusicLink,
        amazonMusicLink: links.amazonMusicLink,
        tidalLink: links.tidalLink,
        musicFetchLastAttempt: new Date(),
        musicFetchAttempts: { increment: 1 },
      },
    });

    return { success: true };
  } catch (error) {
    deps.logger.log(
      color.red.bold(
        `Error updating track music links: ${
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

export async function findMissingServiceLinks(
  deps: DataDeps,
  service: string
): Promise<{ success: boolean; total: number; found: number; results: any[]; error?: string }> {
  const columnName = serviceColumnMap[service];
  const serviceType = serviceTypeMap[service];
  const checkedColumn = serviceCheckedColumnMap[service];

  if (!columnName || !serviceType || !checkedColumn) {
    return { success: false, total: 0, found: 0, results: [], error: 'Invalid service. Must be one of: spotify, youtube, deezer, apple, tidal' };
  }

  const tracks: any[] = await deps.prisma.$queryRawUnsafe(
    `SELECT id, artist, name FROM tracks WHERE ${checkedColumn} = 0 AND (${columnName} IS NULL OR ${columnName} = '')`
  );

  if (tracks.length === 0) {
    return { success: true, total: 0, found: 0, results: [] };
  }

  const { default: MusicProviderFactory } = await import('../providers/MusicProviderFactory');
  const factory = MusicProviderFactory.getInstance();
  const provider = factory.getProvider(serviceType);

  if (!provider.config.supportsSearch || !provider.searchTracks) {
    return { success: false, total: 0, found: 0, results: [], error: `${provider.config.displayName} does not support search` };
  }

  const results: { trackId: number; artist: string; title: string; found: boolean; link?: string }[] = [];
  let foundCount = 0;

  deps.logger.log(
    color.blue.bold(
      `[${color.white.bold(service)}] Starting search for ${color.white.bold(String(tracks.length))} tracks with missing links`
    )
  );

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];

    deps.logger.log(
      color.blue.bold(
        `[${color.white.bold(service)}] (${color.white.bold(String(i + 1))} / ${color.white.bold(String(tracks.length))}) Searching for ${color.white.bold(track.artist)} - ${color.white.bold(track.name)}`
      )
    );

    try {
      const searchResult = await provider.searchTracks(track.artist + ' ' + track.name, 10, 0);

      if (searchResult.success && searchResult.data) {
        const match = searchResult.data.tracks.find((t: any) =>
          t.name.toLowerCase().trim() === track.name.toLowerCase().trim() &&
          t.artist.toLowerCase().trim() === track.artist.toLowerCase().trim()
        );

        if (match) {
          await deps.prisma.track.update({
            where: { id: track.id },
            data: { [columnName]: match.serviceLink, [checkedColumn]: true },
          });
          foundCount++;
          results.push({ trackId: track.id, artist: track.artist, title: track.name, found: true, link: match.serviceLink });
          deps.logger.log(
            color.green.bold(
              `[${color.white.bold(service)}] Found link for ${color.white.bold(track.artist)} - ${color.white.bold(track.name)}: ${color.white.bold(match.serviceLink)}`
            )
          );
        } else {
          await deps.prisma.track.update({ where: { id: track.id }, data: { [checkedColumn]: true } });
          results.push({ trackId: track.id, artist: track.artist, title: track.name, found: false });
        }
      } else {
        await deps.prisma.track.update({ where: { id: track.id }, data: { [checkedColumn]: true } });
        results.push({ trackId: track.id, artist: track.artist, title: track.name, found: false });
        deps.logger.log(
          color.yellow.bold(
            `[${color.white.bold(service)}] Search failed for ${color.white.bold(track.artist)} - ${color.white.bold(track.name)}`
          )
        );
      }
    } catch (searchError) {
      await deps.prisma.track.update({ where: { id: track.id }, data: { [checkedColumn]: true } }).catch(() => {});
      results.push({ trackId: track.id, artist: track.artist, title: track.name, found: false });
      deps.logger.log(
        color.red.bold(
          `[${color.white.bold(service)}] Error searching for ${color.white.bold(track.artist)} - ${color.white.bold(track.name)}: ${(searchError as Error).message}`
        )
      );
    }

    // 1-second delay between searches
    if (i < tracks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  deps.logger.log(
    color.blue.bold(
      `[${color.white.bold(service)}] Done! Found ${color.white.bold(String(foundCount))}/${color.white.bold(String(tracks.length))} missing links`
    )
  );

  return { success: true, total: tracks.length, found: foundCount, results };
}
