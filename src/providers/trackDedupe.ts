import { ProviderTrackData, ProviderTracksResult } from '../interfaces/IMusicProvider';

/**
 * The artist+title duplicate filter, shared by every music provider.
 *
 * Historically only Spotify deduped (inside src/spotify.ts, keyed into its own
 * cache entry). Every other provider returned the raw playlist, so a Tidal or
 * Deezer playlist holding three versions of the same song produced three
 * identical-looking cards. This applies the same rule everywhere.
 *
 * The rule mirrors spotify.ts exactly:
 *   - filter OFF (allowDuplicates = false): collapse on `artist|||title`,
 *     lowercased and trimmed, so "live"/"remaster"/"remix" versions of one song
 *     yield a single card.
 *   - filter ON (allowDuplicates = true): still collapse on the provider track
 *     id, because the SAME track listed twice in a playlist is never something
 *     the customer wants two cards of. "Keep duplicates" means "keep different
 *     versions", not "keep literal repeats".
 *
 * Applied on READ rather than before caching, so the cache always holds the
 * complete list and one entry serves both variants. That removes any chance of
 * handing back the wrong variant from a stale key — the bug that truncated
 * PDFs when the count was computed with the filter in the wrong state.
 *
 * Pure: the input result is never mutated.
 */
export function applyDuplicateFilter(
  data: ProviderTracksResult,
  allowDuplicates: boolean = false
): ProviderTracksResult {
  const kept: ProviderTrackData[] = [];
  const firstPosition = new Map<string, number>();

  // Preserve anything the provider already reported as skipped (unavailable
  // tracks, podcasts, local files) and add our duplicates to it.
  const details = data.skipped ? [...data.skipped.details] : [];
  const summary = {
    unavailable: data.skipped?.summary.unavailable ?? 0,
    localFiles: data.skipped?.summary.localFiles ?? 0,
    podcasts: data.skipped?.summary.podcasts ?? 0,
    duplicates: data.skipped?.summary.duplicates ?? 0,
  };

  data.tracks.forEach((track, index) => {
    const position = index + 1;
    const artist = (track.artist || '').toLowerCase().trim();
    const name = (track.name || '').toLowerCase().trim();
    const key = allowDuplicates ? track.id : `${artist}|||${name}`;

    const seenAt = firstPosition.get(key);
    if (seenAt !== undefined) {
      summary.duplicates++;
      details.push({
        position,
        reason: 'duplicate',
        name: track.name,
        artist: track.artist,
        duplicateOf: seenAt,
      });
      return;
    }

    firstPosition.set(key, position);
    kept.push(track);
  });

  const skippedTotal =
    summary.unavailable + summary.localFiles + summary.podcasts + summary.duplicates;

  return {
    ...data,
    tracks: kept,
    total: kept.length,
    skipped:
      skippedTotal > 0 || data.skipped
        ? { total: skippedTotal, summary, details }
        : undefined,
  };
}
