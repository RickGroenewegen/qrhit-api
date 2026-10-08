/**
 * Live check of the LLM layer against the real providers. Spends real money
 * (a few cents per full run), so run it on purpose:
 *
 *   npx tsx scripts/llm-smoke.ts                 # every text task, once, on its primary route
 *   npx tsx scripts/llm-smoke.ts yearLookup quizTrivia   # only these tasks
 *   npx tsx scripts/llm-smoke.ts --compare       # release years: primary vs fallback route
 *   npx tsx scripts/llm-smoke.ts --compare --routes=anthropic/claude-opus-5-5:low,openai/gpt-5.6-terra:low
 *   npx tsx scripts/llm-smoke.ts --sources --routes=...   # the same, with production-style source data
 *
 * Each task runs a real call site where one exists without a database
 * (AiTasks methods), otherwise a small request with the same kind of schema.
 * Prints the model that answered, tokens, cost, time and a sample of the
 * answer, then checks that the llm_calls ledger received the rows.
 * Images and speech are left out (OpenAI only, and an image costs ~$0.04).
 */
import 'dotenv/config';
import sharp from 'sharp';
import { color } from 'console-log-colors';
import PrismaInstance from '../src/prisma';
import { AiTasks } from '../src/aiTasks';
import { llm, normalizeRequest } from '../src/llm';
import type { LlmResult, LlmRoute, TextTask } from '../src/llm';
import { LLM_TASKS, taskConfig } from '../src/llm/tasks';
import { getProvider } from '../src/llm/providers';
import { priceCall } from '../src/llm/models';

type Check = () => Promise<{ sample: unknown; result?: LlmResult<unknown> }>;

const gpt = new AiTasks();

/** A plain request through the layer, for tasks whose call site needs a database. */
async function direct(task: TextTask, schema: Record<string, unknown> | null, user: string, system = 'Answer briefly.') {
  const req = {
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
  };
  const result = schema
    ? await llm.json(task, { ...req, schema: { name: task, schema } })
    : await llm.text(task, req);
  return { sample: result.data, result };
}

