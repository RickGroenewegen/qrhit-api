import { PrismaClient } from '@prisma/client';

export default class Copy {
  private static instance: Copy;
  private prisma: PrismaClient;

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): Copy {
    if (!Copy.instance) {
      Copy.instance = new Copy();
    }
    return Copy.instance;
  }

  /**
   * Duplicates a payment with all its related data
   * @param originalPaymentId - The paymentId of the payment to duplicate
   * @returns The new paymentId of the duplicated payment
   */
  public async duplicatePayment(
    originalPaymentId: string
  ): Promise<{ success: boolean; newPaymentId?: string; error?: string }> {
    try {
      // Fetch the original payment with all related data
      const originalPayment = await this.prisma.payment.findUnique({
        where: { paymentId: originalPaymentId },
        include: {
          PaymentHasPlaylist: true,
        },
      });

      if (!originalPayment) {
        return { success: false, error: 'Payment not found' };
      }

      // Generate new paymentId by replacing tr_ with dup_ or incrementing dup_ counter
      let newPaymentId: string;
      if (originalPaymentId.startsWith('dup')) {
        // Already a duplicate, increment the counter (dup_ -> dup2_, dup2_ -> dup3_, etc.)
        const match = originalPaymentId.match(/^dup(\d*)_/);
        if (match) {
          const currentNum = match[1] ? parseInt(match[1]) : 1;
          const nextNum = currentNum + 1;
          newPaymentId = originalPaymentId.replace(/^dup\d*_/, `dup${nextNum}_`);
        } else {
          // Fallback if pattern doesn't match
          newPaymentId = originalPaymentId.replace('dup_', 'dup2_');
        }
      } else {
        // Original payment with tr_ prefix
        newPaymentId = originalPaymentId.replace('tr_', 'dup_');
      }

      // Get the highest orderId and increment by 1
      const highestOrder = await this.prisma.payment.findFirst({
        orderBy: {
          id: 'desc',
        },
        select: {
          orderId: true,
        },
      });

      const newOrderId = highestOrder?.orderId
        ? `${parseInt(highestOrder.orderId) + 1}`
        : '1';

      // Create a copy of all payment fields, excluding specific ones
      const {
        id,
        createdAt,
        updatedAt,
        PaymentHasPlaylist,
        printApiOrderId,
        ...paymentData
      } = originalPayment as any;

      // Create the duplicated payment with all fields copied
      const newPayment = await this.prisma.payment.create({
        data: {
          ...paymentData,
          paymentId: newPaymentId,
          orderId: newOrderId,
          sendToPrinter: 0,
        },
      });

      // Duplicate PaymentHasPlaylist records
      for (const php of originalPayment.PaymentHasPlaylist) {
        // Copy all fields except id and paymentId
        const {
          id: phpId,
          paymentId: oldPaymentId,
          ...phpData
        } = php as any;

        await this.prisma.paymentHasPlaylist.create({
          data: {
            ...phpData,
            paymentId: newPayment.id,
          },
        });
      }

      console.log(
        `Successfully duplicated payment ${originalPaymentId} to ${newPaymentId}`
      );

      return { success: true, newPaymentId };
    } catch (error) {
      console.error('Error duplicating payment:', error);
      return {
        success: false,
        error: 'Failed to duplicate payment: ' + (error as Error).message,
      };
    }
  }
}
