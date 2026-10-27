import { color, white } from 'console-log-colors';
import Logger from '../logger';
import PrismaInstance from '../prisma';
import { formatCostUsd, llm } from '../llm';

/**
 * The songs a product photo shows. A visitor reads three of them (the hero's
 * answer and the two backs lying in front) and sees the QR side of two more,
 * so they should be songs everyone in the playlist's market knows, by
 * different artists and from different years. The model picks them from the
 * playlist; when it cannot, a rule does (one per decade, in playlist order).
 */

/** A song as its card prints it, with the link its QR code opens. */
export interface PhotoTrack {
  id: number;
  artist: string;
  name: string;
  year: number;
  extraArtistAttribute: string | null;
  extraNameAttribute: string | null;
  link: string;
}

export type PickSource = 'auto' | 'fallback' | 'admin';

// how many songs a photo shows: hero, songs, song, fan, deck
export const PHOTO_SONGS = 5;
// longer titles and artists wrap on the card and read worse in a photo
const MAX_TEXT = 28;
// what the model chooses from; a longer playlist is sampled evenly
const MAX_CANDIDATES = 150;
// a title that is a version of a song rather than the song
const VERSION_NOISE = /\b(remaster(ed)?|live|version|edit|mix|demo|mono|stereo|acoustic|instrumental|karaoke)\b/i;

const logger = new Logger();

/** Every song of the playlist that can go on the photo, in playlist order. */
export async function photoCandidates(playlistId: number): Promise<PhotoTrack[]> {
  // the printed text, as data/tracks.ts getTracks reads it
  const rows = await PrismaInstance.getInstance().$queryRaw<any[]>`
      SELECT
          tracks.id,
          COALESCE(NULLIF(tei.artist, ''), tracks.artist) AS artist,
          COALESCE(tei.year, tracks.year) AS year,
          COALESCE(NULLIF(tei.name, ''), tracks.name) AS name,
          tei.extraNameAttribute,
          tei.extraArtistAttribute,
          COALESCE(NULLIF(tracks.spotifyLink, ''), NULLIF(tracks.youtubeMusicLink, ''),
                   NULLIF(tracks.appleMusicLink, ''), NULLIF(tracks.deezerLink, ''),
                   NULLIF(tracks.tidalLink, ''), NULLIF(tracks.amazonMusicLink, '')) AS link
      FROM tracks
      INNER JOIN playlist_has_tracks ON tracks.id = playlist_has_tracks.trackId
      LEFT JOIN trackextrainfo tei ON tei.trackId = tracks.id AND tei.playlistId = ${playlistId}
      WHERE playlist_has_tracks.playlistId = ${playlistId}
      ORDER BY playlist_has_tracks.order ASC, playlist_has_tracks.trackId ASC`;
  return rows
    .map((row) => ({
      id: Number(row.id),
      artist: String(row.artist || '').trim(),
      name: String(row.name || '').trim(),
      year: Number(row.year) || 0,
      extraArtistAttribute: row.extraArtistAttribute || null,
      extraNameAttribute: row.extraNameAttribute || null,
      link: row.link || '',
    }))
    .filter(
      (track) =>
        track.year > 0 &&
        track.link &&
        track.artist &&
        track.name &&
        track.artist.length <= MAX_TEXT &&
        track.name.length <= MAX_TEXT
    );
}

/** The songs to show, picked by the model or else by rule; null when too few. */
export async function pickPhotoSongs(
  playlist: { id: number; name: string; featuredLocale: string | null },
  candidates: PhotoTrack[]
): Promise<{ tracks: PhotoTrack[]; source: PickSource } | null> {
  if (candidates.length < PHOTO_SONGS) return null;
  const clean = candidates.filter((track) => !VERSION_NOISE.test(track.name));
  const pool = clean.length >= PHOTO_SONGS ? clean : candidates;
  try {
    const picked = await askModel(playlist, pool);
    if (picked) return { tracks: picked, source: 'auto' };
  } catch (error: any) {
    logger.log(
      color.yellow.bold(`Product photo songs of ${white.bold(playlist.name)}: the model failed (${error.message}), picking by rule`)
    );
  }
  return { tracks: pickByRule(pool), source: 'fallback' };
}

