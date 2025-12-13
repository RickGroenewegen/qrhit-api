import PrismaInstance from './prisma';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import { color } from 'console-log-colors';
import Cache from './cache';
import { ReleaseYearAgent } from './langgraph';
import { DuckDuckGoSearch } from './duckduckgo';

export class Music {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private axiosInstance: AxiosInstance;
  private langgraphAgent = ReleaseYearAgent.getInstance();
  private readonly mbMaxRetries: number = 5;
  private readonly mbMaxRateLimit: number = 1200;
  private readonly discogsMaxRetries: number = 3;
  private readonly discogsMaxRateLimit: number = 1000;
  private cache = Cache.getInstance();
  private mbLastRequestTime: number = 0;
  private discogsLastRequestTime: number = 0;
  private duckDuckGo = DuckDuckGoSearch.getInstance();

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: 'http://musicbrainz.org/ws/2/',
      headers: {
        'User-Agent': 'QRHit/1.0 (info@rickgroenewegen.nl)',
      },
    });
  }

  public async getReleaseDate(
    id: number,
    isrc: string,
    artist: string,
    title: string,
    spotifyReleaseYear: number
  ): Promise<any> {
    // Search MusicBrainz, Discogs, and LangGraph in parallel
    const [mbResult, discogsResult, langgraphResult] = await Promise.all([
      this.searchMusicBrainz(isrc, artist, title),
      this.searchDiscogs(artist, title),
      this.langgraphAgent.research(artist, title),
    ]);

    const langgraphYear = langgraphResult.year;

    // DuckDuckGo search for response data only (not used in weighted calculation)
    const googleResults = await this.duckDuckGo.searchMusicRelease(artist, title);

    // Weights redistributed: LangGraph takes the primary role (previously AI had 0.5)
    const weights = {
      langgraph: 0.78,
      mb: 0.11,
      discogs: 0.11,
    };

    const sources = {
      langgraph: langgraphYear,
      mb: mbResult.year,
      discogs: discogsResult.year,
    };

    // Calculate weighted average of valid years (excluding 0)
    let totalWeight = 0;
    let weightedSum = 0;

    for (const [source, year] of Object.entries(sources)) {
      if (year && year > 0 && year <= new Date().getFullYear()) {
        weightedSum += year * weights[source as keyof typeof weights];
        totalWeight += weights[source as keyof typeof weights];
      }
    }

    let finalYear = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // Calculate standard deviation for valid years (excluding 0)
    const validYears = Object.values(sources).filter(
      (year) => year && year > 0 && year <= new Date().getFullYear()
    );

    let stdDev = 0;
    if (validYears.length > 1) {
      const mean =
        validYears.reduce((sum, year) => sum + year, 0) / validYears.length;
      const squareDiffs = validYears.map((year) => Math.pow(year - mean, 2));
      const avgSquareDiff =
        squareDiffs.reduce((sum, diff) => sum + diff, 0) / squareDiffs.length;
      stdDev = Math.sqrt(avgSquareDiff);
    }

    let standardDeviation = Math.round(stdDev * 100) / 100; // Round to 2 decimal places

    if (standardDeviation > 1) {
      if (
        discogsResult.year == 0 &&
        mbResult.year == 0 &&
        langgraphYear == 0 &&
        spotifyReleaseYear > 0
      ) {
        // Rule 1: If all years except Spotify are 0, use the Spotify year
        finalYear = spotifyReleaseYear;
        standardDeviation = 0;
      }

      // Rule 2: If besides Spotify at least 2 other sources have a valid year (>0),
      // and the Spotify year is the smallest of all valid years (>0), use the Spotify year.
      const nonSpotifyYears = [
        mbResult.year,
        discogsResult.year,
        langgraphYear,
      ];
      const validNonSpotifyYears = nonSpotifyYears.filter(
        (year) => year && year > 0 && year <= new Date().getFullYear()
      );
      const allYears = [spotifyReleaseYear, ...nonSpotifyYears];
      const allValidYears = allYears.filter(
        (year) => year && year > 0 && year <= new Date().getFullYear()
      );

      if (
        validNonSpotifyYears.length >= 2 &&
        spotifyReleaseYear > 0 &&
        allValidYears.length > 0 && // Ensure there are valid years to compare
        spotifyReleaseYear === Math.min(...allValidYears)
      ) {
        finalYear = spotifyReleaseYear;
        standardDeviation = 0;
      }

      // Rule 3: If Spotify year equals LangGraph year, use Spotify year (high confidence match)
      if (
        spotifyReleaseYear > 0 &&
        spotifyReleaseYear == langgraphYear
      ) {
        finalYear = spotifyReleaseYear;
        standardDeviation = 0;
      }

      // Rule 4: If LangGraph year is smaller than Spotify year and valid, use LangGraph year
      // (LangGraph does web research and may find original release dates)
      if (
        langgraphYear > 0 &&
        spotifyReleaseYear > 0 &&
        langgraphYear < spotifyReleaseYear
      ) {
        finalYear = langgraphYear;
        standardDeviation = 0;
      }
    }

    const fullResult = {
      year: finalYear,
      standardDeviation,
      googleResults: JSON.stringify(googleResults),
      sources: {
        spotify: spotifyReleaseYear,
        mb: mbResult.year,
        ai: 0, // Deprecated, kept for backwards compatibility
        openPerplex: 0, // Deprecated, kept for backwards compatibility
        langgraph: langgraphYear,
        discogs: discogsResult.year,
      },
      links: {
        mb: mbResult.link,
        discogs: discogsResult.link,
      },
    };

    this.logger.log(
      color.blue.bold(
        `[SP: ${color.white.bold(spotifyReleaseYear)}] [MB: ${color.white.bold(
          mbResult.year
        )}] [DC: ${color.white.bold(
          discogsResult.year
        )}] [LG: ${color.white.bold(langgraphYear)}] for track ${color.white.bold(artist)} - ${color.white.bold(
          title
        )} [DV: ${color.white.bold(
          fullResult.standardDeviation
        )}] Final year: ${color.white.bold(finalYear)}`
      )
    );

    return fullResult;
  }

  public async searchMusicBrainz(
    isrc: string,
    artist: string,
    title: string
  ): Promise<{ year: number; source: string; link: string }> {
    let apiResult = await this.getReleaseDateFromMusicBrainzAPI(
      isrc,
      artist,
      title,
      'artistAndTitle'
    );

    if (apiResult.year > 0) {
      return { year: apiResult.year, source: 'mb_api_artist_title', link: apiResult.link };
    }

    return { year: 0, source: '', link: '' };
  }

  private async rateLimitDelay(): Promise<void> {
    const timeSinceLastRequest = Date.now() - this.mbLastRequestTime;
    const delay =
      timeSinceLastRequest < this.mbMaxRateLimit
        ? this.mbMaxRateLimit - timeSinceLastRequest
        : 0;

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  public async getReleaseDateFromMusicBrainzAPI(
    isrc: string,
    artist: string,
    title: string,
    mode: string = 'isrc'
  ): Promise<{ year: number; source: string; link: string }> {
    let retryCount = 0;
    while (retryCount < this.mbMaxRetries) {
      await this.rateLimitDelay();
      await this.cache.rateLimit('musicbrainz:rateLimit', this.mbMaxRateLimit);
      try {
        let url = `recording/?query=isrc:${isrc}&fmt=json`;
        if (mode === 'artistAndTitle') {
          url = `recording?query=artist:"${artist}"+AND+recording:"${title}"&fmt=json`;
        }
        const response = await this.axiosInstance.get(url);
        const recordings = response.data.recordings.filter(
          (recording: any) => recording.score >= 95
        );
        let earliestDate: string | null = null;
        let recordingId: string | null = null;

        if (recordings && recordings.length > 0) {
          // Find the recording with the earliest date
          for (const recording of recordings) {
            const releaseDate = recording['first-release-date'] || null;
            if (releaseDate && (!earliestDate || releaseDate < earliestDate)) {
              earliestDate = releaseDate;
              recordingId = recording.id;
            }
          }
        }

        if (!earliestDate) {
          return { year: 0, source: '', link: '' };
        }
        const link = recordingId ? `https://musicbrainz.org/recording/${recordingId}` : '';
        return { year: parseInt(earliestDate.split('-')[0]), source: 'api', link };
      } catch (error: any) {
        this.logger.log(
          color.yellow(
            'Failed to fetch data from MusicBrainz API! Try: ' +
              (retryCount + 1)
          )
        );
        retryCount++;
      }
    }
    return { year: 0, source: '', link: '' };
  }

  private async searchDiscogs(
    artist: string,
    title: string
  ): Promise<{ year: number; source: string; link: string }> {
    let retryCount = 0;
    const discogsToken = process.env['DISCOGS_TOKEN'];

    if (!discogsToken) {
      this.logger.log(
        color.red('Discogs token not found in environment variables')
      );
      return { year: 0, source: '', link: '' };
    }

    while (retryCount < this.discogsMaxRetries) {
      const timeSinceLastRequest = Date.now() - this.discogsLastRequestTime;
      const delay =
        timeSinceLastRequest < this.discogsMaxRateLimit
          ? this.discogsMaxRateLimit - timeSinceLastRequest
          : 0;

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const response = await axios.get(
          'https://api.discogs.com/database/search',
          {
            params: {
              artist: artist,
              track: title,
              type: 'release',
              token: discogsToken,
            },
            headers: {
              'User-Agent': 'QRSong!/1.0 (info@rickgroenewegen.nl)',
            },
          }
        );

        this.discogsLastRequestTime = Date.now();

        if (response.data.results && response.data.results.length > 0) {
          // Find the release with the earliest year
          let earliestYear = Infinity;
          let earliestRelease: any = null;

          for (const release of response.data.results) {
            const year = parseInt(release.year);
            if (!isNaN(year) && year > 0 && year <= new Date().getFullYear() && year < earliestYear) {
              earliestYear = year;
              earliestRelease = release;
            }
          }

          if (earliestRelease) {
            // Discogs returns resource_url like "https://api.discogs.com/releases/123"
            // Convert to user-facing URL: "https://www.discogs.com/release/123"
            const releaseId = earliestRelease.id;
            const link = releaseId ? `https://www.discogs.com/release/${releaseId}` : '';
            return { year: earliestYear, source: 'discogs', link };
          }
        }

        return { year: 0, source: '', link: '' };
      } catch (error: any) {
        this.logger.log(
          color.yellow(
            `Failed to fetch data from Discogs API! Try: ${retryCount + 1}`
          )
        );
        retryCount++;
      }
    }

    return { year: 0, source: '', link: '' };
  }
}
