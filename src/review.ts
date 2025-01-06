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
            playlist: true
          }
        }
      }
    });

    if (!payment) {
      return {
        success: false,
        error: 'Payment not found'
      };
    }

    // Check if payment is old enough for review (e.g., 7 days)
    const reviewThreshold = new Date();
    reviewThreshold.setDate(reviewThreshold.getDate() - 7);

    const isEligibleForReview = payment.createdAt < reviewThreshold;
    const hasPhysicalProducts = payment.PaymentHasPlaylist.some(php => php.type !== 'digital');
    const isDelivered = payment.printApiStatus === 'Shipped';

    return {
      success: true,
      data: {
        eligible: isEligibleForReview && (!hasPhysicalProducts || (hasPhysicalProducts && isDelivered)),
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
}

export default Review;
