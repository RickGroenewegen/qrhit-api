import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Collaborator mocks (no network, no DB, no native sharp work)
// ---------------------------------------------------------------------------

const {
  createMock,
  imagesEditMock,
  prismaQueryRaw,
  prismaExecuteRaw,
  trustpilotUpdate,
  sharpChain,
  sharpFactory,
} = vi.hoisted(() => {
  const chain = {
    jpeg: vi.fn(),
    resize: vi.fn(),
    toFile: vi.fn(),
  };
  chain.jpeg.mockReturnValue(chain);
  chain.resize.mockReturnValue(chain);
  chain.toFile.mockResolvedValue(undefined);
  return {
    createMock: vi.fn(),
    imagesEditMock: vi.fn(),
    prismaQueryRaw: vi.fn(),
    prismaExecuteRaw: vi.fn(),
    trustpilotUpdate: vi.fn(),
    sharpChain: chain,
    sharpFactory: vi.fn(() => chain),
  };
});

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
      trustPilot: { update: trustpilotUpdate },
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
  default: class {
    // Deterministic "random" sample so prompts are stable
    getRandomSample<T>(arr: T[], n: number): T[] {
      return arr.slice(0, n);
    }
  },
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

import { ChatGPT } from '../../src/chatgpt';

const gpt = new ChatGPT();

