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

  public async getCompanyListBySlug(slug: string) {
    try {
      const companyList = await this.prisma.companyList.findFirst({
        where: { slug },
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

      // Check if this track is already in the submission
      const existingTrack =
        await this.prisma.companyListSubmissionTrack.findFirst({
          where: {
            companyListSubmissionId: submission.id,
            trackId: track.id,
          },
        });

      if (existingTrack) {
        // Update the position if the track already exists
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
}

export default Hitlist;
