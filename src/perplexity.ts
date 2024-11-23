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
          model: 'llama-3.1-sonar-small-128k-online',
          messages: [
            {
              role: 'system',
              content: 'Be precise and concise.'
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
          top_p: 0.9,
          search_domain_filter: ['perplexity.ai'],
          return_images: false,
          return_related_questions: false,
          search_recency_filter: 'month',
          top_k: 0,
          stream: false,
          presence_penalty: 0,
          frequency_penalty: 1
        },
        {
          headers: {
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
