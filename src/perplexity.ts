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
    const prompt = `What is the release date of the song ${title} by ${artist}?`;

    const baseUrl =
      'https://44c57909-d9e2-41cb-9244-9cd4a443cb41.app.bhs.ai.cloud.ovh.net';
    const apiKey = process.env['OPENPERPLEX_API_KEY']; // Replace with your actual API key
    const options = {
      query: prompt,
      date_context: '2024-09-09 7:00PM',
      location: 'us',
      pro_mode: 'false',
      response_language: 'en',
      answer_type: 'text',
      search_type: 'general',
      verbose_mode: 'false',
      return_sources: 'false',
      return_images: 'false',
      return_citations: 'false',
      recency_filter: 'anytime',
    };
    const params = new URLSearchParams(
      Object.fromEntries(
        Object.entries(options).map(([key, value]) => [key, String(value)])
      )
    );

    try {
      if (!apiKey) {
        throw new Error(
          'OPENPERPLEX_API_KEY environment variable is not defined'
        );
      }

      const response = await fetch(`${baseUrl}/search?${params}`, {
        method: 'GET',
        headers: new Headers({
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      console.log('Sources : ', data.sources); // if return sources true
      console.log('IMAGES : ', data.images); // if return images true
      console.log('LLM RESPONSE : ', data.llm_response);
      console.log('Response Time : ', data.response_time);

      return data;
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }
  }
}