/** The tracks with these ids, in this order, if every one can still go on a photo. */
export function tracksByIds(ids: unknown, candidates: PhotoTrack[]): PhotoTrack[] | null {
  if (!Array.isArray(ids) || ids.length !== PHOTO_SONGS) return null;
  const byId = new Map(candidates.map((track) => [track.id, track]));
  const tracks = ids.map((id) => byId.get(Number(id)));
  return tracks.every(Boolean) && new Set(ids).size === PHOTO_SONGS ? (tracks as PhotoTrack[]) : null;
}

/** One song per decade first, in playlist order, then the rest; artists not repeated while others are left. */
export function pickByRule(candidates: PhotoTrack[]): PhotoTrack[] {
  const picked: PhotoTrack[] = [];
  const artists = new Set<string>();
  const decades = new Set<number>();
  const take = (track: PhotoTrack) => {
    picked.push(track);
    artists.add(track.artist.toLowerCase());
    decades.add(Math.floor(track.year / 10));
  };
  for (const track of candidates) {
    if (picked.length === PHOTO_SONGS) break;
    if (!decades.has(Math.floor(track.year / 10)) && !artists.has(track.artist.toLowerCase())) take(track);
  }
  for (const track of candidates) {
    if (picked.length === PHOTO_SONGS) break;
    if (!picked.includes(track) && !artists.has(track.artist.toLowerCase())) take(track);
  }
  for (const track of candidates) {
    if (picked.length === PHOTO_SONGS) break;
    if (!picked.includes(track)) take(track);
  }
  return picked;
}

async function askModel(
  playlist: { name: string; featuredLocale: string | null },
  pool: PhotoTrack[]
): Promise<PhotoTrack[] | null> {
  const step = Math.max(1, pool.length / MAX_CANDIDATES);
  const shown = Array.from({ length: Math.min(pool.length, MAX_CANDIDATES) }, (_, i) => pool[Math.floor(i * step)]);
  const market = playlist.featuredLocale || 'en';
  const { data, costUsd } = await llm.json<{ trackIds: number[] }>('productPhotoSongs', {
    messages: [
      {
        role: 'system',
        content:
          'You pick songs for the product photo of a QR music card game. Each card has a song: the QR side plays it, the other side prints artist, year and title. The photo shows the printed side of three cards, and visitors should recognise those songs at a glance.',
      },
      {
        role: 'user',
        content: [
          `Playlist: "${playlist.name}". Visitors of the "${market}" site see the photo.`,
          `Pick ${PHOTO_SONGS} songs from the list, most recognisable first: the songs the most people in that market know and love.`,
          'Use different artists, and spread the years when the playlist spans several decades. Prefer the well-known original over a cover or a version.',
          'The first one is printed largest, so it should be the most iconic song of the playlist.',
          '',
          'Songs (id | year | artist - title):',
          ...shown.map((track) => `${track.id} | ${track.year} | ${track.artist} - ${track.name}`),
        ].join('\n'),
      },
    ],
    schema: {
      name: 'productPhotoSongs',
      schema: {
        type: 'object',
        properties: {
          trackIds: {
            type: 'array',
            items: { type: 'number' },
            description: `The ids of the ${PHOTO_SONGS} songs, most recognisable first`,
          },
        },
        required: ['trackIds'],
      },
    },
  });

  const byId = new Map(shown.map((track) => [track.id, track]));
  const tracks: PhotoTrack[] = [];
  for (const id of data?.trackIds ?? []) {
    const track = byId.get(Number(id));
    if (track && !tracks.includes(track)) tracks.push(track);
  }
  if (!tracks.length) return null;
  // a short or partly wrong answer is topped up by rule
  for (const track of pickByRule(pool.filter((candidate) => !tracks.includes(candidate)))) {
    if (tracks.length === PHOTO_SONGS) break;
    tracks.push(track);
  }
  logger.log(
    color.blue.bold(
      `Product photo songs of ${white.bold(playlist.name)} picked (${white.bold(formatCostUsd(costUsd))}): ${white.bold(
        tracks.map((track) => `${track.artist} - ${track.name}`).join(', ')
      )}`
    )
  );
  return tracks.slice(0, PHOTO_SONGS);
}
