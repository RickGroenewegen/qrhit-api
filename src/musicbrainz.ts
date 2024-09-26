import { color } from 'console-log-colors';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import * as xml2js from 'xml2js';
import PrismaInstance from './prisma';
import { ChatGPT } from './chatgpt';

class MusicBrainz {
  private logger = new Logger();
  private lastRequestTime: number = 0;
  private axiosInstance: AxiosInstance;
  private readonly maxRetries: number = 5;
  private readonly maxRateLimit: number = 1200;
  private prisma = PrismaInstance.getInstance();
  private openai = new ChatGPT();

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: 'http://musicbrainz.org/ws/2/',
      headers: {
        'User-Agent': 'QRHit/1.0 (info@rickgroenewegen.nl)', // Set the custom User-Agent here
      },
    });
  }

  private async rateLimitDelay(): Promise<void> {
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    const delay =
      timeSinceLastRequest < this.maxRateLimit
        ? this.maxRateLimit - timeSinceLastRequest
        : 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  public async getReleaseDate(
    isrc: string,
    artist: string,
    title: string
  ): Promise<{ year: number; source: string }> {
    let year = 0;
    let source = '';
    const result = await this.prisma.isrc.findUnique({
      where: {
        isrc: isrc,
      },
    });

    if (result) {
      source = 'database';
      year = result.year;
    } else {
      const result = await this.getReleaseDateFromAPI(isrc);
      if (result.year > 0) {
        year = result.year;
        source = result.source;
      } else {
        const aiResult = await this.openai.ask(
          `${artist} - ${title} - ISRC: ${isrc}`
        );
        year = aiResult;
        source = 'ai';
      }
    }

    return { year, source };
  }

  public async getReleaseDateFromAPI(
    isrc: string
  ): Promise<{ year: number; source: string }> {
    let retryCount = 0;
    while (retryCount < this.maxRetries) {
      await this.rateLimitDelay(); // Ensure that we respect the rate limit
      try {
        const response = await this.axiosInstance.get(
          `recording/?query=isrc:${isrc}&fmt=xml`
        );
        this.lastRequestTime = Date.now(); // Update the time of the last request

        const parsedResult = await xml2js.parseStringPromise(response.data);
        const recordings = parsedResult.metadata['recording-list'][0].recording;

        let earliestDate: string | null = null;

        if (recordings) {
          earliestDate = recordings.reduce(
            (earliest: string | null, recording: any) => {
              const releaseDate = recording['first-release-date']
                ? recording['first-release-date'][0]
                : null;
              return releaseDate && (!earliest || releaseDate < earliest)
                ? releaseDate
                : earliest;
            },
            null
          );
        }

        if (!earliestDate) {
          return { year: 0, source: '' };
        }
        return { year: parseInt(earliestDate.split('-')[0]), source: 'api' }; // Assuming the date format is YYYY-MM-DD
      } catch (error: any) {
        this.logger.log(
          color.red(
            'Failed to fetch data from MusicBrainz API! Try: ' +
              (retryCount + 1)
          )
        );
        this.logger.log(color.red(`Error: ${error.message}`));
        retryCount++;
      }
    }
    return { year: 0, source: '' };
  }
}

export default MusicBrainz;
