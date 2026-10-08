import Logger from './logger';
import PrismaInstance from './prisma';
import { color } from 'console-log-colors';
import Translation from './translation';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { formatCostUsd, llm, LlmOutputError } from './llm';

/**
 * The description prompt used to ask for "a list of numbers from that
 * playlist", and the model sometimes answered with the label instead of a
 * sentence: "Numbers you'll spot: 1990, 8 - hit play and ...". Four of those
 * reached the live catalogue. The prompt no longer asks for it; this removes
 * the fragment if a model emits it anyway, and repairs the stored rows.
 *
 * The letter that follows the label is captured so the sentence it started can
 * be capitalised. Capitalising after every sentence instead would also hit
 * "QRSong! and ...", where the exclamation mark belongs to the brand name.
 */
export function stripNumberScaffolding(text: string): string {
  if (!text) return text;
  const labelled =
    /\s*\b(?:numbers|cijfers|zahlen|nombres|numeri|liczby|siffror|tall)\b[^.:!?]{0,40}:\s*[^.!?—–-]*\s*(?:[—–-]\s*)?([a-z])?/gi;
  // Only touch text that actually carries the label. The tidy-up below would
  // otherwise re-punctuate and re-capitalise perfectly good descriptions.
  if (!labelled.test(text)) return text;
  labelled.lastIndex = 0;
  const out = text
    .replace(labelled, (_match, next: string | undefined) =>
      next ? ' ' + next.toUpperCase() : ' '
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
  return out.replace(/^([a-z])/, (m) => m.toUpperCase());
}

/**
 * Card-sized companion for a blog image: blog_123.jpg -> blog_123_thumb.webp.
 * Shared with the backfill script so the two cannot disagree on the name.
 */
export function thumbnailNameFor(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, '') + '_thumb.webp';
}

/**
 * Everything the description writer gets to see about a playlist. Built by
 * seoDescriptions.ts from the catalogue row and its stored tracks.
 */
export interface SeoDescriptionBrief {
  playlistName: string;
  /** What the customer typed when submitting the playlist, if anything. */
  customerDescription: string | null;
  /** The description on the streaming service, if any. */
  serviceDescription: string | null;
  trackCount: number;
  yearRange: { from: number; to: number } | null;
  /** Decades with at least a few percent of the tracks, largest first. */
  decadeSplit: Array<{ label: string; percent: number }>;
  topArtists: Array<{ name: string; count: number }>;
  /** "Artist - Title (Year)" lines, evenly spread over the tracklist. */
  sampleTracks: string[];
  sampleIsPartial: boolean;
}

/**
 * The prompts, schemas and answer handling of the API's AI tasks: release
 * years, quiz questions, translations, SEO copy, the app palette. Which
 * provider and model run each task is decided in src/llm/tasks.ts; this class
 * only talks to the LLM layer (src/llm).
 */
export class AiTasks {
  private prisma = PrismaInstance.getInstance();

  private logger = new Logger();
  private translation = new Translation();

