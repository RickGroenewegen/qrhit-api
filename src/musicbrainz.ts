import { color } from 'console-log-colors';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import * as xml2js from 'xml2js';
import { PrismaClient } from '@prisma/client';

class MusicBrainz {
  private logger = new Logger();
  private lastRequestTime: number = 0;
  private axiosInstance: AxiosInstance;
  private readonly maxRetries: number = 5;
  private readonly maxRateLimit: number = 1200;
  private prisma = new PrismaClient();

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

  public async getReleaseDate(isrc: string): Promise<number> {
    let year = 0;
    const result = await this.prisma.isrc.findUnique({
      where: {
        isrc: isrc,
      },
    });

    if (result) {
      year = result.year;
    } else {
      year = await this.getReleaseDateFromAPI(isrc);
    }

    return year;
  }

  public async getReleaseDateFromAPI(isrc: string): Promise<number> {
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
          return 0;
        }
        return parseInt(earliestDate.split('-')[0]); // Assuming the date format is YYYY-MM-DD
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
    return 0;
  }
}

export default MusicBrainz;
