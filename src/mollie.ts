import { ApiResult } from './interfaces/ApiResult';
import { createMollieClient } from '@mollie/api-client';
import { PrismaClient } from '@prisma/client';
import { color } from 'console-log-colors';
import Logger from './logger';

class Mollie {
  private prisma = new PrismaClient();
  private logger = new Logger();

  private mollieClient = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY']!,
  });

  public async getPaymentUri(params: any): Promise<ApiResult> {
    try {
      const payment = await this.mollieClient.payments.create({
        amount: {
          currency: 'EUR',
          value: '10.00',
        },
        description: 'Spotify QR Codes for playlist',
        redirectUrl: `${process.env['FRONTEND_URI']}/?newState=CHECK_PAYMENT`,
        webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
      });

      let userDatabaseId = 0;
      let playlistDatabaseId = 0;

      // Check if the user exists. If not, create it
      const user = await this.prisma.user.findUnique({
        where: {
          userId: params.user.userId,
        },
      });

      if (!user) {
        // create the user
        const userCreate = await this.prisma.user.create({
          data: {
            userId: params.user.userId,
            email: params.user.email,
            displayName: params.user.displayName,
          },
        });
        userDatabaseId = userCreate.id;
      } else {
        userDatabaseId = user.id;
      }

      // Check if the playlist exists. If not, create it
      const playlist = await this.prisma.playlist.findUnique({
        where: {
          playlistId: params.playlist.id,
        },
      });

      if (!playlist) {
        // create the playlist
        const playlistCreate = await this.prisma.playlist.create({
          data: {
            playlistId: params.playlist.id,
            name: params.playlist.name,
          },
        });
        playlistDatabaseId = playlistCreate.id;
      } else {
        playlistDatabaseId = playlist.id;
      }

      // Check if there is a user_has_playlist entry. If not, create it
      const userHasPlaylist = await this.prisma.userHasPlaylist.findFirst({
        where: {
          userId: userDatabaseId, // ID of the user
          playlistId: playlistDatabaseId, // ID of the playlist
        },
      });

      if (!userHasPlaylist) {
        // create the user_has_playlist entry
        await this.prisma.userHasPlaylist.create({
          data: {
            userId: userDatabaseId, // ID of the user
            playlistId: playlistDatabaseId, // ID of the playlist
          },
        });
      }

      // Check if the tracks exist. If not, create them
      for (const track of params.tracks) {
        const trackDatabase = await this.prisma.track.findUnique({
          where: {
            trackId: track.id,
          },
        });

        let trackDatabaseId = 0;

        if (!trackDatabase) {
          // create the track
          const trackCreate = await this.prisma.track.create({
            data: {
              trackId: track.id,
              name: track.name,
              artist: track.artist,
              isrc: track.isrc,
            },
          });
          trackDatabaseId = trackCreate.id;
        } else {
          trackDatabaseId = trackDatabase.id;
        }

        // Check if there is a playlist_has_track entry. If not, create it
        const playlistHasTrack = await this.prisma.playlistHasTrack.findFirst({
          where: {
            playlistId: playlistDatabaseId, // ID of the playlist
            trackId: trackDatabaseId, // ID of the track
          },
        });

        if (!playlistHasTrack) {
          // create the playlist_has_track entry
          await this.prisma.playlistHasTrack.create({
            data: {
              playlistId: playlistDatabaseId, // ID of the playlist
              trackId: trackDatabaseId, // ID of the track
            },
          });
        }
      }

      // Create the payment in the database
      await this.prisma.payment.create({
        data: {
          paymentId: payment.id,
          userId: userDatabaseId,
          playlistId: playlistDatabaseId,
          amount: parseFloat(payment.amount.value),
          status: payment.status,
        },
      });

      return {
        success: true,
        data: {
          paymentId: payment.id,
          paymentUri: payment.getCheckoutUrl(),
        },
      };
    } catch (e) {
      return {
        success: false,
        error: 'Failed to create payment',
      };
    }
  }

  public async processWebhook(params: any): Promise<ApiResult> {
    if (params.id) {
      const payment = await this.mollieClient.payments.get(params.id);

      this.logger.log(
        color.blue.bold('Processed webhook for payment: ') +
          color.bold.white(payment.id) +
          color.blue.bold(' with status: ') +
          color.bold.white(payment.status)
      );

      try {
        // Update the payment in the database
        await this.prisma.payment.update({
          where: {
            paymentId: payment.id,
          },
          data: {
            status: payment.status,
          },
        });
      } catch (e) {
        this.logger.log(
          color.red.bold('Failed to update payment in database: ') +
            color.white.bold(payment.id)
        );
        return {
          success: false,
          error: 'Failed to update payment',
        };
      }
    }
    return {
      success: true,
    };
  }

  public async checkPaymentStatus(paymentId: string): Promise<ApiResult> {
    // Get the payment from the database
    const payment = await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
    });

    if (payment && payment.status == 'paid') {
      return {
        success: true,
        data: {
          status: payment.status,
        },
      };
    } else {
      return {
        success: false,
        error: 'Not paid yet',
      };
    }
  }
}

export default Mollie;
