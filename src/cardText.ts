/**
 * The only HTML entity in stored card text: OnzeVibe's lists (last in 2025-06,
 * code removed 2026-10-07) wrote their voters into
 * trackextrainfo.extraNameAttribute as "Ann&nbsp;B.", which is why the card
 * templates printed that field unescaped. Customers type the same field on the
 * corrections page, so the templates escape it like the rest, and the entity
 * becomes the character it stands for.
 */
export function plainCardTracks<T extends { extraNameAttribute?: string | null }>(tracks: T[]): T[] {
  return tracks.map((track) =>
    track.extraNameAttribute?.includes('&nbsp;')
      ? { ...track, extraNameAttribute: track.extraNameAttribute.replaceAll('&nbsp;', ' ') }
      : track
  );
}
