import { describe, it, expect } from 'vitest';
import { pickAutoModeYear } from '../../src/data/trackYears';

/**
 * Unit tests for the auto-mode year fallback in src/data/trackYears.ts.
 *
 * pickAutoModeYear is what auto-mode uses when getReleaseDate could not settle
 * on a year: it walks the collected sources in priority order and takes the
 * first plausible one.
 */

const NEXT_YEAR = new Date().getFullYear() + 1;

function sources(overrides: Record<string, number> = {}) {
  return {
    spotify: 0,
    mb: 0,
    ai: 0,
    openPerplex: 0,
    discogs: 0,
    ...overrides,
  };
}

describe('pickAutoModeYear', () => {
  it('prefers the AI year over every other source', () => {
    const result = pickAutoModeYear(
      sources({ ai: 1975, spotify: 1990, mb: 1980, discogs: 1985 })
    );
    expect(result).toEqual({ year: 1975, source: 'ai' });
  });

  it('falls back to the Spotify year when there is no AI year', () => {
    const result = pickAutoModeYear(
      sources({ spotify: 1990, mb: 1980, discogs: 1985 })
    );
    expect(result).toEqual({ year: 1990, source: 'spotify' });
  });

  it('falls back to MusicBrainz, then Discogs, then OpenPerplex', () => {
    expect(pickAutoModeYear(sources({ mb: 1980, discogs: 1985 }))).toEqual({
      year: 1980,
      source: 'mb',
    });
    expect(pickAutoModeYear(sources({ discogs: 1985, openPerplex: 1988 }))).toEqual({
      year: 1985,
      source: 'discogs',
    });
    expect(pickAutoModeYear(sources({ openPerplex: 1988 }))).toEqual({
      year: 1988,
      source: 'openPerplex',
    });
  });

  it('skips a future year and takes the next usable source', () => {
    const result = pickAutoModeYear(
      sources({ ai: NEXT_YEAR, spotify: 1990 })
    );
    expect(result).toEqual({ year: 1990, source: 'spotify' });
  });

  it('skips zero and negative years', () => {
    const result = pickAutoModeYear(sources({ ai: 0, spotify: -1, mb: 1966 }));
    expect(result).toEqual({ year: 1966, source: 'mb' });
  });

  it('returns null when no source has a usable year', () => {
    expect(pickAutoModeYear(sources())).toBeNull();
    expect(pickAutoModeYear(sources({ ai: NEXT_YEAR }))).toBeNull();
  });

  it('tolerates missing source keys', () => {
    expect(pickAutoModeYear({ spotify: 1994 })).toEqual({
      year: 1994,
      source: 'spotify',
    });
    expect(pickAutoModeYear({})).toBeNull();
  });
});
