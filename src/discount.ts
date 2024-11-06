import { PrismaClient } from '@prisma/client';
import Utils from './utils';
import Cache from './cache';
import { customAlphabet } from 'nanoid';

class Discount {
  private cache = Cache.getInstance();
  private prisma = new PrismaClient();
  private utils = new Utils();

  public async createDiscountCode(
    amount: number
  ): Promise<{ id: number; code: string }> {
    try {
      // Create nanoid with only uppercase letters and numbers
      const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 4);

      // Generate code in XXXX-XXXX-XXXX-XXXX format
      const parts = Array.from({ length: 4 }, () => nanoid());
      const code = parts.join('-');

      const discount = await this.prisma.discountCode.create({
        data: {
          code,
          amount,
        },
      });

      return {
        id: discount.id,
        code: code,
      };
    } catch (error) {
      throw new Error(`Failed to create discount code: ${error}`);
    }
  }

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

  public async calculateTotalDiscountForPayment(
    paymentId: number
  ): Promise<number> {
    const totalDiscount = await this.prisma.discountCodedUses.aggregate({
      where: { paymentId: paymentId },
      _sum: { amount: true },
    });

    return totalDiscount._sum.amount || 0;
  }

  public async removeDiscountUsesByPaymentId(paymentId: number): Promise<any> {
    try {
      await this.prisma.discountCodedUses.deleteMany({
        where: {
          paymentId: paymentId,
        },
      });
      return { success: true, message: 'discountUsesRemovedSuccessfully' };
    } catch (error) {
      return { success: false, message: 'errorRemovingDiscountUses', error };
    }
  }

  public async associatePaymentWithDiscountUse(
    discountUseId: number,
    paymentId: number
  ): Promise<any> {
    try {
      await this.prisma.discountCodedUses.update({
        where: {
          id: discountUseId,
        },
        data: {
          paymentId: paymentId,
        },
      });
      return { success: true, message: 'paymentAssociatedSuccessfully' };
    } catch (error) {
      return { success: false, message: 'errorAssociatingPayment', error };
    }
  }

  public async checkDiscount(code: string): Promise<any> {
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

      if (amountLeft <= 0) {
        return {
          success: false,
          message: 'discountCodeExhausted',
          fullAmount: discount.amount,
          amountLeft: parseFloat(amountLeft.toFixed(2)),
        };
      }

      return {
        success: true,
        fullAmount: discount.amount,
        amountLeft: parseFloat(amountLeft.toFixed(2)),
      };
    } catch (error: any) {
      return { success: false, message: 'errorCheckingDiscountCode', error };
    }
  }

  public async redeemDiscount(code: string, amount: number): Promise<any> {
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

        const insertResult = await prisma.discountCodedUses.create({
          data: {
            amount: parseFloat(amount.toFixed(2)),
            discountCodeId: discount.id,
          },
        });

        return {
          success: true,
          message: 'discountRedeemedSuccessfully',
          fullAmount: discount.amount,
          amountLeft: parseFloat((amountLeft - amount).toFixed(2)),
          discountUseId: insertResult.id,
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

  public async getDiscountDetails(code: string): Promise<any> {
    try {
      const discount = await this.prisma.discountCode.findUnique({
        where: { code },
        select: {
          id: true,
          code: true,
          amount: true,
          from: true,
          message: true,
        },
      });

      if (!discount) {
        return { success: false, message: 'discountCodeNotFound' };
      }

      return {
        success: true,
        ...discount,
      };
    } catch (error) {
      return { success: false, message: 'errorRetrievingDiscountCode', error };
    }
  }
}

export default Discount;
