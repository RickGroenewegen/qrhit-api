import Logger from './logger';
import PrismaInstance from './prisma';
import Utils from './utils';
import OpenAI from 'openai';
import { color } from 'console-log-colors';
import Translation from './translation';
import { GenreId } from './interfaces/Genre';
import { TrustPilot } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

export class ChatGPT {
  private utils = new Utils();
  private openai = new OpenAI({
    apiKey: process.env['OPENAI_TOKEN'],
  });

  private async parseYear(year: any): Promise<number> {
    return year;
  }

  private prisma = PrismaInstance.getInstance();

  private logger = new Logger();

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

      const result = await this.openai.chat.completions.create({
        model: 'gpt-5',
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
        function_call: { name: 'parseYearMistakes' },
        functions: [
          {
            name: 'parseYearMistakes',
            parameters: {
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
        ],
      });

      if (result?.choices[0]?.message?.function_call) {
        const funcCall = result.choices[0].message.function_call;
        let completionArguments;
        try {
          completionArguments = JSON.parse(funcCall.arguments as string);
        } catch (error) {
          this.logger.log(
            color.red.bold(`Error parsing JSON response: ${error}`)
          );
          this.logger.log(
            color.red.bold(`Raw response: ${funcCall.arguments}`)
          );
          return [];
        }
        const significantMistakes = completionArguments.mistakes.filter(
          (mistake: any) =>
            Math.abs(mistake.suggestedYear - mistake.oldYear) > 2
        );
        allMistakes = allMistakes.concat(significantMistakes);
      }
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

  public async generatePlaylistDescription(
    playlistName: string,
    tracks: Array<{ artist: string; name: string }>,
    languages: string[] = new Translation().allLocales
  ): Promise<Record<string, string>> {
    // Limit to 100 random tracks if there are more
    const sampleTracks = this.utils.getRandomSample(tracks, 100);
    const totalTracks = tracks.length;

    const tracksPrompt = sampleTracks
      .map((track) => `"${track.name}" by ${track.artist}`)
      .join('\n');

    const prompt = `Playlist name: "${playlistName}"\n\nSample tracks:\n${tracksPrompt}`;

    const result = await this.openai.chat.completions.create({
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `  You are a music expert who creates engaging, culturally appropriate playlist descriptions.`,
        },
        {
          role: 'user',
          content: `  Generate a short Spotify playlist description that seamlessly weaves in the playlist’s title and a list of numbers from that playlist. 
                      Keep it casual, engaging, and free of AI jargon. 
                      Make it sound like a real human wrote it.
                      Sometimes mention QRSong! (The name of the service)
                      Keep it concise (2-3 sentences max). 
                      Call the tracks 'tracks' only. Do not use any other terms.
                      Do not mention song titles. You maybe mention artists well known
                      Do not use fancy words or jargon.
                      Avoid disclaimers or explanations of how you wrote it. Just deliver the description.
                      The playlist data is as follows:
                      
                      Number of songs: ${totalTracks}
                      ${prompt}`,
        },
      ],
      function_call: { name: 'generateDescriptions' },
      functions: [
        {
          name: 'generateDescriptions',
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              languages.map((lang) => [
                `description_${lang}`,
                {
                  type: 'string',
                  description: `${lang} description (max 150 words)`,
                },
              ])
            ),
            required: languages.map((lang) => `description_${lang}`),
          },
        },
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      const funcCall = result.choices[0].message.function_call;
      try {
        const descriptions = JSON.parse(funcCall.arguments as string);
        return descriptions;
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error parsing JSON response for descriptions: ${error}`
          )
        );
        this.logger.log(color.red.bold(`Raw response: ${funcCall.arguments}`));
      }
    }

    // Return empty object if something went wrong
    return {};
  }

  public async determineGenre(
    playlistName: string,
    tracks: Array<{ artist: string; name: string }>,
    availableGenres: Array<{ id: number; slug: string | null }>
  ): Promise<number | null> {
    // Limit to 100 random tracks if there are more
    const sampleTracks = this.utils.getRandomSample(tracks, 100);
    const totalTracks = tracks.length;

    const tracksPrompt = sampleTracks
      .map((track) => `"${track.name}" by ${track.artist}`)
      .join('\n');

    const genreOptions = availableGenres
      .map((genre) => `${genre.id}: (${genre.slug})`)
      .join('\n');

    const prompt = `Playlist name: "${playlistName}"\n\nSample tracks (${totalTracks} total):\n${tracksPrompt}`;

    this.logger.log(
      color.blue.bold(
        `Determining genre for playlist: ${color.white.bold(playlistName)}`
      )
    );

    const result = await this.openai.chat.completions.create({
      model: 'o4-mini',
      temperature: 1,
      messages: [
        {
          role: 'system',
          content: `You are a music expert who can accurately categorize playlists into genres.`,
        },
        {
          role: 'user',
          content: `Analyze this playlist and determine which genre it best fits into from the provided list.
                    If the playlist spans multiple genres or doesn't clearly fit any of the available genres, respond with null.
                    Be strict - only assign a genre if there's a clear match.
                    
                    Available genres:
                    ${genreOptions}
                    
                    ${prompt}`,
        },
      ],
      function_call: { name: 'determineGenre' },
      functions: [
        {
          name: 'determineGenre',
          parameters: {
            type: 'object',
            properties: {
              genreId: {
                type: 'integer',
                enum: [GenreId.NoMatch, ...availableGenres.map((g) => g.id)],
                description:
                  'The ID of the matching genre, or 0 if no clear match',
              },
              reasoning: {
                type: 'string',
                description:
                  'Explanation of why this genre was chosen or why no genre was assigned',
              },
            },
            required: ['genreId', 'reasoning'],
          },
        },
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      const funcCall = result.choices[0].message.function_call;
      try {
        const genreResult = JSON.parse(funcCall.arguments as string);

        this.logger.log(
          color.magenta(
            `Genre determination for ${color.white.bold(playlistName)}: ${
              genreResult.genreId !== null
                ? color.white.bold(`ID: ${genreResult.genreId}`)
                : color.white.bold('No clear genre match')
            }`
          )
        );
        this.logger.log(
          color.magenta(`Reasoning: ${color.white(genreResult.reasoning)}`)
        );

        // Convert GenreId.NoMatch (0) to null
        return genreResult.genreId === GenreId.NoMatch
          ? null
          : genreResult.genreId;
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error parsing JSON response for genre determination: ${error}`
          )
        );
        this.logger.log(color.red.bold(`Raw response: ${funcCall.arguments}`));
      }
    }

    // Return null if something went wrong or no clear genre match
    return null;
  }

  /**
   * Translates Trustpilot review titles and messages to all supported locales
   * @param reviews Array of Trustpilot reviews to translate
   * @param targetLocales Array of locale codes to translate to
   * @returns Promise<void>
   */
  public async translateTrustpilotReviews(
    reviews: TrustPilot[],
    targetLocales: string[] = new Translation().allLocales
  ): Promise<void> {
    if (reviews.length === 0) {
      this.logger.log(color.yellow.bold('No reviews to translate'));
      return;
    }

    this.logger.log(
      color.blue.bold(
        `Translating ${color.white.bold(
          reviews.length
        )} Trustpilot reviews to ${color.white.bold(
          targetLocales.length
        )} locales`
      )
    );

    // Process reviews in batches to avoid token limits
    const batchSize = 5;
    for (let i = 0; i < reviews.length; i += batchSize) {
      const batch = reviews.slice(i, i + batchSize);

      this.logger.log(
        color.blue.bold(
          `Processing batch ${color.white.bold(
            Math.floor(i / batchSize) + 1
          )} of ${color.white.bold(Math.ceil(reviews.length / batchSize))}`
        )
      );

      // Create a prompt with all reviews in the batch
      const reviewsPrompt = batch
        .map((review, index) => {
          // Get the locale-specific content or fall back to English
          const locale = review.locale?.split('-')[0].toLowerCase() || 'en';
          const title =
            review[`title_${locale}` as keyof typeof review] || review.title_en;
          const message =
            review[`message_${locale}` as keyof typeof review] ||
            review.message_en;

          return `Review ${index + 1}:\nTitle: ${title}\nMessage: ${message}`;
        })
        .join('\n\n');

      const result = await this.openai.chat.completions.create({
        model: 'o4-mini',
        temperature: 1,
        messages: [
          {
            role: 'system',
            content: `You are a professional translator who specializes in translating customer reviews. 
                      Translate the provided Trustpilot reviews into multiple languages while preserving the 
                      original meaning, tone, and sentiment. Keep translations natural and culturally appropriate.`,
          },
          {
            role: 'user',
            content: `Translate the following Trustpilot reviews into these languages: ${targetLocales.join(
              ', '
            )}.
                      
                      ${reviewsPrompt}`,
          },
        ],
        function_call: { name: 'translateReviews' },
        functions: [
          {
            name: 'translateReviews',
            parameters: {
              type: 'object',
              properties: {
                translations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      reviewIndex: {
                        type: 'integer',
                        description:
                          'The index of the review in the batch (starting from 0)',
                      },
                      translations: {
                        type: 'object',
                        properties: Object.fromEntries(
                          targetLocales.map((locale) => [
                            locale,
                            {
                              type: 'object',
                              properties: {
                                title: {
                                  type: 'string',
                                  description: `The translated title in ${locale}`,
                                },
                                message: {
                                  type: 'string',
                                  description: `The translated message in ${locale}`,
                                },
                              },
                              required: ['title', 'message'],
                            },
                          ])
                        ),
                        required: targetLocales,
                      },
                    },
                    required: ['reviewIndex', 'translations'],
                  },
                },
              },
              required: ['translations'],
            },
          },
        ],
      });

      if (result?.choices[0]?.message?.function_call) {
        const funcCall = result.choices[0].message.function_call;
        try {
          const translationResults = JSON.parse(funcCall.arguments as string);

          // Update each review with translations
          for (const translationResult of translationResults.translations) {
            const reviewIndex = translationResult.reviewIndex;
            const review = batch[reviewIndex];

            // For each locale, update the database with translations
            for (const [locale, translation] of Object.entries(
              translationResult.translations
            )) {
              const localeTranslation = translation as {
                title: string;
                message: string;
              };

              // Create column names based on locale
              const titleColumn = `title_${locale}` as keyof TrustPilot;
              const messageColumn = `message_${locale}` as keyof TrustPilot;

              // Only update if the column exists and doesn't already have content
              if (
                titleColumn in review &&
                messageColumn in review &&
                (!review[titleColumn] || review[titleColumn] === '')
              ) {
                // Update the review with translations
                await this.prisma.trustPilot.update({
                  where: { id: review.id },
                  data: {
                    [titleColumn]: localeTranslation.title,
                    [messageColumn]: localeTranslation.message,
                  } as any,
                });

                this.logger.log(
                  color.green.bold(
                    `Updated translations for review ID ${color.white.bold(
                      review.id
                    )} to ${color.white.bold(locale)}`
                  )
                );
              }
            }
          }
        } catch (error) {
          this.logger.log(
            color.red.bold(`Error parsing translation results: ${error}`)
          );
          console.error(error);
        }
      }

      // Add a delay between batches to avoid rate limits
      if (i + batchSize < reviews.length) {
        this.logger.log(
          color.blue.bold('Waiting before processing next batch...')
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    this.logger.log(
      color.green.bold('Finished translating all Trustpilot reviews')
    );
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
      const result = await this.openai.chat.completions.create({
        model: 'o4-mini',
        temperature: 1,
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
        function_call: { name: 'getGenreTranslations' },
        functions: [
          {
            name: 'getGenreTranslations',
            parameters: {
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
        ],
      });

      if (result?.choices[0]?.message?.function_call) {
        const funcCall = result.choices[0].message.function_call;
        try {
          const translations = JSON.parse(
            funcCall.arguments as string
          ) as Record<string, string>;
          this.logger.log(
            color.green.bold(
              `Successfully translated genre "${color.white.bold(
                genreNameEn
              )}".`
            )
          );
          return translations;
        } catch (error) {
          this.logger.log(
            color.red.bold(
              `Error parsing translation results for genre "${genreNameEn}": ${
                (error as Error).message
              }`
            )
          );
          this.logger.log(
            color.red.bold(`Raw response: ${funcCall.arguments}`)
          );
        }
      } else {
        this.logger.log(
          color.yellow.bold(
            `No translation received from OpenAI for genre "${genreNameEn}". Response: ${JSON.stringify(
              result
            )}`
          )
        );
      }
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
    let answer = undefined;

    const result = await this.openai.chat.completions.create({
      model: 'o4-mini',
      temperature: 1,
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
      function_call: { name: 'parseYear' },
      functions: [
        {
          name: 'parseYear',
          parameters: {
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
      ],
    });

    if (result) {
      if (result.choices[0].message.function_call) {
        // Log the used tokens
        const promptTokens = result.usage!.prompt_tokens;
        const completionTokens = result.usage!.completion_tokens;
        const totalTokens = result.usage!.total_tokens;

        const funcCall = result.choices[0].message.function_call;
        const functionCallName = funcCall.name;
        let completionArguments;
        try {
          completionArguments = JSON.parse(funcCall.arguments as string);
        } catch (error) {
          this.logger.log(
            color.red.bold(`Error parsing JSON response: ${error}`)
          );
          this.logger.log(
            color.red.bold(`Raw response: ${funcCall.arguments}`)
          );
          return { year: 0, reasoning: '', certainty: 0, source: '' };
        }
        if (functionCallName == 'parseYear') {
          answer = await this.parseYear(completionArguments);
        }
      }
    }

    return answer!;
  }

  /**
   * Generate a blog post using AI function calling.
   * @param instruction The instruction for the AI (string)
   * @returns {Promise<{title: string, content: string, summary?: string}>}
   */
  public async askBlog(
    instruction: string
  ): Promise<{ title: string; content: string; summary?: string }> {
    const result = await this.openai.chat.completions.create({
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content: `You are a professional SEO-focused blog writer for QRSong! - a revolutionary music experience service. Here's what QRSong! does:

**Core Service:**
- Converts Spotify playlists into physical QR code cards and digital downloads
- Users scan QR codes with the QRSong! mobile app to instantly play songs in Spotify
- Users have to guess artist, title and release year of the songs
- Creates interactive musical experiences perfect for parties, gifts, and social gatherings

**Key Features & Benefits:**
- Both physical cards (shipped worldwide) and instant digital downloads available
- Enables endless music trivia games: "Name that tune", "Guess the artist", "Identify the genre", "Lyrics challenge", "Music history quiz"
- Perfect for parties, family gatherings, gifts, and adding musical fun to any occasion
- Mobile app available for scanning QR codes with camera permission and push notifications
- Supports multiple languages and international shipping
- Gift card options available
- Custom playlist creation from any Spotify playlist URL
- Curated featured playlists available on the website if you don't have any inspiration
- Professional printing and shipping services on 350g premium paper
- Digital assembly option for immediate use
- Purchasing a physical product includes a free digital download

**Use Cases:**
- Party entertainment and ice breakers
- Good prize for pub quizzes
- Music education and trivia nights
- Unique personalized gifts for music lovers
- Family game nights with musical challenges
- Corporate team building activities
- Wedding entertainment and guest interaction

**SEO REQUIREMENTS - CRITICAL:**
- Write for SEO optimization with target keywords naturally integrated throughout
- Use semantic keywords and related terms to improve topical relevance
- Structure content with clear H2 and H3 headings that include relevant keywords
- Write compelling meta descriptions (summaries) under 160 characters
- Include internal linking opportunities by mentioning QRSong features
- Use long-tail keywords and answer common user questions
- Write content that satisfies search intent and provides comprehensive value
- Include actionable advice and practical information users are searching for
- Use keyword variations and synonyms naturally throughout the text
- Structure content for featured snippets with clear, concise answers
- Write in-depth, authoritative content that establishes expertise
- Include relevant statistics, benefits, and specific use cases
- Use bullet points and numbered lists for better readability and SEO
- Write content that encourages engagement and longer page visits

**INTERNAL LINKING RESTRICTIONS:**
Only use these approved internal links (replace [lang] with appropriate language code):
- /[lang]/generate/playlist (First step in creating your playlist)
- /[lang]/playlists (Featured playlists if you need inspiration)
- /[lang]/giftcard (You can buy and redeem giftcards here)
- /[lang]/examples (Pictures of our product and example PDFs for download)
- /[lang]/pricing (Pricing overview / calculator)
- /[lang]/reviews (All our reviews)
- /[lang]/faq (FAQ)
- /[lang]/onzevibe (QRSong!, but for companies)
- /[lang]/pubquiz (Our music quiz service)
- /[lang]/qr-cards-as-a-service (QR cards as a service)
- /[lang]/contact (Our contact page)
Do NOT link to any other pages or external sites unless specifically requested.

Write in a professional, informative, and engaging style. The tone should be clear and authoritative, but still accessible to a general audience. Avoid overly casual language, slang, and excessive humor. Focus on providing valuable information about the product and its uses. Avoid corporate jargon and AI-sounding phrases. Use a clear structure with varied sentence lengths for readability. Never use em-dashes (—) as they look very AI-generated - use commas, periods, or parentheses instead. Emojis should be used sparingly and only when they add clear value (e.g., 🎵 for music topics). Return a title, summary, and full content in clean HTML format with proper headers (h2, h3), paragraphs, lists, and simple styling.`,
        },
        {
          role: 'user',
          content: instruction,
        },
      ],
      function_call: { name: 'generateBlog' },
      functions: [
        {
          name: 'generateBlog',
          parameters: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description:
                  'The blog post title (keep it short and concise, maximum 8 words). Use sentence case (only capitalize the first word and proper nouns). Make it sound natural and human-written - avoid AI-sounding phrases like "Ultimate Guide", "Comprehensive", "Mastering", "Unlocking", "Revolutionary", or overly promotional language. Use simple, direct language that a real person would use. Include relevant keywords for SEO while maintaining readability.',
              },
              summary: {
                type: 'string',
                description:
                  'A compelling meta description under 160 characters that includes target keywords and encourages clicks. This will be used for SEO purposes.',
              },
              content: {
                type: 'string',
                description:
                  'The blog post content in clean HTML format with headers, paragraphs, lists, and simple styling (do not include h1 tags)',
              },
            },
            required: ['title', 'content'],
          },
        },
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      const funcCall = result.choices[0].message.function_call;
      try {
        const blog = JSON.parse(funcCall.arguments as string);
        return blog;
      } catch (error) {
        this.logger.log(
          color.red.bold(`Error parsing AI blog response: ${error}`)
        );
        this.logger.log(color.red.bold(`Raw response: ${funcCall.arguments}`));
        return { title: '', content: '', summary: '' };
      }
    }
    return { title: '', content: '', summary: '' };
  }

  /**
   * Generate a blog post using AI streaming.
   * @param instruction The instruction for the AI (string)
   * @param onChunk Callback function to handle streaming chunks
   * @returns {Promise<{title: string, content: string, summary?: string}>}
   */
  public async askBlogStream(
    instruction: string,
    onChunk: (chunk: string) => void
  ): Promise<{ title: string; content: string; summary?: string }> {
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-5',
      stream: true,
      messages: [
        {
          role: 'system',
          content: `You are a professional, informative blog writer for QRSong! - a revolutionary music experience service. Here's what QRSong! does:

                    **Core Service:**
                    - Converts Spotify playlists into physical QR code cards and digital downloads
                    - Users scan QR codes with the QRSong! mobile app to instantly play songs in Spotify
                    - Creates interactive musical experiences perfect for parties, gifts, and social gatherings

                    **Key Features & Benefits:**
                    - Both physical cards (shipped worldwide) and instant digital downloads available
                    - Enables endless music trivia games: "Name that tune", "Guess the artist", "Identify the genre", "Lyrics challenge", "Music history quiz"
                    - Perfect for parties, family gatherings, gifts, and adding musical fun to any occasion
                    - Mobile app available for scanning QR codes with camera permission and push notifications
                    - Supports multiple languages and international shipping
                    - Gift card options available
                    - Custom playlist creation from any Spotify playlist URL
                    - Curated featured playlists available on the website
                    - Professional printing and shipping services
                    - Digital assembly option for immediate use

                    **Use Cases:**
                    - Party entertainment and ice breakers
                    - Music education and trivia nights
                    - Unique personalized gifts for music lovers
                    - Family game nights with musical challenges
                    - Corporate team building activities
                    - Wedding entertainment and guest interaction

                    **SEO REQUIREMENTS - CRITICAL:**
                    - Write for SEO optimization with target keywords naturally integrated throughout
                    - Use semantic keywords and related terms to improve topical relevance
                    - Structure content with clear H2 and H3 headings that include relevant keywords
                    - Include internal linking opportunities by mentioning QRSong features
                    - Use long-tail keywords and answer common user questions
                    - Write content that satisfies search intent and provides comprehensive value
                    - Include actionable advice and practical information users are searching for
                    - Use keyword variations and synonyms naturally throughout the text
                    - Structure content for featured snippets with clear, concise answers
                    - Write in-depth, authoritative content that establishes expertise
                    - Include relevant statistics, benefits, and specific use cases
                    - Use bullet points and numbered lists for better readability and SEO
                    - Write content that encourages engagement and longer page visits

                    **INTERNAL LINKING RESTRICTIONS:**
                    Only use these approved internal links (replace [lang] with appropriate language code):
                    - /[lang]/generate/playlist (First step in creating your playlist)
                    - /[lang]/playlists (Featured playlists if you need inspiration)
                    - /[lang]/giftcard (You can buy and redeem giftcards here)
                    - /[lang]/examples (Pictures of our product and example PDFs for download)
                    - /[lang]/pricing (Pricing overview / calculator)
                    - /[lang]/reviews (All our reviews)
                    - /[lang]/faq (FAQ)
                    - /[lang]/onzevibe (QRSong!, but for companies)
                    - /[lang]/contact (Our contact page)
                    Do NOT link to any other pages or external sites unless specifically requested.

                    Write in a professional, informative, and engaging style. Avoid corporate speak, buzzwords, and AI-sounding phrases like "delve into", "unlock", "harness", "seamlessly", "leverage", "cutting-edge", "game-changer", or "revolutionize". 
                    
                    Writing style guidelines:
                    - The tone should be clear and authoritative, but still accessible to a general audience.
                    - Avoid overly casual language, slang, and excessive humor.
                    - Focus on providing valuable information about the product and its uses.
                    - Use a clear structure with varied sentence lengths for readability.
                    - Never use em-dashes (—) as they look very AI-generated. Use commas, periods, or parentheses instead.
                    - Emojis should be used sparingly and only when they add clear value (e.g., 🎵 for music topics).
                    - Sound professional and trustworthy.
                    
                    Generate clean HTML content using proper semantic tags: <h2>, <h3> for headers, <p> for paragraphs, <ul>/<ol> and <li> for lists, <table>, <tr>, <td> for tables. Use simple inline styling where appropriate. Do not include <html>, <head>, or <body> tags - just the content. Do NOT include an <h1> tag for the title as it will be stored separately. Start with an optional summary paragraph, then the full content in HTML using <h2> for main sections.`,
        },
        {
          role: 'user',
          content: instruction,
        },
      ],
    });

    let fullContent = '';

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullContent += content;
        onChunk(content);
      }
    }

    // Parse the streamed HTML content to extract title, summary, and content
    // Since we don't include h1 tags, we need to parse differently
    let title = 'Generated Blog Post';
    let summary = '';
    let content = fullContent.trim();

    // Look for the first paragraph as potential summary
    const firstPMatch = content.match(/<p[^>]*>(.*?)<\/p>/i);
    if (firstPMatch) {
      const potentialSummary = firstPMatch[1].trim();
      // If it's reasonably short, use it as summary
      if (potentialSummary.length < 300) {
        summary = potentialSummary;
        // Remove this paragraph from content
        content = content.replace(/<p[^>]*>.*?<\/p>/i, '').trim();
      }
    }

    return {
      title,
      content: content || fullContent,
      summary: summary || undefined,
    };
  }

  /**
   * Generate a blog image using DALL-E based on image instructions
   * @param imageInstructions Instructions for generating the image
   * @returns Promise<string | null> - Returns filename if successful, null if failed
   */
  public async generateBlogImage(
    imageInstructions: string
  ): Promise<string | null> {
    try {
      // Create blog_images directory if it doesn't exist
      const blogImagesDir = path.join(
        process.env['PUBLIC_DIR']!,
        'blog_images'
      );
      try {
        await fs.access(blogImagesDir);
      } catch {
        await fs.mkdir(blogImagesDir, { recursive: true });
        this.logger.log(
          color.blue.bold(`Created blog images directory: ${blogImagesDir}`)
        );
      }

      // Use the provided image instructions directly
      const imagePrompt = imageInstructions;

      this.logger.log(
        color.blue.bold(
          `Generating blog image with instructions: "${color.white.bold(
            imageInstructions
          )}"`
        )
      );

      const imagePath = path.join(
        process.env['ASSETS_DIR']!,
        'images/cards.png'
      );
      const imageBuffer = await fs.readFile(imagePath);

      // Construct a File object from the buffer (convert to Uint8Array)
      const file = new File([new Uint8Array(imageBuffer)], 'cards.png', {
        type: 'image/png',
      });

      const response = await this.openai.images.edit({
        image: file,
        prompt: imagePrompt,
        n: 1,
        model: 'gpt-image-1',
        size: '1536x1024',
        quality: 'high',
      });

      // const response = await this.openai.images.generate({
      //   model: 'gpt-image-1',
      //   prompt: imagePrompt,
      //   n: 1,
      //   size: '1536x1024',
      //   quality: 'high',
      // });

      if (
        response.data &&
        response.data.length > 0 &&
        response.data[0].b64_json
      ) {
        const imageBuffer = Buffer.from(response.data[0].b64_json, 'base64');

        // Generate filename
        const timestamp = Date.now();
        const filename = `blog_${timestamp}.jpg`;
        const filepath = path.join(blogImagesDir, filename);

        // Compress and optimize the image using Sharp
        await sharp(imageBuffer)
          .jpeg({ quality: 85, progressive: true })
          .resize(1280, 720, { fit: 'cover' })
          .toFile(filepath);

        this.logger.log(
          color.green.bold(
            `Blog image generated and saved: ${color.white.bold(filename)}`
          )
        );

        return filename;
      } else {
        this.logger.log(color.red.bold('No image data received from DALL-E'));
        return null;
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error generating blog image: ${(error as Error).message}`
        )
      );
      return null;
    }
  }

  /**
   * Translate a text to multiple target locales using OpenAI.
   * @param text The text to translate
   * @param targetLocales Array of locale codes to translate to (e.g. ['nl', 'de'])
   * @returns Promise<Record<string, string>> (locale -> translated text)
   */
  public async translateText(
    text: string,
    targetLocales: string[]
  ): Promise<Record<string, string>> {
    if (!text || !targetLocales || targetLocales.length === 0) return {};
    const result = await this.openai.chat.completions.create({
      model: 'gpt-5',
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: `You are a professional translator who maintains the original tone and style. When translating, preserve the light-hearted, conversational, and natural writing style of the original text. Avoid making translations sound formal or robotic. Keep the same personality and flow in each language. Preserve any emojis and their placement in the translations.`,
        },
        {
          role: 'user',
          content: `Translate the following text into these languages: ${targetLocales.join(
            ', '
          )}.\n\nText:\n${text}`,
        },
      ],
      function_call: { name: 'translateText' },
      functions: [
        {
          name: 'translateText',
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              targetLocales.map((locale) => [
                locale,
                {
                  type: 'string',
                  description: `The translated text in ${locale}`,
                },
              ])
            ),
            required: targetLocales,
          },
        },
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      const funcCall = result.choices[0].message.function_call;
      try {
        const translations = JSON.parse(funcCall.arguments as string);
        return translations;
      } catch (error) {
        this.logger.log(
          color.red.bold(`Error parsing translation results for blog: ${error}`)
        );
        this.logger.log(color.red.bold(`Raw response: ${funcCall.arguments}`));
      }
    }
    return {};
  }

  /**
   * Splits a long artist or title string into multiple segments, ensuring no segment exceeds 25 characters.
   * Uses OpenAI function calling to intelligently split the string at natural breaking points.
   * @param text The text to split (artist or title)
   * @param type The type of text ('artist' or 'title')
   * @returns Promise<string[]> Array of segments, each <= 25 characters
   */
  public async splitArtistOrString(
    text: string,
    type: 'artist' | 'title'
  ): Promise<string[]> {
    const result = await this.openai.chat.completions.create({
      model: 'gpt-5',
      temperature: 1,
      messages: [
        {
          role: 'system',
          content: `You are a text processing assistant that splits long strings intelligently. When splitting text, preserve meaning and readability by breaking at natural points like spaces, punctuation, or syllable boundaries. Each segment must be 20 characters or less.`,
        },
        {
          role: 'user',
          content: `Split the following ${type} into segments where each segment is maximum 20 characters. Try to split at natural breaking points (spaces, punctuation, syllables) to maintain readability and preferebly somewhere around the middle:\n\n"${text}"`,
        },
      ],
      function_call: { name: 'splitText' },
      functions: [
        {
          name: 'splitText',
          description: `Splits a ${type} string into segments of maximum 20 characters each`,
          parameters: {
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
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      const funcCall = result.choices[0].message.function_call;
      try {
        const parsed = JSON.parse(funcCall.arguments as string);
        return parsed.segments || [text];
      } catch (e) {
        this.logger.log(
          color.red.bold(
            `Failed to parse splitText JSON from ChatGPT function_call for ${type}: "${text}"`
          )
        );
        return [text];
      }
    } else {
      this.logger.log(
        color.red.bold(
          `No function_call result from ChatGPT for splitText for ${type}: "${text}"`
        )
      );
      return [text];
    }
  }

  /**
   * Extracts an array of order IDs, their order dates (DD-MM-YYYY), and amounts from a pasted HTML string.
   * Uses OpenAI function calling to enforce structured output.
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

    const result = await this.openai.chat.completions.create({
      model: 'gpt-5',
      temperature: 0,
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
      function_call: { name: 'extractOrders' },
      functions: [
        {
          name: 'extractOrders',
          description:
            'Extracts an array of orderIds, order dates, and amounts from HTML. Ignores any Creditfactuur that negates a Factuur (same orderId and amount, but negative).',
          parameters: {
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
      ],
    });

    if (result?.choices[0]?.message?.function_call) {
      const funcCall = result.choices[0].message.function_call;
      try {
        const parsed = JSON.parse(funcCall.arguments as string);
        return { orders: parsed.orders };
      } catch (e) {
        this.logger.log(
          color.red.bold(
            'Failed to parse Orders JSON from ChatGPT function_call'
          )
        );
        return { orders: [] };
      }
    } else {
      this.logger.log(
        color.red.bold(
          'No function_call result from ChatGPT for Orders extraction'
        )
      );
      return { orders: [] };
    }
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
    const localeNames: { [key: string]: string } = {
      en: 'English',
      de: 'German',
      fr: 'French',
      es: 'Spanish',
      it: 'Italian',
      pt: 'Portuguese',
      pl: 'Polish',
      sv: 'Swedish',
      jp: 'Japanese',
      cn: 'Chinese',
      ru: 'Russian',
      hin: 'Hindi',
      nl: 'Dutch',
    };

    const targetLang = localeNames[targetLocale] || 'English';

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
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
        functions: [
          {
            name: 'translate_email',
            description: 'Translate email subject and message to target language',
            parameters: {
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
        ],
        function_call: { name: 'translate_email' },
      });

      const functionCall = response.choices[0]?.message?.function_call;

      if (functionCall && functionCall.arguments) {
        const parsed = JSON.parse(functionCall.arguments);
        return {
          subject: parsed.subject || subject,
          message: parsed.message || message,
        };
      }

      // Fallback if no function call
      return { subject, message };
    } catch (error) {
      this.logger.log(
        color.red.bold(`[ChatGPT] Translation error: ${error}`)
      );
      // Return original content if translation fails
      return { subject, message };
    }
  }
}
