import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';
import Utils from './utils';
import Spotify from './spotify';
import { Music } from './music';

class Hitlist {
  private static instance: Hitlist;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private music: Music;

  private constructor() {
    this.initDir();
    this.music = new Music();
  }

  public static getInstance(): Hitlist {
    if (!Hitlist.instance) {
      Hitlist.instance = new Hitlist();
    }
    return Hitlist.instance;
  }

  private async initDir(): Promise<void> {
    try {
      const backgroundDir = `${process.env['PUBLIC_DIR']}/companydata`;
      await this.utils.createDir(backgroundDir);
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error initializing company data dir: ${color.white.bold(error)}`
        )
      );
    }
  }

  public async submit(hitlist: any) {
    try {
      console.log(111, hitlist);

      // Extract track IDs from the hitlist
      const trackIds = hitlist.map((track: any) => track.trackId);

      // Use the new getTracksByIds method to get detailed track information
      const spotify = new Spotify();
      const music = new Music();
      const tracksResult = await spotify.getTracksByIds(trackIds);

      if (tracksResult.success && tracksResult.data) {
        // Store tracks in the database
        for (const trackData of tracksResult.data) {
          // Check if track already exists in the database
          let track = await this.prisma.track.findUnique({
            where: { trackId: trackData.trackId }
          });

          const spotifyYear = trackData.releaseDate ? parseInt(trackData.releaseDate.substring(0, 4)) : null;

          if (!track) {
            // Create new track if it doesn't exist
            track = await this.prisma.track.create({
              data: {
                trackId: trackData.trackId,
                name: trackData.name,
                artist: trackData.artist,
                album: trackData.album,
                preview: trackData.preview,
                isrc: trackData.isrc,
                spotifyYear: spotifyYear,
                spotifyLink: trackData.link,
                youtubeLink: '',
                manuallyChecked: false
              }
            });
            
            this.logger.log(color.green.bold(`Created new track: ${trackData.artist} - ${trackData.name}`));
            
            // Get release date information for the track
            const result = await music.getReleaseDate(
              track.id,
              track.isrc ?? '',
              track.artist,
              track.name,
              spotifyYear || 0
            );

            // Update the track with the release date information
            await this.prisma.$executeRaw`
              UPDATE  tracks
              SET     year = ${result.year},
                      spotifyYear = ${result.sources.spotify},
                      discogsYear = ${result.sources.discogs},
                      aiYear = ${result.sources.ai},
                      musicBrainzYear = ${result.sources.mb},
                      openPerplexYear = ${result.sources.openPerplex},
                      googleResults = ${result.googleResults},
                      standardDeviation = ${result.standardDeviation}
              WHERE   id = ${track.id}`;
              
            if (result.standardDeviation <= 1) {
              // If standard deviation is low, mark as manually checked
              await this.prisma.$executeRaw`
                UPDATE  tracks
                SET     manuallyChecked = true
                WHERE   id = ${track.id}`;
                
              this.logger.log(
                color.green.bold(
                  `Determined final year for '${color.white.bold(
                    track.artist
                  )} - ${color.white.bold(track.name)}' with year ${color.white.bold(
                    result.year
                  )}`
                )
              );
            }
          }
        }

        // Combine the detailed track info with the position information
        const enrichedTracks = hitlist.map((track: any) => {
          const detailedTrack = tracksResult.data.find((t: any) => t.trackId === track.trackId);
          return {
            ...track,
            ...detailedTrack,
            // Ensure position is preserved from the original hitlist
            position: track.position
          };
        });
        
        return { success: true, data: enrichedTracks };
      }

      return { success: false, error: 'Failed to get track details' };
    } catch (error) {
      this.logger.log(color.red.bold(`Error submitting hitlist: ${error}`));
      return { success: false, error: 'Error submitting hitlist' };
    }
  }

  public async getCompanyListByDomain(domain: string) {
    try {
      const companyList = await this.prisma.companyList.findFirst({
        where: { domain },
        include: {
          Company: true,
        },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      return {
        success: true,
        data: {
          id: companyList.id,
          name: companyList.name,
          description: companyList.description,
          numberOfTracks: companyList.numberOfTracks,
          companyName: companyList.Company.name,
          background: companyList.background,
          logo: companyList.logo,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting company list: ${error}`));
      return { success: false, error: 'Error getting company list' };
    }
  }

  public async searchTracks(searchString: string) {
    try {
      if (!searchString || searchString.length < 2) {
        return { success: false, error: 'Search string too short' };
      }

      // Use Spotify search instead of database search
      const spotify = new Spotify();
      const spotifyResult = await spotify.searchTracks(searchString);

      if (!spotifyResult.success) {
        return spotifyResult;
      }

      // Transform the Spotify search results to match the expected format
      // Based on the JSON structure from the error, we need to extract data differently
      const tracks = spotifyResult.data?.tracks?.items
        ? spotifyResult.data.tracks.items
            .filter((item: any) => item && item.data && item.data.id) // Filter out any empty data items
            .map((item: any) => {
              const track = item.data;
              const artistName = track.artists?.items?.[0]?.profile?.name || '';
              const trackName = track.name || '';

              return {
                id: track.id,
                trackId: track.id, // Use the Spotify track ID
                name: trackName,
                artist: artistName,
              };
            })
            .filter((track: any) => track.name && track.artist) // Filter out tracks with empty name or artist
        : [];

      return {
        success: true,
        data: tracks,
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error searching tracks: ${error}`));
      return { success: false, error: 'Error searching tracks' };
    }
  }
}

export default Hitlist;
