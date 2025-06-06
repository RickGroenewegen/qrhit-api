import Logger from './logger';
import PrismaInstance from './prisma';

class PrinterInvoice {
  private static instance: PrinterInvoice;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): PrinterInvoice {
    if (!PrinterInvoice.instance) {
      PrinterInvoice.instance = new PrinterInvoice();
    }
    return PrinterInvoice.instance;
  }

  async getAllPrinterInvoices() {
    // Get all printer invoices with their payment totals
    const invoices = await this.prisma.printerInvoice.findMany({
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        totalPriceExclVat: true,
        totalPriceInclVat: true,
        Payment: {
          select: {
            totalPrice: true,
            printApiPrice: true,
            printApiPriceInclVat: true,
            printApiInvoicePrice: true,
            profit: true,
            totalPriceWithoutTax: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    });

    // Calculate totals for each invoice
    return invoices.map((invoice: any) => {
      const payments = invoice.Payment || [];
      let totalPrice = 0;
      let printApiPrice = 0;
      let printApiPriceInclVat = 0;
      let printApiInvoicePrice = 0;
      let profit = 0;
      let totalPriceWithoutTax = 0;
      const totalPayments = payments.length;
      for (const payment of payments) {
        totalPrice += payment.totalPrice || 0;
        printApiPrice += payment.printApiPrice || 0;
        printApiPriceInclVat += payment.printApiPriceInclVat || 0;
        printApiInvoicePrice += payment.printApiInvoicePrice || 0;
        profit += payment.profit || 0;
        totalPriceWithoutTax += payment.totalPriceWithoutTax || 0;
      }
      // Helper to round to 2 decimals
      const round2 = (num: number) => Math.round((num + Number.EPSILON) * 100) / 100;
      // Remove Payment array from result, add totals as top-level properties
      const { Payment, ...rest } = invoice;
      return {
        ...rest,
        totalPrice: round2(totalPrice),
        printApiPrice: round2(printApiPrice),
        printApiPriceInclVat: round2(printApiPriceInclVat),
        printApiInvoicePrice: round2(printApiInvoicePrice),
        profit: round2(profit),
        totalPriceWithoutTax: round2(totalPriceWithoutTax),
        totalPayments,
      };
    });
  }

  async updatePrinterInvoice(
    id: number,
    data: {
      invoiceNumber?: string;
      description?: string;
      totalPriceExclVat?: number;
      totalPriceInclVat?: number;
    }
  ) {
    try {
      const updated = await this.prisma.printerInvoice.update({
        where: { id },
        data,
        select: {
          id: true,
          invoiceNumber: true,
          description: true,
          totalPriceExclVat: true,
          totalPriceInclVat: true,
        },
      });
      return { success: true, invoice: updated };
    } catch (error) {
      return { success: false, error: 'Failed to update printer invoice' };
    }
  }

  async createPrinterInvoice(data: {
    invoiceNumber: string;
    description: string;
    totalPriceExclVat: number;
    totalPriceInclVat: number;
  }) {
    try {
      const created = await this.prisma.printerInvoice.create({
        data,
        select: {
          id: true,
          invoiceNumber: true,
          description: true,
          totalPriceExclVat: true,
          totalPriceInclVat: true,
        },
      });
      return { success: true, invoice: created };
    } catch (error) {
      return { success: false, error: 'Failed to create printer invoice' };
    }
  }

  async deletePrinterInvoice(id: number) {
    // Check if any payments refer to this invoice
    const count = await this.prisma.payment.count({
      where: { printerInvoiceId: id },
    });
    if (count > 0) {
      return {
        success: false,
        error: 'Cannot delete: Payments refer to this invoice',
      };
    }
    try {
      await this.prisma.printerInvoice.delete({ where: { id } });
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Failed to delete printer invoice' };
    }
  }

  // Process invoice data using ChatGPT to extract orderIds, dates, and amounts
  async processInvoiceData(id: number, body: any) {
    // First, disconnect all payments from this printer invoice
    await this.prisma.payment.updateMany({
      where: { printerInvoiceId: id },
      data: { printerInvoiceId: null },
    });

    const content = body.content || '';
    // Dynamically import ChatGPT to avoid circular dependency
    const { ChatGPT } = await import('./chatgpt');
    const chatgpt = new ChatGPT();

    // Use logger to indicate start of ChatGPT extraction
    const color = require('console-log-colors').color;
    this.logger.log(
      color.blue.bold(
        `Starting text extraction from content for invoiceId ${color.white(id)}`
      )
    );

    const extraction = await chatgpt.extractOrders(content);

    // Loop over the extracted orders and update payments
    const orderResults: Array<{
      orderId: string;
      paymentId: number | null;
      amount: number;
      paymentAmount: number | null;
    }> = [];

    for (const order of extraction.orders) {
      try {
        // Find the payment by printApiOrderId, but only if it does NOT already have a printerInvoiceId
        const payment = await this.prisma.payment.findFirst({
          where: { printApiOrderId: order.orderId, printerInvoiceId: null },
          select: { id: true, printApiPrice: true, printApiPriceInclVat: true },
        });

        if (payment) {
          // Update the payment's printApiInvoicePrice
          await this.prisma.payment.updateMany({
            where: { printApiOrderId: order.orderId },
            data: { printApiInvoicePrice: order.amount, printerInvoiceId: id },
          });

          this.logger.log(
            color.blue.bold(
              `Updated payment with orderId ${color.white(
                order.orderId
              )} to price ${color.white(order.amount.toFixed(2))}`
            )
          );

          orderResults.push({
            orderId: order.orderId,
            paymentId: payment.id,
            amount: order.amount,
            paymentAmount: payment.printApiPriceInclVat,
          });
        } else {
          this.logger.log(
            color.yellow.bold(
              `No payment found for orderId ${color.white(
                order.orderId
              )} (Amount: ${color.white(order.amount.toFixed(2))})`
            )
          );
          orderResults.push({
            orderId: order.orderId,
            paymentId: null,
            amount: order.amount,
            paymentAmount: null,
          });
        }
      } catch (e) {
        this.logger.log(
          color.red.bold(
            `Error updating payment for orderId ${color.white(
              order.orderId
            )}: ${color.white((e as Error).message)}`
          )
        );
        orderResults.push({
          orderId: order.orderId,
          paymentId: null,
          amount: order.amount,
          paymentAmount: null,
        });
      }
    }

    // Summary log
    this.logger.log(
      color.blue.bold(
        `Processed ${color.white(
          extraction.orders.length
        )} orders. Found: ${color.white(
          orderResults.filter((r) => r.paymentId !== null).length
        )}, Not found: ${color.white(
          orderResults.filter((r) => r.paymentId === null).length
        )}`
      )
    );

    return orderResults;
  }
}

export default PrinterInvoice;