async function paletteImage(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#1b3a6b"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="90" cy="90" r="40" fill="#ffd166"/></svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

const CHECKS: Partial<Record<TextTask, Check>> = {
  yearLookup: async () => ({
    sample: await gpt.ask(
      'Song: "Radar Love" by Golden Earring.\nGoogle: Radar Love is a song by Dutch rock band Golden Earring, released in 1973.\nMusicBrainz earliest release: 1973\nDiscogs: 1973'
    ),
  }),
  yearAudit: () =>
    direct(
      'yearAudit',
      {
        type: 'object',
        properties: {
          mistakes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                oldYear: { type: 'number' },
                suggestedYear: { type: 'number' },
              },
              required: ['title', 'oldYear', 'suggestedYear'],
            },
          },
        },
        required: ['mistakes'],
      },
      'Verify these release years, return only the wrong ones:\n"Wonderwall" by Oasis (1995)\n"Dancing Queen" by ABBA (1981)'
    ),
  wordSplit: async () => ({
    sample: await gpt.splitArtistOrString('Raderbergerboorebürgerspillverein', 'title'),
  }),
  aiKeywords: () =>
    direct(
      'aiKeywords',
      {
        type: 'object',
        properties: {
          title: { type: 'string' },
          artistKeywords: { type: 'array', items: { type: 'string' } },
          startYear: { type: ['integer', 'null'] },
          endYear: { type: ['integer', 'null'] },
        },
        required: ['title', 'artistKeywords', 'startYear', 'endYear'],
      },
      'Theme: Dutch 90s party hits. Return up to 10 artists and the year range.'
    ),
  aiCurate: () =>
    direct(
      'aiCurate',
      { type: 'object', properties: { trackIds: { type: 'array', items: { type: 'string' } } }, required: ['trackIds'] },
      'Theme: summer hits. Pick the fitting ones.\nt1\tMungo Jerry — In the Summertime (1970)\nt2\tMetallica — One (1988)\nt3\tWill Smith — Summertime (1991)'
    ),
  aiSuggestFeatured: () =>
    direct(
      'aiSuggestFeatured',
      {
        type: 'object',
        properties: {
          promptLanguage: { type: 'string', enum: ['nl', 'en', 'de', 'other'] },
          musicMarket: { type: ['string', 'null'], enum: ['nl', 'en', 'de', 'other', null] },
          playlistIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['promptLanguage', 'musicMarket', 'playlistIds'],
      },
      'Catalogue:\n1 | Disney Classics\n2 | Deutsche Schlager 70er\n3 | 80s Rock\n\nThe customer wants: alte deutsche Schlager'
    ),
  aiSpotifyQuery: () =>
    direct(
      'aiSpotifyQuery',
      { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] },
      'Write a Spotify playlist search for: songs from Disney films'
    ),
  aiSpotifyPick: () =>
    direct(
      'aiSpotifyPick',
      { type: 'object', properties: { playlistIds: { type: 'array', items: { type: 'string' } } }, required: ['playlistIds'] },
      'The customer wants Disney songs. Playlists:\na1 | Disney Hits | 120 tracks\nb2 | my car mix | 40 tracks'
    ),
  chatAnswer: async () => {
    const tokens: string[] = [];
    const result = await llm.stream(
      'chatAnswer',
      {
        messages: [
          { role: 'system', content: 'You are the QRSong! support assistant. Answer in the language of the question, in one sentence.' },
          { role: 'assistant', content: 'Hoi! Waarmee kan ik helpen?' },
          { role: 'user', content: 'Hoe lang duurt verzending naar Duitsland?' },
        ],
      },
      (t) => tokens.push(t)
    );
    return { sample: `${tokens.length} chunks: ${result.data}`, result };
  },
  chatTopics: () =>
    direct(
      'chatTopics',
      {
        type: 'object',
        properties: { slugs: { type: 'array', items: { type: 'string' } }, reasoning: { type: 'string' } },
        required: ['slugs'],
      },
      'Topics: pricing, shipping-times, app-download.\nUser question: When will my cards arrive?'
    ),
  chatExtract: () =>
    direct(
      'chatExtract',
      {
        type: 'object',
        properties: {
          orderNumber: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
        },
        required: ['orderNumber', 'email'],
      },
      'Conversation:\nuser: my order is 100123, where is it?\n\nExtract: orderNumber, email'
    ),
  chatTranslate: () => direct('chatTranslate', null, 'Where is my order?', 'Translate the following text to Dutch. Return only the translation, nothing else.'),
  contactTranslate: () =>
    direct(
      'contactTranslate',
      {
        type: 'object',
        properties: { detectedLocale: { type: 'string' }, dutchTranslation: { type: 'string' } },
        required: ['detectedLocale', 'dutchTranslation'],
      },
      'Bonjour, mes cartes ne sont pas encore arrivées.',
      'Detect the language of the text and translate it to Dutch.'
    ),
  contactDraft: () =>
    direct('contactDraft', null, 'Customer "Anna" asks: can I still change the design after paying?', 'Write a short, friendly Dutch email reply signed "Rick,".'),
  quizTrivia: async () => ({
    sample: await gpt.regenerateQuizQuestion({ name: 'Bohemian Rhapsody', artist: 'Queen', year: 1975 }, 'trivia', 'nl'),
  }),
  quizQuestions: async () => ({
    sample: await gpt.generateWrongOptions('Wie zingt dit nummer?', 'Queen', { name: 'Bohemian Rhapsody', artist: 'Queen' }, 'nl'),
  }),
  appPalette: async () => ({
    sample: await gpt.suggestAppPalette(await paletteImage(), ['inter', 'bebas']),
  }),
  seoWrite: async () => ({
    sample: await gpt.writeSeoPlaylistDescription({
      playlistName: 'Dutch 90s Party',
      customerDescription: 'voor ons jaren 90 feest!!',
      serviceDescription: null,
      trackCount: 120,
      yearRange: { from: 1990, to: 1999 },
      decadeSplit: [{ label: '90s', percent: 100 }],
      topArtists: [{ name: '2 Unlimited', count: 4 }, { name: 'Vengaboys', count: 3 }],
      sampleTracks: ['2 Unlimited - No Limit (1993)', 'Vengaboys - Boom, Boom, Boom, Boom!! (1998)'],
      sampleIsPartial: true,
    }),
  }),
  seoTranslate: async () => ({
    sample: await gpt.translateSeoDescription(
      'Dutch 90s Party QR music cards bring back the decade of eurodance.',
      'Dutch 90s Party',
      ['nl', 'de']
    ),
  }),
  literalTranslate: async () => ({
    sample: await gpt.translateLiterally('Alle hits van ons jaren 90 feest.', 'Feest', ['nl', 'en', 'de']),
  }),
  textTranslate: async () => ({ sample: await gpt.translateText('Happy birthday, have fun!', ['nl', 'de']) }),
  genreTranslate: async () => ({ sample: await gpt.translateGenreNames('Hip hop', ['nl', 'de', 'fr']) }),
  baseEvents: async () => ({
    sample: await gpt.determineBaseEvents('Christmas Classics', 'All the Christmas songs', 'Pop', [
      { key: 'christmas', name: 'Christmas' },
      { key: 'valentines_day', name: "Valentine's Day" },
    ]),
  }),
  mailTranslate: async () => ({
    sample: await gpt.translateMessage('Bedankt voor je bestelling!\nGroet, Rick', 'Je bestelling', 'de'),
  }),
  orderExtract: async () => ({
    sample: await gpt.extractOrders(
      '<table><tr><td>Factuur</td><td>Opdrachtnummer 98765</td><td>01-10-2026</td><td>€ 45,10</td></tr><tr><td>Factuur</td><td>Opdrachtnummer 98766</td><td>02-10-2026</td><td>€ 12,00</td></tr></table>'
    ),
  }),
};

