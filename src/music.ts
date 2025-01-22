import PrismaInstance from './prisma';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import { color } from 'console-log-colors';
import wiki from 'wikipedia';
import { ChatGPT } from './chatgpt';
import Cache from './cache';
import { OpenPerplex } from './openperplex';

export class Music {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private axiosInstance: AxiosInstance;
  private openai = new ChatGPT();
  private openperplex = new OpenPerplex();
  private readonly mbMaxRetries: number = 5;
  private readonly mbMaxRateLimit: number = 1200;
  private readonly discogsMaxRetries: number = 3;
  private readonly discogsMaxRateLimit: number = 1000;
  private cache = Cache.getInstance();
  private mbLastRequestTime: number = 0;
  private discogsLastRequestTime: number = 0;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: 'http://musicbrainz.org/ws/2/',
      headers: {
        'User-Agent': 'QRHit/1.0 (info@rickgroenewegen.nl)', // Set the custom User-Agent here
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
    // Step 1: Try to find the year from the ISRC, artist, and title
    const DBYear = await this.findInDB(id, isrc, artist, title);

    if (DBYear.year > 0) {
      return DBYear.year;
    }

    // Search MusicBrainz
    const [mbResult, discogsResult, openPerlexYear] = await Promise.all([
      this.searchMusicBrainz(isrc, artist, title),
      this.searchDiscogs(artist, title),
      this.openperplex.ask(artist, title),
    ]);

    // Try Google search and extract Wikipedia languages
    const googleResults = await this.performGoogleSearch(artist, title);
    const wikiLangs = new Set<string>();

    if (Array.isArray(googleResults)) {
      for (const result of googleResults) {
        const wikiMatch = result.url.match(
          /https?:\/\/([a-z]{2})\.wikipedia\.org/
        );
        if (wikiMatch) {
          wikiLangs.add(wikiMatch[1]);
        }
      }
    }

    // Add English as default if no Wikipedia results found
    if (wikiLangs.size === 0) {
      wikiLangs.add('en');
    }

    // Try Wikipedia search in all found languages
    const wikiResults = await this.searchWikipedia(
      Array.from(wikiLangs),
      artist,
      title
    );

    let prompt = `  I have gaterhered information about a certain song on the internet: ${artist} - ${title}
                    Use your own knowledge. I will share all this information with you below. My goal is to find the release year of this song.
                    If the release date is literally found on Wikipedia, I will use that information.
                    
                    What a Google search on the songs artist and title returned:

                    ${JSON.stringify(googleResults)}
                    
                    What I found on Wikipedia:

                     ${JSON.stringify(wikiResults)}

                    MusicBrainz thinks the release year is ${mbResult.year}
                    Discogs thinks the release year is ${discogsResult.year}
                    OpenPerlex (AI scraping) thinks the release year is ${openPerlexYear}

                    What is the release you think of this song based on the information above? Also explain on which information you based your answer on.
                    `;

    const aiResult = await this.openai.ask(prompt);

    const weights = {
      ai: 0.5,
      openPerplex: 0.28,
      mb: 0.11,
      discogs: 0.11,
    };

    const sources = {
      ai: aiResult.year,
      openPerplex: openPerlexYear,
      mb: mbResult.year,
      discogs: discogsResult.year,
    };

    // Calculate weighted average of valid years
    let totalWeight = 0;
    let weightedSum = 0;

    for (const [source, year] of Object.entries(sources)) {
      if (year && year > 0 && year <= new Date().getFullYear()) {
        weightedSum += year * weights[source as keyof typeof weights];
        totalWeight += weights[source as keyof typeof weights];
      }
    }

    const finalYear =
      totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // Calculate standard deviation for valid years
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

    const fullResult = {
      year: finalYear,
      standardDeviation: Math.round(stdDev * 100) / 100, // Round to 2 decimal places
      googleResults: JSON.stringify(googleResults),
      sources: {
        spotify: spotifyReleaseYear,
        mb: mbResult.year,
        ai: aiResult.year,
        openPerplex: openPerlexYear,
        discogs: discogsResult.year,
      },
    };

    this.logger.log(
      color.blue.bold(
        `[SP: ${color.white.bold(spotifyReleaseYear)}] [MB: ${color.white.bold(
          mbResult.year
        )}] [DC: ${color.white.bold(
          discogsResult.year
        )}] [OP: ${color.white.bold(openPerlexYear)}] [AI: ${color.white.bold(
          aiResult.year
        )}] for track ${color.white.bold(artist)} - ${color.white.bold(
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
  ): Promise<{ year: number; source: string }> {
    let result = await this.prisma.isrc.findUnique({
      where: {
        isrc: isrc,
      },
    });
    if (result) {
      return { year: result.year, source: 'mb_isrc' };
    } else {
      let apiResult = await this.getReleaseDateFromMusicBrainzAPI(
        isrc,
        artist,
        title
      );
      if (apiResult.year > 0) {
        return { year: apiResult.year, source: 'mb_api_isrc' };
      }

      apiResult = await this.getReleaseDateFromMusicBrainzAPI(
        isrc,
        artist,
        title,
        'artistAndTitle'
      );

      if (apiResult.year > 0) {
        return { year: apiResult.year, source: 'mb_api_artist_title' };
      }
    }

    return { year: 0, source: '' };
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
  ): Promise<{ year: number; source: string }> {
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
          color.yellow(
            'Failed to fetch data from MusicBrainz API! Try: ' +
              (retryCount + 1)
          )
        );
        retryCount++;
      }
    }
    return { year: 0, source: '' };
  }

  private async findInDB(
    id: number,
    isrc: string,
    artist: string,
    title: string
  ): Promise<{ year: number; source: string }> {
    let year: number = 0;

    // First try finding a track with matching ISRC
    const existingTrackByISRC = await this.prisma.track.findFirst({
      where: {
        isrc: isrc,
        year: {
          not: null,
        },
        manuallyChecked: true,
      },
      select: {
        id: true,
        year: true,
      },
    });

    if (existingTrackByISRC) {
      return { year: existingTrackByISRC.year!, source: 'isrc' };
    }

    const existingTrackByISRCByArtistAndTitle =
      await this.prisma.track.findFirst({
        where: {
          artist: artist,
          name: title,
          year: {
            not: null,
          },
          manuallyChecked: true,
          id: {
            not: id, // Exclude the current track
          },
        },
        select: {
          id: true,
          year: true,
        },
      });

    if (existingTrackByISRCByArtistAndTitle) {
      return {
        year: existingTrackByISRCByArtistAndTitle.year!,
        source: 'existingArtistAndTitle',
      };
    }

    return { year: 0, source: '' };
  }

  private async performGoogleSearch(
    artist: string,
    title: string
  ): Promise<string> {
    try {
      const response = await this.axiosInstance.get(
        'https://real-time-web-search.p.rapidapi.com/search',
        {
          params: {
            q: `"${artist}" - "${title}" (song) wikipedia discogs`,
            limit: 10,
          },
          headers: {
            'x-rapidapi-host': 'real-time-web-search.p.rapidapi.com',
            'x-rapidapi-key': process.env['RAPID_API_KEY'],
          },
        }
      );

      const results = response.data.data;

      return results;
    } catch (error: any) {
      this.logger.log(
        color.red(`Error fetching Google search results: ${error.message}`)
      );
      return '';
    }
  }

  private async searchWikipedia(
    langs: string[],
    artist: string,
    title: string
  ): Promise<any[]> {
    const results = [];

    for (const lang of langs) {
      try {
        await wiki.setLang(lang);
        const searchResults = await wiki.search(`${artist} ${title}`);

        if (searchResults.results.length > 0) {
          const page = await wiki.page(searchResults.results[0].title);
          const summary = (await page.summary()).extract;
          const infobox = await page.infobox();

          results.push({
            lang,
            summary,
            infobox,
          });
        }
      } catch (error) {
        this.logger.log(
          color.red(`Error in Wikipedia search for ${lang}: ${error}`)
        );
      }
    }

    return results;
  }

  private async searchDiscogs(
    artist: string,
    title: string
  ): Promise<{ year: number; source: string }> {
    let retryCount = 0;
    const discogsToken = process.env['DISCOGS_TOKEN'];

    if (!discogsToken) {
      this.logger.log(
        color.red('Discogs token not found in environment variables')
      );
      return { year: 0, source: '' };
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
              q: `${artist} ${title}`,
              type: 'release',
              token: discogsToken,
            },
            headers: {
              'User-Agent': 'QRHit/1.0 (info@rickgroenewegen.nl)',
            },
          }
        );

        this.discogsLastRequestTime = Date.now();

        if (response.data.results && response.data.results.length > 0) {
          // Get all valid years from the results
          const years = response.data.results
            .map((release: any) => parseInt(release.year))
            .filter(
              (year: number) =>
                !isNaN(year) && year > 0 && year <= new Date().getFullYear()
            );

          if (years.length > 0) {
            const earliestYear = Math.min(...years);
            return { year: earliestYear, source: 'discogs' };
          }
        }

        return { year: 0, source: '' };
      } catch (error: any) {
        this.logger.log(
          color.yellow(
            `Failed to fetch data from Discogs API! Try: ${retryCount + 1}`
          )
        );
        retryCount++;
      }
    }

    return { year: 0, source: '' };
  }
}
