/**
 * How many extra cards a line can buy on the corrections page.
 *
 * Extra cards (qrhit's track-upgrade-modal, `tracks_upgrade` in mollie.ts)
 * only raise the paid count: the customer then adds the songs to their
 * playlist and reloads it. That works on the customer's own playlist. On a
 * playlist they cannot change, one of our ready-made (featured) playlists or
 * an AI playlist in our Spotify account, the reload never brings in more
 * songs than the playlist already has, so the cards beyond that are paid for
 * and never filled. Order 100009738 (line 10825, "House & Techno Classics",
 * 150 songs) bought +10 on 2026-11-09 and was stuck. Lines where the playlist
 * did have more songs than paid (10807 Blasmusikster, 10072 QRSong! voor
 * kinderen) reloaded fine after buying, so such a line keeps the upgrade up
 * to that number.
 *
 * Pure, so the rule is tested without a database; Upgrade.extraTracksForLine
 * does the lookups.
 */

/** The refusal the tracks routes answer (409) for a tier the line has no
 *  room for. The corrections page explains it instead of offering tiers. */
export const PLAYLIST_NOT_EDITABLE = 'playlistNotEditable';

/** How long a playlist's song count from its music service is kept for this
 *  check: the corrections page asks on every load and the price modal per
 *  tier. A reload stores the count it fetched itself. */
export const SOURCE_COUNT_TTL_SECONDS = 10 * 60;

export interface PlaylistEditableInput {
  /** playlists.featured */
  featured: boolean;
  /** playlists.promotionalUserId: who submitted it to be featured */
  promotionalUserId: number | null;
  /** Whose set the line is (lineOwner.ts) */
  holderUserId: number;
  /** One of our AI playlists (an `aisearches` row names it) */
  aiGenerated: boolean;
}

/**
 * Whether the line's holder can add songs to the playlist themselves. A
 * featured playlist is ours or another customer's, unless the holder
 * submitted it (a customer's own playlist that we feature: line 10056
 * "Marlous en Erik 2026" bought +25 and reloaded). An AI playlist always
 * lives in our account.
 */
export function customerCanAddSongs(input: PlaylistEditableInput): boolean {
  if (input.aiGenerated) return false;
  if (input.featured && input.promotionalUserId !== input.holderUserId) {
    return false;
  }
  return true;
}

/**
 * The extra cards the line can still buy: null when the holder can add
 * songs (only the physical cap applies), otherwise the songs the playlist
 * has beyond the paid count. An unknown count sells nothing.
 */
export function extraTracksRoom(
  editable: boolean,
  sourceTracks: number | null,
  paidTracks: number
): number | null {
  if (editable) return null;
  if (sourceTracks === null || !Number.isFinite(sourceTracks)) return 0;
  return Math.max(0, Math.floor(sourceTracks) - (paidTracks || 0));
}

/** Whether a tier fits the room (null = no room limit of its own). */
export function tierFitsRoom(tier: number, room: number | null): boolean {
  return room === null || tier <= room;
}

export const sourceCountCacheKey = (
  playlistId: string,
  allowDuplicates: boolean
): string => `extraTracksSource:${playlistId}:${allowDuplicates ? 1 : 0}`;