const YEAR_SET: Array<[string, string, number]> = [
  ['Queen', 'Bohemian Rhapsody', 1975],
  ['Nirvana', 'Smells Like Teen Spirit', 1991],
  ['Golden Earring', 'Radar Love', 1973],
  ['ABBA', 'Dancing Queen', 1976],
  ['Oasis', 'Wonderwall', 1995],
  ['Dua Lipa', 'Levitating', 2020],
  ['Adele', 'Rolling in the Deep', 2010],
  ['The Beatles', 'Hey Jude', 1968],
  ['Guus Meeuwis & Vagant', 'Het Is Een Nacht', 1994],
  ['Whitney Houston', 'I Wanna Dance with Somebody', 1987],
  ['Daft Punk', 'Get Lucky', 2013],
  ['Survivor', 'Eye of the Tiger', 1982],
  ['Pharrell Williams', 'Happy', 2013],
  ['Pink Floyd', 'Another Brick in the Wall, Pt. 2', 1979],
  ['Vengaboys', 'Boom, Boom, Boom, Boom!!', 1998],
  ['2 Unlimited', 'No Limit', 1993],
  ['BLØF', 'Zoutelande', 2017],
  ['Rammstein', 'Du hast', 1997],
  ['Céline Dion', 'My Heart Will Go On', 1997],
  ['Las Ketchup', 'The Ketchup Song (Aserejé)', 2002],
];

/**
 * Release-year cases with the kind of source data music.ts gathers, built to
 * disagree the way real data does: remasters and reissues, covers of older
 * songs, remixes, chart years after a release, classical composition years.
 * `year` is the answer the sources support (a range for classical works).
 */
