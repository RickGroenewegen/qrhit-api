import { PrismaClient } from '@prisma/client';
import Utils from './utils';
import Cache from './cache';

class Discount {
  private cache = Cache.getInstance();
  private prisma = new PrismaClient();
  private utils = new Utils();

  private async calculateAmountLeft(
    discountId: number,
    discountAmount: number
  ): Promise<number> {
    const totalUsed = await this.prisma.discountCodedUses.aggregate({
      where: { discountCodeId: discountId },
      _sum: { amount: true },
    });

    const amountUsed = totalUsed._sum.amount || 0;
    return discountAmount - amountUsed;
  }

  public async checkDiscount(code: string): Promise<any> {
    const lockKey = `lock:discount:${code}`;

    try {
      const discount = await this.prisma.discountCode.findUnique({
        where: { code },
      });

      if (!discount) {
        return { success: false, message: 'discountCodeNotFound' };
      }

      const now = new Date();
      if (
        (discount.startDate && discount.startDate > now) ||
        (discount.endDate && discount.endDate < now)
      ) {
        return { success: false, message: 'discountNotActive' };
      }

      const amountLeft = await this.calculateAmountLeft(
        discount.id,
        discount.amount
      );

      return {
        success: amountLeft > 0,
        fullAmount: discount.amount,
        amountLeft: parseFloat(amountLeft.toFixed(2)),
      };
    } catch (error: any) {
      return { success: false, message: 'errorCheckingDiscountCode', error };
    } finally {
      // Release the lock
      await this.cache.executeCommand('del', lockKey);
    }
  }

  public async redeemDiscount(
    code: string,
    amount: number,
    paymentId: string,
    captchaToken: string
  ): Promise<any> {
    const cache = Cache.getInstance();
    const lockKey = `lock:discount:${code}`;
    const lockTimeout = 5000; // 5 seconds

    let lockAcquired = false;
    try {
      lockAcquired = await cache.executeCommand(
        'set',
        lockKey,
        'locked',
        'NX',
        'PX',
        lockTimeout
      );
      if (!lockAcquired) {
        return { success: false, message: 'discountCodeInUse' };
      }

      const isHuman = await this.utils.verifyRecaptcha(captchaToken);

      if (!isHuman && process.env['ENVIRONMENT'] != 'development') {
        throw new Error('reCAPTCHA verification failed');
      }

      return await this.prisma.$transaction(async (prisma) => {
        const discount = await prisma.discountCode.findUnique({
          where: { code },
        });

        if (!discount) {
          return { success: false, message: 'discountCodeNotFound' };
        }

        const now = new Date();
        if (
          (discount.startDate && discount.startDate > now) ||
          (discount.endDate && discount.endDate < now)
        ) {
          return { success: false, message: 'discountNotActive' };
        }

        const amountLeft = await this.calculateAmountLeft(
          discount.id,
          discount.amount
        );

        if (amountLeft < amount) {
          return {
            success: false,
            message: 'insufficientDiscountAmountLeft',
            fullAmount: discount.amount,
            amountLeft: parseFloat(amountLeft.toFixed(2)),
          };
        }

        const payment = await prisma.payment.findUnique({
          where: { paymentId },
        });

        if (!payment) {
          return { success: false, message: 'paymentNotFound' };
        }

        await prisma.discountCodedUses.create({
          data: {
            amount: parseFloat(amount.toFixed(2)),
            discountCodeId: discount.id,
            paymentId: payment.id,
          },
        });

        return {
          success: true,
          message: 'discountRedeemedSuccessfully',
          fullAmount: discount.amount,
          amountLeft: parseFloat((amountLeft - amount).toFixed(2)),
        };
      });
    } catch (error) {
      console.log(error);

      return {
        success: false,
        message: 'errorRedeemingDiscountCode',
        error,
      };
    } finally {
      if (lockAcquired) {
        await cache.executeCommand('del', lockKey);
      }
    }
  }
}

export default Discount;
