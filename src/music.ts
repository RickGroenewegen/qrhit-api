import PrismaInstance from './prisma';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import { color } from 'console-log-colors';

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

    const googleResult = await this.performGoogleSearch(
      artist,
      title + ' (song)'
    );
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
          params: { q: `${artist} - ${title} (song)`, limit: 10 },
          headers: {
            'x-rapidapi-host': 'real-time-web-search.p.rapidapi.com',
            'x-rapidapi-key': process.env['RAPID_API_KEY'],
          },
        }
      );

      const results = response.data.data;

      let searchResults = '';
      for (const result of results) {
        searchResults += `Title: ${result.title}\nDescription: ${result.snippet}\nLink: ${result.url}\n\n`;
      }

      return searchResults;
    } catch (error: any) {
      this.logger.log(
        color.red(`Error fetching Google search results: ${error.message}`)
      );
      return '';
    }
  }
}
