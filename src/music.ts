import PrismaInstance from './prisma';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import { color } from 'console-log-colors';
import wiki from 'wikipedia';
import { sum } from 'pdf-lib';

export class Music {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private axiosInstance: AxiosInstance;

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
    title: string
  ): Promise<number> {
    console.log(111, isrc, artist, title);

    let year = 0;

    // Step 1: Try to find the year from the ISRC, artist, and title
    const DBYear = await this.findInDB(id, isrc, artist, title);

    if (DBYear.year > 0) {
      return DBYear.year;
    }

    // Try Google search and extract Wikipedia languages
    const googleResults = await this.performGoogleSearch(artist, title);
    const wikiLangs = new Set<string>();
    
    if (Array.isArray(googleResults)) {
      for (const result of googleResults) {
        const wikiMatch = result.url.match(/https?:\/\/([a-z]{2})\.wikipedia\.org/);
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
    const wikiResults = await this.searchWikipedia(Array.from(wikiLangs), artist, title);
    
    // console.log('Wikipedia results:', wikiResults);

    //const musicBrainzResult = await this.searchMusicBrainz(isrc);

    return year;
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
            infobox
          });
        }
      } catch (error) {
        this.logger.log(color.red(`Error in Wikipedia search for ${lang}: ${error}`));
      }
    }
    
    return results;
  }
}
