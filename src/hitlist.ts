import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';
import Utils from './utils';
import Spotify from './spotify';
import { Music } from './music';
import Data from './data';

class Hitlist {
  private static instance: Hitlist;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private music: Music;
  private data = Data.getInstance();

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
      // Check if we have a company list submission hash in the first track
      const submissionHash = hitlist[0]?.submissionHash;
      const companyListId = hitlist[0]?.companyListId;
      const fullname = hitlist[0]?.fullname;
      const email = hitlist[0]?.email;

      if (!submissionHash || !companyListId) {
        return {
          success: false,
          error: 'Missing submission hash or company list ID',
        };
      }

      // Check if there's already a submission with this email for this company list
      if (email) {
        const existingSubmission = await this.prisma.companyListSubmission.findFirst({
          where: {
            companyListId: parseInt(companyListId),
            email: email,
            NOT: {
              hash: submissionHash // Exclude the current submission
            }
          }
        });

        if (existingSubmission) {
          return {
            success: false,
            error: 'You have already submitted a playlist for this company',
          };
        }
      }

      // Find or create the company list submission
      let submission = await this.prisma.companyListSubmission.findUnique({
        where: { hash: submissionHash },
      });

      if (!submission) {
        submission = await this.prisma.companyListSubmission.create({
          data: {
            companyListId: parseInt(companyListId),
            hash: submissionHash,
            status: 'submitted',
            name: fullname || null,
            email: email || null,
          },
        });

        this.logger.log(
          color.green.bold(
            `Created new company list submission with hash ${color.white.bold(
              submissionHash
            )}`
          )
        );
      } else {
        // Update the existing submission with the new status and user info
        submission = await this.prisma.companyListSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'submitted',
            name: fullname || submission.name,
            email: email || submission.email,
          },
        });
      }

      // Extract track IDs from the hitlist
      const trackIds = hitlist.map((track: any) => track.trackId);

      // Use the new getTracksByIds method to get detailed track information
      const spotify = new Spotify();
      const data = Data.getInstance();
      const tracksResult = await spotify.getTracksByIds(trackIds);

      if (tracksResult.success && tracksResult.data) {
        // Array to store newly created track IDs
        const newTrackIds: string[] = [];
        const trackDbIds: Map<string, number> = new Map(); // Map to store trackId -> DB id

        this.logger.log(
          color.blue.bold(
            `Received hitlist with ${color.white.bold(hitlist.length)} tracks`
          )
        );

        // Store tracks in the database
        for (const trackData of tracksResult.data) {
          // Check if track already exists in the database
          let track = await this.prisma.track.findUnique({
            where: { trackId: trackData.trackId },
          });

          const spotifyYear = trackData.releaseDate
            ? parseInt(trackData.releaseDate.substring(0, 4))
            : null;

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
                manuallyChecked: false,
              },
            });

            const youtubeId = await this.data.getYouTubeLink(
              track.artist,
              track.name
            );
            if (youtubeId) {
              await this.prisma.track.update({
                where: { trackId: track.trackId },
                data: { youtubeLink: youtubeId },
              });
            }

            // Add to the list of newly created tracks
            newTrackIds.push(trackData.trackId);
          }

          // Store the DB id for this track
          trackDbIds.set(trackData.trackId, track.id);
        }

        this.logger.log(
          color.blue.bold(
            `Hitlist has ${color.white.bold(newTrackIds.length)} new tracks`
          )
        );

        // If we have new tracks, update their years
        if (newTrackIds.length > 0) {
          await this.data.updateTrackYear(newTrackIds, tracksResult.data);
        }

        // Delete any existing tracks for this submission
        await this.prisma.companyListSubmissionTrack.deleteMany({
          where: {
            companyListSubmissionId: submission.id,
          },
        });

        // Create CompanyListSubmissionTrack entries for each track
        for (const track of hitlist) {
          const trackDbId = trackDbIds.get(track.trackId);

          if (trackDbId) {
            await this.prisma.companyListSubmissionTrack.create({
              data: {
                companyListSubmissionId: submission.id,
                trackId: trackDbId,
                position: track.position,
              },
            });
          }
        }

        this.logger.log(
          color.green.bold(
            `Created ${color.white.bold(
              hitlist.length
            )} submission tracks for submission ${color.white.bold(
              submission.id
            )}`
          )
        );

        return {
          success: true,
        };
      }

      return { success: false, error: 'Failed to get track details' };
    } catch (error) {
      this.logger.log(color.red.bold(`Error submitting hitlist: ${error}`));
      return { success: false, error: 'Error submitting hitlist' };
    }
  }

  public async getCompanyListByDomain(domain: string, hash: string) {
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

      let submissionStatus = 'open';
      
      if (hash && hash.length > 0) {
        // Find the submission with this hash
        const submission = await this.prisma.companyListSubmission.findUnique({
          where: { hash },
        });
        
        if (submission) {
          submissionStatus = submission.status;
        }
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
          submissionStatus: submissionStatus,
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
