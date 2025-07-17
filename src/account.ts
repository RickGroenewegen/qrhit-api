import { PrismaClient } from '@prisma/client';
import Logger from './logger';
import { color } from 'console-log-colors';

class Account {
  private static instance: Account;
  private prisma = new PrismaClient();
  private logger = new Logger();

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
        numberOfVotes: number;
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
        numberOfVotes: number;
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
            _count: {
              select: {
                CompanyListSubmission: {
                  where: {
                    verified: true,
                  },
                },
              },
            },
          },
        });

        companyLists = userCompanyLists.map((list) => ({
          id: list.id,
          name: list.name,
          description: list.description_nl,
          slug: list.slug,
          status: list.status,
          startAt: list.startAt,
          endAt: list.endAt,
          numberOfVotes: list._count.CompanyListSubmission,
        }));
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
}

export default Account;
