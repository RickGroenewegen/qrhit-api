import Utils from './utils';

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

  public async ask(prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'mixtral-8x7b-instruct',
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Perplexity API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error('Error calling Perplexity API:', error);
      throw error;
    }
  }
}
