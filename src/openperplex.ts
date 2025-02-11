import { color } from 'console-log-colors';
import Logger from './logger';
import { ChatGPT } from './chatgpt';
import { OpenperplexSync } from 'openperplex-js';

export class OpenPerplex {
  private logger = new Logger();
  private chatgpt = new ChatGPT();
  private client: OpenperplexSync;

  constructor() {
    const apiKey = process.env['OPENPERPLEX_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'OPENPERPLEX_API_KEY environment variable is not defined'
      );
    }
    this.client = new OpenperplexSync(apiKey);
  }

  public async ask(artist: string, title: string): Promise<number> {
    let year = 0;
    const prompt = `What is the release date of the song ${title} by ${artist} and provide your source URL.`;

    try {
      const result = await this.client.search({
        query: prompt,
        model: 'o3-mini-high',
        date_context: new Date().toISOString(),
        location: 'us',
        response_language: 'en',
        answer_type: 'text',
        search_type: 'general',
        return_citations: false,
        return_sources: true,
        return_images: false,
        recency_filter: 'anytime',
      });

      try {
        // First try direct parsing
        year = parseInt(result.llm_response, 10);

        if (isNaN(year)) {
          // If direct parsing fails, try using ChatGPT to extract the year
          const chatGptResponse = await this.chatgpt.ask(
            `What is the release year according to this text: "${
              result.llm_response
            }". Also provide the source URL. Open perplex provided the following source URL's so pick one:
              ${JSON.stringify(result.sources, null, 2)}
            `
          );

          if (chatGptResponse && chatGptResponse.year) {
            year = chatGptResponse.year;
          } else {
            year = 0;
          }
        }
      } catch (e) {
        year = 0;
      }

      return year;
    } catch (error) {
      if (error.response?.status === 429) {
        this.logger.log(
          color.yellow.bold(
            'Rate limited by OpenPerplex. Trying again in 5 seconds ...'
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return await this.ask(artist, title);
      }
      console.error('Error:', error);
      throw error;
    }
  }
}
