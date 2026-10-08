import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Collaborator mocks (no network, no DB, no native sharp work)
// ---------------------------------------------------------------------------

const {
  createMock,
  imagesEditMock,
  prismaQueryRaw,
  prismaExecuteRaw,
  sharpChain,
  sharpFactory,
} = vi.hoisted(() => {
  const chain = {
    jpeg: vi.fn(),
    webp: vi.fn(),
    resize: vi.fn(),
    toFile: vi.fn(),
  };
  chain.jpeg.mockReturnValue(chain);
  chain.webp.mockReturnValue(chain);
  chain.resize.mockReturnValue(chain);
  chain.toFile.mockResolvedValue(undefined);
  return {
    createMock: vi.fn(),
    imagesEditMock: vi.fn(),
    prismaQueryRaw: vi.fn(),
    prismaExecuteRaw: vi.fn(),
    sharpChain: chain,
    sharpFactory: vi.fn(() => chain),
  };
});

// Every task on its OpenAI route, so the SDK mock below answers it.
vi.mock('../../src/llm/tasks', async (importOriginal) =>
  (await import('../helpers/llm-openai-routes')).openAiRoutes(await importOriginal<any>())
);

vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: createMock } };
    images = { edit: imagesEditMock };
  },
}));

vi.mock('../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      $queryRaw: prismaQueryRaw,
      $executeRaw: prismaExecuteRaw,
    }),
  },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../src/utils', () => ({
  default: class {},
}));

vi.mock('../../src/translation', () => ({
  default: class {
    allLocales = ['en', 'nl'];
    isValidLocale = (l: string) => ['en', 'nl'].includes(l);
    getLanguageName = (l: string) => (l === 'nl' ? 'Dutch' : 'English');
    translate = (key: string, locale: string) => `[${key}:${locale}]`;
  },
}));

vi.mock('sharp', () => ({ default: sharpFactory }));

import { AiTasks } from '../../src/aiTasks';

const gpt = new AiTasks();

/**
 * Builds a chat completion response carrying a structured (json_schema)
 * output. The schema name is accepted for readability at the call sites but
 * plays no part in the response.
 */
