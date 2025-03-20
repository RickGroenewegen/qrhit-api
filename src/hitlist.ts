import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';

class Hitlist {
  private static instance: Hitlist;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): Hitlist {
    if (!Hitlist.instance) {
      Hitlist.instance = new Hitlist();
    }
    return Hitlist.instance;
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

      // Search for tracks that match the search string in name or artist
      const tracks = await this.prisma.track.findMany({
        where: {
          OR: [
            { name: { contains: searchString } },
            { artist: { contains: searchString } },
          ],
        },
        select: {
          id: true,
          trackId: true,
          name: true,
          artist: true,
        },
        take: 10,
        orderBy: [{ name: 'asc' }],
      });

      return {
        success: true,
        data: tracks,
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error searching tracks: ${error}`));
      return { success: false, error: 'Error searching tracks' };
    }
  }

  public async submitTrack(
    trackId: string,
    companyListId: number,
    hash: string,
    position: number
  ) {
    try {
      // Find the track by trackId
      const track = await this.prisma.track.findUnique({
        where: { trackId },
      });

      if (!track) {
        return { success: false, error: 'Track not found' };
      }

      // Check if the company list exists
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: companyListId },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      // Find or create a submission for this hash
      let submission = await this.prisma.companyListSubmission.findUnique({
        where: { hash },
      });

      if (!submission) {
        submission = await this.prisma.companyListSubmission.create({
          data: {
            companyListId,
            hash,
            status: 'open',
          },
        });
      }

      // Check if any track already exists at this position
      const existingPositionTrack =
        await this.prisma.companyListSubmissionTrack.findFirst({
          where: {
            companyListSubmissionId: submission.id,
            position,
          },
        });

      // If a track exists at this position, delete it
      if (existingPositionTrack) {
        await this.prisma.companyListSubmissionTrack.delete({
          where: { id: existingPositionTrack.id },
        });
      }

      // Check if this specific track is already in the submission (at a different position)
      const existingTrack =
        await this.prisma.companyListSubmissionTrack.findFirst({
          where: {
            companyListSubmissionId: submission.id,
            trackId: track.id,
          },
        });

      if (existingTrack) {
        // Update the position if the track exists
        await this.prisma.companyListSubmissionTrack.update({
          where: { id: existingTrack.id },
          data: { position },
        });
      } else {
        // Create a new submission track
        await this.prisma.companyListSubmissionTrack.create({
          data: {
            companyListSubmissionId: submission.id,
            trackId: track.id,
            position,
          },
        });
      }

      return { success: true, data: { submissionId: submission.id } };
    } catch (error) {
      this.logger.log(color.red.bold(`Error submitting track: ${error}`));
      return { success: false, error: 'Error submitting track' };
    }
  }

  public async submitList(companyListSubmissionId: number, hash: string) {
    try {
      // Check if the submission exists and matches the hash
      const submission = await this.prisma.companyListSubmission.findFirst({
        where: {
          id: companyListSubmissionId,
          hash,
        },
      });

      if (!submission) {
        return {
          success: false,
          error: 'Submission not found or hash does not match',
        };
      }

      // Update the submission status to 'submitted'
      await this.prisma.companyListSubmission.update({
        where: { id: companyListSubmissionId },
        data: { status: 'submitted' },
      });

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error submitting list: ${error}`));
      return { success: false, error: 'Error submitting list' };
    }
  }

  public async getTracks(hash: string) {
    try {
      // Find the submission by hash
      const submission = await this.prisma.companyListSubmission.findUnique({
        where: { hash },
        include: {
          CompanyList: true,
        },
      });

      if (!submission) {
        return { success: false, error: 'Submission not found' };
      }

      // Get all tracks for this submission
      const submissionTracks =
        await this.prisma.companyListSubmissionTrack.findMany({
          where: {
            companyListSubmissionId: submission.id,
          },
          include: {
            Track: true,
          },
          orderBy: {
            position: 'asc',
          },
        });

      // Format the tracks for the response
      const tracks = submissionTracks.map((st) => ({
        id: st.Track.id,
        trackId: st.Track.trackId,
        name: st.Track.name,
        artist: st.Track.artist,
        position: st.position,
      }));

      return {
        success: true,
        data: {
          companyList: {
            id: submission.CompanyList.id,
            name: submission.CompanyList.name,
            description: submission.CompanyList.description,
          },
          submission: {
            id: submission.id,
            status: submission.status,
          },
          tracks,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting tracks: ${error}`));
      return { success: false, error: 'Error getting tracks' };
    }
  }

  public async removeTrack(trackId: number, hash: string) {
    try {
      // Find the submission by hash
      const submission = await this.prisma.companyListSubmission.findUnique({
        where: { hash },
      });

      if (!submission) {
        return { success: false, error: 'Submission not found' };
      }

      // Check if the submission is still open
      if (submission.status !== 'open') {
        return {
          success: false,
          error: 'Cannot modify a submission that has already been submitted',
        };
      }

      // Find the track in the submission
      const submissionTrack =
        await this.prisma.companyListSubmissionTrack.findFirst({
          where: {
            companyListSubmissionId: submission.id,
            trackId,
          },
        });

      if (!submissionTrack) {
        return { success: false, error: 'Track not found in this submission' };
      }

      // Get the position of the track to be removed
      const removedPosition = submissionTrack.position;

      // Delete the track from the submission
      await this.prisma.companyListSubmissionTrack.delete({
        where: { id: submissionTrack.id },
      });

      // Find all tracks with higher positions and decrement their positions
      const tracksToUpdate = await this.prisma.companyListSubmissionTrack.findMany({
        where: {
          companyListSubmissionId: submission.id,
          position: {
            gt: removedPosition
          }
        },
        orderBy: {
          position: 'asc'
        }
      });

      // Update the positions of all subsequent tracks
      for (const track of tracksToUpdate) {
        await this.prisma.companyListSubmissionTrack.update({
          where: { id: track.id },
          data: { position: track.position - 1 }
        });
      }

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error removing track: ${error}`));
      return { success: false, error: 'Error removing track' };
    }
  }
}

export default Hitlist;
