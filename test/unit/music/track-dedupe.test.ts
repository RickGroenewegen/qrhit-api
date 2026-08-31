import { describe, it, expect } from 'vitest';
import { applyDuplicateFilter } from '../../../src/providers/trackDedupe';
import { ProviderTracksResult } from '../../../src/interfaces/IMusicProvider';
import { ServiceType } from '../../../src/enums/ServiceType';

function track(id: string, artist: string, name: string): any {
  return {
    id,
    name,
    artist,
    artistsList: [artist],
    album: '',
    albumImageUrl: null,
    releaseDate: null,
    serviceType: ServiceType.TIDAL,
    serviceLink: `https://example.test/${id}`,
  };
}

function result(tracks: any[], skipped?: ProviderTracksResult['skipped']): ProviderTracksResult {
  return { tracks, total: tracks.length, skipped };
}

describe('applyDuplicateFilter', () => {
  it('collapses different versions of the same song when the filter is on', () => {
    const out = applyDuplicateFilter(
      result([
        track('a', 'Los Del Rio', 'Macarena'),
        track('b', 'Scatman John', 'Scatman'),
        track('c', 'los del rio', '  MACARENA '), // same song, different version
      ]),
      false
    );

    expect(out.tracks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(out.total).toBe(2);
    expect(out.skipped?.summary.duplicates).toBe(1);
    expect(out.skipped?.details[0]).toMatchObject({
      position: 3,
      reason: 'duplicate',
      duplicateOf: 1,
    });
  });

  it('keeps different versions when the customer opted out', () => {
    const out = applyDuplicateFilter(
      result([
        track('a', 'Los Del Rio', 'Macarena'),
        track('b', 'Scatman John', 'Scatman'),
        track('c', 'Los Del Rio', 'Macarena'),
      ]),
      true
    );

    expect(out.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(out.total).toBe(3);
    expect(out.skipped).toBeUndefined();
  });

  // "Keep duplicates" means keep different VERSIONS, never the same track twice.
  it('still collapses the identical track id even when the filter is off', () => {
    const out = applyDuplicateFilter(
      result([
        track('a', 'Los Del Rio', 'Macarena'),
        track('a', 'Los Del Rio', 'Macarena'),
      ]),
      true
    );

    expect(out.tracks.map((t) => t.id)).toEqual(['a']);
    expect(out.skipped?.summary.duplicates).toBe(1);
  });

  it('preserves skip info the provider already reported and adds to its total', () => {
    const out = applyDuplicateFilter(
      result(
        [track('a', 'A', 'One'), track('b', 'A', 'One')],
        {
          total: 1,
          summary: { unavailable: 1, localFiles: 0, podcasts: 0, duplicates: 0 },
          details: [{ position: 9, reason: 'unavailable', name: 'Gone', artist: 'A' }],
        }
      ),
      false
    );

    expect(out.skipped?.summary.unavailable).toBe(1);
    expect(out.skipped?.summary.duplicates).toBe(1);
    expect(out.skipped?.total).toBe(2);
    expect(out.skipped?.details).toHaveLength(2);
  });

  it('does not mutate the input', () => {
    const input = result([track('a', 'A', 'One'), track('b', 'A', 'One')]);
    applyDuplicateFilter(input, false);
    expect(input.tracks).toHaveLength(2);
    expect(input.total).toBe(2);
  });

  it('handles an empty playlist', () => {
    const out = applyDuplicateFilter(result([]), false);
    expect(out.tracks).toEqual([]);
    expect(out.total).toBe(0);
  });
});