/** Builds a chat completion response carrying a single function tool call. */
function toolCallResponse(name: string, args: unknown, rawArgs?: string) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: {
                name,
                arguments: rawArgs ?? JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** A completion with a plain message and no tool calls. */
const noToolCallResponse = {
  choices: [{ message: { content: 'no function call here' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

beforeEach(() => {
  createMock.mockReset();
  imagesEditMock.mockReset();
  prismaQueryRaw.mockReset();
  prismaExecuteRaw.mockReset();
  trustpilotUpdate.mockReset();
  sharpFactory.mockClear();
  sharpChain.jpeg.mockClear();
  sharpChain.resize.mockClear();
  sharpChain.toFile.mockClear();
});

// ---------------------------------------------------------------------------
// ask (year detection)
// ---------------------------------------------------------------------------

describe('ChatGPT.ask', () => {
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

    expect(answer).toEqual({
      year: 1982,
      reasoning: 'Released on Thriller',
      certainty: 95,
      source: 'https://example.com',
    });

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.4-mini');
    expect(payload.temperature).toBe(1);
    expect(payload.tool_choice).toEqual({
      type: 'function',
      function: { name: 'parseYear' },
    });
    expect(payload.tools[0].function.name).toBe('parseYear');
    expect(payload.tools[0].function.parameters.required).toEqual([
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

describe('ChatGPT.verifyList', () => {
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
    expect(payload.model).toBe('gpt-5.4-mini');
    expect(payload.tool_choice.function.name).toBe('parseYearMistakes');
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
// generatePlaylistDescription
// ---------------------------------------------------------------------------

describe('ChatGPT.generatePlaylistDescription', () => {
  const tracks = [
    { artist: 'A', name: 'One' },
    { artist: 'B', name: 'Two' },
  ];

  it('returns per-language descriptions and requests one schema property per locale', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateDescriptions', {
        description_en: 'EN text',
        description_nl: 'NL tekst',
      })
    );

    const result = await gpt.generatePlaylistDescription('Party', tracks, [
      'en',
      'nl',
    ]);
    expect(result).toEqual({
      description_en: 'EN text',
      description_nl: 'NL tekst',
    });

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.4-mini');
    expect(payload.temperature).toBe(1);
    expect(payload.tool_choice.function.name).toBe('generateDescriptions');
    expect(
      Object.keys(payload.tools[0].function.parameters.properties)
    ).toEqual(['description_en', 'description_nl']);
    expect(payload.tools[0].function.parameters.required).toEqual([
      'description_en',
      'description_nl',
    ]);
    expect(payload.messages[1].content).toContain('Number of songs: 2');
    expect(payload.messages[1].content).toContain('"One" by A');
  });

  it('defaults languages to the Translation locales', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateDescriptions', {
        description_en: 'x',
        description_nl: 'y',
      })
    );
    await gpt.generatePlaylistDescription('Party', tracks);
    const payload = createMock.mock.calls[0][0];
    expect(payload.tools[0].function.parameters.required).toEqual([
      'description_en',
      'description_nl',
    ]);
  });

  it('returns {} on a malformed JSON response', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('generateDescriptions', null, 'oops')
    );
    expect(
      await gpt.generatePlaylistDescription('Party', tracks, ['en'])
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// determineGenre
// ---------------------------------------------------------------------------

describe('ChatGPT.determineGenre', () => {
  const genres = [
    { id: 5, slug: 'rock' },
    { id: 9, slug: 'pop' },
  ];
  const tracks = [{ artist: 'A', name: 'One' }];

  it('returns the matched genre id and includes 0 (NoMatch) in the enum', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('determineGenre', { genreId: 9, reasoning: 'pop' })
    );

    expect(await gpt.determineGenre('Hits', tracks, genres)).toBe(9);

    const payload = createMock.mock.calls[0][0];
    expect(payload.tool_choice.function.name).toBe('determineGenre');
    expect(payload.tools[0].function.parameters.properties.genreId.enum).toEqual(
      [0, 5, 9]
    );
    expect(payload.messages[1].content).toContain('5: (rock)');
  });

  it('converts GenreId.NoMatch (0) to null', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('determineGenre', { genreId: 0, reasoning: 'mixed' })
    );
    expect(await gpt.determineGenre('Hits', tracks, genres)).toBeNull();
  });

  it('returns null on a malformed JSON response', async () => {
    createMock.mockResolvedValueOnce(
      toolCallResponse('determineGenre', null, '!')
    );
    expect(await gpt.determineGenre('Hits', tracks, genres)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// translateTrustpilotReviews
// ---------------------------------------------------------------------------

describe('ChatGPT.translateTrustpilotReviews', () => {
  it('does nothing when there are no reviews', async () => {
    await gpt.translateTrustpilotReviews([] as any, ['nl']);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('updates only reviews whose target locale columns are still empty', async () => {
    const reviews = [
      {
        id: 1,
        locale: 'en-US',
        title_en: 'Great',
        message_en: 'Nice product',
        title_nl: '',
        message_nl: '',
      },
      {
        id: 2,
        locale: 'en-US',
        title_en: 'Okay',
        message_en: 'Fine',
        title_nl: 'Al vertaald',
        message_nl: 'Bestaat al',
      },
    ] as any[];

    createMock.mockResolvedValueOnce(
      toolCallResponse('translateReviews', {
        translations: [
          {
            reviewIndex: 0,
            translations: { nl: { title: 'Geweldig', message: 'Leuk product' } },
          },
          {
            reviewIndex: 1,
            translations: { nl: { title: 'Nieuw', message: 'Nieuw bericht' } },
          },
        ],
      })
    );

    await gpt.translateTrustpilotReviews(reviews as any, ['nl']);

    expect(trustpilotUpdate).toHaveBeenCalledTimes(1);
    expect(trustpilotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title_nl: 'Geweldig', message_nl: 'Leuk product' },
    });

    const payload = createMock.mock.calls[0][0];
    expect(payload.tool_choice.function.name).toBe('translateReviews');
    expect(payload.messages[1].content).toContain('Title: Great');
  });

  it('survives a malformed translation response without writing', async () => {
    const reviews = [
      {
        id: 3,
        locale: 'en-US',
        title_en: 'T',
        message_en: 'M',
        title_nl: '',
        message_nl: '',
      },
    ] as any[];
    createMock.mockResolvedValueOnce(
      toolCallResponse('translateReviews', null, 'bad')
    );

    await gpt.translateTrustpilotReviews(reviews as any, ['nl']);
    expect(trustpilotUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// translateGenreNames
// ---------------------------------------------------------------------------

describe('ChatGPT.translateGenreNames', () => {
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
    expect(payload.tools[0].function.parameters.required).toEqual(['nl', 'de']);
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
// askBlog / askBlogStream
// ---------------------------------------------------------------------------

describe('ChatGPT.askBlog', () => {
  it('returns the generated blog and uses the gpt-5.5 model', async () => {
    const blog = { title: 'My post', summary: 'Sum', content: '<p>Hi</p>' };
    createMock.mockResolvedValueOnce(toolCallResponse('generateBlog', blog));

    expect(await gpt.askBlog('Write about parties')).toEqual(blog);

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.5');
    expect(payload.tool_choice.function.name).toBe('generateBlog');
    expect(payload.tools[0].function.parameters.required).toEqual([
      'title',
      'content',
    ]);
    expect(payload.messages[1].content).toBe('Write about parties');
  });

  it('returns empty fields on a malformed response', async () => {
    createMock.mockResolvedValueOnce(toolCallResponse('generateBlog', null, '['));
    expect(await gpt.askBlog('x')).toEqual({ title: '', content: '', summary: '' });
  });

  it('returns empty fields when there is no tool call', async () => {
    createMock.mockResolvedValueOnce(noToolCallResponse);
    expect(await gpt.askBlog('x')).toEqual({ title: '', content: '', summary: '' });
  });
});

describe('ChatGPT.askBlogStream', () => {
  it('streams chunks, extracts a short first paragraph as summary', async () => {
    async function* stream() {
      yield { choices: [{ delta: { content: '<p>Short intro.</p>' } }] };
      yield { choices: [{ delta: { content: '<h2>Main</h2><p>Body</p>' } }] };
      yield { choices: [{ delta: {} }] }; // empty delta is skipped
    }
    createMock.mockResolvedValueOnce(stream());

    const chunks: string[] = [];
    const result = await gpt.askBlogStream('topic', (c) => chunks.push(c));

    expect(chunks).toEqual(['<p>Short intro.</p>', '<h2>Main</h2><p>Body</p>']);
    expect(result.title).toBe('Generated Blog Post');
    expect(result.summary).toBe('Short intro.');
    expect(result.content).toBe('<h2>Main</h2><p>Body</p>');

    const payload = createMock.mock.calls[0][0];
    expect(payload.stream).toBe(true);
    expect(payload.model).toBe('gpt-5.5');
  });

  it('keeps a long first paragraph in the content and returns no summary', async () => {
    const longPara = `<p>${'x'.repeat(320)}</p>`;
    async function* stream() {
      yield { choices: [{ delta: { content: longPara } }] };
    }
    createMock.mockResolvedValueOnce(stream());

    const result = await gpt.askBlogStream('topic', () => {});
    expect(result.summary).toBeUndefined();
    expect(result.content).toBe(longPara);
  });
});

// ---------------------------------------------------------------------------
// translateText / translateMessage
// ---------------------------------------------------------------------------

describe('ChatGPT.translateText', () => {
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
    expect(payload.tool_choice.function.name).toBe('translateText');
    expect(payload.messages[1].content).toContain('hello');
  });

  it('returns {} on a malformed response', async () => {
    createMock.mockResolvedValueOnce(toolCallResponse('translateText', null, '}'));
    expect(await gpt.translateText('hello', ['nl'])).toEqual({});
  });
});

describe('ChatGPT.translateMessage', () => {
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
    expect(payload.tool_choice.function.name).toBe('translate_email');
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

describe('ChatGPT.splitArtistOrString', () => {
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
    expect(payload.model).toBe('gpt-5.5');
    expect(payload.tool_choice.function.name).toBe('splitText');
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

describe('ChatGPT.extractOrders', () => {
  it('returns extracted orders and uses temperature 0', async () => {
    const orders = [
      { orderId: '123', date: '01-02-2026', amount: 19.95 },
      { orderId: '456', date: '02-02-2026', amount: 5.5 },
    ];
    createMock.mockResolvedValueOnce(toolCallResponse('extractOrders', { orders }));

    expect(await gpt.extractOrders('<table>...</table>')).toEqual({ orders });

    const payload = createMock.mock.calls[0][0];
    expect(payload.temperature).toBe(0);
    expect(payload.tool_choice.function.name).toBe('extractOrders');
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

describe('ChatGPT.generateQuizQuestions', () => {
  it('generates year questions locally and the other types via the LLM', async () => {
    createMock.mockImplementation(async (payload: any) => {
      const name = payload.tool_choice.function.name;
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
      (c) => c[0].tool_choice.function.name === 'generateTriviaQuestions'
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

describe('ChatGPT.regenerateQuizQuestion', () => {
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

describe('ChatGPT.generateWrongOptions', () => {
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

// ---------------------------------------------------------------------------
// askWithImages
// ---------------------------------------------------------------------------

describe('ChatGPT.askWithImages', () => {
  const imgPath = path.join(process.env['PUBLIC_DIR']!, 'chatgpt-test-img.png');

  beforeAll(async () => {
    await fs.writeFile(imgPath, Buffer.from('fake-png-bytes'));
  });

  it('sends images as base64 data URIs and parses the JSON answer', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ok":true,"count":2}' } }],
    });

    const result = await gpt.askWithImages('Describe', [imgPath], {
      systemPrompt: 'You are a vision bot',
    });
    expect(result).toEqual({ ok: true, count: 2 });

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-5.5');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.messages[0]).toEqual({
      role: 'system',
      content: 'You are a vision bot',
    });
    const userContent = payload.messages[1].content;
    expect(userContent[0]).toEqual({ type: 'text', text: 'Describe' });
    expect(userContent[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`
    );
  });

  it('returns the raw string when expectJson is false (no response_format)', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'plain answer' } }],
    });
    const result = await gpt.askWithImages('Describe', [imgPath], {
      expectJson: false,
    });
    expect(result).toBe('plain answer');
    expect(createMock.mock.calls[0][0].response_format).toBeUndefined();
    // No system prompt was given, so the only message is the user message
    expect(createMock.mock.calls[0][0].messages).toHaveLength(1);
  });

  it('returns null when the JSON answer is unparseable', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'not json' } }],
    });
    expect(await gpt.askWithImages('Describe', [imgPath])).toBeNull();
  });

  it('returns null when the API call fails', async () => {
    createMock.mockRejectedValueOnce(new Error('vision down'));
    expect(await gpt.askWithImages('Describe', [imgPath])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateBlogImage
// ---------------------------------------------------------------------------

describe('ChatGPT.generateBlogImage', () => {
  beforeAll(async () => {
    const imagesDir = path.join(process.env['ASSETS_DIR']!, 'images');
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.writeFile(path.join(imagesDir, 'cards.png'), Buffer.from('cards'));
  });

  it('edits the base image, compresses it with sharp and returns the filename', async () => {
    imagesEditMock.mockResolvedValueOnce({
      data: [{ b64_json: Buffer.from('generated-image').toString('base64') }],
    });

    const filename = await gpt.generateBlogImage('A party scene');

    expect(filename).toMatch(/^blog_\d+\.jpg$/);
    const editArgs = imagesEditMock.mock.calls[0][0];
    expect(editArgs.model).toBe('gpt-image-1.5');
    expect(editArgs.prompt).toBe('A party scene');
    expect(editArgs.size).toBe('1536x1024');
    expect(editArgs.quality).toBe('high');

    expect(sharpChain.jpeg).toHaveBeenCalledWith({ quality: 85, progressive: true });
    expect(sharpChain.resize).toHaveBeenCalledWith(1280, 720, { fit: 'cover' });
    expect(sharpChain.toFile).toHaveBeenCalledWith(
      path.join(process.env['PUBLIC_DIR']!, 'blog_images', filename!)
    );
  });

  it('returns null when no image data is returned', async () => {
    imagesEditMock.mockResolvedValueOnce({ data: [] });
    expect(await gpt.generateBlogImage('x')).toBeNull();
  });

  it('returns null when the image API throws', async () => {
    imagesEditMock.mockRejectedValueOnce(new Error('img down'));
    expect(await gpt.generateBlogImage('x')).toBeNull();
  });
});
