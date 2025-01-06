import PrismaInstance from './prisma';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import Mail from './mail';
import { CronJob } from 'cron';

class Review {
  private static instance: Review;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {
    // Schedule review emails to run every hour
    if (process.env['ENVIRONMENT'] != 'development') {
      new CronJob(
        '0 * * * *',
        async () => {
          await this.processReviewEmails();
        },
        null,
        true
      );
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

    console.log(111, paymentId, rating, review);

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
    this.logger.log(color.blue.bold('Getting list of unsent review emails'));

    const timeAgoHours = 72;
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
    };

    // Only check reviewMailSent in production
    if (process.env['ENVIRONMENT'] !== 'development') {
      whereClause.reviewMailSent = false;
    }

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

    let counter = 1;

    for (const payment of payments) {
      // Send review email to first user only
      if (counter == 1) {
        const fullPayment = await this.prisma.payment.findUnique({
          where: { id: payment.id },
        });

        if (fullPayment) {
          const mail = Mail.getInstance();
          await mail.sendReviewEmail(fullPayment);

          // Update reviewMailSent flag
          await this.prisma.payment.update({
            where: { id: payment.id },
            data: { reviewMailSent: true },
          });

          this.logger.log(
            color.blue.bold(`Sent review email to ${white.bold(payment.email)}`)
          );
        }
      }
      counter++;
    }

    return {
      success: true,
      data: payments,
    };
  }
}

export default Review;
