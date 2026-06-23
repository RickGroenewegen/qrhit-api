import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * AIPlaylistGenerator with every collaborator mocked: OpenAI (keyword
 * brainstorm / expansion / curation tool calls), Prisma (raw candidate
 * search + AISearch persistence), Spotify, Redis cache, the progress
 * WebSocket hub and cron. The real CostTracker (src/aiPricing) is used
 * so token/cost persistence is asserted against actual pricing math.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    cacheStore,
    cacheSet: vi.fn(async (key: string, value: string, _ttl?: number) => {
      cacheStore.set(key, value);
    }),
    createMock: vi.fn(),
    prismaMock: {
      aISearch: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
      playlist: { findUnique: vi.fn() },
      $queryRaw: vi.fn(),
    },
    spotifyCreate: vi.fn(),
    spotifyDelete: vi.fn(),
    wsProgress: vi.fn(),
    wsComplete: vi.fn(),
    wsError: vi.fn(),
    cronCtorCalls: [] as any[][],
    cronStarts: { count: 0 },
  };
});

vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: h.createMock } };
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prismaMock },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string, _parse?: boolean) =>
        h.cacheStore.get(key) ?? null,
      set: h.cacheSet,
    }),
  },
}));

vi.mock('../../../src/spotify', () => ({
  default: {
    getInstance: () => ({
      createOrUpdatePlaylist: h.spotifyCreate,
      deletePlaylist: h.spotifyDelete,
    }),
  },
}));

vi.mock('../../../src/progress-websocket', () => ({
  default: {
    getInstance: () => ({
      broadcastProgress: h.wsProgress,
      broadcastComplete: h.wsComplete,
      broadcastError: h.wsError,
    }),
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

// isMainServer → true so the singleton's scheduleCleanup() registers the
// (mocked) cron job and we can assert the schedule.
vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = async () => true;
    // Faithful subset of the real cleanTrackName: " - suffix" split,
    // "(feat. …)" removal, whitespace collapse. dedupeKey() layers its own
    // trailing-(…)/[…] stripping and lowercasing on top of this.
    cleanTrackName(name: string): string {
      let s = String(name ?? '');
      if (s.includes(' - ')) s = s.split(' - ')[0];
      s = s.replace(/\(feat\..*?\)/gi, ' ');
      return s.replace(/\s+/g, ' ').trim();
    }
  },
}));

vi.mock('cron', () => ({
  CronJob: class {
    constructor(...args: any[]) {
      h.cronCtorCalls.push(args);
    }
    start() {
      h.cronStarts.count += 1;
    }
  },
}));

import AIPlaylistGenerator, {
  aiPlaylistPromptKey,
  aiPlaylistProgressKey,
  AI_PLAYLIST_PROMPT_KEY,
  AI_PLAYLIST_PROGRESS_KEY,
} from '../../../src/aiPlaylist';
import { CostTracker } from '../../../src/aiPricing';

const gen = AIPlaylistGenerator.getInstance();
const MODEL = 'gpt-5.4-mini';

/** Chat completion carrying a single function tool call + usage. */
function toolCallResponse(
  name: string,
  args: unknown,
  usage: { prompt_tokens: number; completion_tokens: number },
  rawArgs?: string
) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: { name, arguments: rawArgs ?? JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage,
  };
}

const noToolCallResponse = (usage = { prompt_tokens: 5, completion_tokens: 1 }) => ({
  choices: [{ message: { content: 'no tool call' } }],
  usage,
});

let rowId = 0;
const row = (trackId: string, artist: string, name: string, sid: string) => ({
  id: ++rowId,
  trackId,
  artist,
  name,
  spotifyLink: `https://open.spotify.com/track/${sid}`,
});

/** Normalized SQL text of the n-th $queryRaw call. */
const sqlOfCall = (n: number) => {
  const arg = h.prismaMock.$queryRaw.mock.calls[n][0];
  return { sql: String(arg.sql).replace(/\s+/g, ' ').trim(), values: arg.values };
};

beforeEach(() => {
  h.createMock.mockReset();
  h.prismaMock.aISearch.create.mockReset().mockResolvedValue({});
  h.prismaMock.aISearch.update.mockReset().mockResolvedValue({});
  h.prismaMock.aISearch.findMany.mockReset();
  h.prismaMock.playlist.findUnique.mockReset();
  h.prismaMock.$queryRaw.mockReset();
  h.spotifyCreate.mockReset();
  h.spotifyDelete.mockReset();
  h.wsProgress.mockClear();
  h.wsComplete.mockClear();
  h.wsError.mockClear();
  h.cacheSet.mockClear();
  h.cacheStore.clear();
});

// ---------------------------------------------------------------------------
// Exported key helpers
// ---------------------------------------------------------------------------

describe('redis key helpers', () => {
  it('builds prompt and progress keys from the shared prefixes', () => {
    expect(aiPlaylistPromptKey('PL1')).toBe(`${AI_PLAYLIST_PROMPT_KEY}:PL1`);
    expect(aiPlaylistProgressKey('job-1')).toBe(
      `${AI_PLAYLIST_PROGRESS_KEY}:job-1`
    );
  });
});

// ---------------------------------------------------------------------------
// Cron scheduling (singleton side effect)
// ---------------------------------------------------------------------------

