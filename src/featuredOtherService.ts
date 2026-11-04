import { format } from 'date-fns';
import { ServiceType } from './enums/ServiceType';
import { ApiResult } from './interfaces/ApiResult';
import {
  IMusicProvider,
  ProgressCallback,
  ProviderTrackData,
  ProviderTracksResult,
} from './interfaces/IMusicProvider';
import { Track } from './interfaces/Track';
import AppleMusicProvider from './providers/AppleMusicProvider';
import DeezerProvider from './providers/DeezerProvider';
import TidalProvider from './providers/TidalProvider';
import YouTubeMusicProvider from './providers/YouTubeMusicProvider';

/**
 * A featured playlist made from a playlist on another service than Spotify
 * (Apple Music, YouTube Music, Deezer, Tidal), loaded for its product page.
 *
 * The product page (`/:lang/product/:slug`) has no service in its URL, so it
 * loads every slug through `POST /spotify/playlists(/tracks)` with `slug: 1`.
 * Until 2026-11-04 `Spotify.getPlaylist` then asked Spotify for whatever id
 * the slug stood for, and Spotify answers a `pl.u-…` or `PL…` id with a 400:
 * all 17 non-Spotify product pages showed "we could not retrieve this
 * playlist" (Rick, 2026-11-04). Now the slug path asks the playlist's own
 * service through these helpers and answers in the Spotify route's shape,
 * with the playlist's `serviceType`, so the page knows which service it sells.
 *
 * Kept out of spotify.ts so the providers (and the SpotifyProvider → spotify.ts
 * import) do not form a cycle, and so the mapping can be tested on its own.
 */

export type OtherServiceType = Exclude<ServiceType, ServiceType.SPOTIFY>;

/** The provider of a service other than Spotify; null for Spotify or an unknown value. */
export function otherServiceProvider(serviceType?: string | null): IMusicProvider | null {
  switch (serviceType) {
    case ServiceType.APPLE_MUSIC:
      return AppleMusicProvider.getInstance();
    case ServiceType.YOUTUBE_MUSIC:
      return YouTubeMusicProvider.getInstance();
    case ServiceType.DEEZER:
      return DeezerProvider.getInstance();
    case ServiceType.TIDAL:
      return TidalProvider.getInstance();
    default:
      return null;
  }
}

/** True when a featured playlist's source is on another service than Spotify. */
export function isOtherService(serviceType?: string | null): serviceType is OtherServiceType {
  return otherServiceProvider(serviceType) !== null;
}

/**
 * The Apple Music storefront for a featured playlist: its own market first
 * (`featuredLocale`, a comma list), as the link check does; the provider's
 * default (nl) without one. Tracks are cached per storefront, so the product
 * page always asks the same one for a playlist whatever the visitor's locale.
 */
export function appleStorefrontFor(featuredLocale?: string | null): string {
  const first = (featuredLocale || '')
    .split(',')
    .map((l) => l.trim())
    .find(Boolean);
  return AppleMusicProvider.getInstance().getStorefrontForLocale(first);
}

/**
 * The playlist from its own service, in the shape `Spotify.getPlaylist` reads
 * from the Spotify Web API (`name`, `description`, `images[0].url`,
 * `tracks.total`), so everything after the fetch (the featured row's name,
 * descriptions, design, cover sync, caching) stays one path. Apple Music
 * gives no track count for a user's playlist; the row's stored count stands
 * in for it.
 */
export async function fetchOtherServicePlaylist(
  serviceType: OtherServiceType,
  playlistId: string,
  options: { cache: boolean; featuredLocale?: string | null; storedTrackCount?: number | null }
): Promise<ApiResult> {
  const provider = otherServiceProvider(serviceType)!;
  const result =
    serviceType === ServiceType.APPLE_MUSIC
      ? await (provider as AppleMusicProvider).getPlaylist(
          playlistId,
          appleStorefrontFor(options.featuredLocale),
          options.cache
        )
      : await (provider as any).getPlaylist(playlistId, options.cache);

  if (!result.success || !result.data) {
    return { success: false, error: result.error || `Error getting playlist from ${serviceType}` };
  }

  const data = result.data;
  return {
    success: true,
    data: {
      name: data.name,
      description: data.description || '',
      images: data.imageUrl ? [{ url: data.imageUrl }] : [],
      tracks: { total: data.trackCount || options.storedTrackCount || 0 },
    },
  };
}

/** The tracks of a playlist from its own service, as the provider gives them. */
export async function fetchOtherServiceTracks(
  serviceType: OtherServiceType,
  playlistId: string,
  options: {
    cache: boolean;
    allowDuplicates: boolean;
    featuredLocale?: string | null;
    onProgress?: ProgressCallback;
  }
): Promise<ApiResult & { data?: ProviderTracksResult }> {
  const provider = otherServiceProvider(serviceType)!;
  return provider.getTracks(playlistId, {
    cache: options.cache,
    allowDuplicates: options.allowDuplicates,
    onProgress: options.onProgress,
    storefront:
      serviceType === ServiceType.APPLE_MUSIC ? appleStorefrontFor(options.featuredLocale) : undefined,
  });
}

/** What a track's year, name and artist become: the database's enrichment and this playlist's corrections. */
export interface TrackCorrection {
  year?: number;
  name?: string;
  artist?: string;
  extraNameAttribute?: string;
  extraArtistAttribute?: string;
}

/**
 * A provider's track in the shape `Spotify.getTracks` answers (src/interfaces/Track),
 * which the product page reads for every service. `link` is the track on its
 * own service; `spotifyLink` stays empty, there is none.
 */
export function providerTrackToTrack(
  track: ProviderTrackData,
  correction: TrackCorrection | undefined,
  cleanTrackName: (name: string) => string
): Track | null {
  const name = correction?.name || track.name;
  const artist = correction?.artist || track.artist;
  if (!track.id || !name || !artist) return null;

  let releaseDate = '';
  if (track.releaseDate) {
    const date = new Date(track.releaseDate);
    if (!Number.isNaN(date.getTime())) releaseDate = format(date, 'yyyy-MM-dd');
  }

  return {
    id: track.id,
    name: cleanTrackName(name),
    album: cleanTrackName(track.album || ''),
    preview: track.previewUrl || '',
    artist,
    link: track.serviceLink || '',
    spotifyLink: '',
    isrc: track.isrc || '',
    image: track.albumImageUrl || '',
    releaseDate,
    trueYear: correction?.year,
    extraNameAttribute: correction?.extraNameAttribute,
    extraArtistAttribute: correction?.extraArtistAttribute,
  };
}
