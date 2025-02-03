import PrismaInstance from './prisma';
import Utils from './utils';
import OpenAI from 'openai';

export class ChatGPT {
  private utils = new Utils();
  private openai = new OpenAI({
    apiKey: process.env['OPENAI_TOKEN'],
  });

  private async parseYear(year: any): Promise<number> {
    return year;
  }

  private prisma = PrismaInstance.getInstance();

  public async verifyList(playlistId: string): Promise<
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

    // Format tracks into verification prompt
    const tracksPrompt = tracks
      .map((track) => `"${track.name}" by ${track.artist} (${track.year})`)
      .join('\n');

    const prompt = `Please verify the release years for these songs:\n${tracksPrompt}`;

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
      const completionArguments = JSON.parse(funcCall.arguments as string);
      
      // Create user suggestions for each mistake
      for (const mistake of completionArguments.mistakes) {
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
            1,
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

      return completionArguments.mistakes;
    }

    return [];
  }

  public async ask(prompt: string): Promise<any> {
    let answer = undefined;

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a helpfull assistant that helps me determine the release year of a song based on its title and artist. I am sure the artist and title are provided are correct. So do not talk about other songs or artists. If you are not sure about the release year, please let me know.`,
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
        const completionArguments = JSON.parse(funcCall.arguments as string);
        if (functionCallName == 'parseYear') {
          answer = await this.parseYear(completionArguments);
        }
      }
    }

    return answer!;
  }
}
