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

      return {
        success: amountLeft > 0,
        fullAmount: discount.amount,
        amountLeft: amountLeft,
      };
    } catch (error) {
      return { success: false, message: 'Error checking discount code', error };
    }
  }

  public async redeemDiscount(code: string): Promise<any> {
    try {
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

      if (amountLeft <= 0) {
        return { success: false, message: 'No discount amount left' };
      }

      // Assuming a paymentId is available in the context.
      const paymentId = 1; // Replace with actual payment ID

      await prisma.discountCodedUses.create({
        data: {
          amount: discount.amount,
          discountCodeId: discount.id,
          paymentId,
        },
      });

      return { success: true, message: 'Discount code redeemed successfully' };
    } catch (error) {
      return {
        success: false,
        message: 'Error redeeming discount code',
        error,
      };
    }
  }
}

export default Discount;