const SOURCE_CASES: Array<{
  artist: string;
  title: string;
  year: number | [number, number];
  google: Array<{ title: string; snippet: string; url: string }>;
  wiki: string;
  mb: number;
  discogs: number;
}> = [
  {
    artist: 'Kate Bush', title: 'Running Up That Hill (A Deal with God)', year: 1985,
    google: [
      { title: 'Running Up That Hill - Wikipedia', snippet: 'is a song by English singer Kate Bush, released in August 1985 as the lead single from Hounds of Love. It re-entered charts worldwide in 2022 after it was featured in Stranger Things.', url: 'https://en.wikipedia.org/wiki/Running_Up_That_Hill' },
      { title: 'Running Up That Hill (2018 Remaster) - Spotify', snippet: 'Kate Bush · Song · 2022', url: 'https://open.spotify.com/track/x' },
    ],
    wiki: 'Released 5 August 1985. Label EMI. From the album Hounds of Love.', mb: 1985, discogs: 2022,
  },
  {
    artist: 'Mr. Probz', title: 'Waves', year: 2013,
    google: [{ title: 'Waves (Mr. Probz song) - Wikipedia', snippet: 'is a song by Dutch singer Mr. Probz, released in 2013. A remix by German DJ Robin Schulz, released in 2014, became an international hit.', url: 'https://en.wikipedia.org/wiki/Waves_(Mr._Probz_song)' }],
    wiki: 'Released 2013. Remix by Robin Schulz released 2014.', mb: 2014, discogs: 2013,
  },
  {
    artist: 'Soft Cell', title: 'Tainted Love', year: 1981,
    google: [{ title: 'Tainted Love - Wikipedia', snippet: 'is a song written by Ed Cobb and originally recorded by Gloria Jones in 1964. The 1981 cover by Soft Cell reached number one in the UK.', url: 'https://en.wikipedia.org/wiki/Tainted_Love' }],
    wiki: 'Soft Cell version: released July 1981 (single).', mb: 1981, discogs: 1981,
  },
  {
    artist: 'Whitney Houston', title: 'I Will Always Love You', year: 1992,
    google: [{ title: 'I Will Always Love You - Wikipedia', snippet: 'written and originally recorded by Dolly Parton in 1973 and released in 1974. Whitney Houston recorded it for The Bodyguard (1992).', url: 'https://en.wikipedia.org/wiki/I_Will_Always_Love_You' }],
    wiki: 'Whitney Houston version released November 3, 1992.', mb: 1992, discogs: 1993,
  },
  {
    artist: 'Queen', title: 'Bohemian Rhapsody - Remastered 2011', year: 1975,
    google: [
      { title: 'Bohemian Rhapsody - Wikipedia', snippet: 'is a song by the British rock band Queen, released as the lead single from their fourth studio album, A Night at the Opera (1975).', url: 'https://en.wikipedia.org/wiki/Bohemian_Rhapsody' },
      { title: 'Bohemian Rhapsody (The Original Soundtrack) 2018', snippet: 'Soundtrack album of the 2018 film', url: 'https://example.com/soundtrack' },
    ],
    wiki: 'Released 31 October 1975.', mb: 1975, discogs: 2018,
  },
  {
    artist: 'Ludwig van Beethoven', title: 'Für Elise, WoO 59', year: 1810,
    google: [{ title: 'Für Elise - Wikipedia', snippet: 'Bagatelle No. 25 in A minor, composed by Ludwig van Beethoven in 1810. It was not published until 1867, 40 years after his death.', url: 'https://en.wikipedia.org/wiki/F%C3%BCr_Elise' }],
    wiki: 'Composed 1810. Published 1867.', mb: 1958, discogs: 1993,
  },
  {
    artist: 'Johann Sebastian Bach', title: 'Toccata and Fugue in D minor, BWV 565', year: [1700, 1710],
    google: [{ title: 'Toccata and Fugue in D minor, BWV 565 - Wikipedia', snippet: 'organ work attributed to Johann Sebastian Bach, possibly composed as early as 1704. First published in 1833.', url: 'https://en.wikipedia.org/wiki/Toccata_and_Fugue_in_D_minor,_BWV_565' }],
    wiki: 'Composed c. 1704 (uncertain). Published 1833.', mb: 2001, discogs: 1997,
  },
  {
    artist: 'Guus Meeuwis & Vagant', title: 'Het Is Een Nacht (Levensecht)', year: 1994,
    google: [{ title: 'Het is een nacht (Levensecht) - Wikipedia', snippet: 'is een nummer van Guus Meeuwis & Vagant uit 1994. In 1995 werd het een grote hit in Nederland.', url: 'https://nl.wikipedia.org/wiki/Het_is_een_nacht' }],
    wiki: 'Uitgebracht 1994. Hit in 1995.', mb: 1995, discogs: 1994,
  },
  {
    artist: 'BLØF, Geike Arnaert', title: 'Zoutelande', year: 2017,
    google: [{ title: 'Zoutelande - Wikipedia', snippet: 'is een single van BLØF en Geike Arnaert uit 2017.', url: 'https://nl.wikipedia.org/wiki/Zoutelande_(lied)' }],
    wiki: 'Uitgebracht 2017.', mb: 2017, discogs: 2017,
  },
  {
    artist: 'Elvis Presley', title: "Can't Help Falling in Love", year: 1961,
    google: [{ title: "Can't Help Falling in Love - Wikipedia", snippet: 'recorded by Elvis Presley for Blue Hawaii (1961). UB40 had a number one hit with a reggae cover in 1993.', url: 'https://en.wikipedia.org/wiki/Can%27t_Help_Falling_in_Love' }],
    wiki: 'Released October 1, 1961.', mb: 1961, discogs: 1961,
  },
  {
    artist: 'Andrea Bocelli', title: 'Con te partirò', year: 1995,
    google: [{ title: 'Con te partirò - Wikipedia', snippet: 'Italian song by Andrea Bocelli, first performed at the 1995 Sanremo Music Festival and released on his 1995 album Bocelli. In 1996 it was re-recorded with Sarah Brightman as Time to Say Goodbye.', url: 'https://en.wikipedia.org/wiki/Con_te_partir%C3%B2' }],
    wiki: 'Released 1995.', mb: 1995, discogs: 1996,
  },
  {
    artist: 'Toto', title: 'Africa', year: 1982,
    google: [{ title: 'Africa (Toto song) - Wikipedia', snippet: 'released in 1982 as the third single from Toto IV. It reached number one on the Billboard Hot 100 in February 1983.', url: 'https://en.wikipedia.org/wiki/Africa_(Toto_song)' }],
    wiki: 'Released October 1982.', mb: 1982, discogs: 1983,
  },
  {
    artist: 'Ben E. King', title: 'Stand by Me', year: 1961,
    google: [{ title: 'Stand by Me (Ben E. King song) - Wikipedia', snippet: 'released in 1961. Re-released in 1986 for the film Stand by Me, it reached number one in the UK in 1987.', url: 'https://en.wikipedia.org/wiki/Stand_by_Me_(Ben_E._King_song)' }],
    wiki: 'Released April 1961.', mb: 1961, discogs: 1987,
  },
  {
    artist: 'Darude', title: 'Sandstorm', year: 1999,
    google: [{ title: 'Sandstorm (instrumental) - Wikipedia', snippet: 'by Finnish producer Darude, released on 26 October 1999. Released in the UK in 2000, where it reached number 3.', url: 'https://en.wikipedia.org/wiki/Sandstorm_(instrumental)' }],
    wiki: 'Released 26 October 1999.', mb: 2000, discogs: 1999,
  },
  {
    artist: 'Gary Jules', title: 'Mad World', year: 2001,
    google: [{ title: 'Mad World - Wikipedia', snippet: 'a song by Tears for Fears from 1982. Gary Jules and Michael Andrews recorded a cover for the Donnie Darko soundtrack (2001); released as a single in 2003, it became the UK Christmas number one.', url: 'https://en.wikipedia.org/wiki/Mad_World' }],
    wiki: 'Gary Jules version: recorded 2001 for Donnie Darko, single 2003.', mb: 2003, discogs: 2001,
  },
  {
    artist: 'Survivor', title: 'Eye of the Tiger - 2006 Remaster', year: 1982,
    google: [{ title: 'Eye of the Tiger - Wikipedia', snippet: 'released in May 1982 as the theme song of Rocky III.', url: 'https://en.wikipedia.org/wiki/Eye_of_the_Tiger' }],
    wiki: 'Released May 29, 1982.', mb: 1982, discogs: 1982,
  },
];

