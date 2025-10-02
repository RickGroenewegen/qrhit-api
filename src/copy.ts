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
          DiscountCodedUses: {
            include: {
              discountCode: true,
            },
          },
        },
      });

      if (!originalPayment) {
        return { success: false, error: 'Payment not found' };
      }

      // Generate new paymentId by replacing tr_ with dup_
      const newPaymentId = originalPaymentId.replace('tr_', 'dup_');

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

      // Create the duplicated payment
      const newPayment = await this.prisma.payment.create({
        data: {
          // User and basic info
          userId: originalPayment.userId,
          paymentId: newPaymentId,
          orderId: newOrderId,

          // Customer information
          fullname: originalPayment.fullname,
          email: originalPayment.email,
          address: originalPayment.address,
          housenumber: originalPayment.housenumber,
          city: originalPayment.city,
          zipcode: originalPayment.zipcode,
          countrycode: originalPayment.countrycode,

          // Invoice address if different
          differentInvoiceAddress: originalPayment.differentInvoiceAddress,
          invoiceAddress: originalPayment.invoiceAddress,
          invoiceHousenumber: originalPayment.invoiceHousenumber,
          invoiceCity: originalPayment.invoiceCity,
          invoiceZipcode: originalPayment.invoiceZipcode,
          invoiceCountrycode: originalPayment.invoiceCountrycode,

          // Pricing information
          totalPrice: originalPayment.totalPrice,
          totalPriceWithoutTax: originalPayment.totalPriceWithoutTax,
          productPriceWithoutTax: originalPayment.productPriceWithoutTax,
          shippingPriceWithoutTax: originalPayment.shippingPriceWithoutTax,
          productVATPrice: originalPayment.productVATPrice,
          shippingVATPrice: originalPayment.shippingVATPrice,
          totalVATPrice: originalPayment.totalVATPrice,
          shipping: originalPayment.shipping,
          taxRate: originalPayment.taxRate,
          taxRateShipping: originalPayment.taxRateShipping,
          discount: originalPayment.discount,
          profit: originalPayment.profit,

          // Settings and preferences
          locale: originalPayment.locale,
          marketingEmails: originalPayment.marketingEmails,
          orderTypeId: originalPayment.orderTypeId,
          fast: originalPayment.fast,
          test: originalPayment.test,
          vibe: originalPayment.vibe,
          clientIp: originalPayment.clientIp,
          paymentMethod: originalPayment.paymentMethod,

          // Copy status and processing flags
          status: originalPayment.status,
          finalized: originalPayment.finalized,
          finalizedAt: originalPayment.finalizedAt,
          allTracksChecked: originalPayment.allTracksChecked,
          processedFirstTime: originalPayment.processedFirstTime,
          processedFirstTimeAt: originalPayment.processedFirstTimeAt,
          reviewMailSent: originalPayment.reviewMailSent,

          // Copy printer-related fields
          printApiOrderId: originalPayment.printApiOrderId,
          printApiStatus: originalPayment.printApiStatus,
          printApiShipped: originalPayment.printApiShipped,
          printApiOrderRequest: originalPayment.printApiOrderRequest,
          printApiOrderResponse: originalPayment.printApiOrderResponse,
          printApiTrackingLink: originalPayment.printApiTrackingLink,
          printApiPrice: originalPayment.printApiPrice,
          printApiPriceInclVat: originalPayment.printApiPriceInclVat,
          printApiInvoicePrice: originalPayment.printApiInvoicePrice,
          canBeSentToPrinter: originalPayment.canBeSentToPrinter,
          canBeSentToPrinterAt: originalPayment.canBeSentToPrinterAt,
          userAgreedToPrinting: originalPayment.userAgreedToPrinting,
          userAgreedToPrintingAt: originalPayment.userAgreedToPrintingAt,
          sentToPrinter: originalPayment.sentToPrinter,
          sentToPrinterAt: originalPayment.sentToPrinterAt,
          printerInvoiceId: originalPayment.printerInvoiceId,

          // QR subdirectory will be regenerated
          qrSubDir: originalPayment.qrSubDir,
        },
      });

      // Duplicate PaymentHasPlaylist records
      for (const php of originalPayment.PaymentHasPlaylist) {
        await this.prisma.paymentHasPlaylist.create({
          data: {
            paymentId: newPayment.id,
            playlistId: php.playlistId,
            amount: php.amount,
            numberOfTracks: php.numberOfTracks,
            orderTypeId: php.orderTypeId,
            type: php.type,
            subType: php.subType,

            // Reset filenames - will be regenerated
            filename: null,
            filenameDigital: null,
            filenameDigitalDoubleSided: null,

            // Copy preferences
            doubleSided: php.doubleSided,
            eco: php.eco,
            hideCircle: php.hideCircle,
            qrBackgroundType: php.qrBackgroundType,
            qrColor: php.qrColor,
            hideDomain: php.hideDomain,
            emoji: php.emoji,
            background: php.background,
            logo: php.logo,
            selectedFont: php.selectedFont,
            selectedFontSize: php.selectedFontSize,

            // Copy pricing
            price: php.price,
            priceWithoutVAT: php.priceWithoutVAT,
            priceVAT: php.priceVAT,

            // Reset print API fields - will be regenerated
            printApiPrice: 0,
            printApiUploaded: false,
            printApiUploadResponse: null,
            printerPageCount: 0,
            suggestionsPending: false,
            eligableForPrinter: false,
            eligableForPrinterAt: null,
          },
        });
      }

      // Duplicate DiscountCodedUses if present
      for (const discountUse of originalPayment.DiscountCodedUses) {
        await this.prisma.discountCodedUses.create({
          data: {
            discountCodeId: discountUse.discountCodeId,
            paymentId: newPayment.id,
            amount: discountUse.amount,
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