function toolCallResponse(_name: string, args: unknown, rawArgs?: string) {
  return {
    choices: [
      {
        message: {
          content: rawArgs ?? JSON.stringify(args),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** A completion with no message content (refusal or empty output). */
const noToolCallResponse = {
  choices: [{ message: { content: null } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

beforeEach(() => {
  createMock.mockReset();
  imagesEditMock.mockReset();
  prismaQueryRaw.mockReset();
  prismaExecuteRaw.mockReset();
  sharpFactory.mockClear();
  sharpChain.jpeg.mockClear();
  sharpChain.resize.mockClear();
  sharpChain.toFile.mockClear();
});

// ---------------------------------------------------------------------------
// ask (year detection)
// ---------------------------------------------------------------------------

describe('AiTasks.ask', () => {
  it('returns the parsed year payload and sends the parseYear function schema', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('parseYear', {
        year: 1982,
        reasoning: 'Released on Thriller',
        certainty: 95,
        source: 'https://example.com',
      })
    );

    const answer = await gpt.ask('"Thriller" by Michael Jackson');

    // The answer plus what it cost (100 in + 50 out tokens of gpt-5.6-terra).
    expect(answer).toEqual({
      year: 1982,
      reasoning: 'Released on Thriller',
      certainty: 95,
      source: 'https://example.com',
      costUsd: (100 * 2 + 50 * 12) / 1e6,
    });

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.6-terra');
    expect(payload.reasoning_effort).toBe('low');
    expect(payload.temperature).toBeUndefined();
    expect(payload.tools).toBeUndefined();
    expect(payload.response_format.type).toBe('json_schema');
    expect(payload.response_format.json_schema.name).toBe('parseYear');
    expect(payload.response_format.json_schema.schema.required).toEqual([
      'year',
      'reasoning',
    ]);
    expect(payload.messages[1]).toEqual({
      role: 'user',
      content: '"Thriller" by Michael Jackson',
    });
  });

  it('returns a zeroed result when the function arguments are not valid JSON', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('parseYear', null, 'not-json{')
    );

    const answer = await gpt.ask('prompt');
    expect(answer).toEqual({ year: 0, reasoning: '', certainty: 0, source: '' });
  });

  it('returns undefined when the model produces no tool call', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.ask('prompt')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyList
// ---------------------------------------------------------------------------

describe('AiTasks.verifyList', () => {
  it('returns [] when the playlist is unknown', async () => {
    prismaQueryRaw.mockResolvedValueOnce([]);
    expect(await gpt.verifyList(1, 'unknown')).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns [] when the playlist has no tracks', async () => {
    prismaQueryRaw
      .mockResolvedValueOnce([{ id: 7, name: 'PL' }])
      .mockResolvedValueOnce([]);
    expect(await gpt.verifyList(1, 'pl1')).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('keeps only mistakes that differ by more than 2 years and writes suggestions', async () => {
    prismaQueryRaw
      .mockResolvedValueOnce([{ id: 7, name: 'PL' }]) // playlist lookup
      .mockResolvedValueOnce([
        { name: 'Song A', artist: 'Artist A', year: 1990 },
        { name: 'Song B', artist: 'Artist B', year: 2000 },
      ]) // tracks
      .mockResolvedValueOnce([]) // existing suggestion for first mistake: none
      .mockResolvedValueOnce([{ id: 55 }]); // existing suggestion for second: present

    createMock.mockResolvedValueOnce(
      toolCallResponse('parseYearMistakes', {
        mistakes: [
          {
            artist: 'Artist A',
            title: 'Song A',
            oldYear: 1990,
            suggestedYear: 1980,
            reasoning: 'big diff',
          },
          {
            artist: 'Artist B',
            title: 'Song B',
            oldYear: 2000,
            suggestedYear: 2005,
            reasoning: 'also big diff',
          },
          {
            artist: 'Artist C',
            title: 'Song C',
            oldYear: 1999,
            suggestedYear: 2000,
            reasoning: 'insignificant',
          },
        ],
      })
    );

    const mistakes = await gpt.verifyList(42, 'pl1');

    expect(mistakes).toHaveLength(2);
    expect(mistakes.map((m) => m.title)).toEqual(['Song A', 'Song B']);

    // 1x suggestionsPending update + 1x insert (second mistake already existed)
    expect(prismaExecuteRaw).toHaveBeenCalledTimes(2);

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.6-terra');
    expect(payload.reasoning_effort).toBe('medium');
    expect(payload.response_format.json_schema.name).toBe('parseYearMistakes');
    expect(payload.messages[1].content).toContain(
      '"Song A" by Artist A (1990)'
    );
  });

  it('returns [] when the batch response JSON is unparseable', async () => {
    prismaQueryRaw
      .mockResolvedValueOnce([{ id: 7, name: 'PL' }])
      .mockResolvedValueOnce([{ name: 'S', artist: 'A', year: 1990 }]);
    createMock.mockResolvedValueOnce(
      toolCallResponse('parseYearMistakes', null, '{{nope')
    );

    expect(await gpt.verifyList(1, 'pl1')).toEqual([]);
    expect(prismaExecuteRaw).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// translateGenreNames
// ---------------------------------------------------------------------------

describe('AiTasks.translateGenreNames', () => {
  it('returns {} when no target locales are given', async () => {
    expect(await gpt.translateGenreNames('Rock', [])).toEqual({});
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns the per-locale translations', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('getGenreTranslations', { nl: 'Rock', de: 'Rock' })
    );
    const result = await gpt.translateGenreNames('Rock', ['nl', 'de']);
    expect(result).toEqual({ nl: 'Rock', de: 'Rock' });

    const payload = createMock.mock.calls[0][0];
    expect(payload.response_format.json_schema.schema.required).toEqual(['nl', 'de']);
  });

  it('returns {} when the response has no tool call', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.translateGenreNames('Rock', ['nl'])).toEqual({});
  });

  it('returns {} when the API call throws', async () => {
    createMock.mockRejectedValueOnce(new Error('rate limited'));
    expect(await gpt.translateGenreNames('Rock', ['nl'])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// translateText / translateMessage
// ---------------------------------------------------------------------------

describe('AiTasks.translateText', () => {
  it('returns {} for empty input without calling OpenAI', async () => {
    expect(await gpt.translateText('', ['nl'])).toEqual({});
    expect(await gpt.translateText('hello', [])).toEqual({});
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns translations keyed by locale', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('translateText', { nl: 'hallo', de: 'hallo' })
    );
    expect(await gpt.translateText('hello', ['nl', 'de'])).toEqual({
      nl: 'hallo',
      de: 'hallo',
    });
    const payload = createMock.mock.calls[0][0];
    expect(payload.response_format.json_schema.name).toBe('translateText');
    expect(payload.messages[1].content).toContain('hello');
  });

  it('returns {} on a malformed response', async () => {
    createMock.mockResolvedValueOnce(toolCallResponse('translateText', null, '}'));
    expect(await gpt.translateText('hello', ['nl'])).toEqual({});
  });
});

describe('AiTasks.translateLiterally', () => {
  it('returns nothing for empty input without calling OpenAI', async () => {
    expect(await gpt.translateLiterally('', 'P', ['nl'])).toEqual({
      sourceLocale: null,
      translations: {},
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('names the language it detected and returns the translations', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('translateLiterally', {
        sourceLanguage: 'nl',
        translations: { en: ' Hello there ', nl: 'Hallo daar', xx: 'dropped' },
      })
    );
    expect(await gpt.translateLiterally('Hallo daar', 'Symphony!', ['en', 'nl'])).toEqual({
      sourceLocale: 'nl',
      translations: { en: 'Hello there', nl: 'Hallo daar' },
    });
    const payload = createMock.mock.calls[0][0];
    expect(payload.response_format.json_schema.name).toBe('translateLiterally');
    expect(
      payload.response_format.json_schema.schema.properties.sourceLanguage.enum
    ).toEqual(['en', 'nl', 'other']);
    expect(payload.messages[1].content).toContain('"Symphony!"');
    expect(payload.messages[1].content).toContain('Hallo daar');
  });

  it('reads "other" (or anything unknown) as no source locale', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('translateLiterally', {
        sourceLanguage: 'other',
        translations: { en: 'Hi', nl: 'Hoi' },
      })
    );
    const result = await gpt.translateLiterally('Hej', 'P', ['en', 'nl']);
    expect(result.sourceLocale).toBeNull();
    expect(result.translations).toEqual({ en: 'Hi', nl: 'Hoi' });
  });

  it('returns nothing on a malformed response', async () => {
    createMock.mockResolvedValueOnce(toolCallResponse('translateLiterally', null, '}'));
    expect(await gpt.translateLiterally('Hallo', 'P', ['nl'])).toEqual({
      sourceLocale: null,
      translations: {},
    });
  });
});

describe('AiTasks.translateMessage', () => {
  it('returns the translated subject and message', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('translate_email', {
        subject: 'Hello',
        message: 'Your order shipped',
      })
    );

    const result = await gpt.translateMessage('Je bestelling', 'Hallo', 'en');
    expect(result).toEqual({ subject: 'Hello', message: 'Your order shipped' });

    const payload = createMock.mock.calls[0][0];
    expect(payload.messages[0].content).toContain('to English');
    expect(payload.response_format.json_schema.name).toBe('translate_email');
  });

  it('falls back to the originals when no tool call is returned', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.translateMessage('bericht', 'onderwerp', 'en')).toEqual({
      subject: 'onderwerp',
      message: 'bericht',
    });
  });

  it('falls back to the originals when the API throws', async () => {
    createMock.mockRejectedValueOnce(new Error('down'));
    expect(await gpt.translateMessage('bericht', 'onderwerp', 'en')).toEqual({
      subject: 'onderwerp',
      message: 'bericht',
    });
  });
});

// ---------------------------------------------------------------------------
// splitArtistOrString / extractOrders
// ---------------------------------------------------------------------------

describe('AiTasks.splitArtistOrString', () => {
  it('returns the produced segments', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('splitText', { segments: ['Raderberger', 'boorebürger'] })
    );
    const segments = await gpt.splitArtistOrString(
      'Raderbergerboorebürger',
      'artist'
    );
    expect(segments).toEqual(['Raderberger', 'boorebürger']);

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.6-sol');
    expect(payload.response_format.json_schema.name).toBe('splitText');
    expect(payload.messages[1].content).toContain('Raderbergerboorebürger');
  });

  it('falls back to the original text on parse failure', async () => {
    createMock.mockResolvedValueOnce(toolCallResponse('splitText', null, 'x'));
    expect(await gpt.splitArtistOrString('LongWord', 'title')).toEqual([
      'LongWord',
    ]);
  });

  it('falls back to the original text when no tool call is returned', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.splitArtistOrString('LongWord', 'artist')).toEqual([
      'LongWord',
    ]);
  });
});

describe('AiTasks.extractOrders', () => {
  it('returns extracted orders with low reasoning and no temperature', async () => {
    const orders = [
      { orderId: '123', date: '01-02-2026', amount: 19.95 },
      { orderId: '456', date: '02-02-2026', amount: 5.5 },
    ];
    createMock.mockResolvedValueOnce(toolCallResponse('extractOrders', { orders }));

    expect(await gpt.extractOrders('<table>...</table>')).toEqual({ orders });

    const payload = createMock.mock.calls[0][0];
    expect(payload.temperature).toBeUndefined();
    expect(payload.reasoning_effort).toBe('low');
    expect(payload.response_format.json_schema.name).toBe('extractOrders');
    expect(payload.messages[1].content).toContain('<table>...</table>');
  });

  it('returns empty orders on parse failure', async () => {
    createMock.mockResolvedValueOnce(toolCallResponse('extractOrders', null, '<'));
    expect(await gpt.extractOrders('html')).toEqual({ orders: [] });
  });

  it('returns empty orders when no tool call is returned', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.extractOrders('html')).toEqual({ orders: [] });
  });
});

// ---------------------------------------------------------------------------
// generateQuizQuestions
// ---------------------------------------------------------------------------

describe('AiTasks.generateQuizQuestions', () => {
  it('generates year questions locally and the other types via the LLM', async () => {
    createMock.mockImplementation(async (payload: any) => {
      const name = payload.response_format.json_schema.name;
      switch (name) {
        case 'generateTriviaQuestions':
          return toolCallResponse(name, {
            questions: [
              {
                index: 1,
                question: 'Which album?',
                correctAnswer: 'Thriller',
                wrongOptions: ['Bad', 'Dangerous', 'Off the Wall'],
              },
            ],
          });
        case 'generateArtistAlternatives':
          return toolCallResponse(name, {
            tracks: [{ index: 1, alternatives: ['Prince', 'Lionel Richie', 'Rick James'] }],
          });
        case 'generateMissingWordQuestions':
          return toolCallResponse(name, {
            tracks: [
              {
                index: 1,
                missingWord: 'Love',
                titleWithBlank: '_____ Me Do',
                alternatives: ['Hold', 'Tell', 'Call'],
              },
            ],
          });
        case 'generateTitleAlternatives':
          return toolCallResponse(name, {
            tracks: [{ index: 1, alternatives: ['Alt One', 'Alt Two', 'Alt Three'] }],
          });
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    });

    const tracks = [
      { trackId: 1, name: 'Billie Jean', artist: 'Michael Jackson', year: 1982, type: 'year' as const },
      { trackId: 2, name: 'Beat It', artist: 'Michael Jackson', year: 1982, type: 'trivia' as const },
      { trackId: 3, name: 'Superstition', artist: 'Stevie Wonder', year: 1972, type: 'artist' as const },
      { trackId: 4, name: 'Love Me Do', artist: 'The Beatles', year: 1962, type: 'missing_word' as const },
      { trackId: 5, name: 'You Can Call Me Al', artist: 'Paul Simon', year: 1986, type: 'title' as const },
    ];

    const progress: string[] = [];
    const results = await gpt.generateQuizQuestions(tracks, 'en', (p) =>
      progress.push(p.step)
    );

    expect(results).toHaveLength(5);
    expect(progress).toEqual(['year', 'trivia', 'artist', 'missingWord', 'title']);
    // 4 LLM calls (year is local)
    expect(createMock).toHaveBeenCalledTimes(4);

    const year = results.find((r) => r.type === 'year')!;
    expect(year).toEqual({
      trackId: 1,
      type: 'year',
      question: '[quiz.yearQuestion:en]',
      options: null,
      correctAnswer: '1982',
    });

    const trivia = results.find((r) => r.type === 'trivia')!;
    expect(trivia.trackId).toBe(2);
    expect(trivia.question).toBe('Which album?');
    expect(trivia.correctAnswer).toBe('Thriller');
    expect(trivia.options).toHaveLength(4);
    expect(trivia.options).toEqual(
      expect.arrayContaining(['Thriller', 'Bad', 'Dangerous', 'Off the Wall'])
    );

    const artist = results.find((r) => r.type === 'artist')!;
    expect(artist.correctAnswer).toBe('Stevie Wonder');
    expect(artist.question).toBe('[quiz.artistQuestion:en]');
    expect(artist.options).toEqual(
      expect.arrayContaining(['Stevie Wonder', 'Prince', 'Lionel Richie', 'Rick James'])
    );

    const missing = results.find((r) => r.type === 'missing_word')!;
    expect(missing.question).toBe('_____ Me Do\n[quiz.missingWordQuestion:en]');
    expect(missing.correctAnswer).toBe('Love');
    expect(missing.options).toEqual(
      expect.arrayContaining(['Love', 'Hold', 'Tell', 'Call'])
    );

    const title = results.find((r) => r.type === 'title')!;
    expect(title.correctAnswer).toBe('You Can Call Me Al');
    expect(title.question).toBe('[quiz.titleQuestion:en]');
    expect(title.options).toContain('You Can Call Me Al');

    // The trivia call must request the interface language by name
    const triviaPayload = createMock.mock.calls.find(
      (c) => c[0].response_format.json_schema.name === 'generateTriviaQuestions'
    )![0];
    expect(triviaPayload.messages[0].content).toContain('English');
  });

  it('skips LLM answers whose index does not match a batch track', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateTriviaQuestions', {
        questions: [
          {
            index: 99,
            question: 'Q',
            correctAnswer: 'A',
            wrongOptions: ['b', 'c', 'd'],
          },
        ],
      })
    );

    const results = await gpt.generateQuizQuestions([
      { trackId: 1, name: 'S', artist: 'A', year: 2000, type: 'trivia' },
    ]);
    expect(results).toEqual([]);
  });

  it('continues without questions when a batch returns no tool call', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    const results = await gpt.generateQuizQuestions([
      { trackId: 1, name: 'S', artist: 'A', year: 2000, type: 'artist' },
    ]);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// regenerateQuizQuestion
// ---------------------------------------------------------------------------

describe('AiTasks.regenerateQuizQuestion', () => {
  const track = { name: 'Billie Jean', artist: 'Michael Jackson', year: 1982 };

  it('regenerates year questions locally', async () => {
    const result = await gpt.regenerateQuizQuestion(track, 'year', 'nl');
    expect(result).toEqual({
      question: '[quiz.yearQuestion:nl]',
      options: null,
      correctAnswer: '1982',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('regenerates a trivia question and passes the previous question to avoid', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateTriviaQuestion', {
        question: 'New Q?',
        correctAnswer: 'Right',
        wrongOptions: ['w1', 'w2', 'w3'],
      })
    );
    const result = await gpt.regenerateQuizQuestion(track, 'trivia', 'en', 'Old Q?');
    expect(result.question).toBe('New Q?');
    expect(result.correctAnswer).toBe('Right');
    expect(result.options).toEqual(
      expect.arrayContaining(['Right', 'w1', 'w2', 'w3'])
    );

    const payload = createMock.mock.calls[0][0];
    expect(payload.messages[1].content).toContain('The previous question was: "Old Q?"');
  });

  it('regenerates an artist question with the real artist as correct answer', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateAlternatives', {
        alternatives: ['Prince', 'Usher', 'Chris Brown'],
      })
    );
    const result = await gpt.regenerateQuizQuestion(track, 'artist', 'en');
    expect(result.correctAnswer).toBe('Michael Jackson');
    expect(result.question).toBe('[quiz.artistQuestion:en]');
    expect(result.options).toContain('Michael Jackson');
  });

  it('regenerates a missing word question', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateMissingWordQuestion', {
        missingWord: 'Jean',
        titleWithBlank: 'Billie _____',
        alternatives: ['Joe', 'King', 'Girl'],
      })
    );
    const result = await gpt.regenerateQuizQuestion(track, 'missing_word', 'en');
    expect(result.question).toBe('Billie _____\n[quiz.missingWordQuestion:en]');
    expect(result.correctAnswer).toBe('Jean');
    expect(result.options).toHaveLength(4);
  });

  it('regenerates a title question with the track name as correct answer', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateAlternatives', {
        alternatives: ['Smooth Criminal', 'Thriller', 'Bad'],
      })
    );
    const result = await gpt.regenerateQuizQuestion(track, 'title', 'en');
    expect(result.correctAnswer).toBe('Billie Jean');
    expect(result.question).toBe('[quiz.titleQuestion:en]');
    expect(result.options).toContain('Billie Jean');
  });

  it('falls back to a year question when the LLM returns no tool call', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    const result = await gpt.regenerateQuizQuestion(track, 'trivia', 'en');
    expect(result).toEqual({
      question: '[quiz.yearQuestion:en]',
      options: null,
      correctAnswer: '1982',
    });
  });
});

// ---------------------------------------------------------------------------
// generateWrongOptions
// ---------------------------------------------------------------------------

describe('AiTasks.generateWrongOptions', () => {
  const track = { name: 'Song', artist: 'Artist' };

  it('returns at most 3 wrong options', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateWrongOptions', {
        wrongOptions: ['a', 'b', 'c', 'd'],
      })
    );
    const options = await gpt.generateWrongOptions('Q?', 'Right', track, 'en');
    expect(options).toEqual(['a', 'b', 'c']);
  });

  it('asks the model to avoid the previous wrong options', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateWrongOptions', { wrongOptions: ['x', 'y', 'z'] })
    );
    await gpt.generateWrongOptions('Q?', 'Right', track, 'en', ['old1', 'old2']);
    const payload = createMock.mock.calls[0][0];
    expect(payload.messages[1].content).toContain('"old1", "old2"');
  });

  it('falls back to placeholder options when no tool call is returned', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.generateWrongOptions('Q?', 'Right', track)).toEqual([
      'Option B',
      'Option C',
      'Option D',
    ]);
  });
});

