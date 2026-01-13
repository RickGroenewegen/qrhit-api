import PrismaInstance from './prisma';
import Logger from './logger';
import Mail from './mail';
import Promotional from './promotional';
import Utils from './utils';
import { color } from 'console-log-colors';

const REFERRAL_CREDIT_AMOUNT = parseFloat(process.env['REFERRAL_CREDIT_AMOUNT'] || '2.5');

class Referral {
  private static instance: Referral;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private mail = Mail.getInstance();
  private promotional = Promotional.getInstance();
  private utils = new Utils();

  private constructor() {}

  public static getInstance(): Referral {
    if (!Referral.instance) {
      Referral.instance = new Referral();
    }
    return Referral.instance;
  }

  /**
   * Generate a unique 8-character referral code
   * Uses uppercase alphanumeric for readability
   */
  private generateRefCode(): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      result += characters[randomIndex];
    }
    return result;
  }

  /**
   * Validate if a referral code exists
   * Used by frontend to check if a ref code from URL is valid
   */
  public async validateRefCode(refCode: string): Promise<{ valid: boolean; userId?: number }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { refCode },
        select: { id: true },
      });

      return { valid: !!user, userId: user?.id };
    } catch (error) {
      this.logger.log(`Error validating ref code: ${error}`);
      return { valid: false };
    }
  }

  /**
   * Get or create a referral code for a user
   * Lazy generation - only creates when requested
   */
  public async getOrCreateRefCode(userId: number): Promise<{ refCode: string; referralLink: string }> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { refCode: true },
      });

      let refCode = user?.refCode;

      // Generate if not exists
      if (!refCode) {
        // Generate unique code with retry logic
        let isUnique = false;
        let attempts = 0;
        while (!isUnique && attempts < 10) {
          refCode = this.generateRefCode();
          const existing = await this.prisma.user.findUnique({
            where: { refCode },
          });
          if (!existing) {
            isUnique = true;
          }
          attempts++;
        }

        if (!isUnique) {
          throw new Error('Failed to generate unique ref code');
        }

        await this.prisma.user.update({
          where: { id: userId },
          data: { refCode },
        });

        this.logger.log(
          color.blue.bold(`Generated ref code ${color.white.bold(refCode)} for user ${color.white.bold(userId.toString())}`)
        );
      }

      const referralLink = `${process.env['FRONTEND_URI']}?ref=${refCode}`;

      return { refCode: refCode!, referralLink };
    } catch (error) {
      this.logger.log(`Error getting/creating ref code: ${error}`);
      throw error;
    }
  }

  /**
   * Credit referrer when a referred user makes a purchase
   * Called from mollie.processWebhook() after successful payment
   *
   * Credit is €2.50 per playlist purchased (not per quantity)
   * Allows repeat credits (same user can refer multiple purchases)
   * Blocks self-referral
   */
  public async creditReferrer(paymentId: number): Promise<{ success: boolean; credited: boolean; error?: string }> {
    try {
      // Get payment with refCode and user info
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          refCode: true,
          userId: true,
          PaymentHasPlaylist: {
            where: {
              type: { not: 'giftcard' }, // Only count card playlists, not giftcards
            },
            select: { id: true },
          },
        },
      });

      // No ref code on this payment
      if (!payment?.refCode) {
        return { success: true, credited: false };
      }

      // Find referrer by refCode
      const referrer = await this.prisma.user.findUnique({
        where: { refCode: payment.refCode },
        select: { id: true, email: true, displayName: true, locale: true },
      });

      if (!referrer) {
        this.logger.log(
          color.yellow.bold(`Referral code ${color.white.bold(payment.refCode)} not found for payment ${color.white.bold(paymentId.toString())}`)
        );
        return { success: true, credited: false };
      }

      // Block self-referral
      if (referrer.id === payment.userId) {
        this.logger.log(
          color.yellow.bold(`Self-referral blocked for user ${color.white.bold(referrer.id.toString())} on payment ${color.white.bold(paymentId.toString())}`)
        );
        return { success: true, credited: false };
      }

      // Check if already credited for this payment (idempotency)
      const existingCredit = await this.prisma.referralCredit.findUnique({
        where: { paymentId: payment.id },
      });

      if (existingCredit) {
        this.logger.log(
          color.yellow.bold(`Referral already credited for payment ${color.white.bold(paymentId.toString())}`)
        );
        return { success: true, credited: false };
      }

      // Calculate credit: €2.50 per playlist (not per quantity)
      const playlistCount = payment.PaymentHasPlaylist.length;
      if (playlistCount === 0) {
        return { success: true, credited: false };
      }

      const creditAmount = REFERRAL_CREDIT_AMOUNT * playlistCount;

      // Get or create discount code for referrer (reuse promotional system)
      const discountCodeData = await this.promotional.fetchOrCreateDiscountCode(
        referrer.id,
        referrer.displayName || undefined,
        referrer.email
      );

      // Add credit to discount code
      await this.prisma.discountCode.update({
        where: { id: discountCodeData.id },
        data: { amount: { increment: creditAmount } },
      });

      // Record credit for audit
      await this.prisma.referralCredit.create({
        data: {
          referrerUserId: referrer.id,
          paymentId: payment.id,
          amount: creditAmount,
          playlistCount,
        },
      });

      // Calculate new balance (total minus used)
      const totalUsed = await this.prisma.discountCodedUses.aggregate({
        where: { discountCodeId: discountCodeData.id },
        _sum: { amount: true },
      });
      const newBalance = discountCodeData.amount + creditAmount - (totalUsed._sum.amount || 0);

      // Get referrer's referral link
      const referralLink = `${process.env['FRONTEND_URI']}?ref=${payment.refCode}`;

      // Send referral credit email
      await this.mail.sendReferralCreditEmail(
        referrer.email,
        referrer.displayName || referrer.email.split('@')[0],
        creditAmount,
        newBalance,
        discountCodeData.code,
        referralLink,
        referrer.locale || 'en',
        playlistCount
      );

      this.logger.log(
        color.green.bold(
          `Credited ${color.white.bold(`€${creditAmount.toFixed(2)}`)} referral bonus to user ${color.white.bold(referrer.email)} for ${color.white.bold(playlistCount.toString())} playlist(s)`
        )
      );

      return { success: true, credited: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error crediting referrer: ${error}`));
      return { success: false, credited: false, error: 'Failed to credit referrer' };
    }
  }
}

export default Referral;
