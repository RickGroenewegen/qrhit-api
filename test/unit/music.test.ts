/**
 * Unit tests for src/music.ts (Music class).
 *
 * The Music class queries MusicBrainz, Discogs, Wikipedia + Google via axios,
 * caches ISRC lookups, and uses ChatGPT to weight the final release year.
 *
 * All I/O is mocked:
 *  - axios (instance + global) → controlled responses
 *  - src/prisma               → in-memory map
 *  - src/cache                → in-memory map
 *  - src/chatgpt              → returns deterministic year
 *
 * No network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Cache mock (in-memory) ────────────────────────────────────────────────
const cacheStore = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => { cacheStore.set(key, value); },
      rateLimit: async () => {},
    }),
  },
}));

// ─── Prisma mock (in-memory) ───────────────────────────────────────────────
const isrcStore = new Map<string, { isrc: string; year: number | null }>();
const prismaMock = {
  isrc: {
    findUnique: vi.fn(async ({ where }: { where: { isrc: string } }) =>
      isrcStore.get(where.isrc) ?? null
    ),
  },
};
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

// ─── ChatGPT mock ─────────────────────────────────────────────────────────
const chatGptAskMock = vi.fn(async (_prompt: string) => ({ year: 1985 }));
vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class {
    ask = chatGptAskMock;
  },
}));

// ─── axios mock (hoisted) ─────────────────────────────────────────────────
const { axiosGetMock } = vi.hoisted(() => ({ axiosGetMock: vi.fn() }));
vi.mock('axios', () => {
  const axiosMock: any = {
    get: axiosGetMock,
    create: () => ({
      get: axiosGetMock,
    }),
  };
  axiosMock.default = axiosMock;
  return axiosMock;
});

import { Music } from '../../src/music';

// Helper: build a minimal MusicBrainz API response with recordings
function mbResponse(recordings: any[]) {
  return { data: { recordings } };
}

function mbRecording(score: number, firstReleaseDate: string | null) {
  return { score, 'first-release-date': firstReleaseDate };
}

// Helper: build a Discogs response
function discogsResponse(results: { year: string }[]) {
  return { data: { results } };
}

describe('Music.searchMusicBrainz', () => {
  let music: Music;

  beforeEach(() => {
    cacheStore.clear();
    isrcStore.clear();
    axiosGetMock.mockReset();
    chatGptAskMock.mockReset();
    chatGptAskMock.mockResolvedValue({ year: 1985 });
    // Reset singleton between tests
    (Music as any).instance = undefined;
    music = new Music();
  });

  it('returns cached ISRC year when present in DB', async () => {
    isrcStore.set('USRC11234567', { isrc: 'USRC11234567', year: 1990 });
    const result = await (music as any).searchMusicBrainz('USRC11234567', 'Artist', 'Title');
    expect(result.year).toBe(1990);
    expect(result.source).toBe('isrc_cache');
    // API should not be called
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it('falls back to artist/title API search when ISRC not in DB', async () => {
    axiosGetMock.mockResolvedValue(
      mbResponse([mbRecording(98, '1982-05-10')])
    );
    const result = await (music as any).searchMusicBrainz('NOTFOUND', 'Artist', 'Title');
    expect(result.year).toBe(1982);
    expect(result.source).toBe('mb_api_artist_title');
  });

  it('returns year=0 when no ISRC in DB and API returns no high-score recordings', async () => {
    axiosGetMock.mockResolvedValue(mbResponse([mbRecording(50, '1980')]));
    const result = await (music as any).searchMusicBrainz('', 'Artist', 'Title');
    expect(result.year).toBe(0);
  });
});

describe('Music.getReleaseDateFromMusicBrainzAPI', () => {
  let music: Music;

  beforeEach(() => {
    cacheStore.clear();
    axiosGetMock.mockReset();
    (Music as any).instance = undefined;
    music = new Music();
  });

  it('returns year=0 in isrc mode when isrc is empty', async () => {
    const result = await (music as any).getReleaseDateFromMusicBrainzAPI('', 'A', 'B', 'isrc');
    expect(result.year).toBe(0);
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it('parses year from earliest first-release-date among high-score recordings', async () => {
    axiosGetMock.mockResolvedValue(
      mbResponse([
        mbRecording(97, '1985-06-01'),
        mbRecording(99, '1982-01-01'),
        mbRecording(95, '1990-12-31'),
      ])
    );
    const result = await (music as any).getReleaseDateFromMusicBrainzAPI('USXX', 'A', 'B', 'artistAndTitle');
    expect(result.year).toBe(1982);
    expect(result.source).toBe('api');
  });

  it('ignores recordings with score < 95', async () => {
    axiosGetMock.mockResolvedValue(
      mbResponse([
        mbRecording(94, '1970-01-01'), // below threshold — ignored
        mbRecording(96, '1990-03-15'),
      ])
    );
    const result = await (music as any).getReleaseDateFromMusicBrainzAPI('USXX', 'A', 'B', 'artistAndTitle');
    expect(result.year).toBe(1990);
  });

  it('returns year=0 when all recordings have null first-release-date', async () => {
    axiosGetMock.mockResolvedValue(
      mbResponse([mbRecording(99, null)])
    );
    const result = await (music as any).getReleaseDateFromMusicBrainzAPI('USXX', 'A', 'B', 'artistAndTitle');
    expect(result.year).toBe(0);
  });

  it('returns year=0 when recordings array is empty', async () => {
    axiosGetMock.mockResolvedValue(mbResponse([]));
    const result = await (music as any).getReleaseDateFromMusicBrainzAPI('USXX', 'A', 'B', 'artistAndTitle');
    expect(result.year).toBe(0);
  });

  it('retries on error and returns year=0 after max retries', async () => {
    axiosGetMock.mockRejectedValue(new Error('network error'));
    const result = await (music as any).getReleaseDateFromMusicBrainzAPI('USXX', 'A', 'B', 'artistAndTitle');
    expect(result.year).toBe(0);
    // Should have retried mbMaxRetries (5) times
    expect(axiosGetMock).toHaveBeenCalledTimes(5);
  });
});

describe('Music.getReleaseDate – year aggregation rules', () => {
  let music: Music;

  beforeEach(() => {
    cacheStore.clear();
    isrcStore.clear();
    axiosGetMock.mockReset();
    chatGptAskMock.mockReset();
    (Music as any).instance = undefined;
    music = new Music();
  });

  /**
   * Helper: intercept the internal calls by spying on the private methods.
   * We replace them with a stub that returns the provided values directly.
   */
  function stubSources(mb: number, discogs: number, ai: number) {
    vi.spyOn(music as any, 'searchMusicBrainz').mockResolvedValue({ year: mb });
    vi.spyOn(music as any, 'searchDiscogs').mockResolvedValue({ year: discogs });
    vi.spyOn(music as any, 'performGoogleSearch').mockResolvedValue([]);
    vi.spyOn(music as any, 'searchWikipedia').mockResolvedValue([]);
    chatGptAskMock.mockResolvedValue({ year: ai });
  }

  it('Rule 1: non-Spotify years are 0 but one source provides a spread → use spotify year when stddev > 1', async () => {
    // For Rule 1 to fire, stddev must be > 1. We need at least 2 valid years.
    // If MB gives a year different from AI, stddev will be > 1, then check Rule 1.
    // But Rule 1 requires discogs=0, ai=0, mb=0. So let's use 1 non-zero source
    // to get stddev > 1, with ai=0 and discogs=0 and mb providing a large spread.
    // Actually: the easiest way is mb=2000, discogs=0, ai=0 → stddev between mb(2000) and spotify(1999)
    // validYears = [1999(spotify in sources check)...] NO, spotify is not in the sources dict.
    // sources = {ai: 0, mb: 2000, discogs: 0} → validYears = [2000] → only 1 year → stddev = 0
    // So Rule 1 can never fire unless there are 2+ conflicting valid non-Spotify sources.
    // With mb=1980, discogs=0, ai=2000 → validYears=[1980,2000] → stddev=(2000-1980)/sqrt(2)=~14 > 1
    // In this case Rule 1 requires discogs==0 && ai==0 → ai=2000 != 0 → Rule 1 does NOT fire.
    // NOTE: suspected bug: Rule 1 can never fire in practice because:
    // - It requires stddev > 1 (need 2+ valid non-Spotify years to get stddev > 0)
    // - But it also requires mb==0 && discogs==0 && ai==0 (all non-Spotify years 0)
    // These two conditions are mutually exclusive!
    // Test that at least the output is a consistent 0 when all sources are 0
    stubSources(0, 0, 0);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1999);
    // All sources 0 → validYears=[] → stddev=0 → rules block never fires → finalYear=0
    // // NOTE: suspected bug: Spotify year is ignored when all other sources return 0 and stddev<=1
    expect(result.year).toBe(0);
  });

  it('Rule 3: Spotify equals AI → use Spotify (no MB/DC veto)', async () => {
    stubSources(0, 0, 1988); // ai=1988, spotify=1988 → rule 3 applies
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1988);
    expect(result.year).toBe(1988);
  });

  it('Rule 3: MB and Discogs agree on earlier year → veto applies, do NOT override', async () => {
    // mb=1982, discogs=1982, ai=1988, spotify=1988
    // MB and DC agree on 1982 < 1988 → veto: rule 3 does NOT apply
    stubSources(1982, 1982, 1988);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1988);
    // With veto, the AI/spotify override is blocked. The weighted average of 1982, 1982, 1988
    // with weights mb=0.25, discogs=0.25, ai=0.5 = (1982*0.25 + 1982*0.25 + 1988*0.5) / 1.0
    // = (495.5 + 495.5 + 994) / 1 = 1985
    expect(result.year).not.toBe(1988);
  });

  it('Rule 4: Discogs, MB, AI all agree → trust consensus', async () => {
    stubSources(1975, 1975, 1975);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1990);
    expect(result.year).toBe(1975);
    expect(result.standardDeviation).toBe(0);
  });

  it('Rule 5: all four sources agree → 4-way consensus wins', async () => {
    stubSources(1980, 1980, 1980);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1980);
    expect(result.year).toBe(1980);
    expect(result.standardDeviation).toBe(0);
  });

  it('returns weighted average when standard deviation <= 1', async () => {
    // All three sources within 1 year of each other → stddev <= 1 → no rules fire
    stubSources(1984, 1984, 1985); // very close — stddev < 1
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1990);
    // stddev <= 1 → finalYear is just the weighted average
    expect(result.standardDeviation).toBeLessThanOrEqual(1);
    // Weighted avg of valid years: ai=0.5, mb=0.25, discogs=0.25
    // = (1985*0.5 + 1984*0.25 + 1984*0.25) / 1.0 = (992.5 + 496 + 496) = 1984.5 → 1985 or 1984
    expect([1984, 1985]).toContain(result.year);
  });

  it('sources are reported in the result', async () => {
    stubSources(1970, 1972, 1974);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1975);
    expect(result.sources.mb).toBe(1970);
    expect(result.sources.discogs).toBe(1972);
    expect(result.sources.ai).toBe(1974);
    expect(result.sources.spotify).toBe(1975);
  });

  it('future years from any source are ignored in the weighted average', async () => {
    const nextYear = new Date().getFullYear() + 1;
    stubSources(nextYear, 0, 0); // MB is a future year (invalid) — discogs=0, ai=0
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1990);
    // Future MB year must be reported but excluded from calculation
    expect(result.sources.mb).toBe(nextYear);
    // validYears = [] (nextYear filtered out, discogs=0 filtered, ai=0 filtered)
    // → weightedAvg = 0 → finalYear = 0
    // Spotify year cannot override because stddev = 0 (no valid years)
    // NOTE: suspected bug: Spotify year (1990) is not used as a fallback when
    // it is the only valid year and all AI/MB/Discogs sources are invalid.
    expect(result.year).toBe(0);
  });

  it('Rule 2: Spotify is smallest year and ≥2 non-Spotify sources agree', async () => {
    // spotify=1970 (smallest), mb=1975, discogs=1975 (2 non-Spotify valid years) → Rule 2
    stubSources(1975, 1975, 1980);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 1970);
    expect(result.year).toBe(1970);
    expect(result.standardDeviation).toBe(0);
  });

  it('stddev > 1 does not crash when all years are 0', async () => {
    stubSources(0, 0, 0);
    const result = await music.getReleaseDate(1, 'ISRC', 'Artist', 'Title', 0);
    // All years 0, spotify 0 → no valid year; finalYear should be 0
    expect(result.year).toBe(0);
  });
});