/** The prompt music.ts builds, with a case's sources in it. */
function sourcePrompt(c: (typeof SOURCE_CASES)[number]): string {
  return `  I have gathered information about a certain song on the internet: ${c.artist} - ${c.title}
                    Use your own knowledge. I will share all this information with you below. My goal is to find the release year of this song.
                    If the release date is literally found on Wikipedia, I will use that information.

                    What a Google search on the songs artist and title returned:

                    ${JSON.stringify(c.google)}

                    What I found on Wikipedia:

                    ${JSON.stringify(c.wiki)}

                    MusicBrainz thinks the release year is ${c.mb}
                    Discogs thinks the release year is ${c.discogs}

                    When evaulating a classical song, we are looking for the year of original composition, not the year of release.

                    What is the release you think of this song based on the information above? Also explain on which information you based your answer on.
                    `;
}

async function compareSources(routeArg?: string): Promise<void> {
  const config = taskConfig('yearLookup');
  const routes =
    parseRoutes(routeArg) ??
    ([config.primary, config.fallback].filter(Boolean) as LlmRoute[]);
  const score = routes.map(() => ({ right: 0, cost: 0, ms: 0 }));
  for (const c of SOURCE_CASES) {
    const cells: string[] = [];
    for (const [i, route] of routes.entries()) {
      const req = normalizeRequest({
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant that helps me determine the release year of a song based on its title and artist. I am sure the artist and title provided are correct. So do not talk about other songs or artists. If you are not sure about the release year, please let me know.',
          },
          { role: 'user', content: sourcePrompt(c) },
        ],
        schema: {
          name: 'parseYear',
          schema: {
            type: 'object',
            properties: {
              year: { type: 'number', description: 'The release year of the song based on all sources' },
              reasoning: { type: 'string' },
              certainty: { type: 'number' },
              source: { type: 'string' },
            },
            required: ['year', 'reasoning'],
          },
        },
      });
      const t0 = Date.now();
      const res = await getProvider(route.provider).complete!(req, {
        route,
        maxOutputTokens: 4000,
        timeoutMs: 60_000,
        maxRetries: 1,
      });
      const answer = JSON.parse(res.text).year;
      const ok = Array.isArray(c.year) ? answer >= c.year[0] && answer <= c.year[1] : answer === c.year;
      score[i].right += ok ? 1 : 0;
      score[i].cost += res.parts.reduce((sum, p) => sum + priceCall(p.model, p.usage), 0);
      score[i].ms += Date.now() - t0;
      cells.push(`${answer}${ok ? '' : ' ✗'}`.padEnd(7));
    }
    const truth = Array.isArray(c.year) ? `${c.year[0]}-${c.year[1]}` : String(c.year);
    console.log(`${truth.padEnd(10)} ${`${c.artist} - ${c.title}`.slice(0, 50).padEnd(51)} ${cells.join(' | ')}`);
  }
  routes.forEach((route, i) =>
    console.log(
      color.white.bold(`${route.provider}/${route.model}:${route.effort}: `) +
        `${score[i].right}/${SOURCE_CASES.length} right, $${score[i].cost.toFixed(4)} ($${(score[i].cost / SOURCE_CASES.length).toFixed(5)} per call), ${(score[i].ms / SOURCE_CASES.length / 1000).toFixed(1)}s per call`
    )
  );
}

