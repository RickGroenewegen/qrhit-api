import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/quiz.ts question generation/shuffling/mapping logic.
 * Prisma is faked; Translation is real (APP_ROOT points at src/, so the
 * actual en/nl locale files are used). Randomized behavior is asserted
 * through invariants, not exact orderings.
 */

const h = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

import Quiz, {
  MAX_AI_QUIZZES_PER_WEEK,
  TrackRow,
  TrackWithType,
  ReleaseOrderOption,
} from '../../../src/quiz';

const quiz = Quiz.getInstance();

function makeTrack(id: number, overrides: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    trackId: `isrc-${id}`,
    name: `Song Number ${id}`,
    artist: `Artist ${id}`,
    year: 1980 + (id % 40),
    trackOrder: id,
    ...overrides,
  };
}

describe('shuffle', () => {
  it('returns a permutation without mutating the input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const copy = [...input];
    const result = quiz.shuffle(input);
    expect(input).toEqual(copy);
    expect([...result].sort((a, b) => a - b)).toEqual(copy);
  });

  it('handles empty and single-element arrays', () => {
    expect(quiz.shuffle([])).toEqual([]);
    expect(quiz.shuffle([42])).toEqual([42]);
  });
});

describe('filterSelectedTracks', () => {
  it('keeps only tracks whose ISRC is selected', () => {
    const tracks = [makeTrack(1), makeTrack(2), makeTrack(3)];
    const result = quiz.filterSelectedTracks(tracks, ['isrc-1', 'isrc-3', 'isrc-99']);
    expect(result.map((t) => t.id)).toEqual([1, 3]);
  });

  it('returns empty for no selection', () => {
    expect(quiz.filterSelectedTracks([makeTrack(1)], [])).toEqual([]);
  });
});

describe('assignQuestionTypes', () => {
  it('assigns every track exactly one type from the requested set', () => {
    const tracks = Array.from({ length: 20 }, (_, i) => makeTrack(i + 1));
    const result = quiz.assignQuestionTypes(tracks, ['year', 'artist']);

    expect(result).toHaveLength(20);
    expect(new Set(result.map((r) => r.trackId)).size).toBe(20);
    for (const r of result) {
      expect(['year', 'artist']).toContain(r.type);
    }
    // Proportions: 2 types, equal weight => 10 each
    const years = result.filter((r) => r.type === 'year').length;
    expect(years).toBe(10);
  });

  it('respects weighting through repeated entries in questionTypes', () => {
    const tracks = Array.from({ length: 30 }, (_, i) => makeTrack(i + 1));
    const result = quiz.assignQuestionTypes(tracks, ['year', 'year', 'artist']);
    const years = result.filter((r) => r.type === 'year').length;
    const artists = result.filter((r) => r.type === 'artist').length;
    expect(years).toBe(20);
    expect(artists).toBe(10);
  });

  it('never assigns missing_word to titles with fewer than 3 words', () => {
    const tracks = [
      makeTrack(1, { name: 'Yesterday' }),
      makeTrack(2, { name: 'Hey Jude' }),
      makeTrack(3, { name: 'Let It Be Now' }),
      makeTrack(4, { name: 'Here Comes The Sun' }),
    ];
    for (let i = 0; i < 10; i++) {
      const result = quiz.assignQuestionTypes(tracks, ['missing_word']);
      for (const r of result) {
        const track = tracks.find((t) => t.id === r.trackId)!;
        if (track.name.trim().split(/\s+/).length < 3) {
          // Ineligible tracks fall back (missing_word ineligible => trivia)
          expect(r.type).toBe('trivia');
        } else {
          expect(r.type).toBe('missing_word');
        }
      }
    }
  });

  it('never assigns year-dependent types to tracks without a year', () => {
    const tracks = [
      makeTrack(1, { year: null }),
      makeTrack(2, { year: null }),
      makeTrack(3),
      makeTrack(4),
    ];
    for (let i = 0; i < 10; i++) {
      const result = quiz.assignQuestionTypes(tracks, ['release_order', 'decade']);
      for (const r of result) {
        const track = tracks.find((t) => t.id === r.trackId)!;
        if (!track.year) {
          expect(['release_order', 'decade']).not.toContain(r.type);
        }
      }
    }
  });

  it('defaults missing year to 2000 in the mapped output', () => {
    const result = quiz.assignQuestionTypes([makeTrack(1, { year: null })], ['trivia']);
    expect(result[0].year).toBe(2000);
  });

  it('uses all seven types when none are requested', () => {
    const tracks = Array.from({ length: 70 }, (_, i) => makeTrack(i + 1));
    const result = quiz.assignQuestionTypes(tracks);
    const allowed = new Set([
      'year',
      'trivia',
      'artist',
      'title',
      'missing_word',
      'release_order',
      'decade',
    ]);
    expect(result).toHaveLength(70);
    for (const r of result) expect(allowed.has(r.type)).toBe(true);
  });
});

