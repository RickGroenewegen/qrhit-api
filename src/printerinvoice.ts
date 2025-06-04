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
      orderBy: { createdAt: 'desc' },
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
}

export default PrinterInvoice;