describe('scheduleCleanup', () => {
  it('schedules the daily 03:30 UTC cleanup cron once on the main server', async () => {
    // getInstance() at import time kicked off the fire-and-forget
    // isMainServer() promise; give it a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.cronCtorCalls).toHaveLength(1);
    expect(h.cronCtorCalls[0][0]).toBe('30 3 * * *');
    expect(typeof h.cronCtorCalls[0][1]).toBe('function');
    expect(h.cronStarts.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeYearRange (private)
// ---------------------------------------------------------------------------

describe('normalizeYearRange (private)', () => {
  const norm = (s: any, e: any) => (gen as any).normalizeYearRange(s, e);

  it('passes through nulls', () => {
    expect(norm(null, null)).toEqual({ startYear: null, endYear: null });
    expect(norm(undefined, undefined)).toEqual({ startYear: null, endYear: null });
  });

  it('swaps a reversed range', () => {
    expect(norm(1999, 1990)).toEqual({ startYear: 1990, endYear: 1999 });
  });

  it('rejects far-future years and floors fractional ones', () => {
    expect(norm(3050, 1995.7)).toEqual({ startYear: null, endYear: 1995 });
  });

  it('rejects non-numeric and non-finite values', () => {
    expect(norm('1990', NaN)).toEqual({ startYear: null, endYear: null });
  });

  it('rejects non-positive years but keeps historic ones (classical catalog)', () => {
    expect(norm(0, 1000)).toEqual({ startYear: null, endYear: 1000 });
  });
});

// ---------------------------------------------------------------------------
// dedupeKey (private)
// ---------------------------------------------------------------------------

describe('dedupeKey (private)', () => {
  const key = (a: any, n: any) => (gen as any).dedupeKey(a, n);

  it('joins normalized artist and title with |||', () => {
    expect(key('Queen', 'Bohemian Rhapsody')).toBe('queen|||bohemian rhapsody');
  });

  it('collapses " - Remastered"-style suffixes and casing', () => {
    expect(key('QUEEN', 'Bohemian Rhapsody - Remastered 2011')).toBe(
      key('Queen', 'Bohemian Rhapsody')
    );
  });

  it('strips trailing parenthetical/bracket groups and trailing punctuation', () => {
    expect(key('Vengaboys', 'We Like to Party! (The Vengabus)')).toBe(
      key('Vengaboys', 'We Like To Party')
    );
  });

  it('strips repeated trailing groups', () => {
    expect(key('A', 'Song [Single Version] (Live)')).toBe(key('A', 'Song'));
  });

  it('returns an empty key when either side is missing', () => {
    expect(key('', 'Song')).toBe('');
    expect(key('Artist', null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// searchByKeyword (private) — SQL assembly
// ---------------------------------------------------------------------------

describe('searchByKeyword (private)', () => {
  const search = (kw: any, s: number | null, e: number | null) =>
    (gen as any).searchByKeyword(kw, s, e);

  beforeEach(() => {
    h.prismaMock.$queryRaw.mockResolvedValue([]);
  });

  it('escapes LIKE wildcards and searches both columns for target=any', async () => {
    await search({ value: '100%_a', target: 'any' }, null, null);
    const { sql, values } = sqlOfCall(0);
    expect(sql).toContain('(artist LIKE ? OR name LIKE ?)');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).not.toContain('year');
    expect(values).toEqual(['%100\\%\\_a%', '%100\\%\\_a%', 50]);
  });

  it('searches only the title column with a BETWEEN year filter', async () => {
    await search({ value: 'Love', target: 'title' }, 1990, 1999);
    const { sql, values } = sqlOfCall(0);
    expect(sql).toContain('AND name LIKE ?');
    expect(sql).not.toContain('artist LIKE');
    expect(sql).toContain('year IS NOT NULL AND year BETWEEN ? AND ?');
    expect(values).toEqual(['%Love%', 1990, 1999, 50]);
  });

  it('searches only the artist column with an end-year-only filter', async () => {
    await search({ value: 'ABBA', target: 'artist' }, null, 1999);
    const { sql, values } = sqlOfCall(0);
    expect(sql).toContain('AND artist LIKE ?');
    expect(sql).not.toContain('name LIKE');
    expect(sql).toContain('year IS NOT NULL AND year <= ?');
    expect(values).toEqual(['%ABBA%', 1999, 50]);
  });

  it('applies a start-year-only filter', async () => {
    await search({ value: 'ABBA', target: 'any' }, 2010, null);
    const { sql } = sqlOfCall(0);
    expect(sql).toContain('year IS NOT NULL AND year >= ?');
  });
});

// ---------------------------------------------------------------------------
// thinkKeywords (private) — prompt assembly + response parsing
// ---------------------------------------------------------------------------

describe('thinkKeywords (private)', () => {
  const think = (jobId: string, prompt: string, locale: string, cost: CostTracker) =>
    (gen as any).thinkKeywords(jobId, prompt, locale, cost);

  it('sends the keyword-rules system prompt, locale hint and tool schema', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse(
        'returnKeywords',
        {
          title: 'Dutch 90s',
          keywords: ['2 Unlimited'],
          artistKeywords: [],
          titleKeywords: [],
          startYear: 1990,
          endYear: 1999,
        },
        { prompt_tokens: 100, completion_tokens: 10 }
      )
    );

    await think('job-t1', 'Dutch 90s hits', 'nl', new CostTracker(MODEL));

    const payload = h.createMock.mock.calls[0][0];
    expect(payload.model).toBe(MODEL);
    expect(payload.tool_choice).toEqual({
      type: 'function',
      function: { name: 'returnKeywords' },
    });
    const system = payload.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('KEYWORD RULES — CRITICAL');
    expect(system.content).toContain('Dutch (Netherlands / Flanders)');
    expect(system.content).toContain('LOCALE BIAS — IMPORTANT');
    const user = payload.messages[1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('Theme:\nDutch 90s hits');
    expect(user.content).toContain('User locale: nl');
    expect(user.content).toContain('max 100');
    expect(payload.tools[0].function.name).toBe('returnKeywords');
    expect(payload.tools[0].function.parameters.required).toEqual([
      'title',
      'keywords',
      'artistKeywords',
      'titleKeywords',
      'startYear',
      'endYear',
    ]);

    // Progress broadcast before the LLM call.
    expect(h.wsProgress).toHaveBeenCalledWith(
      'job-t1',
      'ai',
      'job-t1',
      expect.objectContaining({
        stage: 'thinking_keywords',
        percentage: 5,
        messageKey: 'submit.aiMsg.thinking',
      })
    );
  });

  it('uses a no-bias hint for the en locale', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse(
        'returnKeywords',
        { title: 'T', keywords: ['a'], artistKeywords: [], titleKeywords: [], startYear: null, endYear: null },
        { prompt_tokens: 1, completion_tokens: 1 }
      )
    );
    await think('job-t2', 'hits', 'en', new CostTracker(MODEL));
    expect(h.createMock.mock.calls[0][0].messages[0].content).toContain(
      'Treat this as the default global catalog'
    );
  });

  it('merges the three buckets, keeping the most specific intent and first display value', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse(
        'returnKeywords',
        {
          title: '  "Dutch 90s Hits" ',
          // 'love' appears in both title bucket and any bucket → stays title.
          keywords: ['2 Unlimited', ' love ', ''],
          artistKeywords: ['Vengaboys', '2 unlimited'],
          titleKeywords: ['Love'],
          startYear: 1999, // reversed on purpose
          endYear: 1990,
        },
        { prompt_tokens: 100, completion_tokens: 10 }
      )
    );

    const cost = new CostTracker(MODEL);
    const out = await think('job-t3', 'Dutch 90s hits', 'nl', cost);

    // Ingest order is title → artist → any; dedupe is case-insensitive on
    // the trimmed value; the first-seen display string and the most
    // specific intent win ('2 Unlimited' in the any-bucket collapses into
    // the artist-bucket '2 unlimited').
    expect(out.keywords).toEqual([
      { value: 'Love', target: 'title' },
      { value: 'Vengaboys', target: 'artist' },
      { value: '2 unlimited', target: 'artist' },
    ]);
    expect(out.title).toBe('Dutch 90s Hits'); // quotes stripped
    expect(out.startYear).toBe(1990); // swapped
    expect(out.endYear).toBe(1999);
    expect(cost.callCount).toBe(1);
    expect(cost.inputTokens).toBe(100);
    expect(cost.outputTokens).toBe(10);

    // Done-broadcast announces the range and displayable keyword strings.
    expect(h.wsProgress).toHaveBeenCalledWith(
      'job-t3',
      'ai',
      'job-t3',
      expect.objectContaining({
        percentage: 15,
        messageKey: 'submit.aiMsg.keywordsDoneWithRange',
        keywords: ['Love', 'Vengaboys', '2 unlimited'],
        startYear: 1990,
        endYear: 1999,
      })
    );
  });

  it('caps the merged keyword list at 100', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse(
        'returnKeywords',
        {
          title: 'Big',
          keywords: Array.from({ length: 120 }, (_, i) => `artist-${i}`),
          artistKeywords: [],
          titleKeywords: [],
          startYear: null,
          endYear: null,
        },
        { prompt_tokens: 1, completion_tokens: 1 }
      )
    );
    const out = await think('job-t4', 'everything', 'en', new CostTracker(MODEL));
    expect(out.keywords).toHaveLength(100);
  });

  it('trims an over-long title to 60 characters', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse(
        'returnKeywords',
        {
          title: `"${'x'.repeat(80)}"`,
          keywords: ['a'],
          artistKeywords: [],
          titleKeywords: [],
          startYear: null,
          endYear: null,
        },
        { prompt_tokens: 1, completion_tokens: 1 }
      )
    );
    const out = await think('job-t5', 'p', 'en', new CostTracker(MODEL));
    expect(out.title).toBe('x'.repeat(60));
  });

  it('throws when the model returns no tool call', async () => {
    h.createMock.mockResolvedValueOnce(noToolCallResponse());
    await expect(
      think('job-t6', 'p', 'en', new CostTracker(MODEL))
    ).rejects.toThrow('Keyword generation returned no tool call');
  });

  it('throws when the tool arguments are not valid JSON', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse('returnKeywords', null, { prompt_tokens: 1, completion_tokens: 1 }, 'not-json{')
    );
    await expect(
      think('job-t7', 'p', 'en', new CostTracker(MODEL))
    ).rejects.toThrow('Failed to parse keyword tool call arguments');
  });
});

