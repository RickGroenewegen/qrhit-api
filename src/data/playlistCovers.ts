import { color } from 'console-log-colors';
import { CACHE_KEY_FEATURED_PLAYLISTS } from './featuredPlaylists';
import { DataDeps } from './types';

/**
 * Featured playlist covers.
 *
 * `playlists.image` is a URL on the music service's CDN, stored when the row
 * is created. When the owner of a playlist changes its cover, Spotify deletes
 * the old file and that stored URL starts answering 404. The product page
 * never noticed, because it shows the cover from a live playlist lookup, but
 * `/featured` reads the column: the playlist list showed a broken image for a
 * playlist whose product page looked fine.
 *
 * Two things keep the column honest. `syncFeaturedPlaylistCover` is called by
 * every live lookup of a featured playlist, so the column follows the service.
 * `repairFeaturedPlaylistCovers` is the nightly sweep for covers nobody looked
 * up: it asks the CDN (a HEAD per cover, no music service quota) and only
 * re-fetches the playlists whose cover is actually gone.
 */

const CHECK_CONCURRENCY = 8;
const CHECK_TIMEOUT_MS = 10000;

export interface CoverPlaylist {
  id: number;
  slug: string;
  playlistId: string;
  serviceType: string;
  image: string;
}

export type CoverCheck = (url: string) => Promise<boolean>;
/** Returns the cover the music service serves today, or null when unknown. */
export type CoverFetch = (playlist: CoverPlaylist) => Promise<string | null>;

/**
 * False only when the CDN says the file is gone. A timeout or a 5xx says
 * nothing about the cover, and re-fetching hundreds of playlists because a
 * CDN had a bad minute would burn the music service quota for nothing.
 */
export async function coverIsAlive(deps: DataDeps, url: string): Promise<boolean> {
  try {
    const response = await deps.axiosInstance.head(url, {
      timeout: CHECK_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return response.status < 400 || response.status >= 500;
  } catch {
    return true;
  }
}

/**
 * Stores the cover a live lookup just returned, when it differs from the
 * column. Returns true when the row changed.
 */
export async function syncFeaturedPlaylistCover(
  deps: DataDeps,
  playlist: { id: number; slug?: string | null; image?: string | null },
  freshImage: string | null | undefined
): Promise<boolean> {
  if (!freshImage || freshImage === playlist.image) {
    return false;
  }

  await deps.prisma.playlist.update({
    where: { id: playlist.id },
    data: { image: freshImage },
  });
  await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

  deps.logger.log(
    color.blue.bold(
      `Updated cover of featured playlist ${color.white.bold(playlist.slug || playlist.id)}`
    )
  );
  return true;
}

export async function repairFeaturedPlaylistCovers(
  deps: DataDeps,
  fetchCover: CoverFetch,
  isAlive: CoverCheck = (url) => coverIsAlive(deps, url)
): Promise<{ checked: number; dead: number; repaired: number; unresolved: string[] }> {
  // A custom image is served by us and wins over `image` everywhere, so those
  // rows cannot show a dead cover.
  const playlists = (await deps.prisma.playlist.findMany({
    where: { featured: true, featuredHidden: false, customImage: null },
    select: { id: true, slug: true, playlistId: true, serviceType: true, image: true },
  })) as CoverPlaylist[];

  const candidates = playlists.filter((p) => /^https?:\/\//.test(p.image || ''));
  const dead: CoverPlaylist[] = [];

  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const playlist = candidates[next++];
      if (!(await isAlive(playlist.image))) {
        dead.push(playlist);
      }
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));

  let repaired = 0;
  const unresolved: string[] = [];

  // One at a time: each of these is a real call to the music service.
  for (const playlist of dead) {
    let fresh: string | null = null;
    try {
      fresh = await fetchCover(playlist);
    } catch (error: any) {
      deps.logger.log(
        color.red.bold(
          `Error fetching cover of ${color.white.bold(playlist.slug)}: ${error.message}`
        )
      );
    }

    // The same dead URL back means the lookup was served from somewhere stale.
    if (fresh && fresh !== playlist.image && (await isAlive(fresh))) {
      await syncFeaturedPlaylistCover(deps, playlist, fresh);
      repaired++;
    } else {
      unresolved.push(playlist.slug);
    }
  }

  if (dead.length === 0) {
    deps.logger.log(
      color.green.bold(
        `Featured playlist covers: all ${color.white.bold(candidates.length)} reachable`
      )
    );
  } else {
    deps.logger.log(
      color.yellow.bold(
        `Featured playlist covers: ${color.white.bold(dead.length)} of ${color.white.bold(
          candidates.length
        )} dead, ${color.white.bold(repaired)} repaired`
      )
    );
  }
  if (unresolved.length > 0) {
    deps.logger.log(
      color.red.bold(
        `Featured playlist covers still dead, upload a custom image: ${color.white.bold(
          unresolved.join(', ')
        )}`
      )
    );
  }

  return { checked: candidates.length, dead: dead.length, repaired, unresolved };
}