describe('generateStandardQuestions', () => {
  const allTracks = Array.from({ length: 10 }, (_, i) =>
    makeTrack(i + 1, { year: 1970 + i * 5 })
  );

  function withType(id: number, type: TrackWithType['type'], overrides: Partial<TrackRow> = {}): TrackWithType {
    const t = makeTrack(id, overrides);
    return {
      trackId: t.id,
      name: t.name,
      artist: t.artist,
      year: t.year!,
      type,
    };
  }

  it('generates year questions with the translated prompt and the year as answer', () => {
    const [q] = quiz.generateStandardQuestions([withType(1, 'year')], allTracks, 'en');
    expect(q).toEqual({
      trackId: 1,
      type: 'year',
      question: 'In which year was this song released?',
      options: null,
      correctAnswer: String(1980 + 1),
    });
  });

  it('translates the prompt for non-English locales', () => {
    const [q] = quiz.generateStandardQuestions([withType(1, 'year')], allTracks, 'nl');
    expect(q.question).not.toBe('In which year was this song released?');
    expect(q.question.length).toBeGreaterThan(0);
  });

  it('generates artist questions with the artist as answer', () => {
    const [q] = quiz.generateStandardQuestions([withType(2, 'artist')], allTracks, 'en');
    expect(q.type).toBe('artist');
    expect(q.correctAnswer).toBe('Artist 2');
    expect(q.options).toBeNull();
  });

  it('blanks exactly one word for missing_word and uses it as the answer', () => {
    const track = withType(3, 'missing_word', { name: 'The Sound Of Silence' });
    const [q] = quiz.generateStandardQuestions([track], allTracks, 'en');

    expect(q.type).toBe('missing_word');
    const [blankedTitle] = q.question.split('\n');
    const blankedWords = blankedTitle.split(' ');
    expect(blankedWords).toHaveLength(4);
    expect(blankedWords.filter((w) => w === '___')).toHaveLength(1);

    // Replacing the blank with the answer reconstructs the title
    const restored = blankedWords
      .map((w) => (w === '___' ? q.correctAnswer : w))
      .join(' ');
    expect(restored).toBe('The Sound Of Silence');
  });

  it('leaves trivia questions empty for manual/AI fill-in', () => {
    const [q] = quiz.generateStandardQuestions([withType(4, 'trivia')], allTracks, 'en');
    expect(q).toEqual({
      trackId: 4,
      type: 'trivia',
      question: '',
      options: null,
      correctAnswer: '',
    });
  });

  it('builds title questions with 4 options including the correct title', () => {
    const track = withType(5, 'title');
    const [q] = quiz.generateStandardQuestions([track], allTracks, 'en');

    expect(q.type).toBe('title');
    expect(q.options).toHaveLength(4);
    expect(q.options).toContain('Song Number 5');
    expect(q.correctAnswer).toBe('Song Number 5');
    // Wrong options come from other tracks
    for (const opt of q.options as string[]) {
      if (opt !== 'Song Number 5') {
        expect(allTracks.some((t) => t.name === opt)).toBe(true);
      }
    }
  });

  it('pads title options with placeholders when not enough other tracks exist', () => {
    const track = withType(5, 'title');
    const [q] = quiz.generateStandardQuestions([track], [], 'en');
    expect(q.options).toHaveLength(4);
    expect(q.options).toEqual(
      expect.arrayContaining(['Song Number 5', 'Track 2', 'Track 3', 'Track 4'])
    );
  });

  it('builds release_order questions sorted chronologically with the correct index', () => {
    const track = withType(1, 'release_order', { year: 1985 });
    const [q] = quiz.generateStandardQuestions([track], allTracks, 'en');

    expect(q.type).toBe('release_order');
    const options = q.options as ReleaseOrderOption[];
    expect(options).toHaveLength(4);

    // Sorted ascending by year, unique years
    const years = options.map((o) => o.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(new Set(years).size).toBe(4);

    // correctAnswer points at the entry for the asked track
    const idx = parseInt(q.correctAnswer, 10);
    expect(options[idx].label).toBe('Artist 1 - Song Number 1');
    expect(options[idx].year).toBe(1985);
  });

  it('falls back to a year question when fewer than 3 distinct other years exist', () => {
    const track = withType(1, 'release_order', { year: 1985 });
    const sameYearPool = [
      makeTrack(2, { year: 1990 }),
      makeTrack(3, { year: 1990 }),
      makeTrack(4, { year: 1985 }),
    ];
    const [q] = quiz.generateStandardQuestions([track], sameYearPool, 'en');
    expect(q.type).toBe('year');
    expect(q.options).toBeNull();
    expect(q.correctAnswer).toBe('1985');
  });

  it('builds decade questions with 4 unique decade options containing the answer', () => {
    const track = withType(1, 'decade', { year: 1987 });
    const [q] = quiz.generateStandardQuestions([track], allTracks, 'en');

    expect(q.type).toBe('decade');
    expect(q.correctAnswer).toBe('1980s');
    expect(q.options).toHaveLength(4);
    expect(q.options).toContain('1980s');
    expect(new Set(q.options as string[]).size).toBe(4);
    for (const opt of q.options as string[]) {
      expect(opt).toMatch(/^\d{4}s$/);
    }
  });

  it('clamps decade options at the 1900 lower bound', () => {
    const track = withType(1, 'decade', { year: 1903 });
    const [q] = quiz.generateStandardQuestions([track], allTracks, 'en');
    expect(q.correctAnswer).toBe('1900s');
    for (const opt of q.options as string[]) {
      expect(parseInt(opt, 10)).toBeGreaterThanOrEqual(1900);
    }
  });
});

describe('getAiQuizUsage', () => {
  beforeEach(() => {
    h.prisma.$queryRaw.mockReset();
  });

  it('computes used and remaining from the weekly count', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([{ count: 1n }]);
    const usage = await quiz.getAiQuizUsage('hash-1');
    expect(usage).toEqual({
      used: 1,
      remaining: MAX_AI_QUIZZES_PER_WEEK - 1,
      limit: MAX_AI_QUIZZES_PER_WEEK,
    });
  });

  it('clamps remaining at zero when over the limit', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([{ count: 7n }]);
    const usage = await quiz.getAiQuizUsage('hash-1');
    expect(usage).toEqual({ used: 7, remaining: 0, limit: MAX_AI_QUIZZES_PER_WEEK });
  });
});