// ---------------------------------------------------------------------------
// expandKeywords (private)
// ---------------------------------------------------------------------------

describe('expandKeywords (private)', () => {
  const expand = (tried: string[]) =>
    (gen as any).expandKeywords(
      'job-e1',
      'theme',
      'en',
      tried,
      null,
      null,
      new CostTracker(MODEL)
    );

  it('lists the already-tried keywords and filters them from the answer', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse(
        'returnMoreKeywords',
        { keywords: ['ABBA', ' Agnetha ', 'agnetha', ''] },
        { prompt_tokens: 10, completion_tokens: 5 }
      )
    );
    const out = await expand(['abba', 'nobody']);
    expect(out).toEqual([{ value: 'Agnetha', target: 'any' }]);

    const payload = h.createMock.mock.calls[0][0];
    expect(payload.tool_choice.function.name).toBe('returnMoreKeywords');
    expect(payload.messages[1].content).toContain(
      'Already tried (do not repeat any of these):\nabba, nobody'
    );
    expect(payload.messages[0].content).toContain('No specific year range was implied.');
  });

  it('returns [] when there is no tool call', async () => {
    h.createMock.mockResolvedValueOnce(noToolCallResponse());
    expect(await expand(['x'])).toEqual([]);
  });

  it('returns [] when the tool arguments are malformed', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse('returnMoreKeywords', null, { prompt_tokens: 1, completion_tokens: 1 }, '{{')
    );
    expect(await expand(['x'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// curateBatch (private)
// ---------------------------------------------------------------------------

describe('curateBatch (private)', () => {
  const batch = [
    row('c1', 'Artist One', 'Song One', 'cs1'),
    row('c2', 'Artist Two', 'Song Two', 'cs2'),
  ];
  const curateBatch = (remaining: number, cost = new CostTracker(MODEL)) =>
    (gen as any).curateBatch('theme', batch, remaining, null, null, cost);

  it('switches to inclusive mode when the pool is small and lists candidates tab-separated', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse('returnPicks', { trackIds: ['c1', '', 'c2'] }, { prompt_tokens: 10, completion_tokens: 5 })
    );
    // pool 2 <= remaining*1.5 (3) → inclusive
    const picked = await curateBatch(2);
    expect(picked).toEqual(['c1', 'c2']); // falsy ids filtered

    const payload = h.createMock.mock.calls[0][0];
    expect(payload.messages[0].content).toContain('INCLUSIVE MODE');
    expect(payload.messages[1].content).toContain('Pick up to 2');
    expect(payload.messages[1].content).toContain('c1\tArtist One — Song One');
    expect(payload.messages[1].content).toContain('c2\tArtist Two — Song Two');
  });

  it('uses selective mode when the pool is plentiful and records cost', async () => {
    h.createMock.mockResolvedValueOnce(
      toolCallResponse('returnPicks', { trackIds: ['c1'] }, { prompt_tokens: 10, completion_tokens: 5 })
    );
    const cost = new CostTracker(MODEL);
    await curateBatch(1, cost); // pool 2 > 1*1.5 → selective
    expect(h.createMock.mock.calls[0][0].messages[0].content).toContain('SELECTIVE MODE');
    expect(cost.callCount).toBe(1);
    expect(cost.inputTokens).toBe(10);
    expect(cost.outputTokens).toBe(5);
  });

  it('returns [] on a missing tool call or malformed arguments', async () => {
    h.createMock.mockResolvedValueOnce(noToolCallResponse());
    expect(await curateBatch(1)).toEqual([]);
    h.createMock.mockResolvedValueOnce(
      toolCallResponse('returnPicks', null, { prompt_tokens: 1, completion_tokens: 1 }, 'nope')
    );
    expect(await curateBatch(1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// run() — full pipeline
// ---------------------------------------------------------------------------

describe('run (happy path)', () => {
  const JOB = 'job-happy';
  const PROMPT = 'Dutch 90s hits';

  // Candidate rows. The pool deliberately contains all three duplicate
  // classes: same trackId, same Spotify id, and same normalized
  // artist+title.
  const T1 = row('t1', 'Whitney Houston', 'How Will I Know', 's1');
  const T2 = row('t2', 'Vengaboys', 'Boom, Boom, Boom, Boom!!', 's2');
  const T3 = row('t3', 'Vengaboys', 'We Like to Party! (The Vengabus)', 's3');
  const T4 = row('t4', '2 Unlimited', 'No Limit', 's4');
  const T5 = row('t5', '2 Unlimited', 'No Limit - Live', 's5'); // artist+title dup of T4
  const T6 = row('t6', 'Spice Girls', 'Wannabe', 's4'); // Spotify-id dup of T4
  const T3b = row('t3b', 'Vengaboys', 'We Like To Party', 's3b'); // artist+title dup of T3
  const T7 = row('t7', '2 Unlimited', 'Twilight Zone', 's7');

  function prime() {
    h.createMock
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnKeywords',
          {
            title: '"Dutch 90s Hits"',
            keywords: ['2 Unlimited'],
            artistKeywords: ['Vengaboys'],
            titleKeywords: ['Love'],
            startYear: 1999,
            endYear: 1990, // reversed → normalized to 1990–1999
          },
          { prompt_tokens: 1000, completion_tokens: 200 }
        )
      )
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnPicks',
          // 'bogus' is an invented trackId → must be dropped; t2 is cut by
          // the target cap (trackCount=2).
          { trackIds: ['t4', 'bogus', 't1', 't2'] },
          { prompt_tokens: 2000, completion_tokens: 100 }
        )
      );

    // Keyword search order = bucket-merge order: Love[title],
    // Vengaboys[artist], 2 Unlimited[any].
    h.prismaMock.$queryRaw
      .mockResolvedValueOnce([T1])
      .mockResolvedValueOnce([T1, T2, T3])
      .mockResolvedValueOnce([T4, T5, T6, T3b, T7]);

    h.spotifyCreate.mockResolvedValue({
      success: true,
      data: {
        playlistId: 'PL1',
        playlistUrl: 'https://open.spotify.com/playlist/PL1',
      },
    });
  }

  it('runs the four steps and persists a success AISearch row with real cost math', async () => {
    prime();
    await gen.run({ jobId: JOB, prompt: PROMPT, trackCount: 2, locale: 'nl' });

    // Up-front AISearch row.
    expect(h.prismaMock.aISearch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: JOB,
        shortId: expect.stringMatching(/^[a-z0-9]{8}$/),
        prompt: PROMPT,
        locale: 'nl',
        requestedCount: 2,
        model: MODEL,
        status: 'running',
      }),
    });

    // Exactly 2 LLM calls: think + 1 curation batch (no expansion: 5 unique
    // candidates >= targetPool 4; no top-up: target reached).
    expect(h.createMock).toHaveBeenCalledTimes(2);

    // Curation prompt: theme, year hint, quota, tab-separated candidates.
    const curatePayload = h.createMock.mock.calls[1][0];
    expect(curatePayload.tool_choice.function.name).toBe('returnPicks');
    expect(curatePayload.messages[0].content).toContain('SELECTIVE MODE');
    expect(curatePayload.messages[1].content).toContain(`Theme:\n${PROMPT}`);
    expect(curatePayload.messages[1].content).toContain('from 1990–1999');
    expect(curatePayload.messages[1].content).toContain('Pick up to 2');
    expect(curatePayload.messages[1].content).toContain('t4\t2 Unlimited — No Limit');
    // Duplicates never reach the LLM.
    expect(curatePayload.messages[1].content).not.toContain('t5\t');
    expect(curatePayload.messages[1].content).not.toContain('t6\t');
    expect(curatePayload.messages[1].content).not.toContain('t3b\t');

    // Keyword searches used the normalized year range.
    expect(h.prismaMock.$queryRaw).toHaveBeenCalledTimes(3);
    expect(sqlOfCall(0).values).toEqual(['%Love%', 1990, 1999, 50]);
    expect(sqlOfCall(0).sql).toContain('AND name LIKE ?');
    expect(sqlOfCall(1).sql).toContain('AND artist LIKE ?');
    expect(sqlOfCall(2).sql).toContain('(artist LIKE ? OR name LIKE ?)');

    // Spotify playlist: picked order (t4, t1), invented id dropped, name
    // carries the cleaned title + AIID suffix.
    expect(h.spotifyCreate).toHaveBeenCalledTimes(1);
    const [playlistName, trackIds] = h.spotifyCreate.mock.calls[0];
    expect(playlistName).toMatch(/^qrsong! AI — Dutch 90s Hits \(AIID: [a-z0-9]{8}\)$/);
    expect(trackIds).toEqual(['s4', 's1']);

    // Prompt cached for the post-payment flow, with the 7-day TTL.
    expect(h.cacheSet).toHaveBeenCalledWith(
      'aiPlaylistPrompt:PL1',
      PROMPT,
      7 * 24 * 3600
    );

    // Final AISearch row: status, delivered count, keywords, year range and
    // the real CostTracker math (3000 in + 300 out tokens of gpt-5.4-mini).
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith({
      where: { jobId: JOB },
      data: expect.objectContaining({
        status: 'success',
        errorMessage: null,
        deliveredCount: 2,
        keywords: ['Love', 'Vengaboys', '2 Unlimited'],
        title: 'Dutch 90s Hits',
        startYear: 1990,
        endYear: 1999,
        spotifyPlaylistId: 'PL1',
        spotifyPlaylistUrl: 'https://open.spotify.com/playlist/PL1',
        inputTokens: 3000,
        outputTokens: 300,
        // 3000/1e6*0.75 + 300/1e6*4.5
        totalCostUsd: 0.0036,
        durationMs: expect.any(Number),
      }),
    });

    // Completion broadcast mirrors deliveredCount into trackCount.
    expect(h.wsComplete).toHaveBeenCalledWith(JOB, 'ai', JOB, {
      spotifyPlaylistUrl: 'https://open.spotify.com/playlist/PL1',
      spotifyPlaylistId: 'PL1',
      requestedCount: 2,
      deliveredCount: 2,
      trackCount: 2,
    });
    expect(h.wsError).not.toHaveBeenCalled();

    // Terminal snapshot persisted to Redis for reload-resume.
    const snap = JSON.parse(h.cacheStore.get(`aiPlaylistProgress:${JOB}`)!);
    expect(snap).toMatchObject({
      jobId: JOB,
      status: 'success',
      percentage: 100,
      deliveredCount: 2,
      spotifyPlaylistId: 'PL1',
      spotifyPlaylistUrl: 'https://open.spotify.com/playlist/PL1',
      requestedCount: 2,
      activeWord: null,
    });
    // All three keywords returned hits, so all are in the word cloud.
    expect(snap.keywords).toEqual(['Love', 'Vengaboys', '2 Unlimited']);
  });

  it('still completes when the up-front AISearch insert fails', async () => {
    prime();
    h.prismaMock.aISearch.create.mockRejectedValueOnce(new Error('db down'));

    await gen.run({ jobId: 'job-noinsert', prompt: PROMPT, trackCount: 2, locale: 'nl' });

    expect(h.spotifyCreate).toHaveBeenCalledTimes(1);
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: 'job-noinsert' },
        data: expect.objectContaining({ status: 'success' }),
      })
    );
    expect(h.wsComplete).toHaveBeenCalledTimes(1);
  });
});

