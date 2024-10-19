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

  public async ask(prompt: string): Promise<any> {
    let answer = undefined;

    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o',
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
                description: 'The release year of the song',
              },
              reasoning: {
                type: 'string',
                description:
                  'The explanation of how the year was determined (max 100 chars)',
              },
              certainty: {
                type: 'number',
                description:
                  'The certainty in % of how sure you are of the year',
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
        // const promptTokens = result.usage!.prompt_tokens;
        // const completionTokens = result.usage!.completion_tokens;
        // const totalTokens = result.usage!.total_tokens;

        // console.log();

        // console.log(
        //   `Prompt tokens: ${promptTokens} (Cost: $${(
        //     (promptTokens / 1_000_000) *
        //     5
        //   ).toFixed(2)})`
        // );
        // console.log(
        //   `Completion tokens: ${completionTokens} (Cost: $${(
        //     (completionTokens / 1_000_000) *
        //     15
        //   ).toFixed(2)})`
        // );
        // console.log(
        //   `Total tokens: ${totalTokens} (Cost: $${(
        //     (promptTokens / 1_000_000) * 5 +
        //     (completionTokens / 1_000_000) * 15
        //   ).toFixed(2)})`
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
