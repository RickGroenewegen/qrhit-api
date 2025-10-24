import PrismaInstance from './prisma';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import Mail from './mail';
import { CronJob } from 'cron';
import Utils from './utils';
import cluster from 'cluster';
import Cache from './cache';

class Review {
  private static instance: Review;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private mail = Mail.getInstance();
  private utils = new Utils();
  private cache = Cache.getInstance();

  private constructor() {
    // Schedule review emails to run every hour
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] != 'development') {
          // Cron job to process playback counts and mark eligible payments
          // Runs every hour at minute :00
          new CronJob(
            '0 * * * *',
            async () => {
              await this.processPlaybackCounts();
            },
            null,
            true
          );

          // Cron job to send review emails (runs 5 minutes after playback counts)
          new CronJob(
            '5 * * * *',
            async () => {
              await this.processReviewEmails();
            },
            null,
            true
          );
        }
      });
    }
  }

  public static getInstance(): Review {
    if (!Review.instance) {
      Review.instance = new Review();
    }
    return Review.instance;
  }

  public async checkReview(paymentId: string) {
    this.logger.log(
      color.blue.bold(
        `Checking review status for payment ${white.bold(paymentId)}`
      )
    );

    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
      include: {
        PaymentHasPlaylist: {
          include: {
            playlist: true,
          },
        },
        Review: true,
      },
    });

    if (!payment) {
      return {
        success: false,
        error: 'notFound',
      };
    }

    // Check if already reviewed
    if (
      payment.Review.length > 0 &&
      process.env['ENVIRONMENT'] != 'development'
    ) {
      return {
        success: false,
        error: 'alreadyReviewed',
      };
    }

    return {
      success: true,
      data: {
        canReview: true,
      },
    };
  }

  public async createReview(paymentId: string, rating: number, review: string) {
    this.logger.log(
      color.blue.bold(`Creating review for payment ${white.bold(paymentId)}`)
    );

    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
      include: {
        Review: true,
        PaymentHasPlaylist: {
          include: {
            playlist: true,
          },
        },
      },
    });

    if (!payment) {
      return {
        success: false,
        error: 'notFound',
      };
    }

    // Validate rating is between 1-5
    if (rating < 1 || rating > 5) {
      return {
        success: false,
        error: 'invalidRating',
      };
    }

    // Check if already reviewed
    if (
      payment.Review.length > 0 &&
      process.env['ENVIRONMENT'] != 'development'
    ) {
      return {
        success: false,
        error: 'alreadyReviewed',
      };
    }

    // Create the review
    await this.prisma.review.create({
      data: {
        paymentId: payment.id,
        rating,
        review: review || '',
      },
    });

    return {
      success: true,
    };
  }

  public async processPlaybackCounts() {
    try {
      // Get all playback data from Redis
      const ipInfoListKey = 'ipInfoList';
      const ipInfoList = await this.cache.executeCommand(
        'lrange',
        ipInfoListKey,
        0,
        -1
      );

      if (ipInfoList.length === 0) {
        return { success: true, data: [] };
      }

      // Parse playback data and extract php IDs
      const playbackData: Array<{ php: number; trackId: number }> = [];
      for (const ipInfoJson of ipInfoList) {
        try {
          const ipInfo = JSON.parse(ipInfoJson);
          if (ipInfo.php && ipInfo.trackId) {
            playbackData.push({
              php: parseInt(ipInfo.php),
              trackId: parseInt(ipInfo.trackId),
            });
          }
        } catch (e) {
          // Skip invalid JSON entries
          continue;
        }
      }

      if (playbackData.length === 0) {
        return { success: true, data: [] };
      }

      // Get unique php IDs to fetch payment information
      const phpIds = [...new Set(playbackData.map((p) => p.php))];

      // Fetch PaymentHasPlaylist data with payment info
      const phpRecords = await this.prisma.paymentHasPlaylist.findMany({
        where: { id: { in: phpIds } },
        select: {
          id: true,
          paymentId: true,
          payment: {
            select: {
              id: true,
              paymentId: true,
              reviewAllowed: true,
            },
          },
        },
      });

      // Create a map of php ID to payment ID
      const phpToPaymentMap = new Map<number, number>();
      const paymentInfo = new Map<
        number,
        { paymentId: string; reviewAllowed: number }
      >();

      for (const php of phpRecords) {
        phpToPaymentMap.set(php.id, php.payment.id);
        paymentInfo.set(php.payment.id, {
          paymentId: php.payment.paymentId,
          reviewAllowed: php.payment.reviewAllowed,
        });
      }

      // Group playbacks by payment ID and count unique tracks
      const paymentTrackCounts = new Map<number, Set<number>>();

      for (const playback of playbackData) {
        const paymentId = phpToPaymentMap.get(playback.php);
        if (paymentId) {
          if (!paymentTrackCounts.has(paymentId)) {
            paymentTrackCounts.set(paymentId, new Set());
          }
          paymentTrackCounts.get(paymentId)!.add(playback.trackId);
        }
      }

      // Process payments that reached the 25 song threshold
      const updatedPayments: Array<{ paymentId: string; trackCount: number }> =
        [];

      for (const [paymentId, trackSet] of paymentTrackCounts.entries()) {
        const info = paymentInfo.get(paymentId);
        if (!info) continue;

        const uniqueTrackCount = trackSet.size;

        // Only update if reviewAllowed is not already set and they've played 25+ unique tracks
        if (info.reviewAllowed === 0 && uniqueTrackCount >= 25) {
          await this.prisma.payment.update({
            where: { id: paymentId },
            data: {
              reviewAllowed: 1,
              reviewAllowedAt: new Date(),
            },
          });

          updatedPayments.push({
            paymentId: info.paymentId,
            trackCount: uniqueTrackCount,
          });

          this.logger.log(
            color.green.bold(
              `Marked payment ${white.bold(info.paymentId)} as review eligible (${white.bold(uniqueTrackCount)} unique tracks played)`
            )
          );
        }
      }

      if (updatedPayments.length > 0) {
        this.logger.log(
          color.blue.bold(
            `Processed ${white.bold(updatedPayments.length)} payments eligible for review`
          )
        );
      }

      return {
        success: true,
        data: updatedPayments,
      };
    } catch (error) {
      this.logger.log(
        color.red.bold('Error processing playback counts: ') +
          color.white.bold(error instanceof Error ? error.message : String(error))
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async processReviewEmails() {
    const timeAgoHours = 240;
    const timeAgo = new Date(Date.now() - timeAgoHours * 60 * 60 * 1000);

    // 24 hours ago for reviewAllowedAt check
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let checker = false;
    if (process.env['ENVIRONMENT'] == 'development') {
      checker = true;
    }

    let whereClause: any = {
      status: 'paid',
      Review: {
        none: {}, // No reviews exist
      },
      finalizedAt: {
        lt: timeAgo,
      },
      reviewMailSent: false,
      marketingEmails: true,
      reviewAllowed: 1,
      reviewAllowedAt: {
        lte: twentyFourHoursAgo, // At least 24 hours since becoming eligible
      },
    };

    const payments = await this.prisma.payment.findMany({
      where: whereClause,
      select: {
        id: true,
        paymentId: true,
        email: true,
        fullname: true,
        createdAt: true,
      },
    });

    if (payments.length > 0) {
      this.logger.log(
        color.blue.bold(
          `Found ${white.bold(payments.length)} unsent review emails`
        )
      );
    }

    for (const payment of payments) {
      // Send review email to first user only

      // Check if this user has already has payments other than this one where reviewMailSent is true
      const otherPayments = await this.prisma.payment.findMany({
        where: {
          email: payment.email,
          reviewMailSent: true,
          id: {
            not: payment.id,
          },
        },
      });

      if (otherPayments.length == 0) {
        const fullPayment = await this.prisma.payment.findUnique({
          where: { id: payment.id },
        });

        if (fullPayment) {
          await this.mail.sendReviewEmail(fullPayment);

          this.logger.log(
            color.blue.bold(`Sent review email to ${white.bold(payment.email)}`)
          );
        }
      } else {
        this.logger.log(
          color.yellow.bold(
            `Skipping review email for ${white.bold(
              payment.email
            )} since they have already received one`
          )
        );
      }
      // Update reviewMailSent flag
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { reviewMailSent: true },
      });
    }

    return {
      success: true,
      data: payments,
    };
  }
}

export default Review;
