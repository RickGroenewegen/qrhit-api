import { color, white } from 'console-log-colors';
import Logger from './logger';
import { ChatGPT } from './chatgpt';

export class OpenPerplex {
  private logger = new Logger();
  private chatgpt = new ChatGPT();

  public async ask(artist: string, title: string): Promise<number> {
    let year = 0;
    const prompt = `What is the release date of the song ${title} by ${artist}. Only output the year`;

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

      if (response.status === 429) {
        this.logger.log(
          color.yellow.bold(
            'Rate limited by OpenPerplex. Trying again in 5 seconds ...'
          )
        );

        // Wait 3 seconds and try again
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return await this.ask(artist, title);
      } else if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      try {
        // First try direct parsing
        year = parseInt(data.llm_response, 10);

        if (isNaN(year)) {
          // If direct parsing fails, try using ChatGPT to extract the year
          this.logger.log(
            color.yellow.bold(
              'Failed to parse year directly. Asking ChatGPT to interpret the response...'
            )
          );

          const chatGptResponse = await this.chatgpt.ask(
            `What year is being referred to in this text: "${data.llm_response}"`
          );

          if (chatGptResponse && chatGptResponse.year) {
            year = chatGptResponse.year;
          } else {
            this.logger.log(
              color.yellow.bold(
                'Failed to get year from ChatGPT. Trying again in 5 seconds...'
              )
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return await this.ask(artist, title);
          }
        }

        this.logger.log(
          color.blue.bold(
            `OpenPerplex claims release year for ${color.white.bold(
              title
            )} by ${color.white.bold(artist)} is ${color.white.bold(year)}`
          )
        );
      } catch (e) {}

      return year;
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }
  }
}
