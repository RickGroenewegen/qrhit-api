import Utils from './utils';
import OpenAI from 'openai';

export class ChatGPT {
  private utils = new Utils();
  private openai = new OpenAI({
    apiKey: process.env['OPENAI_TOKEN'],
  });

  private async parseYear(year: any): Promise<number> {
    return year.year;
  }

  public async ask(prompt: string): Promise<number> {
    let answer = undefined;

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a helpfull assistant that helps me determine the release year of a song based on its ISRC code, title and artist.`,
        },
        {
          role: 'user',
          content:
            `I would like to know the release date for the following song: ` +
            prompt,
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
                description: 'The release year of the song',
              },
            },
            required: ['year'],
          },
        },
      ],
    });

    if (result) {
      if (result.choices[0].message.function_call) {
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
