import { describe, it, expect, vi } from 'vitest';

/**
 * Pure unit tests for the playlist suggestions filter and the query parser.
 * featuredPlaylists.ts pulls in src/spotify and src/data/misc, which have
 * heavy side effects, so both are mocked before import (same as
 * generation/data-featured-playlists.test.ts).
 */

vi.mock('../../src/spotify', () => ({
  CACHE_KEY_PLAYLIST: 'playlist2_',
  CACHE_KEY_PLAYLIST_DB: 'playlistdb2_',
  CACHE_KEY_TRACKS: 'tracks2_',
  CACHE_KEY_TRACK_COUNT: 'trackcount2_',
}));

vi.mock('../../src/data/misc', () => ({
  clearPlaylistCache: vi.fn(async () => undefined),
}));

import { filterPlaylistSuggestions } from '../../src/data/featuredPlaylists';
import {
  parsePlaylistSuggestionOptions,
  playlistSuggestionQuery,
} from '../../src/playlistSuggestions';
import Translation from '../../src/translation';

function playlist(overrides: Record<string, any>) {
  return {
    id: 1,
    name: 'Playlist',
    featuredLocale: null,
    genreId: 1,
    numberOfTracks: 100,
    score: 10,
    ...overrides,
  };
}

const ALL = [
  playlist({ id: 1, name: 'Dutch only', featuredLocale: 'nl', numberOfTracks: 50, score: 90 }),
  playlist({ id: 2, name: 'German and Dutch', featuredLocale: 'de,nl', numberOfTracks: 120, score: 50, genreId: 2 }),
  playlist({ id: 3, name: 'International', featuredLocale: null, numberOfTracks: 250, score: 70 }),
  playlist({ id: 4, name: 'Swedish', featuredLocale: 'sv', numberOfTracks: 300, score: 99, genreId: 3 }),
];

describe('filterPlaylistSuggestions', () => {
  it('returns everything above the card count when no locale or genre is chosen', () => {
    const result = filterPlaylistSuggestions(ALL, { locales: [], genreIds: [], cardCount: 96 });
    expect(result.map((p) => p.id)).toEqual([4, 3, 2]);
  });

  it('keeps international playlists when locales are selected', () => {
    const result = filterPlaylistSuggestions(ALL, { locales: ['de'], genreIds: [], cardCount: 48 });
    expect(result.map((p) => p.id)).toEqual([2, 3]);
  });

  it('matches any of several selected locales inside a comma list', () => {
    const result = filterPlaylistSuggestions(ALL, { locales: ['sv', 'nl'], genreIds: [], cardCount: 48 });
    // Localised first (by score), then international.
    expect(result.map((p) => p.id)).toEqual([4, 1, 2, 3]);
  });

  it('filters on genre ids', () => {
    const result = filterPlaylistSuggestions(ALL, { locales: [], genreIds: [2, 3], cardCount: 48 });
    expect(result.map((p) => p.id)).toEqual([4, 2]);
  });

  it('requires at least cardCount tracks', () => {
    const result = filterPlaylistSuggestions(ALL, { locales: [], genreIds: [], cardCount: 200 });
    expect(result.map((p) => p.id)).toEqual([4, 3]);
  });
});

describe('parsePlaylistSuggestionOptions', () => {
  const translation = new Translation();

  it('parses comma separated query values and drops junk', () => {
    const parsed = parsePlaylistSuggestionOptions(
      { locale: 'de', locales: 'nl, DE,xx,zz1', genreIds: '3,3,abc,-1,7', cardCount: '192' },
      translation
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.opts).toEqual({
      locale: 'de',
      locales: ['nl', 'de'],
      genreIds: [3, 7],
      cardCount: 192,
    });
  });

  it('accepts JSON arrays from a POST body', () => {
    const parsed = parsePlaylistSuggestionOptions(
      { locale: 'fr', locales: ['nl'], genreIds: [4], cardCount: 48 },
      translation
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // fr is not a business document language, so the document falls back to English.
    expect(parsed.opts.locale).toBe('en');
    expect(parsed.opts.locales).toEqual(['nl']);
    expect(parsed.opts.genreIds).toEqual([4]);
  });

  it('defaults to 96 cards and rejects unsupported card counts', () => {
    const ok = parsePlaylistSuggestionOptions({}, translation);
    expect(ok.ok && ok.opts.cardCount).toBe(96);

    const bad = parsePlaylistSuggestionOptions({ cardCount: 100 }, translation);
    expect(bad).toEqual({ ok: false, error: 'Invalid cardCount' });
  });

  it('builds a stable query string for the HTML view', () => {
    const parsed = parsePlaylistSuggestionOptions(
      { locale: 'nl', locales: ['nl', 'de'], genreIds: [2], cardCount: 200 },
      translation
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(playlistSuggestionQuery(parsed.opts)).toBe(
      'locale=nl&cardCount=200&locales=nl%2Cde&genreIds=2'
    );
  });
});