/** "provider/model:effort,..." from --routes. */
function parseRoutes(arg: string | undefined): LlmRoute[] | null {
  if (!arg) return null;
  return arg
    .slice('--routes='.length)
    .split(',')
    .map((spec) => {
      const [path, effort] = spec.split(':');
      const [provider, model] = path.split('/');
      return { provider: provider as LlmRoute['provider'], model, effort: (effort || 'low') as LlmRoute['effort'] };
    });
}

/**
 * Release years side by side: the primary and fallback route of yearLookup,
 * or the routes given with --routes. The prompt names only artist and title,
 * so this measures what a model knows; production prompts also carry the
 * Google, MusicBrainz and Discogs data.
 */
async function compareYears(routeArg?: string): Promise<void> {
  const config = taskConfig('yearLookup');
  const routes =
    parseRoutes(routeArg) ??
    ([config.primary, config.fallback].filter(Boolean) as LlmRoute[]);
  const score = routes.map(() => ({ right: 0, cost: 0, ms: 0 }));
  for (const [artist, title, year] of YEAR_SET) {
    const cells: string[] = [];
    for (const [i, route] of routes.entries()) {
      const req = normalizeRequest({
        messages: [
          { role: 'system', content: 'You are a helpful assistant that helps me determine the release year of a song based on its title and artist.' },
          { role: 'user', content: `Song: "${title}" by ${artist}. What is the year of its original release?` },
        ],
        schema: {
          name: 'parseYear',
          schema: {
            type: 'object',
            properties: { year: { type: 'number' }, reasoning: { type: 'string' } },
            required: ['year', 'reasoning'],
          },
        },
      });
      const t0 = Date.now();
      const res = await getProvider(route.provider).complete!(req, {
        route,
        maxOutputTokens: 4000,
        timeoutMs: 60_000,
        maxRetries: 1,
      });
      const answer = JSON.parse(res.text).year;
      score[i].right += answer === year ? 1 : 0;
      score[i].cost += res.parts.reduce((sum, p) => sum + priceCall(p.model, p.usage), 0);
      score[i].ms += Date.now() - t0;
      cells.push(`${answer}${answer === year ? '' : ' ✗'}`);
    }
    console.log(`${String(year).padEnd(5)} ${`${artist} - ${title}`.padEnd(52)} ${cells.join('  |  ')}`);
  }
  routes.forEach((route, i) =>
    console.log(
      color.white.bold(`${route.provider}/${route.model}: `) +
        `${score[i].right}/${YEAR_SET.length} right, $${score[i].cost.toFixed(4)}, ${(score[i].ms / YEAR_SET.length / 1000).toFixed(1)}s per call`
    )
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--sources')) {
    await compareSources(args.find((a) => a.startsWith('--routes=')));
    return;
  }
  if (args.includes('--compare')) {
    await compareYears(args.find((a) => a.startsWith('--routes=')));
    return;
  }
  // --routes without --compare/--sources: run each task's check on each of
  // those routes instead of its own, without fallback, to compare answers.
  const routeOverride = parseRoutes(args.find((a) => a.startsWith('--routes=')));
  const tasksArg = args.filter((a) => !a.startsWith('--'));
  const wanted = (tasksArg.length ? tasksArg : Object.keys(CHECKS)) as TextTask[];
  const started = new Date();
  let failures = 0;
  for (const task of wanted) {
    const check = CHECKS[task];
    if (!check) {
      console.log(color.yellow.bold(`${task}: no check`));
      continue;
    }
    const config = LLM_TASKS[task] as { primary: LlmRoute; fallback?: LlmRoute };
    const original = { primary: config.primary, fallback: config.fallback };
    for (const route of routeOverride ?? [config.primary]) {
      if (routeOverride) {
        config.primary = route;
        config.fallback = undefined;
      }
      const t0 = Date.now();
      try {
        const { sample } = await check();
        const text = JSON.stringify(sample);
        const ok = sample !== null && sample !== undefined && text !== '{}' && text !== '[]';
        if (!ok) failures++;
        console.log(
          (ok ? color.green.bold('✓ ') : color.red.bold('✗ ')) +
            color.white.bold(task.padEnd(18)) +
            ` ${route.provider}/${route.model}:${route.effort} ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
            text.slice(0, routeOverride ? 700 : 160)
        );
      } catch (err) {
        failures++;
        console.log(color.red.bold('✗ ') + color.white.bold(task.padEnd(18)) + ` ${(err as Error).message}`);
      } finally {
        config.primary = original.primary;
        config.fallback = original.fallback;
      }
    }
  }

  // The ledger is written fire-and-forget; give the last writes a moment.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const rows = await PrismaInstance.getInstance().llmCall.groupBy({
    by: ['task', 'provider', 'model', 'role', 'status'],
    where: { createdAt: { gte: started } },
    _count: { _all: true },
    _sum: { costUsd: true },
  });
  console.log(color.blue.bold('\nLedger rows written during this run:'));
  let total = 0;
  for (const r of rows) {
    total += r._sum.costUsd ?? 0;
    console.log(
      `  ${r.task.padEnd(18)} ${`${r.provider}/${r.model}`.padEnd(32)} ${r.role.padEnd(8)} ${r.status.padEnd(11)} ×${r._count._all}  $${(r._sum.costUsd ?? 0).toFixed(5)}`
    );
  }
  console.log(color.white.bold(`Total: $${total.toFixed(4)}, ${failures} failed check(s)`));
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 100));
