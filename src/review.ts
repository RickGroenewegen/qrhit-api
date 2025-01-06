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
      },
    });

    if (!payment) {
      return {
        success: false,
        error: 'notFound',
      };
    }

    console.log(111, payment);

    return {
      success: true,
    };
  }
}

export default Review;
