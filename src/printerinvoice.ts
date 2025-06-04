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
    const extraction = await chatgpt.extractOrders(content);

    // Loop over the extracted orders and update payments
    const results: Array<{ orderId: string; updated: boolean }> = [];
    for (const order of extraction.orders) {
      try {
        const updated = await this.prisma.payment.updateMany({
          where: { printApiOrderId: order.orderId },
          data: { printApiInvoicePrice: order.amount },
        });
        results.push({
          orderId: order.orderId,
          updated: updated.count > 0,
        });
      } catch (e) {
        results.push({
          orderId: order.orderId,
          updated: false,
        });
      }
    }

    return {
      success: true,
      extracted: extraction.orders,
      updateResults: results,
    };
  }
}

export default PrinterInvoice;