describe('run (keyword expansion)', () => {
  it('asks for more keywords when the pool is too small, merges without duplicates and stops on an empty round', async () => {
    const JOB = 'job-expand';
    const A1 = row('a1', 'ABBA', 'Waterloo', 'sa1');
    const A2 = row('a2', 'ABBA', 'SOS', 'sa2');
    const A3 = row('a3', 'Agnetha Fältskog', 'The Heat Is On', 'sa3');
    const A4 = row('a4', 'Agnetha Fältskog', 'Wrap Your Arms Around Me', 'sa4');

    h.createMock
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnKeywords',
          {
            title: 'ABBA Deep Cuts',
            keywords: ['ABBA', 'Nobody'],
            artistKeywords: [],
            titleKeywords: [],
            startYear: null,
            endYear: null,
          },
          { prompt_tokens: 100, completion_tokens: 20 }
        )
      )
      // Round 1: 'ABBA' must be ignored (already tried), 'Agnetha' is new.
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnMoreKeywords',
          { keywords: ['ABBA', 'Agnetha'] },
          { prompt_tokens: 50, completion_tokens: 10 }
        )
      )
      // Round 2: empty → expansion loop must break.
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnMoreKeywords',
          { keywords: [] },
          { prompt_tokens: 40, completion_tokens: 5 }
        )
      )
      // Curation: pool (4) <= target (5) * 1.5 → inclusive, returns all.
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnPicks',
          { trackIds: ['a1', 'a2', 'a3', 'a4'] },
          { prompt_tokens: 200, completion_tokens: 30 }
        )
      );

    h.prismaMock.$queryRaw
      .mockResolvedValueOnce([A1, A2]) // ABBA
      .mockResolvedValueOnce([]) // Nobody → zero hits
      .mockResolvedValueOnce([{ ...A2 }, A3, A4]); // Agnetha (a2 = trackId dup)

    h.spotifyCreate.mockResolvedValue({
      success: true,
      data: { playlistId: 'PL2', playlistUrl: 'https://spotify/PL2' },
    });

    await gen.run({ jobId: JOB, prompt: 'ABBA deep cuts', trackCount: 5, locale: 'en' });

    // think + expand + expand + curate
    expect(h.createMock).toHaveBeenCalledTimes(4);
    expect(h.createMock.mock.calls[1][0].messages[1].content).toContain(
      'Already tried (do not repeat any of these):\nabba, nobody'
    );
    expect(h.createMock.mock.calls[3][0].messages[0].content).toContain('INCLUSIVE MODE');

    // 4 unique tracks survive the merge (a2 deduped across rounds).
    const [, trackIds] = h.spotifyCreate.mock.calls[0];
    expect(trackIds).toEqual(['sa1', 'sa2', 'sa3', 'sa4']);

    // Cost accumulates across all four calls (390 in / 65 out tokens).
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'success',
          deliveredCount: 4, // Spotify addedCount, not the requested 5
          inputTokens: 390,
          outputTokens: 65,
          totalCostUsd: parseFloat(
            ((390 / 1e6) * 0.75 + (65 / 1e6) * 4.5).toFixed(6)
          ),
          // NOTE: actual behavior — only the FIRST-round keywords are
          // persisted; expansion keywords (Agnetha) are not.
          keywords: ['ABBA', 'Nobody'],
          startYear: null,
          endYear: null,
        }),
      })
    );

    // The snapshot word cloud only collects keywords with >= 1 hit, so the
    // zero-hit 'Nobody' is excluded while expansion hit 'Agnetha' is in.
    const snap = JSON.parse(h.cacheStore.get(`aiPlaylistProgress:${JOB}`)!);
    expect(snap.keywords).toEqual(['ABBA', 'Agnetha']);

    expect(h.wsComplete).toHaveBeenCalledWith(JOB, 'ai', JOB, {
      spotifyPlaylistUrl: 'https://spotify/PL2',
      spotifyPlaylistId: 'PL2',
      requestedCount: 5,
      deliveredCount: 4,
      trackCount: 4,
    });
  });
});

