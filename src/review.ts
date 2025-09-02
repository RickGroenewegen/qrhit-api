import PrismaInstance from './prisma';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import Mail from './mail';
import { CronJob } from 'cron';
import Utils from './utils';
import cluster from 'cluster';

class Review {
  private static instance: Review;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private mail = Mail.getInstance();
  private utils = new Utils();

  private constructor() {
    // Schedule review emails to run every hour
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] != 'development') {
          new CronJob(
            '0 * * * *',
            async () => {
              //await this.processReviewEmails();
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

  public async processReviewEmails() {
    const timeAgoHours = 240;
    const timeAgo = new Date(Date.now() - timeAgoHours * 60 * 60 * 1000);

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
