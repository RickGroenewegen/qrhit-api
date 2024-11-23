import Utils from './utils';
import axios from 'axios';

export class Perplexity {
  private utils = new Utils();
  private apiKey: string;
  private baseUrl = 'https://api.perplexity.ai';

  constructor() {
    const apiKey = process.env['PERPLEXITY_API_KEY'];
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY environment variable is not defined');
    }
    this.apiKey = apiKey;
  }

  public async ask(artist: string, title: string): Promise<string> {
    try {
      const prompt = `What is the release date of the song "${title}" by ${artist}?`;

      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: 'mixtral-8x7b-instruct',
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        },
        {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      console.error('Error calling Perplexity API:', error);
      throw error;
    }
  }
}
