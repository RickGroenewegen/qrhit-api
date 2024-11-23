import Utils from './utils';
import OpenAI from 'openai';

export class Perplexity {
  private utils = new Utils();
  private openai = new OpenAI({
    apiKey: process.env['OPENAI_TOKEN'],
  });

  private async parseYear(year: any): Promise<number> {
    return year;
  }

  public async ask(prompt: string): Promise<any> {
    let answer = '';
    return answer!;
  }
}