  public async verifyList(
    userId: number,
    playlistId: string
  ): Promise<
    Array<{
      artist: string;
      title: string;
      oldYear: number;
      suggestedYear: number;
      reasoning: string;
    }>
  > {
    // First get the playlist ID from the Spotify playlist ID
    const playlist = await this.prisma.$queryRaw<any[]>`
      SELECT id, name 
      FROM playlists 
      WHERE playlistId = ${playlistId}`;

    if (!playlist || playlist.length === 0) {
      return [];
    }

    // Then get all tracks for this playlist
    const tracks = await this.prisma.$queryRaw<any[]>`
      SELECT t.name, t.artist, t.year
      FROM tracks t
      INNER JOIN playlist_has_tracks pht ON t.id = pht.trackId 
      WHERE pht.playlistId = ${playlist[0].id}`;

    if (!tracks || tracks.length === 0) {
      return [];
    }

    // Process tracks in batches of 20
    const batchSize = 20;
    let allMistakes: any[] = [];

    this.logger.log(
      color.blue.bold(
        `Verifying playlist: ${color.white.bold(
          playlistId
        )} in batches of ${color.white.bold(batchSize)}`
      )
    );

    for (let i = 0; i < tracks.length; i += batchSize) {
      const batch = tracks.slice(i, i + batchSize);
      const tracksPrompt = batch
        .map((track) => `"${track.name}" by ${track.artist} (${track.year})`)
        .join('\n');

      const prompt = `Please verify the release years for these songs:\n${tracksPrompt}`;

      this.logger.log(
        color.blue.bold(
          `Processing batch ${color.white.bold(
            Math.floor(i / batchSize) + 1
          )} of ${color.white.bold(
            Math.ceil(tracks.length / batchSize)
          )} (${color.white.bold(allMistakes.length)} mistakes found so far)`
        )
      );

      const completionArguments = await llm.tryJson<{ mistakes: any[] }>('yearAudit', {
        messages: [
          {
            role: 'system',
            content: `You are a helpful assistant that helps verify song release years. For classical songs I'm not looking for release year, but for the year of composition. I will provide a list of songs with their years. For each song that you believe has an incorrect year, return the correct year with an explanation and sources. Only suggest different years when you are highly confident.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        schema: {
          name: 'parseYearMistakes',
          schema: {
            type: 'object',
            properties: {
              mistakes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    artist: {
                      type: 'string',
                      description: 'The artist name',
                    },
                    title: {
                      type: 'string',
                      description: 'The song title',
                    },
                    oldYear: {
                      type: 'number',
                      description: 'The original year provided',
                    },
                    suggestedYear: {
                      type: 'number',
                      description: 'The correct release year',
                    },
                    reasoning: {
                      type: 'string',
                      description:
                        'Explanation with sources for why this year is correct',
                    },
                  },
                  required: [
                    'artist',
                    'title',
                    'oldYear',
                    'suggestedYear',
                    'reasoning',
                  ],
                },
              },
            },
            required: ['mistakes'],
          },
        },
      });

      if (!completionArguments) {
        this.logger.log(
          color.red.bold('Year audit stopped: the model gave no usable answer')
        );
        return [];
      }
      const significantMistakes = (completionArguments.mistakes ?? []).filter(
        (mistake: any) =>
          Math.abs(mistake.suggestedYear - mistake.oldYear) > 2
      );
      allMistakes = allMistakes.concat(significantMistakes);
    }

    if (allMistakes.length > 0) {
      // Set suggestionsPending flag for this playlist
      await this.prisma.$executeRaw`
        UPDATE payment_has_playlist
        SET suggestionsPending = 1
        WHERE playlistId = ${playlist[0].id}`;

      // Create user suggestions for each mistake, checking for duplicates
      for (const mistake of allMistakes) {
        // First check if this suggestion already exists
        const existingSuggestion = await this.prisma.$queryRaw<any[]>`
          SELECT us.id 
          FROM usersuggestions us
          INNER JOIN tracks t ON t.id = us.trackId
          INNER JOIN playlist_has_tracks pht ON t.id = pht.trackId
          WHERE t.name = ${mistake.title}
          AND t.artist = ${mistake.artist}
          AND pht.playlistId = ${playlist[0].id}
          AND us.userId = ${userId}
          LIMIT 1
        `;

        this.logger.log(
          color.blue.bold(
            `Suggestion for "${color.white.bold(
              mistake.title
            )}" by ${color.white.bold(mistake.artist)} (${color.white.bold(
              mistake.oldYear
            )} -> ${color.white.bold(mistake.suggestedYear)})`
          )
        );

        // Only create suggestion if it doesn't exist
        if (existingSuggestion.length === 0) {
          await this.prisma.$executeRaw`
            INSERT INTO usersuggestions (
              name, 
              artist, 
              year,
              trackId,
              playlistId,
              userId,
              createdAt,
              updatedAt,
              comment
            )
            SELECT 
              ${mistake.title},
              ${mistake.artist},
              ${mistake.suggestedYear},
              t.id,
              pht.playlistId,
              ${userId},
              NOW(),
              NOW(),
              ${mistake.reasoning}
            FROM tracks t
            INNER JOIN playlist_has_tracks pht ON t.id = pht.trackId
            WHERE t.name = ${mistake.title}
            AND t.artist = ${mistake.artist}
            AND pht.playlistId = ${playlist[0].id}
            LIMIT 1
          `;
        }
      }

      return allMistakes;
    }

    this.logger.log(color.blue.bold('Done verifying playlist'));

    return [];
  }

  /**
   * Write the English product-page description for a featured playlist.
   *
   * The customer's own text is input, not output: it carries the intent (who
   * the list is for, the occasion) but is typically written for friends, in
   * the wrong language, or with things a shop page cannot say. The tracklist
   * facts are what keep the model honest about genre, era and artists.
   *
   * Returns null when the model produced nothing usable. Callers decide what
   * that means; the bulk run records it and moves on.
   */
  public async writeSeoPlaylistDescription(
    brief: SeoDescriptionBrief
  ): Promise<string | null> {
    const facts: string[] = [`Playlist name: "${brief.playlistName}"`];
    facts.push(`Number of tracks: ${brief.trackCount}`);
    if (brief.yearRange) {
      facts.push(
        `Release years: ${brief.yearRange.from} to ${brief.yearRange.to}`
      );
    }
    if (brief.decadeSplit.length > 0) {
      facts.push(
        `Share per decade: ${brief.decadeSplit
          .map((d) => `${d.label} ${d.percent}%`)
          .join(', ')}`
      );
    }
    if (brief.topArtists.length > 0) {
      facts.push(
        `Most frequent artists: ${brief.topArtists
          .map((a) => (a.count > 1 ? `${a.name} (${a.count} tracks)` : a.name))
          .join(', ')}`
      );
    }

    const customerText = brief.customerDescription?.trim();
    const serviceText = brief.serviceDescription?.trim();

    const sections: string[] = [facts.join('\n')];
    if (customerText) {
      sections.push(
        `Description the customer wrote when submitting the playlist (any language, treat as intent only, never quote it):\n"""${customerText}"""`
      );
    }
    if (serviceText && serviceText !== customerText) {
      sections.push(
        `Description shown on the streaming service (often noise, use only if it says something useful):\n"""${serviceText}"""`
      );
    }
    sections.push(
      `${
        brief.sampleIsPartial
          ? `Evenly spread sample of ${brief.sampleTracks.length} of the ${brief.trackCount} tracks`
          : 'Complete tracklist'
      } (artist - title (year)):\n${brief.sampleTracks.join('\n')}`
    );

    const parsed = await llm.tryJson<{ description?: unknown }>('seoWrite', {
      messages: [
        {
          role: 'system',
          content: `You write product descriptions for QRSong!, a shop that turns a music playlist into QR music cards: each card has a QR code on one side and the artist, title and year on the other, and players scan a card, hear the song and guess what it is. You write in natural English for a product page that search engines also read. You sound like a knowledgeable music fan, not a marketer.`,
        },
        {
          role: 'user',
          content: `Write the description for the product page of this playlist.

Purpose and where it is used:
- This is SEO copy. It has to earn the page a place in search results for people looking for music cards, a music quiz or a guess-the-song game around this kind of music, and then convince them once they land.
- The whole text is the introduction under the page title on the product page (www.qrsong.io/<language>/product/<slug>), the description in the page's Product and MusicPlaylist structured data, the description in the Google Shopping product feed, and the text shown when the page is shared on social media.
- The first sentence alone is the meta description search engines print under the page title in their results, so it has to make sense with nothing around it.

Structure and length:
- Three or four sentences, 320 to 520 characters in total.
- The first sentence stands on its own as the page's meta description: at most 150 characters, contains the playlist name exactly as given and the words "QR music cards", and says what kind of music this is (genre, era or mood).
- The following sentences cover: how many tracks and which years or decades it spans; two to four artists that stand out (only artists present in the data); who or which occasion it suits (a party, a birthday, a family evening, a road trip, a themed night...), inferred from the music and the customer's intent.

Sources:
- Use the customer's description for intent only: the mood, the occasion, who it is for. Rewrite from scratch. Drop anything personal, dated, first person, addressed to specific people, promotional, off topic, or unsuitable for a shop page. If it is in another language, use it for meaning only and write English.
- Never invent facts. No artists, years, genres or counts that are not in the data. Do not list song titles. If the genre is unclear, describe the era and the mood instead.

Style:
- Plain, concrete sentences. No hype words (ultimate, amazing, best ever, epic), no rhetorical questions, no "are you ready", no exclamation marks, no emojis, no hashtags, no URLs, no ALL CAPS, no em dashes, no bullet points and no labelled lists of numbers.
- Say "QR music cards" once, and optionally "guess the song" or "music quiz" once. Do not repeat the playlist name more than twice.
- Call the songs "tracks". Do not mention prices, shipping, apps, Spotify or any other brand, game or competitor.
- Do not explain what you did; return only the description.

${sections.join('\n\n')}`,
        },
      ],
      schema: {
        name: 'seoPlaylistDescription',
        schema: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description:
                'The English product description, three or four sentences.',
            },
          },
          required: ['description'],
        },
      },
    });

    if (!parsed || typeof parsed.description !== 'string') return null;
    const text = stripNumberScaffolding(parsed.description).trim();
    return text.length > 0 ? text : null;
  }

  /**
   * Translate a product description written by writeSeoPlaylistDescription.
   *
   * Different from translateText on purpose: the playlist name and the brand
   * stay untouched, "QR music cards" becomes the term that market searches
   * for rather than a literal rendering, and the first sentence keeps its
   * role as a standalone meta description within 150 characters.
   */
  public async translateSeoDescription(
    text: string,
    playlistName: string,
    targetLocales: string[]
  ): Promise<Record<string, string>> {
    if (!text || targetLocales.length === 0) return {};

    const parsed = await llm.tryJson<Record<string, unknown>>('seoTranslate', {
      messages: [
        {
          role: 'system',
          content: `You localise product descriptions for QRSong!, a shop that turns a music playlist into QR music cards for a guess-the-song game. You write the way a native copywriter in each market would, not word for word.`,
        },
        {
          role: 'user',
          content: `Translate the product description below into: ${targetLocales
            .map((l) => `${this.translation.getLanguageName(l)} (key "${l}")`)
            .join(', ')}.

This is SEO copy. Each translation is the introduction on that language's product page, the description in its structured data and shopping feed, and its first sentence is the meta description shown in search results, so it has to read like something a native speaker would search for and click.

Rules for every language:
- Keep the playlist name "${playlistName}" exactly as written. Keep "QRSong!" exactly as written.
- Render "QR music cards" as the phrase people in that market would type into a search engine for printable music cards with QR codes (for example Dutch "QR muziekkaarten", German "QR-Musikkarten"), and use that phrase once.
- Keep the same number of sentences and the same facts. Do not add or remove artists, years or counts.
- The first sentence must still work on its own as a meta description of at most 150 characters in that language.
- Plain and natural, no exclamation marks, no emojis, no em dashes. Artist names and song titles are never translated.

Text:
${text}`,
        },
      ],
      schema: {
        name: 'translateSeoDescription',
        schema: {
          type: 'object',
          properties: Object.fromEntries(
            targetLocales.map((locale) => [
              locale,
              {
                type: 'string',
                description: `The description in ${this.translation.getLanguageName(locale)}`,
              },
            ])
          ),
          required: targetLocales,
        },
      },
    });

    if (!parsed) return {};
    const translations: Record<string, string> = {};
    for (const locale of targetLocales) {
      const value = parsed[locale];
      if (typeof value === 'string' && value.trim()) {
        translations[locale] = value.trim();
      }
    }
    return translations;
  }

  /**
   * Translate a customer's playlist description word for word, for a
   * featured playlist whose description is kept (playlists.preserveDescription).
   *
   * The opposite of translateSeoDescription: nothing is rewritten, shortened
   * or tuned for search. The same call names the language the text is
   * written in (`sourceLocale`, null when it is none of `locales`), so the
   * caller can store the original there unchanged; whatever the model returns
   * for that locale is not meant to be used.
   */
  public async translateLiterally(
    text: string,
    playlistName: string,
    locales: string[]
  ): Promise<{ sourceLocale: string | null; translations: Record<string, string> }> {
    if (!text || locales.length === 0) return { sourceLocale: null, translations: {} };

    const parsed = await llm.tryJson<{
      sourceLanguage?: unknown;
      translations?: Record<string, unknown>;
    }>('literalTranslate', {
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. You translate faithfully and completely, the way a careful human translator would, and never rewrite or improve the text.`,
        },
        {
          role: 'user',
          content: `The text below is the description a curator wrote for their playlist "${playlistName}". It is kept exactly because it is good, so translate it literally.

First decide which of these languages it is written in: ${locales
            .map((l) => `${this.translation.getLanguageName(l)} (key "${l}")`)
            .join(', ')}. Answer "other" when it is none of them.

Then translate it into each of those languages.
- Keep every sentence, fact, name and nuance, in the same order and the same tone. Do not shorten, summarise, add, explain or optimise anything for search engines.
- Keep the playlist name "${playlistName}", the names of people, artists, composers and bands, and song titles exactly as written, in the same script.
- Keep the paragraphs, line breaks and emojis where they are.
- For the language the text is already written in, return the text unchanged.

Text:
${text}`,
        },
      ],
      schema: {
        name: 'translateLiterally',
        schema: {
          type: 'object',
          properties: {
            sourceLanguage: {
              type: 'string',
              enum: [...locales, 'other'],
              description: 'The key of the language the text is written in, or "other"',
            },
            translations: {
              type: 'object',
              properties: Object.fromEntries(
                locales.map((locale) => [
                  locale,
                  {
                    type: 'string',
                    description: `The text in ${this.translation.getLanguageName(locale)}`,
                  },
                ])
              ),
              required: locales,
            },
          },
          required: ['sourceLanguage', 'translations'],
        },
      },
    });

    if (!parsed) return { sourceLocale: null, translations: {} };
    const sourceLocale =
      typeof parsed.sourceLanguage === 'string' && locales.includes(parsed.sourceLanguage)
        ? parsed.sourceLanguage
        : null;
    const translations: Record<string, string> = {};
    for (const locale of locales) {
      const value = parsed.translations?.[locale];
      if (typeof value === 'string' && value.trim()) {
        translations[locale] = value.trim();
      }
    }
    return { sourceLocale, translations };
  }

  /**
   * Decide which gift-occasion base events (if any) a playlist belongs to.
   * Returns the matching base-event keys (0, 1 or more). Deliberately strict:
   * most playlists are not occasion-specific and should return an empty list.
   */
  public async determineBaseEvents(
    playlistName: string,
    description: string | null,
    genreName: string | null,
    availableBaseEvents: Array<{ key: string; name: string; description?: string | null }>
  ): Promise<string[]> {
    if (availableBaseEvents.length === 0) return [];

    const keys = availableBaseEvents.map((b) => b.key);
    const optionList = availableBaseEvents
      .map((b) => `- ${b.key}: ${b.name}${b.description ? ` (${b.description})` : ''}`)
      .join('\n');

    const prompt = `Playlist name: "${playlistName}"
Genre: ${genreName || 'unknown'}
Description: ${description ? description.replace(/\s+/g, ' ').trim() : '(none)'}`;

    let parsed: { baseEventKeys?: unknown } | null;
    let costUsd = 0;
    try {
      ({ data: parsed, costUsd } = await llm.tryJsonWithCost<{ baseEventKeys?: unknown }>('baseEvents', {
        messages: [
          {
            role: 'system',
            content: `You match music playlists to gift-giving occasions for a personalized music-card shop.`,
          },
          {
            role: 'user',
            content: `Decide which of the occasions below this playlist is a good fit for as a gift.
                      Only choose an occasion when the playlist is clearly themed for it (e.g. a Christmas songs
                      playlist -> christmas; a romantic/love playlist -> valentines_day). Most playlists are NOT
                      occasion-specific: when in doubt, return an empty list. A playlist may match several occasions.

                      Available occasions (key: name):
                      ${optionList}

                      ${prompt}`,
          },
        ],
        schema: {
          name: 'determineBaseEvents',
          schema: {
            type: 'object',
            properties: {
              baseEventKeys: {
                type: 'array',
                items: { type: 'string', enum: keys },
                description:
                  'Keys of the occasions this playlist clearly fits, or an empty array if none.',
              },
              reasoning: {
                type: 'string',
                description: 'Brief explanation of the choice.',
              },
            },
            required: ['baseEventKeys', 'reasoning'],
          },
        },
      }));
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error calling LLM for base events (${playlistName}): ${error}`)
      );
      return [];
    }

    if (!parsed) return [];
    const chosen: string[] = Array.isArray(parsed.baseEventKeys)
      ? parsed.baseEventKeys.filter((k: string) => keys.includes(k))
      : [];
    this.logger.log(
      color.blue.bold(
        `Base events for ${color.white.bold(playlistName)}: ${color.white.bold(
          chosen.length ? chosen.join(', ') : 'none'
        )} (${color.white.bold(formatCostUsd(costUsd))})`
      )
    );
    return [...new Set(chosen)];
  }

  public async translateGenreNames(
    genreNameEn: string,
    targetLocales: string[]
  ): Promise<Record<string, string>> {
    if (targetLocales.length === 0) {
      this.logger.log(
        color.yellow.bold(
          `No target locales specified for translating genre "${genreNameEn}".`
        )
      );
      return {};
    }

    this.logger.log(
      color.blue.bold(
        `Translating genre "${color.white.bold(
          genreNameEn
        )}" to ${color.white.bold(targetLocales.join(', '))}`
      )
    );

    try {
      const { data: translations, costUsd } = await llm.tryJsonWithCost<
        Record<string, string>
      >('genreTranslate', {
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate the provided music genre name accurately into the specified languages. Provide only the translated name for each language.`,
          },
          {
            role: 'user',
            content: `Translate the music genre name "${genreNameEn}" into the following languages: ${targetLocales.join(
              ', '
            )}.`,
          },
        ],
        schema: {
          name: 'getGenreTranslations',
          schema: {
            type: 'object',
            properties: Object.fromEntries(
              targetLocales.map((locale) => [
                locale,
                {
                  type: 'string',
                  description: `The translated genre name in ${locale}`,
                },
              ])
            ),
            required: targetLocales,
          },
        },
      });

      if (translations) {
        this.logger.log(
          color.green.bold(
            `Successfully translated genre "${color.white.bold(
              genreNameEn
            )}" (${color.white.bold(formatCostUsd(costUsd))}).`
          )
        );
        return translations;
      }
      this.logger.log(
        color.yellow.bold(
          `No usable translation for genre "${color.white.bold(genreNameEn)}"`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `API call failed for translating genre "${genreNameEn}": ${
            (error as Error).message
          }`
        )
      );
    }
    return {};
  }

  public async ask(prompt: string): Promise<any> {
    try {
      const { data, costUsd } = await llm.json<any>('yearLookup', {
        messages: [
          {
            role: 'system',
            content: `You are a helpful assistant that helps me determine the release year of a song based on its title and artist. I am sure the artist and title provided are correct. So do not talk about other songs or artists. If you are not sure about the release year, please let me know.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        schema: {
          name: 'parseYear',
          schema: {
            type: 'object',
            properties: {
              year: {
                type: 'number',
                description:
                  'The release year of the song based on all sources',
              },
              reasoning: {
                type: 'string',
                description:
                  'The explanation of how the year was determined. Refer to the source, and explain the reasoning behind the choice.',
              },
              certainty: {
                type: 'number',
                description:
                  'The certainty in % of how sure you are of the year',
              },
              source: {
                type: 'string',
                description: "An URL of the source you've used",
              },
            },
            required: ['year', 'reasoning'],
          },
        },
      });
      // The cost rides along for the caller's log line (music.ts).
      return { ...data, costUsd };
    } catch (error) {
      if (!(error instanceof LlmOutputError)) throw error;
      // An answer that is not JSON reads as "no year"; no answer at all as unknown.
      if (error.kind === 'unparseable') {
        this.logger.log(
          color.red.bold(`Error parsing JSON response: ${color.white.bold(error.raw)}`)
        );
        return { year: 0, reasoning: '', certainty: 0, source: '' };
      }
      return undefined;
    }
  }

  /**
   * Generate a hero image for an occasion / base event, themed around the
   * occasion and its description. No product reference image is used (see
   * the prompt below): it is a pure text-to-image scene, stored as a wide
   * hero-sized JPEG under PUBLIC_DIR/event_images.
   * @param name The occasion name (e.g. "Christmas") used for theming
   * @param description Optional admin description guiding the mood
   * @returns Promise<string | null> - filename if successful, null if failed
   */
  public async generateEventImage(
    name: string,
    description?: string | null
  ): Promise<string | null> {
    try {
      const eventImagesDir = path.join(
        process.env['PUBLIC_DIR']!,
        'event_images'
      );
      try {
        await fs.access(eventImagesDir);
      } catch {
        await fs.mkdir(eventImagesDir, { recursive: true });
        this.logger.log(
          color.blue.bold(
            `Created event images directory: ${color.white.bold(
              eventImagesDir
            )}`
          )
        );
      }

      // Build a hero-banner prompt from the occasion name + description. The
      // description is admin-authored guidance ("what fits this occasion"); we
      // frame it as a visual scene rather than passing it verbatim. No product
      // reference image is used — this is a pure text-to-image hero scene.
      const mood =
        description && description.trim()
          ? ` Mood and theme: ${description.trim()}.`
          : '';
      const imagePrompt =
        `A warm, festive wide hero banner celebrating ${name}.${mood} ` +
        `A beautifully styled, seasonal scene themed around ${name}, with ` +
        `soft cinematic lighting and vibrant, tasteful colours. Photographic, ` +
        `high quality, suitable as a website hero background with calm ` +
        `negative space. No text, no words, no letters, no logos, no ` +
        `watermarks.`;

      this.logger.log(
        color.blue.bold(
          `Generating event hero image for "${color.white.bold(name)}"`
        )
      );

      const { data: resultBuffer, costUsd } = await llm.image('eventBanner', {
        prompt: imagePrompt,
        size: '1536x1024',
        quality: 'high',
      });

      const timestamp = Date.now();
      const filename = `event_${timestamp}.jpg`;
      const filepath = path.join(eventImagesDir, filename);

      // Wide hero crop (16:9) for the occasion landing page background.
      await sharp(resultBuffer)
        .resize(1920, 1080, { fit: 'cover' })
        .jpeg({ quality: 85, progressive: true })
        .toFile(filepath);

      this.logger.log(
        color.green.bold(
          `Event hero image generated and saved: ${color.white.bold(
            filename
          )} (${color.white.bold(formatCostUsd(costUsd))})`
        )
      );

      return filename;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error generating event hero image: ${(error as Error).message}`
        )
      );
      return null;
    }
  }

  /**
   * Translate a text to multiple target locales.
   * @param text The text to translate
   * @param targetLocales Array of locale codes to translate to (e.g. ['nl', 'de'])
   * @returns Promise<Record<string, string>> (locale -> translated text)
   */
  public async translateText(
    text: string,
    targetLocales: string[]
  ): Promise<Record<string, string>> {
    if (!text || !targetLocales || targetLocales.length === 0) return {};
    const translations = await llm.tryJson<Record<string, string>>('textTranslate', {
      messages: [
        {
          role: 'system',
          content: `You are a professional translator who maintains the original tone and style. When translating, preserve the light-hearted, conversational, and natural writing style of the original text. Avoid making translations sound formal or robotic. Keep the same personality and flow in each language. Preserve any emojis and their placement in the translations.`,
        },
        {
          role: 'user',
          content: `Translate the following text into these languages: ${targetLocales
            .map((l) => `${this.translation.getLanguageName(l)} (key "${l}")`)
            .join(', ')}.\n\nReturn each translation under its key.\n\nText:\n${text}`,
        },
      ],
      schema: {
        name: 'translateText',
        schema: {
          type: 'object',
          properties: Object.fromEntries(
            targetLocales.map((locale) => [
              locale,
              {
                type: 'string',
                description: `The translated text in ${this.translation.getLanguageName(locale)}`,
              },
            ])
          ),
          required: targetLocales,
        },
      },
    });
    return translations ?? {};
  }

  /**
   * Splits a long artist or title string into multiple segments, ensuring no segment exceeds 20 characters.
   * The model picks natural breaking points; the caller (data/tracks.ts)
   * checks the lengths and the concatenation and hyphenates when they fail.
   * @param text The text to split (artist or title)
   * @param type The type of text ('artist' or 'title')
   * @returns Promise<string[]> Array of segments, each <= 20 characters
   */
  public async splitArtistOrString(
    text: string,
    type: 'artist' | 'title'
  ): Promise<string[]> {
    const parsed = await llm.tryJson<{ segments?: string[] }>('wordSplit', {
      messages: [
        {
          role: 'system',
          content: `You split a single long word into shorter segments for display. Rules:
1. Every segment MUST be 20 characters or less.
2. Concatenating all segments in order (with no separators) MUST exactly equal the input — do not add, drop, reorder, or change any characters, including case, accents, and umlauts.
3. Use the minimum number of segments needed to satisfy rule 1.
4. Prefer breaks at natural points: syllable boundaries, compound-word boundaries, or between consonant clusters. Aim for roughly balanced segment lengths.
5. Do not add spaces, hyphens, or any other characters between segments.`,
        },
        {
          role: 'user',
          content: `Split this ${type} word into segments following the rules. The input is one long word (not a phrase).

Example input: "Raderbergerboorebürgerspillverein"
Example output segments: ["Raderberger", "boorebürger", "spillverein"]
(concatenated = "Raderbergerboorebürgerspillverein", each ≤ 20 chars)

Input: "${text}"`,
        },
      ],
      schema: {
        name: 'splitText',
        description: `Splits a ${type} string into segments of maximum 20 characters each`,
        schema: {
          type: 'object',
          properties: {
            segments: {
              type: 'array',
              items: {
                type: 'string',
                maxLength: 20,
                description: 'A segment of the text, maximum 20 characters',
              },
              description:
                'Array of text segments, each 20 characters or less',
            },
          },
          required: ['segments'],
        },
      },
    });

    if (!parsed) {
      this.logger.log(
        color.red.bold(
          `No usable split for ${type}: "${color.white.bold(text)}"`
        )
      );
      return [text];
    }
    return parsed.segments || [text];
  }

  /**
   * Extracts an array of order IDs, their order dates (DD-MM-YYYY), and amounts from a pasted HTML string.
   * Uses structured output to enforce the shape.
   * Ignores any "Creditfactuur" that completely negates a "Factuur" (leave both out).
   * @param htmlString The HTML string to extract data from.
   * @returns Promise<{ orders: Array<{ orderId: string, date: string, amount: number }> }>
   */
  public async extractOrders(htmlString: string): Promise<{
    orders: Array<{
      orderId: string;
      date: string;
      amount: number;
    }>;
  }> {
    const prompt = `
Given the following unstructured Dutch HTML/text (copy-pasted from a web page), extract an array of objects with the following fields:
- orderId (string, the order number, called "Opdrachtnummer" in the input)
- date (string, the order date in DD-MM-YYYY format)
- amount (number, the amount, as a float, in euros)

Some lines may refer to a "Factuur" (invoice) and some to a "Creditfactuur" (credit invoice). 
If you notice a "Creditfactuur" that completely negates a "Factuur" (i.e., same orderId/"Opdrachtnummer" and amount, but negative), leave both out of the result.

Return ONLY the structured data as requested, no explanation, no extra text.

HTML:
${htmlString}
`;

    const parsed = await llm.tryJson<{
      orders: Array<{ orderId: string; date: string; amount: number }>;
    }>('orderExtract', {
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that extracts structured data from Dutch HTML order overviews. Ignore any "Creditfactuur" that completely negates a "Factuur" (same orderId/"Opdrachtnummer" and amount, but negative), and leave both out of the result.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      schema: {
        name: 'extractOrders',
        description:
          'Extracts an array of orderIds, order dates, and amounts from HTML. Ignores any Creditfactuur that negates a Factuur (same orderId and amount, but negative).',
        schema: {
          type: 'object',
          properties: {
            orders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  orderId: {
                    type: 'string',
                    description:
                      'The order number (Opdrachtnummer in the input)',
                  },
                  date: {
                    type: 'string',
                    description: 'The order date in DD-MM-YYYY format',
                  },
                  amount: {
                    type: 'number',
                    description: 'The amount in euros',
                  },
                },
                required: ['orderId', 'date', 'amount'],
              },
              description:
                'Array of extracted orders, excluding negated pairs.',
            },
          },
          required: ['orders'],
        },
      },
    });

    if (!parsed) {
      this.logger.log(
        color.red.bold('No usable order extraction from the printer invoice')
      );
      return { orders: [] };
    }
    return { orders: parsed.orders };
  }

  /**
   * Translate email subject and message to target locale
   * @param message - Email message in Dutch
   * @param subject - Email subject in Dutch
   * @param targetLocale - Target locale code (e.g., 'en', 'de', 'fr')
   * @returns Object with translated subject and message
   */
  public async translateMessage(
    message: string,
    subject: string,
    targetLocale: string
  ): Promise<{ subject: string; message: string }> {
    const targetLang = this.translation.getLanguageName(targetLocale);

    try {
      const parsed = await llm.tryJson<{ subject?: string; message?: string }>('mailTranslate', {
        messages: [
          {
            role: 'system',
            content: `You are a professional email translator. Translate both the subject and message from Dutch to ${targetLang}. Maintain a professional tone and preserve line breaks.`,
          },
          {
            role: 'user',
            content: `Subject: ${subject}\n\nMessage: ${message}`,
          },
        ],
        schema: {
          name: 'translate_email',
          description: 'Translate email subject and message to target language',
          schema: {
            type: 'object',
            properties: {
              subject: {
                type: 'string',
                description: 'Translated email subject',
              },
              message: {
                type: 'string',
                description: 'Translated email message with line breaks preserved',
              },
            },
            required: ['subject', 'message'],
          },
        },
      });

      // The originals when there is no usable translation.
      return {
        subject: parsed?.subject || subject,
        message: parsed?.message || message,
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`[AiTasks] Translation error: ${error}`)
      );
      // Return original content if translation fails
      return { subject, message };
    }
  }

  /**
   * Generate quiz questions for tracks in batch.
   * Handles trivia and artist question types via LLM.
   * Year questions are generated locally (no LLM needed).
   * @param tracks Array of { trackId, name, artist, year, type }
   * @returns Array of generated questions with options and correct answers
   */
  private getLanguageName(locale: string): string {
    return this.translation.getLanguageName(locale);
  }

  public async generateQuizQuestions(
    tracks: Array<{
      trackId: number;
      name: string;
      artist: string;
      year: number;
      type: 'year' | 'trivia' | 'artist' | 'missing_word' | 'title';
    }>,
    locale: string = 'en',
    onProgress?: (progress: { step: string; detail: string; questionsGenerated: number }) => void,
  ): Promise<
    Array<{
      trackId: number;
      type: string;
      question: string;
      options: string[] | null;
      correctAnswer: string;
      imageFilename?: string;
    }>
  > {
    const results: Array<{
      trackId: number;
      type: string;
      question: string;
      options: string[] | null;
      correctAnswer: string;
      imageFilename?: string;
    }> = [];

    const languageName = this.getLanguageName(locale);
    this.logger.logDev(
      color.cyan.bold(`[Quiz] Starting question generation for ${tracks.length} tracks in ${languageName} (${locale})`)
    );
    this.logger.logDev(
      color.cyan(`[Quiz] Breakdown: ${tracks.filter((t) => t.type === 'year').length} year, ${tracks.filter((t) => t.type === 'trivia').length} trivia, ${tracks.filter((t) => t.type === 'artist').length} artist, ${tracks.filter((t) => t.type === 'missing_word').length} missing_word, ${tracks.filter((t) => t.type === 'title').length} title`)
    );

    const yearQuestionText = this.translation.translate('quiz.yearQuestion', locale);
    const artistQuestionText = this.translation.translate('quiz.artistQuestion', locale);
    const titleQuestionText = this.translation.translate('quiz.titleQuestion', locale);

    // Handle year questions locally (no LLM)
    const yearTracks = tracks.filter((t) => t.type === 'year');
    onProgress?.({ step: 'year', detail: 'quiz.gen_year', questionsGenerated: results.length });
    for (const track of yearTracks) {
      this.logger.logDev(
        color.cyan(`[Quiz] Year question: "${track.name}" by ${track.artist} → ${track.year}`)
      );
      results.push({
        trackId: track.trackId,
        type: 'year',
        question: yearQuestionText,
        options: null,
        correctAnswer: String(track.year),
      });
    }

    // Handle trivia questions via LLM in batches
    const triviaTracks = tracks.filter((t) => t.type === 'trivia');
    if (triviaTracks.length > 0) {
      const batchSize = 10;
      for (let i = 0; i < triviaTracks.length; i += batchSize) {
        const batch = triviaTracks.slice(i, i + batchSize);

        this.logger.logDev(
          color.blue.bold(
            `[Quiz] Generating trivia questions batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(triviaTracks.length / batchSize)}`
          )
        );

        const tracksPrompt = batch
          .map((t, idx) => `${idx + 1}. "${t.name}" by ${t.artist} (${t.year})`)
          .join('\n');

        this.logger.logDev(
          color.cyan(`[Quiz] Trivia prompt tracks:\n${tracksPrompt}`)
        );

        const parsed = await llm.tryJson<{ questions: any[] }>('quizTrivia', {
          messages: [
            {
              role: 'system',
              content: `You are a fun music quiz master. Generate interesting, entertaining trivia questions about songs. Each question should have 4 options: 1 correct and 3 wrong but plausible. Questions can be about the song's history, lyrics themes, chart performance, cultural impact, album it appeared on, or fun facts. Keep questions accessible and fun. IMPORTANT: Generate all questions and answer options in ${languageName}. However, when referring to specific song lyrics, keep them in their original language — never translate lyrics.`,
            },
            {
              role: 'user',
              content: `Generate a trivia question for each of these songs (respond in ${languageName}):\n${tracksPrompt}`,
            },
          ],
          schema: {
            name: 'generateTriviaQuestions',
            schema: {
              type: 'object',
              properties: {
                questions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: {
                        type: 'integer',
                        description: 'The 1-based index of the song from the list',
                      },
                      question: {
                        type: 'string',
                        description: 'The trivia question about the song',
                      },
                      correctAnswer: {
                        type: 'string',
                        description: 'The correct answer',
                      },
                      wrongOptions: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '3 wrong but plausible options',
                      },
                    },
                    required: ['index', 'question', 'correctAnswer', 'wrongOptions'],
                  },
                },
              },
              required: ['questions'],
            },
          },
        });

        if (parsed) {
          try {
            this.logger.logDev(
              color.cyan(`[Quiz] Trivia batch returned ${parsed.questions?.length || 0} questions`)
            );
            for (const q of parsed.questions) {
              const track = batch[q.index - 1];
              if (track) {
                const allOptions = [q.correctAnswer, ...q.wrongOptions.slice(0, 3)];
                // Shuffle options
                for (let j = allOptions.length - 1; j > 0; j--) {
                  const k = Math.floor(Math.random() * (j + 1));
                  [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
                }
                this.logger.logDev(
                  color.green(`[Quiz] Trivia: "${track.name}" by ${track.artist} → Q: "${q.question}" | Correct: "${q.correctAnswer}" | Options: [${allOptions.join(', ')}]`)
                );
                results.push({
                  trackId: track.trackId,
                  type: 'trivia',
                  question: q.question,
                  options: allOptions,
                  correctAnswer: q.correctAnswer,
                });
              } else {
                this.logger.logDev(
                  color.yellow(`[Quiz] Trivia: skipped question with index ${q.index} (no matching track in batch)`)
                );
              }
            }
          } catch (error) {
            this.logger.log(color.red.bold(`[Quiz] Error parsing trivia response: ${error}`));
          }
        } else {
          this.logger.logDev(
            color.yellow(`[Quiz] Trivia batch returned no structured response`)
          );
        }
        onProgress?.({ step: 'trivia', detail: 'quiz.gen_trivia', questionsGenerated: results.length });
      }
    }

    // Handle artist questions via LLM in batches
    const artistTracks = tracks.filter((t) => t.type === 'artist');
    if (artistTracks.length > 0) {
      const batchSize = 10;
      for (let i = 0; i < artistTracks.length; i += batchSize) {
        const batch = artistTracks.slice(i, i + batchSize);

        this.logger.logDev(
          color.blue.bold(
            `[Quiz] Generating artist alternatives batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(artistTracks.length / batchSize)}`
          )
        );

        const tracksPrompt = batch
          .map((t, idx) => `${idx + 1}. "${t.name}" by ${t.artist} (genre/style context)`)
          .join('\n');

        this.logger.logDev(
          color.cyan(`[Quiz] Artist prompt tracks:\n${tracksPrompt}`)
        );

        const parsed = await llm.tryJson<{ tracks: any[] }>('quizQuestions', {
          messages: [
            {
              role: 'system',
              content: `You are a music expert. For each song, generate 3 alternative artist names that are from the same genre or style as the real artist. The alternatives should be plausible but wrong. Pick artists that listeners might confuse with the real one.`,
            },
            {
              role: 'user',
              content: `For each song, provide 3 alternative artist names (same genre/style, plausible but wrong). Use real artist names, do not translate them:\n${tracksPrompt}`,
            },
          ],
          schema: {
            name: 'generateArtistAlternatives',
            schema: {
              type: 'object',
              properties: {
                tracks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: {
                        type: 'integer',
                        description: 'The 1-based index of the song from the list',
                      },
                      alternatives: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '3 alternative artist names from the same genre/style',
                      },
                    },
                    required: ['index', 'alternatives'],
                  },
                },
              },
              required: ['tracks'],
            },
          },
        });

        if (parsed) {
          try {
            this.logger.logDev(
              color.cyan(`[Quiz] Artist batch returned ${parsed.tracks?.length || 0} items`)
            );
            for (const item of parsed.tracks) {
              const track = batch[item.index - 1];
              if (track) {
                const allOptions = [track.artist, ...item.alternatives.slice(0, 3)];
                // Shuffle options
                for (let j = allOptions.length - 1; j > 0; j--) {
                  const k = Math.floor(Math.random() * (j + 1));
                  [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
                }
                this.logger.logDev(
                  color.green(`[Quiz] Artist: "${track.name}" → Correct: "${track.artist}" | Alternatives: [${item.alternatives.join(', ')}]`)
                );
                results.push({
                  trackId: track.trackId,
                  type: 'artist',
                  question: artistQuestionText,
                  options: allOptions,
                  correctAnswer: track.artist,
                });
              } else {
                this.logger.logDev(
                  color.yellow(`[Quiz] Artist: skipped item with index ${item.index} (no matching track in batch)`)
                );
              }
            }
          } catch (error) {
            this.logger.log(color.red.bold(`[Quiz] Error parsing artist response: ${error}`));
          }
        } else {
          this.logger.logDev(
            color.yellow(`[Quiz] Artist batch returned no structured response`)
          );
        }
        onProgress?.({ step: 'artist', detail: 'quiz.gen_artist', questionsGenerated: results.length });
      }
    }

    // Handle missing_word questions via LLM in batches
    const missingWordTracks = tracks.filter((t) => t.type === 'missing_word');
    if (missingWordTracks.length > 0) {
      const missingWordQuestionText = this.translation.translate('quiz.missingWordQuestion', locale);
      const batchSize = 10;
      for (let i = 0; i < missingWordTracks.length; i += batchSize) {
        const batch = missingWordTracks.slice(i, i + batchSize);

        this.logger.logDev(
          color.blue.bold(
            `[Quiz] Generating missing word questions batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(missingWordTracks.length / batchSize)}`
          )
        );

        const tracksPrompt = batch
          .map((t, idx) => `${idx + 1}. "${t.name}" by ${t.artist}`)
          .join('\n');

        this.logger.logDev(
          color.cyan(`[Quiz] Missing word prompt tracks:\n${tracksPrompt}`)
        );

        const parsed = await llm.tryJson<{ tracks: any[] }>('quizQuestions', {
          messages: [
            {
              role: 'system',
              content: `You are a music quiz designer. For each song title, pick one interesting word to blank out and generate 3 wrong alternatives. The alternatives must be completely different words (not spelling variations!) that could plausibly fit in the same position in the title and still form a believable song title. For example, if the title is "Crazy In Love" and the missing word is "Crazy", good alternatives would be "Lost", "Deep", "Back" — NOT "Craze", "Crazy", "Crazed". IMPORTANT: Never translate song titles or lyrics. Keep the original title as-is and pick a word from the original language. The alternatives should also be in the same language as the original word.`,
            },
            {
              role: 'user',
              content: `For each song title, pick a word to blank out and provide 3 wrong alternatives (different words that could plausibly fit in the title):\n${tracksPrompt}`,
            },
          ],
          schema: {
            name: 'generateMissingWordQuestions',
            schema: {
              type: 'object',
              properties: {
                tracks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: {
                        type: 'integer',
                        description: 'The 1-based index of the song from the list',
                      },
                      missingWord: {
                        type: 'string',
                        description: 'The word that is blanked out from the title',
                      },
                      titleWithBlank: {
                        type: 'string',
                        description: 'The song title with the missing word replaced by _____',
                      },
                      alternatives: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '3 wrong alternatives — different real words that could plausibly fit in the same position in the title',
                      },
                    },
                    required: ['index', 'missingWord', 'titleWithBlank', 'alternatives'],
                  },
                },
              },
              required: ['tracks'],
            },
          },
        });

        if (parsed) {
          try {
            this.logger.logDev(
              color.cyan(`[Quiz] Missing word batch returned ${parsed.tracks?.length || 0} items`)
            );
            for (const item of parsed.tracks) {
              const track = batch[item.index - 1];
              if (track) {
                const allOptions = [item.missingWord, ...item.alternatives.slice(0, 3)];
                // Shuffle options
                for (let j = allOptions.length - 1; j > 0; j--) {
                  const k = Math.floor(Math.random() * (j + 1));
                  [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
                }
                this.logger.logDev(
                  color.green(`[Quiz] Missing word: "${track.name}" → "${item.titleWithBlank}" | Correct: "${item.missingWord}" | Alternatives: [${item.alternatives.join(', ')}]`)
                );
                results.push({
                  trackId: track.trackId,
                  type: 'missing_word',
                  question: `${item.titleWithBlank}\n${missingWordQuestionText}`,
                  options: allOptions,
                  correctAnswer: item.missingWord,
                });
              } else {
                this.logger.logDev(
                  color.yellow(`[Quiz] Missing word: skipped item with index ${item.index} (no matching track in batch)`)
                );
              }
            }
          } catch (error) {
            this.logger.log(color.red.bold(`[Quiz] Error parsing missing word response: ${error}`));
          }
        } else {
          this.logger.logDev(
            color.yellow(`[Quiz] Missing word batch returned no structured response`)
          );
        }
        onProgress?.({ step: 'missingWord', detail: 'quiz.gen_missingWord', questionsGenerated: results.length });
      }
    }

    // Handle title questions via LLM in batches
    const titleTracks = tracks.filter((t) => t.type === 'title');
    if (titleTracks.length > 0) {
      const batchSize = 10;
      for (let i = 0; i < titleTracks.length; i += batchSize) {
        const batch = titleTracks.slice(i, i + batchSize);

        this.logger.logDev(
          color.blue.bold(
            `[Quiz] Generating title alternatives batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(titleTracks.length / batchSize)}`
          )
        );

        const tracksPrompt = batch
          .map((t, idx) => `${idx + 1}. "${t.name}" by ${t.artist} (${t.year})`)
          .join('\n');

        this.logger.logDev(
          color.cyan(`[Quiz] Title prompt tracks:\n${tracksPrompt}`)
        );

        const parsed = await llm.tryJson<{ tracks: any[] }>('quizQuestions', {
          messages: [
            {
              role: 'system',
              content: `You are a music expert. For each song, generate 3 alternative song titles that are plausible but wrong. The alternatives should be real or realistic-sounding song titles from the same genre or era that a player might confuse with the real title. Use real song titles when possible. You can also use well-known phrases or lyrics from the song that people often mistakenly think is the title (e.g. "You Can Be My Bodyguard" for a song actually called "You Can Call Me Al").\n\nCRITICAL LANGUAGE RULE: Song titles MUST stay in their original language. NEVER translate song titles into any other language under any circumstances. If the original song title is in English, all 3 alternatives MUST be in English. If the original is in Spanish, alternatives MUST be in Spanish. The alternatives should match the language of the actual song title, NOT the user's interface language.`,
            },
            {
              role: 'user',
              content: `For each song, provide 3 alternative song titles (same genre/era, plausible but wrong). Use real song titles or well-known lyrics/phrases from the song that are often mistaken for the title. IMPORTANT: keep every alternative in the same language as the original song title — do not translate:\n${tracksPrompt}`,
            },
          ],
          schema: {
            name: 'generateTitleAlternatives',
            schema: {
              type: 'object',
              properties: {
                tracks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: {
                        type: 'integer',
                        description: 'The 1-based index of the song from the list',
                      },
                      alternatives: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '3 alternative song titles from the same genre/era, or well-known lyrics/phrases often mistaken for the title',
                      },
                    },
                    required: ['index', 'alternatives'],
                  },
                },
              },
              required: ['tracks'],
            },
          },
        });

        if (parsed) {
          try {
            this.logger.logDev(
              color.cyan(`[Quiz] Title batch returned ${parsed.tracks?.length || 0} items`)
            );
            for (const item of parsed.tracks) {
              const track = batch[item.index - 1];
              if (track) {
                const allOptions = [track.name, ...item.alternatives.slice(0, 3)];
                // Shuffle options
                for (let j = allOptions.length - 1; j > 0; j--) {
                  const k = Math.floor(Math.random() * (j + 1));
                  [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
                }
                this.logger.logDev(
                  color.green(`[Quiz] Title: "${track.name}" → Alternatives: [${item.alternatives.join(', ')}]`)
                );
                results.push({
                  trackId: track.trackId,
                  type: 'title',
                  question: titleQuestionText,
                  options: allOptions,
                  correctAnswer: track.name,
                });
              } else {
                this.logger.logDev(
                  color.yellow(`[Quiz] Title: skipped item with index ${item.index} (no matching track in batch)`)
                );
              }
            }
          } catch (error) {
            this.logger.log(color.red.bold(`[Quiz] Error parsing title response: ${error}`));
          }
        } else {
          this.logger.logDev(
            color.yellow(`[Quiz] Title batch returned no structured response`)
          );
        }
        onProgress?.({ step: 'title', detail: 'quiz.gen_title', questionsGenerated: results.length });
      }
    }

    this.logger.logDev(
      color.green.bold(`[Quiz] Generated ${results.length} questions for ${tracks.length} tracks`)
    );
    this.logger.logDev(
      color.cyan(`[Quiz] Results breakdown: ${results.filter((r) => r.type === 'year').length} year, ${results.filter((r) => r.type === 'trivia').length} trivia, ${results.filter((r) => r.type === 'artist').length} artist, ${results.filter((r) => r.type === 'missing_word').length} missing_word, ${results.filter((r) => r.type === 'title').length} title`)
    );

    return results;
  }

  /**
   * Regenerate a single quiz question via LLM.
   * @param track Track info
   * @param type Question type
   * @returns Single generated question
   */
  public async regenerateQuizQuestion(
    track: { name: string; artist: string; year: number },
    type: 'year' | 'trivia' | 'artist' | 'missing_word' | 'title',
    locale: string = 'en',
    currentQuestion?: string
  ): Promise<{
    question: string;
    options: string[] | null;
    correctAnswer: string;
  }> {
    const languageName = this.getLanguageName(locale);
    this.logger.logDev(
      color.cyan(`[Quiz] Regenerating ${type} question for "${track.name}" by ${track.artist} (${track.year}) in ${languageName}`)
    );

    if (type === 'year') {
      this.logger.logDev(color.green(`[Quiz] Regenerated year question → ${track.year}`));
      return {
        question: this.translation.translate('quiz.yearQuestion', locale),
        options: null,
        correctAnswer: String(track.year),
      };
    }

    if (type === 'trivia') {
      const parsed = await llm.tryJson<any>('quizTrivia', {
        messages: [
          {
            role: 'system',
            content: `You are a fun music quiz master. Generate an interesting, entertaining trivia question about a song. The question should have 4 options: 1 correct and 3 wrong but plausible. Make it different from common/obvious questions. IMPORTANT: Generate the question and all answer options in ${languageName}.`,
          },
          {
            role: 'user',
            content: `Generate a trivia question about "${track.name}" by ${track.artist} (${track.year}). Respond in ${languageName}.${currentQuestion ? `\n\nIMPORTANT: The previous question was: "${currentQuestion}". Generate a DIFFERENT question — do not repeat or rephrase this.` : ''}`,
          },
        ],
        schema: {
          name: 'generateTriviaQuestion',
          schema: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              correctAnswer: { type: 'string' },
              wrongOptions: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['question', 'correctAnswer', 'wrongOptions'],
          },
        },
      });

      if (parsed) {
        try {
          const allOptions = [parsed.correctAnswer, ...parsed.wrongOptions.slice(0, 3)];
          for (let j = allOptions.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
          }
          this.logger.logDev(
            color.green(`[Quiz] Regenerated trivia: Q: "${parsed.question}" | Correct: "${parsed.correctAnswer}" | Options: [${allOptions.join(', ')}]`)
          );
          return {
            question: parsed.question,
            options: allOptions,
            correctAnswer: parsed.correctAnswer,
          };
        } catch (error) {
          this.logger.log(color.red.bold(`[Quiz] Error regenerating trivia: ${error}`));
        }
      } else {
        this.logger.logDev(color.yellow(`[Quiz] Trivia regeneration returned no structured response`));
      }
    }

    if (type === 'artist') {
      const parsed = await llm.tryJson<any>('quizQuestions', {
        messages: [
          {
            role: 'system',
            content: `You are a music expert. Generate 3 alternative artist names from the same genre/style as the given artist. They should be plausible but wrong.`,
          },
          {
            role: 'user',
            content: `Generate 3 alternative artist names for "${track.name}" by ${track.artist}.${currentQuestion ? `\n\nThe previous question was: "${currentQuestion}". Generate different alternatives than before.` : ''}`,
          },
        ],
        schema: {
          name: 'generateAlternatives',
          schema: {
            type: 'object',
            properties: {
              alternatives: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['alternatives'],
          },
        },
      });

      if (parsed) {
        try {
          const allOptions = [track.artist, ...parsed.alternatives.slice(0, 3)];
          for (let j = allOptions.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
          }
          this.logger.logDev(
            color.green(`[Quiz] Regenerated artist: Correct: "${track.artist}" | Alternatives: [${parsed.alternatives.join(', ')}]`)
          );
          return {
            question: this.translation.translate('quiz.artistQuestion', locale),
            options: allOptions,
            correctAnswer: track.artist,
          };
        } catch (error) {
          this.logger.log(color.red.bold(`[Quiz] Error regenerating artist: ${error}`));
        }
      } else {
        this.logger.logDev(color.yellow(`[Quiz] Artist regeneration returned no structured response`));
      }
    }

    if (type === 'missing_word') {
      const missingWordQuestionText = this.translation.translate('quiz.missingWordQuestion', locale);

      const parsed = await llm.tryJson<any>('quizQuestions', {
        messages: [
          {
            role: 'system',
            content: `You are a music quiz designer. For the given song title, pick one interesting word to blank out and generate 3 wrong alternatives. The alternatives must be completely different words (not spelling variations!) that could plausibly fit in the same position in the title and still form a believable song title. For example, if the missing word is "Crazy", good alternatives would be "Lost", "Deep", "Back" — NOT "Craze", "Crazed", "Crasy". The alternatives should be in the same language as the original word.`,
          },
          {
            role: 'user',
            content: `For the song "${track.name}" by ${track.artist}, pick a word to blank out and provide 3 wrong alternatives (different words that could plausibly fit in the title).${currentQuestion ? `\n\nIMPORTANT: The previous question was: "${currentQuestion}". Pick a DIFFERENT word to blank out this time.` : ''}`,
          },
        ],
        schema: {
          name: 'generateMissingWordQuestion',
          schema: {
            type: 'object',
            properties: {
              missingWord: {
                type: 'string',
                description: 'The word that is blanked out from the title',
              },
              titleWithBlank: {
                type: 'string',
                description: 'The song title with the missing word replaced by _____',
              },
              alternatives: {
                type: 'array',
                items: { type: 'string' },
                description: '3 wrong alternatives — different real words that could plausibly fit in the same position in the title',
              },
            },
            required: ['missingWord', 'titleWithBlank', 'alternatives'],
          },
        },
      });

      if (parsed) {
        try {
          const allOptions = [parsed.missingWord, ...parsed.alternatives.slice(0, 3)];
          for (let j = allOptions.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
          }
          this.logger.logDev(
            color.green(`[Quiz] Regenerated missing word: "${track.name}" → "${parsed.titleWithBlank}" | Correct: "${parsed.missingWord}"`)
          );
          return {
            question: `${parsed.titleWithBlank}\n${missingWordQuestionText}`,
            options: allOptions,
            correctAnswer: parsed.missingWord,
          };
        } catch (error) {
          this.logger.log(color.red.bold(`[Quiz] Error regenerating missing word: ${error}`));
        }
      } else {
        this.logger.logDev(color.yellow(`[Quiz] Missing word regeneration returned no structured response`));
      }
    }

    if (type === 'title') {
      const parsed = await llm.tryJson<any>('quizQuestions', {
        messages: [
          {
            role: 'system',
            content: `You are a music expert. Generate 3 alternative song titles from the same genre or era as the given song. The alternatives should be real or realistic-sounding song titles that a player might confuse with the real title. Use real song titles when possible. You can also use well-known phrases or lyrics from the song that people often mistakenly think is the title (e.g. "You Can Be My Bodyguard" for a song actually called "You Can Call Me Al").\n\nCRITICAL LANGUAGE RULE: Song titles MUST stay in their original language. NEVER translate song titles. If the original is English, alternatives MUST be English. Match the language of the actual song title, not the user's interface language.`,
          },
          {
            role: 'user',
            content: `Generate 3 alternative song titles for "${track.name}" by ${track.artist} (${track.year}). You may use famous lyrics or phrases from the song that are commonly mistaken for the title. Keep every alternative in the same language as the original title — do not translate.${currentQuestion ? `\n\nThe previous question was: "${currentQuestion}". Generate different alternatives than before.` : ''}`,
          },
        ],
        schema: {
          name: 'generateAlternatives',
          schema: {
            type: 'object',
            properties: {
              alternatives: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['alternatives'],
          },
        },
      });

      if (parsed) {
        try {
          const allOptions = [track.name, ...parsed.alternatives.slice(0, 3)];
          for (let j = allOptions.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
          }
          this.logger.logDev(
            color.green(`[Quiz] Regenerated title: Correct: "${track.name}" | Alternatives: [${parsed.alternatives.join(', ')}]`)
          );
          return {
            question: this.translation.translate('quiz.titleQuestion', locale),
            options: allOptions,
            correctAnswer: track.name,
          };
        } catch (error) {
          this.logger.log(color.red.bold(`[Quiz] Error regenerating title: ${error}`));
        }
      } else {
        this.logger.logDev(color.yellow(`[Quiz] Title regeneration returned no structured response`));
      }
    }

    // Fallback
    this.logger.logDev(color.yellow(`[Quiz] Falling back to year question for "${track.name}"`));
    return {
      question: this.translation.translate('quiz.yearQuestion', locale),
      options: null,
      correctAnswer: String(track.year),
    };
  }

  public async generateWrongOptions(
    question: string,
    correctAnswer: string,
    track: { name: string; artist: string },
    locale: string = 'en',
    currentWrongOptions?: string[]
  ): Promise<string[]> {
    const languageName = this.getLanguageName(locale);
    this.logger.logDev(
      color.cyan(`[Quiz] Generating wrong options for "${question}" (correct: "${correctAnswer}") in ${languageName}`)
    );

    const avoidText = currentWrongOptions?.length
      ? `\n\nIMPORTANT: The previous wrong options were: ${currentWrongOptions.map(o => `"${o}"`).join(', ')}. Generate DIFFERENT options — do not reuse any of these.`
      : '';

    const parsed = await llm.tryJson<{ wrongOptions?: string[] }>('quizQuestions', {
      messages: [
        {
          role: 'system',
          content: `You are a music quiz designer. Given a question and the correct answer about a song, generate 3 wrong but plausible answer options. The wrong options should be believable but clearly incorrect. IMPORTANT: Generate all options in ${languageName}.`,
        },
        {
          role: 'user',
          content: `Song: "${track.name}" by ${track.artist}\nQuestion: ${question}\nCorrect answer: ${correctAnswer}\n\nGenerate 3 plausible wrong answers in ${languageName}.${avoidText}`,
        },
      ],
      schema: {
        name: 'generateWrongOptions',
        schema: {
          type: 'object',
          properties: {
            wrongOptions: {
              type: 'array',
              items: { type: 'string' },
              description: '3 plausible but incorrect answer options',
            },
          },
          required: ['wrongOptions'],
        },
      },
    });

    if (parsed) return (parsed.wrongOptions || []).slice(0, 3);
    this.logger.log(color.red.bold('[Quiz] No usable wrong options'));
    return ['Option B', 'Option C', 'Option D'];
  }

  /**
   * Propose a scan-app palette that fits a customer's background image
   * (App Designer "theme from my image"). The image goes in as a data URI;
   * the answer comes back as structured output so it is always the same
   * shape. The customer waits on this button, so the effort is low. Returns
   * null when the model produced nothing usable; the caller falls back to a
   * palette computed from the image itself.
   */
  public async suggestAppPalette(
    imageDataUri: string,
    fontIds: string[]
  ): Promise<{
    backgroundColor: string;
    textColor: string;
    accentColor: string;
    accentTextColor: string;
    buttonStyle: string;
    fontId: string;
    showMusicalNotes: boolean;
    mood: string;
  } | null> {
    try {
      const palette = await llm.tryJson<any>('appPalette', {
        messages: [
          {
            role: 'system',
            content: `You are a brand designer choosing colors for a mobile music game app whose full-screen background is the customer's own image. Pick colors that look intentional against that image and stay readable:
1. backgroundColor: a solid color that matches the image's overall tone; it fills areas the image does not cover and modal backgrounds.
2. textColor: must contrast clearly with the image (WCAG AA against backgroundColor, aim for a contrast ratio of at least 4.5).
3. accentColor: one lively color drawn from or complementary to the image, used for the big round scan button, links and the vinyl center.
4. accentTextColor: readable on accentColor (contrast at least 4.5).
5. buttonStyle: "accent" when solid accent buttons suit the image, "glass" when translucent light buttons suit it better (busy or dark photos).
6. fontId: one id from the allowed list that fits the mood, or "system" for a neutral sans-serif.
7. showMusicalNotes: true only for playful designs where floating music notes would not clash with the image.
8. mood: two or three words describing the look.
Return hex colors with six digits.`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Allowed fontId values: ${fontIds.join(', ')}, system. Choose the palette for this background image.`,
              },
              { type: 'image', dataUri: imageDataUri, detail: 'low' },
            ],
          },
        ],
        schema: {
          name: 'appPalette',
          schema: {
            type: 'object',
            properties: {
              backgroundColor: { type: 'string', description: 'Hex color, e.g. #18565e' },
              textColor: { type: 'string', description: 'Hex color' },
              accentColor: { type: 'string', description: 'Hex color' },
              accentTextColor: { type: 'string', description: 'Hex color' },
              buttonStyle: { type: 'string', enum: ['accent', 'glass'] },
              fontId: { type: 'string' },
              showMusicalNotes: { type: 'boolean' },
              mood: { type: 'string' },
            },
            required: [
              'backgroundColor',
              'textColor',
              'accentColor',
              'accentTextColor',
              'buttonStyle',
              'fontId',
              'showMusicalNotes',
              'mood',
            ],
          },
        },
      });

      if (palette) return palette;
      this.logger.log(
        color.yellow.bold('[AppDesign] No palette in the suggestAppPalette response')
      );
      return null;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `[AppDesign] suggestAppPalette failed: ${error?.message || String(error)}`
        )
      );
      return null;
    }
  }
}
