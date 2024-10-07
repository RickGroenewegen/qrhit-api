import { color } from 'console-log-colors';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
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

    if (false && result) {
      source = 'database';
      //year = result.year;
    } else {
      const result = await this.getReleaseDateFromAPI(isrc);
      if (false && result.year > 0) {
        year = result.year;
        source = result.source;
        // Create a record in the isrc table
        await this.prisma.isrc.create({
          data: {
            isrc: isrc,
            year: year,
          },
        });
      } else {
        const searchResults = await this.performGoogleSearch(artist, title);

        console.log(111, searchResults);

        const aiResult = await this.openai.ask(`${artist} - ${title}`);

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
          `recording/?query=isrc:${isrc}&fmt=json`
        );
        this.lastRequestTime = Date.now(); // Update the time of the last request

        const recordings = response.data.recordings;
        let earliestDate: string | null = null;

        if (recordings && recordings.length > 0) {
          earliestDate = recordings.reduce(
            (earliest: string | null, recording: any) => {
              const releaseDate = recording['first-release-date'] || null;
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
        return { year: parseInt(earliestDate.split('-')[0]), source: 'api' };
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
  private async queryKnowledgeGraph(artist: string, title: string): Promise<string> {
    const apiKey = process.env.GOOGLE_API_KEY;
    const query = `${artist} ${title}`;
    const url = `https://kgsearch.googleapis.com/v1/entities:search?query=${encodeURIComponent(query)}&key=${apiKey}&limit=1&indent=True`;

    try {
      const response = await axios.get(url);
      const elements = response.data.itemListElement;
      const knowledgeGraphInfo = elements.map((element: any) => element.result.description).join('\n');
      return knowledgeGraphInfo;
    } catch (error: any) {
      this.logger.log(color.red(`Error fetching Knowledge Graph data: ${error.message}`));
      return '';
    }
  }
}
export default MusicBrainz;
