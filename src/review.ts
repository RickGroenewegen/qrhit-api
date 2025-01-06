import PrismaInstance from './prisma';
import Logger from './logger';
import { color, white } from 'console-log-colors';

class Review {
  private static instance: Review;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

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
}

export default Review;
