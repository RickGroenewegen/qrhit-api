import { PrismaClient } from '@prisma/client';
import Utils from './utils';

const prisma = new PrismaClient();
const utils = new Utils();

class Discount {
  private async calculateAmountLeft(
    discountId: number,
    discountAmount: number
  ): Promise<number> {
    const totalUsed = await prisma.discountCodedUses.aggregate({
      where: { discountCodeId: discountId },
      _sum: { amount: true },
    });

    const amountUsed = totalUsed._sum.amount || 0;
    return discountAmount - amountUsed;
  }

  public async checkDiscount(code: string): Promise<any> {
    try {
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

      return {
        success: amountLeft > 0,
        fullAmount: discount.amount,
        amountLeft: amountLeft,
      };
    } catch (error) {
      return { success: false, message: 'errorCheckingDiscountCode', error };
    }
  }

  public async redeemDiscount(
    code: string,
    amount: number,
    paymentId: string,
    captchaToken: string
  ): Promise<any> {
    const isHuman = await utils.verifyRecaptcha(captchaToken);

    if (!isHuman && process.env['ENVIRONMENT'] != 'development') {
      throw new Error('reCAPTCHA verification failed');
    }

    try {
      return await prisma.$transaction(async (prisma) => {
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
          return { success: false, message: 'insufficientDiscountAmountLeft' };
        }

        const payment = await prisma.payment.findUnique({
          where: { paymentId },
        });

        if (!payment) {
          return { success: false, message: 'paymentNotFound' };
        }

        await prisma.discountCodedUses.create({
          data: {
            amount: amount,
            discountCodeId: discount.id,
            paymentId: payment.id,
          },
        });

        return {
          success: true,
          message: 'discountRedeemedSuccessfully',
          fullAmount: discount.amount,
          amountLeft: amountLeft - amount,
        };
      });
    } catch (error) {
      console.log(error);

      return {
        success: false,
        message: 'errorRedeemingDiscountCode',
        error,
      };
    }
  }
}

export default Discount;
