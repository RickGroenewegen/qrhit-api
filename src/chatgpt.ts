import Logger from './logger';
import PrismaInstance from './prisma';
import Utils from './utils';
import OpenAI from 'openai';
import { color } from 'console-log-colors';
import Translation from './translation';
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

      console.log(prompt);

      const result = await this.openai.chat.completions.create({
        model: 'o3-mini',
        messages: [
          {
            role: 'system',
            content: `You are a helpful assistant that helps verify song release years. I will provide a list of songs with their years. For each song that you believe has an incorrect year, return the correct year with an explanation and sources. Only suggest different years when you are highly confident.`,
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
  ): Promise<{
    description_en?: string;
    description_nl?: string;
    description_de?: string;
    description_fr?: string;
    description_es?: string;
    description_it?: string;
    description_pt?: string;
    description_pl?: string;
    description_hin?: string;
    description_jp?: string;
    description_cn?: string;
  }> {
    // Limit to 100 random tracks if there are more
    const sampleTracks = this.utils.getRandomSample(tracks, 100);

    const tracksPrompt = sampleTracks
      .map((track) => `"${track.name}" by ${track.artist}`)
      .join('\n');

    const prompt = `Playlist name: "${playlistName}"\n\nSample tracks:\n${tracksPrompt}`;

    this.logger.log(
      color.blue.bold(
        `Generating descriptions for playlist: ${color.white.bold(
          playlistName
        )}`
      )
    );

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `You are a music expert who creates engaging, culturally appropriate playlist descriptions. 
          Based on the playlist name and sample tracks, create a short, compelling description (max 150 words) that captures the essence, mood, and cultural context of the playlist.
          Your descriptions should be engaging, informative, and appropriate for each language's cultural context.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      function_call: { name: 'generateDescriptions' },
      functions: [
        {
          name: 'generateDescriptions',
          parameters: {
            type: 'object',
            properties: {
              description_en: {
                type: 'string',
                description: 'English description (max 150 words)',
              },
              description_nl: {
                type: 'string',
                description: 'Dutch description (max 150 words)',
              },
              description_de: {
                type: 'string',
                description: 'German description (max 150 words)',
              },
              description_fr: {
                type: 'string',
                description: 'French description (max 150 words)',
              },
              description_es: {
                type: 'string',
                description: 'Spanish description (max 150 words)',
              },
              description_it: {
                type: 'string',
                description: 'Italian description (max 150 words)',
              },
              description_pt: {
                type: 'string',
                description: 'Portuguese description (max 150 words)',
              },
              description_pl: {
                type: 'string',
                description: 'Polish description (max 150 words)',
              },
              description_hin: {
                type: 'string',
                description: 'Hindi description (max 150 words)',
              },
              description_jp: {
                type: 'string',
                description: 'Japanese description (max 150 words)',
              },
              description_cn: {
                type: 'string',
                description: 'Chinese description (max 150 words)',
              },
            },
            required: [
              'description_en',
              'description_nl',
              'description_de',
              'description_fr',
              'description_es',
              'description_it',
              'description_pt',
              'description_pl',
              'description_hin',
              'description_jp',
              'description_cn',
            ],
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

  public async ask(prompt: string): Promise<any> {
    let answer = undefined;

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
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

        // console.log();

        // console.log(
        //   `Prompt tokens: ${promptTokens} (Cost: $${(
        //     (promptTokens / 1_000_000) *
        //     0.15
        //   ).toFixed(6)})`
        // );
        // console.log(
        //   `Completion tokens: ${completionTokens} (Cost: $${(
        //     (completionTokens / 1_000_000) *
        //     0.6
        //   ).toFixed(6)})`
        // );
        // console.log(
        //   `Total tokens: ${totalTokens} (Cost: $${(
        //     (promptTokens / 1_000_000) * 0.15 +
        //     (completionTokens / 1_000_000) * 0.6
        //   ).toFixed(6)})`
        // );

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
}
