import { PrismaClient } from '@prisma/client';
import Logger from './logger';
import { color } from 'console-log-colors';
import fs from 'fs/promises';
import path from 'path';
import Utils from './utils';

class Account {
  private static instance: Account;
  private prisma = new PrismaClient();
  private logger = new Logger();
  private utils = new Utils();

  private constructor() {}

  public static getInstance(): Account {
    if (!Account.instance) {
      Account.instance = new Account();
    }
    return Account.instance;
  }

  /**
   * Get user data including personal info, ordered playlists, and company lists
   * @param userId The user's ID (string)
   * @returns Object with user data or error
   */
  public async getUserData(userId: string): Promise<{
    success: boolean;
    data?: {
      user: {
        displayName: string;
        email: string;
      };
      playlists: Array<{
        id: number;
        name: string;
        numberOfTracks: number;
        createdAt: Date;
        type: string;
        digitalFilename: string;
        orderId: string;
        trackingLink: string;
      }>;
      companyLists: Array<{
        id: number;
        name: string;
        description: string;
        slug: string;
        status: string;
        startAt: Date | null;
        endAt: Date | null;
        numberOfCards: number;
        numberOfTracks: number;
        minimumNumberOfTracks: number | null;
        numberOfVotes: number;
        numberOfSongsVoted: number;
        votingBackground: string | null;
        votingLogo: string | null;
        qrvote: boolean;
      }>;
    };
    error?: string;
  }> {
    try {
      // Get user information
      const user = await this.prisma.user.findUnique({
        where: { userId },
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      });

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // Get user's ordered playlists through payments
      const payments = await this.prisma.payment.findMany({
        where: { userId: user.id },
        include: {
          PaymentHasPlaylist: {
            include: {
              playlist: {
                select: {
                  id: true,
                  name: true,
                  numberOfTracks: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Transform payments to playlist data
      const playlists = payments.flatMap((payment) =>
        payment.PaymentHasPlaylist.map((php) => ({
          id: php.playlist.id,
          name: php.playlist.name,
          numberOfTracks: php.numberOfTracks,
          createdAt: payment.createdAt,
          type:
            php.type === 'physical' && php.subType === 'sheets'
              ? 'sheets'
              : php.type,
          digitalFilename:
            php.type === 'digital' ? php.filenameDigital || '' : '',
          orderId: payment.orderId || '',
          trackingLink: payment.printApiTrackingLink || '',
        }))
      );

      // Get user's company lists (if user has a company)
      let companyLists: Array<{
        id: number;
        name: string;
        description: string;
        slug: string;
        status: string;
        startAt: Date | null;
        endAt: Date | null;
        numberOfCards: number;
        numberOfTracks: number;
        minimumNumberOfTracks: number | null;
        numberOfVotes: number;
        numberOfSongsVoted: number;
        votingBackground: string | null;
        votingLogo: string | null;
        qrvote: boolean;
      }> = [];

      // Get the user with their companyId
      const userWithCompany = await this.prisma.user.findUnique({
        where: { userId },
        select: {
          companyId: true,
        },
      });

      if (userWithCompany?.companyId) {
        // Find all company lists that belong to the user's company
        const userCompanyLists = await this.prisma.companyList.findMany({
          where: {
            companyId: userWithCompany.companyId,
          },
          select: {
            id: true,
            name: true,
            description_nl: true,
            slug: true,
            status: true,
            startAt: true,
            endAt: true,
            numberOfCards: true,
            numberOfTracks: true,
            minimumNumberOfTracks: true,
            votingBackground: true,
            votingLogo: true,
            qrvote: true,
            _count: {
              select: {
                CompanyListSubmission: {
                  where: {
                    verified: true,
                  },
                },
              },
            },
            CompanyListSubmission: {
              where: {
                verified: true,
              },
              select: {
                CompanyListSubmissionTrack: {
                  select: {
                    trackId: true,
                  },
                },
              },
            },
          },
        });

        companyLists = userCompanyLists.map((list) => {
          // Count unique tracks that have been voted on
          const uniqueTrackIds = new Set();
          list.CompanyListSubmission.forEach((submission) => {
            submission.CompanyListSubmissionTrack.forEach((track) => {
              uniqueTrackIds.add(track.trackId);
            });
          });

          return {
            id: list.id,
            name: list.name,
            description: list.description_nl,
            slug: list.slug,
            status: list.status,
            startAt: list.startAt,
            endAt: list.endAt,
            numberOfCards: list.numberOfCards,
            numberOfTracks: list.numberOfTracks,
            minimumNumberOfTracks: list.minimumNumberOfTracks,
            numberOfVotes: list._count.CompanyListSubmission,
            numberOfSongsVoted: uniqueTrackIds.size,
            votingBackground: list.votingBackground,
            votingLogo: list.votingLogo,
            qrvote: list.qrvote,
          };
        });
      }

      this.logger.log(
        color.blue.bold(
          `Retrieved account overview for user: ${color.white.bold(user.email)}`
        )
      );

      return {
        success: true,
        data: {
          user: {
            displayName: user.displayName,
            email: user.email,
          },
          playlists,
          companyLists,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting user data: ${error}`));
      return { success: false, error: 'Error retrieving user data' };
    }
  }

  /**
   * Update a CompanyList settings
   * @param userId The user's ID
   * @param companyListId The company list ID to update
   * @param updateData The data to update
   * @returns Success status
   */
  public async updateCompanyList(
    userId: string,
    companyListId: number,
    updateData: {
      name: string;
      slug: string;
      description: string;
      startAt: string | null;
      endAt: string | null;
      numberOfTracks: number;
      numberOfCards: number;
      minimumNumberOfTracks: number;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // First, verify the user has permission to update this company list
      const user = await this.prisma.user.findUnique({
        where: { userId },
        select: { id: true, companyId: true },
      });

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (!user.companyId) {
        return { success: false, error: 'User does not belong to a company' };
      }

      // Check if the company list belongs to the user's company
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: companyListId },
        select: { companyId: true },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      if (companyList.companyId !== user.companyId) {
        return { success: false, error: 'Access denied' };
      }

      // Update the company list
      await this.prisma.companyList.update({
        where: { id: companyListId },
        data: {
          name: updateData.name,
          slug: updateData.slug,
          description_nl: updateData.description,
          startAt: updateData.startAt ? new Date(updateData.startAt) : null,
          endAt: updateData.endAt ? new Date(updateData.endAt) : null,
          numberOfTracks: updateData.numberOfTracks,
          numberOfCards: updateData.numberOfCards,
          minimumNumberOfTracks: updateData.minimumNumberOfTracks,
        },
      });

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating CompanyList: ${error}`));
      return { success: false, error: 'Error updating company list' };
    }
  }

  /**
   * Delete a CompanyList
   * @param userId The user's ID
   * @param companyListId The company list ID to delete
   * @returns Success status
   */
  public async deleteCompanyList(
    userId: string,
    companyListId: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // First, verify the user has permission to delete this company list
      const user = await this.prisma.user.findUnique({
        where: { userId },
        select: { id: true, companyId: true },
      });

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (!user.companyId) {
        return { success: false, error: 'User does not belong to a company' };
      }

      // Check if the company list belongs to the user's company
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: companyListId },
        select: { companyId: true },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      if (companyList.companyId !== user.companyId) {
        return { success: false, error: 'Access denied' };
      }

      // Delete related records first (cascade should handle this, but being explicit)
      await this.prisma.companyListSubmission.deleteMany({
        where: { companyListId: companyListId },
      });

      await this.prisma.companyListQuestion.deleteMany({
        where: { companyListId: companyListId },
      });

      // Delete the company list
      await this.prisma.companyList.delete({
        where: { id: companyListId },
      });

      this.logger.log(
        color.green.bold(
          `Deleted CompanyList ID ${companyListId} for user: ${userId}`
        )
      );

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error deleting CompanyList: ${error}`));
      return { success: false, error: 'Error deleting company list' };
    }
  }

  /**
   * Update a CompanyList with image uploads
   * @param userId The user's ID
   * @param companyListId The company list ID to update
   * @param request The Fastify request object containing multipart data
   * @returns Success status and updated data
   */
  public async updateCompanyListWithImages(
    userId: string,
    companyListId: number,
    request: any
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      // First, verify the user has permission to update this company list
      const user = await this.prisma.user.findUnique({
        where: { userId },
        select: { id: true, companyId: true },
      });
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      if (!user.companyId) {
        return { success: false, error: 'User does not belong to a company' };
      }

      // Check if the company list belongs to the user's company
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: companyListId },
        select: { companyId: true, votingBackground: true, votingLogo: true },
      });
      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }
      if (companyList.companyId !== user.companyId) {
        return { success: false, error: 'Access denied' };
      }

      // Prepare update data object
      const updateData: any = {};
      let votingBackgroundFilename = companyList.votingBackground;
      let votingLogoFilename = companyList.votingLogo;

      // Process multipart data from the request
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === 'file') {
          // Process expected image files immediately
          if (part.fieldname === 'votingBackground') {
            const savedFilename = await this.processAndSaveImage(
              part,
              companyListId,
              'votingBackground'
            );
            if (savedFilename !== null) {
              updateData.votingBackground = savedFilename;
              votingBackgroundFilename = savedFilename;
            }
          } else if (part.fieldname === 'votingLogo') {
            const savedFilename = await this.processAndSaveImage(
              part,
              companyListId,
              'votingLogo'
            );
            if (savedFilename !== null) {
              updateData.votingLogo = savedFilename;
              votingLogoFilename = savedFilename;
            }
          } else {
            // Drain any other unexpected file streams
            try {
              await part.toBuffer();
            } catch (drainError) {
              // Continue processing
            }
          }
        } else {
          // Handle regular fields for image removal
          if (part.fieldname === 'votingBackground' && part.value === '') {
            updateData.votingBackground = null;
            votingBackgroundFilename = null;
          } else if (part.fieldname === 'votingLogo' && part.value === '') {
            updateData.votingLogo = null;
            votingLogoFilename = null;
          }
        }
      }

      // Only update if there's something to change
      if (Object.keys(updateData).length > 0) {
        await this.prisma.companyList.update({
          where: { id: companyListId },
          data: updateData,
        });
      }

      return {
        success: true,
        data: {
          votingBackgroundFilename,
          votingLogoFilename,
        },
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error updating CompanyList images: ${error}`)
      );
      return { success: false, error: 'Error updating company list images' };
    }
  }

  /**
   * Process and save an uploaded image file
   * @param fileData The file data object from Fastify multipart
   * @param listId The ID of the company list
   * @param type The type of image ('votingBackground', 'votingLogo')
   * @returns The generated filename or null if error occurred
   */
  private async processAndSaveImage(
    fileData: any,
    listId: number,
    type: 'votingBackground' | 'votingLogo'
  ): Promise<string | null> {
    // Check if fileData exists and has a filename
    if (!fileData || !fileData.filename) {
      this.logger.log(color.yellow.bold(`No file provided for ${type}`));
      return null;
    }

    try {
      const backgroundsDir = path.join(
        process.env['PUBLIC_DIR'] as string,
        'companydata',
        'backgrounds'
      );
      await fs.mkdir(backgroundsDir, { recursive: true });

      // Determine file extension
      const fileExtension =
        path.extname(fileData.filename).toLowerCase() || '.png';

      // Generate unique filename
      const uniqueId = this.utils.generateRandomString(32);
      const actualFilename = `voting_${type}_${listId}_${uniqueId}${fileExtension}`;
      const filePath = path.join(backgroundsDir, actualFilename);

      // Get file buffer
      const buffer = await fileData.toBuffer();

      // Write the file
      await fs.writeFile(filePath, buffer);

      this.logger.log(
        color.green.bold(
          `Voting portal image saved: ${color.white.bold(filePath)}`
        )
      );

      return actualFilename;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error processing/saving voting portal image ${type} for list ${listId}: ${color.white.bold(
            error
          )}`
        )
      );
      return null;
    }
  }
}

export default Account;
