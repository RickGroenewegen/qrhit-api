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
        Review: true
      },
    });

    if (!payment) {
      return {
        success: false,
        error: 'notFound',
      };
    }

    // Check if payment is old enough for review (e.g., 7 days)
    const reviewThreshold = new Date();
    reviewThreshold.setDate(reviewThreshold.getDate() - 7);

    const isEligibleForReview = payment.createdAt < reviewThreshold;
    const hasPhysicalProducts = payment.PaymentHasPlaylist.some(php => php.type !== 'digital');
    const isDelivered = payment.printApiStatus === 'Shipped';
    const hasReview = payment.Review.length > 0;

    return {
      success: true,
      data: {
        eligible: isEligibleForReview && (!hasPhysicalProducts || (hasPhysicalProducts && isDelivered)) && !hasReview,
        payment: {
          id: payment.paymentId,
          createdAt: payment.createdAt,
          status: payment.status,
          printApiStatus: payment.printApiStatus,
          playlists: payment.PaymentHasPlaylist.map(php => ({
            name: php.playlist.name,
            type: php.type
          }))
        }
      }
    };
  }

  public async createReview(paymentId: string, rating: number, review: string) {
    this.logger.log(
      color.blue.bold(
        `Creating review for payment ${white.bold(paymentId)}`
      )
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
    if (payment.Review.length > 0) {
      return {
        success: false,
        error: 'alreadyReviewed',
      };
    }

    // Check if eligible for review
    const reviewThreshold = new Date();
    reviewThreshold.setDate(reviewThreshold.getDate() - 7);

    const isEligibleForReview = payment.createdAt < reviewThreshold;
    const hasPhysicalProducts = payment.PaymentHasPlaylist.some(php => php.type !== 'digital');
    const isDelivered = payment.printApiStatus === 'Shipped';

    if (!isEligibleForReview || (hasPhysicalProducts && !isDelivered)) {
      return {
        success: false,
        error: 'notEligible',
      };
    }

    // Create the review
    const newReview = await this.prisma.review.create({
      data: {
        paymentId: payment.id,
        rating,
        review: review || '',
      },
    });

    return {
      success: true,
      data: newReview
    };
  }
}

export default Review;