describe('run (curation top-up)', () => {
  it('runs a top-up batch over the leftovers when the first pass under-delivers', async () => {
    const JOB = 'job-topup';
    const rows = [
      row('r1', 'A1', 'S1', 'sr1'),
      row('r2', 'A2', 'S2', 'sr2'),
      row('r3', 'A3', 'S3', 'sr3'),
      row('r4', 'A4', 'S4', 'sr4'),
      row('r5', 'A5', 'S5', 'sr5'),
    ];

    h.createMock
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnKeywords',
          { title: 'T', keywords: ['X'], artistKeywords: [], titleKeywords: [], startYear: null, endYear: null },
          { prompt_tokens: 10, completion_tokens: 2 }
        )
      )
      // Main pass: quota is 2 but only 1 pick comes back.
      .mockResolvedValueOnce(
        toolCallResponse('returnPicks', { trackIds: ['r1'] }, { prompt_tokens: 10, completion_tokens: 2 })
      )
      // Top-up pass over the 4 leftovers: only 1 still needed.
      .mockResolvedValueOnce(
        toolCallResponse('returnPicks', { trackIds: ['r2', 'r3'] }, { prompt_tokens: 10, completion_tokens: 2 })
      );

    h.prismaMock.$queryRaw.mockResolvedValueOnce(rows);
    h.spotifyCreate.mockResolvedValue({
      success: true,
      data: { playlistId: 'PL3', playlistUrl: 'https://spotify/PL3' },
    });

    await gen.run({ jobId: JOB, prompt: 'theme', trackCount: 2, locale: 'en' });

    expect(h.createMock).toHaveBeenCalledTimes(3);
    expect(h.createMock.mock.calls[1][0].messages[1].content).toContain('Pick up to 2');
    expect(h.createMock.mock.calls[2][0].messages[1].content).toContain('Pick up to 1');

    // r3 is cut by the hard target cap: r1 from the main pass + r2 top-up.
    const [, trackIds] = h.spotifyCreate.mock.calls[0];
    expect(trackIds).toEqual(['sr1', 'sr2']);
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'success', deliveredCount: 2 }),
      })
    );
  });
});

