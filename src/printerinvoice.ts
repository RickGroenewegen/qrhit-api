import PrismaInstance from './prisma';

class PrinterInvoice {
  private static instance: PrinterInvoice;
  private prisma = PrismaInstance.getInstance();

  private constructor() {}

  public static getInstance(): PrinterInvoice {
    if (!PrinterInvoice.instance) {
      PrinterInvoice.instance = new PrinterInvoice();
    }
    return PrinterInvoice.instance;
  }

  async getAllPrinterInvoices() {
    return await this.prisma.printerInvoice.findMany({
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        totalPriceExclVat: true,
        totalPriceInclVat: true,
      },
      orderBy: { id: 'desc' },
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
    const content = body.content || '';
    // Dynamically import ChatGPT to avoid circular dependency
    const { ChatGPT } = await import('./chatgpt');
    const chatgpt = new ChatGPT();

    // Use logger to indicate start of ChatGPT extraction
    const color = require('console-log-colors').color;
    this.logger.log(
      color.blue.bold(
        `Starting ChatGPT extraction for invoiceId=${color.white(id)}`
      )
    );

    const extraction = await chatgpt.extractOrders(content);

    // Loop over the extracted orders and update payments
    const results: Array<{ orderId: string; updated: boolean; amount: number }> = [];
    const warnings: Array<{ orderId: string; amount: number }> = [];

    for (const order of extraction.orders) {
      try {
        const updated = await this.prisma.payment.updateMany({
          where: { printApiOrderId: order.orderId },
          data: { printApiInvoicePrice: order.amount },
        });
        if (updated.count > 0) {
          // Success
          this.logger.log(
            color.green.bold(
              `✔ Updated payment with printApiOrderId=${color.white(order.orderId)} to printApiInvoicePrice=${color.white(order.amount)}`
            )
          );
          results.push({
            orderId: order.orderId,
            updated: true,
            amount: order.amount,
          });
        } else {
          // Not found
          this.logger.log(
            color.yellow.bold(
              `⚠ No payment found for printApiOrderId=${color.white(order.orderId)} (amount=${color.white(order.amount)})`
            )
          );
          results.push({
            orderId: order.orderId,
            updated: false,
            amount: order.amount,
          });
          warnings.push({
            orderId: order.orderId,
            amount: order.amount,
          });
        }
      } catch (e) {
        // Error
        this.logger.log(
          color.red.bold(
            `✖ Error updating payment for printApiOrderId=${color.white(order.orderId)}: ${color.white((e as Error).message)}`
          )
        );
        results.push({
          orderId: order.orderId,
          updated: false,
          amount: order.amount,
        });
        warnings.push({
          orderId: order.orderId,
          amount: order.amount,
        });
      }
    }

    // Summary log
    this.logger.log(
      color.cyan.bold(
        `Processed ${color.white(extraction.orders.length)} orders. Updated: ${color.white(results.filter(r => r.updated).length)}, Warnings: ${color.white(warnings.length)}`
      )
    );
    if (warnings.length > 0) {
      this.logger.log(
        color.yellow.bold(
          `Warning: No payment found for the following orderIds: ${color.white(warnings.map(w => w.orderId).join(', '))}`
        )
      );
    }

    return {
      success: true,
      extracted: extraction.orders,
      updateResults: results,
      warnings,
      summary: {
        total: extraction.orders.length,
        updated: results.filter(r => r.updated).length,
        warnings: warnings.length,
      },
    };
  }
}

export default PrinterInvoice;
