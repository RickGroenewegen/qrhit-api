import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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

  public async redeemDiscount(code: string, amount: number): Promise<any> {
    try {
      return await prisma.$transaction(async (prisma) => {
        const discount = await prisma.discountCode.findUnique({
          where: { code },
        });

        if (!discount) {
          return { success: false, message: 'Discount code not found' };
        }

        const now = new Date();
        if (
          (discount.startDate && discount.startDate > now) ||
          (discount.endDate && discount.endDate < now)
        ) {
          return { success: false, message: 'Discount code is not active' };
        }

        const amountLeft = await this.calculateAmountLeft(
          discount.id,
          discount.amount
        );

        if (amountLeft < amount) {
          return { success: false, message: 'insufficientDiscountAmountLeft' };
        }

        // Assuming a paymentId is available in the context.
        const paymentId = 1; // Replace with actual payment ID or handle it as needed

        await prisma.discountCodedUses.create({
          data: {
            amount: amount,
            discountCodeId: discount.id,
            paymentId,
          },
        });

        return { success: true, message: 'discountRedeemedSuccessfully' };
      });
    } catch (error) {
      return {
        success: false,
        message: 'errorRedeemingDiscountCode',
        error,
      };
    }
  }
}

export default Discount;