describe('run (error paths)', () => {
  it('finalizes an error row and broadcasts when keyword generation returns no tool call', async () => {
    const JOB = 'job-nokw';
    h.createMock.mockResolvedValueOnce(noToolCallResponse({ prompt_tokens: 5, completion_tokens: 1 }));

    await gen.run({ jobId: JOB, prompt: 'p', trackCount: 3, locale: 'en' });

    expect(h.prismaMock.aISearch.update).toHaveBeenCalledTimes(1);
    const { where, data } = h.prismaMock.aISearch.update.mock.calls[0][0];
    expect(where).toEqual({ jobId: JOB });
    expect(data).toMatchObject({
      status: 'error',
      errorMessage: 'Keyword generation returned no tool call',
      deliveredCount: 0,
      title: null,
      // Tokens were recorded BEFORE the tool-call check, so the failed call
      // still counts toward cost.
      inputTokens: 5,
      outputTokens: 1,
      totalCostUsd: parseFloat(((5 / 1e6) * 0.75 + (1 / 1e6) * 4.5).toFixed(6)),
    });
    // No keywords gathered → JsonNull sentinel.
    expect(data.keywords).toBe(Prisma.JsonNull);

    expect(h.wsError).toHaveBeenCalledWith(
      JOB,
      'ai',
      JOB,
      'Keyword generation returned no tool call'
    );
    expect(h.wsComplete).not.toHaveBeenCalled();
    expect(h.spotifyCreate).not.toHaveBeenCalled();

    const snap = JSON.parse(h.cacheStore.get(`aiPlaylistProgress:${JOB}`)!);
    expect(snap.status).toBe('error');
    expect(snap.error).toBe('Keyword generation returned no tool call');
  });

  it('fails the run when the keyword tool arguments are malformed JSON', async () => {
    const JOB = 'job-badjson';
    h.createMock.mockResolvedValueOnce(
      toolCallResponse('returnKeywords', null, { prompt_tokens: 1, completion_tokens: 1 }, '<not json>')
    );

    await gen.run({ jobId: JOB, prompt: 'p', trackCount: 3, locale: 'en' });

    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'error',
          errorMessage: 'Failed to parse keyword tool call arguments',
        }),
      })
    );
    expect(h.wsError).toHaveBeenCalledWith(
      JOB,
      'ai',
      JOB,
      'Failed to parse keyword tool call arguments'
    );
  });

  it('aborts with a dedicated error when curation keeps zero tracks', async () => {
    const JOB = 'job-zero';
    h.createMock
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnKeywords',
          { title: 'Q', keywords: ['Queen'], artistKeywords: [], titleKeywords: [], startYear: null, endYear: null },
          { prompt_tokens: 10, completion_tokens: 2 }
        )
      )
      // Main curation batch and the top-up batch both return nothing.
      .mockResolvedValueOnce(
        toolCallResponse('returnPicks', { trackIds: [] }, { prompt_tokens: 10, completion_tokens: 2 })
      )
      .mockResolvedValueOnce(
        toolCallResponse('returnPicks', { trackIds: [] }, { prompt_tokens: 10, completion_tokens: 2 })
      );
    h.prismaMock.$queryRaw.mockResolvedValueOnce([
      row('q1', 'Queen', 'One', 'sq1'),
      row('q2', 'Queen', 'Two', 'sq2'),
      row('q3', 'Queen', 'Three', 'sq3'),
    ]);

    await gen.run({ jobId: JOB, prompt: 'queen', trackCount: 1, locale: 'en' });

    expect(h.spotifyCreate).not.toHaveBeenCalled();
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'error',
          errorMessage: 'No tracks matched the theme',
          deliveredCount: 0,
          keywords: ['Queen'],
        }),
      })
    );
    expect(h.wsError).toHaveBeenCalledWith(
      JOB,
      'ai',
      JOB,
      'Could not find any matching tracks for this theme.'
    );
  });

  it('finalizes an error row when Spotify playlist creation fails', async () => {
    const JOB = 'job-spfail';
    h.createMock
      .mockResolvedValueOnce(
        toolCallResponse(
          'returnKeywords',
          { title: 'T', keywords: ['X'], artistKeywords: [], titleKeywords: [], startYear: null, endYear: null },
          { prompt_tokens: 10, completion_tokens: 2 }
        )
      )
      .mockResolvedValueOnce(
        toolCallResponse('returnPicks', { trackIds: ['p1', 'p2'] }, { prompt_tokens: 10, completion_tokens: 2 })
      );
    h.prismaMock.$queryRaw.mockResolvedValueOnce([
      row('p1', 'A', 'One', 'sp1'),
      row('p2', 'B', 'Two', 'sp2'),
      row('p3', 'C', 'Three', 'sp3'),
      row('p4', 'D', 'Four', 'sp4'),
    ]);
    h.spotifyCreate.mockResolvedValue({ success: false, error: 'Spotify exploded' });

    await gen.run({ jobId: JOB, prompt: 'theme', trackCount: 2, locale: 'en' });

    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'error',
          errorMessage: 'Spotify exploded',
          deliveredCount: 2, // the LLM picks survive into the error row
          spotifyPlaylistId: null,
          spotifyPlaylistUrl: null,
        }),
      })
    );
    expect(h.wsError).toHaveBeenCalledWith(JOB, 'ai', JOB, 'Spotify exploded');
    // The prompt is never cached when playlist creation fails.
    expect(h.cacheSet).not.toHaveBeenCalledWith(
      expect.stringContaining('aiPlaylistPrompt:'),
      expect.anything(),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// getSnapshot
// ---------------------------------------------------------------------------

describe('getSnapshot', () => {
  it('returns the parsed snapshot from the cache', async () => {
    const snap = { jobId: 'j1', status: 'running', percentage: 42, keywords: ['a'], updatedAt: 1 };
    h.cacheStore.set('aiPlaylistProgress:j1', JSON.stringify(snap));
    expect(await gen.getSnapshot('j1')).toEqual(snap);
  });

  it('returns null when there is no snapshot', async () => {
    expect(await gen.getSnapshot('missing')).toBeNull();
  });

  it('returns null when the stored snapshot is corrupt', async () => {
    h.cacheStore.set('aiPlaylistProgress:j2', '{broken');
    expect(await gen.getSnapshot('j2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cleanupUnpurchasedPlaylists
// ---------------------------------------------------------------------------

describe('cleanupUnpurchasedPlaylists', () => {
  it('deletes unpurchased playlists, skips purchased ones and counts failures', async () => {
    h.prismaMock.aISearch.findMany.mockResolvedValue([
      { id: 1, jobId: 'j-del', spotifyPlaylistId: 'sp-del' },
      { id: 2, jobId: 'j-bought', spotifyPlaylistId: 'sp-bought' },
      { id: 3, jobId: 'j-fail', spotifyPlaylistId: 'sp-fail' },
      { id: 4, jobId: 'j-crash', spotifyPlaylistId: 'sp-crash' },
    ]);
    h.prismaMock.playlist.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.playlistId === 'sp-bought') return { id: 99 };
      if (where.playlistId === 'sp-crash') throw new Error('db hiccup');
      return null;
    });
    h.spotifyDelete.mockImplementation(async (id: string) =>
      id === 'sp-del' ? { success: true } : { success: false, error: 'denied' }
    );

    const result = await gen.cleanupUnpurchasedPlaylists();
    expect(result).toEqual({ scanned: 4, deleted: 1, skipped: 1, errors: 2 });

    // Candidate query: successful, week-old, not yet cleaned.
    const where = h.prismaMock.aISearch.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('success');
    expect(where.spotifyPlaylistId).toEqual({ not: null });
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(
      7 * 24 * 3600 * 1000 - 5000
    );
    expect(where.OR).toEqual([
      { errorMessage: null },
      { NOT: { errorMessage: { startsWith: 'cleaned:' } } },
    ]);

    // Only the unpurchased ones reach Spotify; the purchased one never does.
    expect(h.spotifyDelete.mock.calls.map((c) => c[0])).toEqual(['sp-del', 'sp-fail']);

    // Only the successful deletion is marked with the cleaned: sentinel.
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledTimes(1);
    expect(h.prismaMock.aISearch.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { errorMessage: expect.stringMatching(/^cleaned:/) },
    });
  });

  it('returns all zeros when there are no candidates', async () => {
    h.prismaMock.aISearch.findMany.mockResolvedValue([]);
    expect(await gen.cleanupUnpurchasedPlaylists()).toEqual({
      scanned: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
    });
    expect(h.spotifyDelete).not.toHaveBeenCalled();
    expect(h.prismaMock.aISearch.update).not.toHaveBeenCalled();
  });
});
