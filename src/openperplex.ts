import { color, white } from 'console-log-colors';
import Logger from './logger';
import { ChatGPT } from './chatgpt';
import { LLMLayerClient } from 'llmlayer';

export class OpenPerplex {
  private logger = new Logger();
  private chatgpt = new ChatGPT();

  public async ask(artist: string, title: string): Promise<number> {
    let year = 0;
    const prompt = `What is the release date of the song ${title} by ${artist} and provide your source URL. When evaulating a classical song, we are looking for the year of original composition, not the year of release. When it's the theme song of a TV show, we are looking for the year of first airing of the show. `;

    const client = new LLMLayerClient({
      apiKey: process.env['LLM_LAYER_API_KEY'],
    });

    try {
      const response = await client.answer({
        query: prompt,
        model: 'openai/gpt-4o-mini',
        temperature: 0.2,
        answer_type: 'json',
        json_schema: JSON.stringify({
          release_year: { type: 'integer' },
        }),
      });

      let llmData: { release_year?: number } = {};
      if (typeof response.llm_response === 'string') {
        try {
          llmData = JSON.parse(response.llm_response);
        } catch {
          llmData = {};
        }
      } else if (
        typeof response.llm_response === 'object' &&
        response.llm_response !== null
      ) {
        llmData = response.llm_response as { release_year?: number };
      }

      return llmData.release_year ?? 0;
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `Error fetching data from OpenPerplex: ${
            error instanceof Error
              ? color.white.bold(error.message)
              : color.white.bold(String(error))
          }`
        )
      );
      return 0;
    }
  }
}
