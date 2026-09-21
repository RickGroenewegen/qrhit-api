import fs from 'fs/promises';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Mail from './mail';
import PDF from './pdf';
import { round2 } from './services/discount-allocation';
import type { InvoiceLine } from './services/invoice-lines';

/**
 * Invoices for purchases made after an order: App Designer and QRGames (on
 * the account) and extra cards and gift boxes (on an order). They get their
 * own number range,
 * U<year>-<sequence> (U2026-00001), so the order invoices keep the order id
 * as their number and neither range has gaps from the other. Each invoice is
 * mailed to the customer in its own mail with the PDF attached.
 *
 * The PDF is the order invoice template (src/views/invoice.ejs), rendered by
 * GET /invoice/upgrade/:molliePaymentId from the snapshot stored here, so an
 * upgrade invoice looks exactly like an order invoice.
 */

export type UpgradeInvoiceType = 'app_design' | 'extra_tracks' | 'box' | 'games';

/**
 * The upgrades whose webhook also adds the charge to the order's
 * `totalPrice`. The order invoice takes its total from that column, so it
 * subtracts these invoices again (see amountBookedOnOrder). App Designer and
 * QRGames are bought on the account and never touch an order.
 */
export const ORDER_BOOKED_UPGRADE_TYPES: UpgradeInvoiceType[] = ['extra_tracks', 'box'];

/** One line as sold: EUR incl. VAT. Ex-VAT and VAT are derived. */
export interface UpgradeInvoiceItem {
  description: string;
  quantity: number;
  totalIncl: number;
}

export interface UpgradeInvoiceCustomer {
  fullname: string;
  companyName: string | null;
  isBusinessOrder: boolean;
  vatId: string | null;
  address: string;
  housenumber: string;
  zipcode: string;
  city: string;
  countrycode: string;
}

export function upgradeInvoiceNumber(year: number, sequence: number): string {
  return `U${year}-${String(sequence).padStart(5, '0')}`;
}

/**
 * Invoice lines at one VAT rate, from VAT-inclusive amounts: the ex-VAT
 * column sums to the subtotal, the VAT column to the VAT and both to the
 * total, like the order invoice.
 */
export function buildUpgradeInvoiceLines(
  items: UpgradeInvoiceItem[],
  taxRate: number
): { lines: InvoiceLine[]; totalIncl: number; totalExcl: number; totalVat: number } {
  const lines: InvoiceLine[] = items
    .filter((item) => item.quantity > 0 && item.totalIncl > 0)
    .map((item) => {
      const totalIncl = round2(item.totalIncl);
      const totalExcl = round2(totalIncl / (1 + taxRate / 100));
      return {
        kind: 'product',
        description: item.description,
        quantity: item.quantity,
        unitExcl: round2(totalExcl / item.quantity),
        totalExcl,
        rate: taxRate,
        vat: round2(totalIncl - totalExcl),
        totalIncl,
      };
    });
  const totalIncl = round2(lines.reduce((sum, line) => sum + line.totalIncl, 0));
  const totalExcl = round2(lines.reduce((sum, line) => sum + line.totalExcl, 0));
  return { lines, totalIncl, totalExcl, totalVat: round2(totalIncl - totalExcl) };
}

/** Billing details from an order, the invoice address first. */
export function customerFromOrder(order: any): UpgradeInvoiceCustomer {
  return {
    fullname: order?.fullname || '',
    companyName: order?.companyName || null,
    isBusinessOrder: !!order?.isBusinessOrder,
    vatId: order?.vatId || null,
    address: order?.invoiceAddress || order?.address || '',
    housenumber: order?.invoiceHousenumber || order?.housenumber || '',
    zipcode: order?.invoiceZipcode || order?.zipcode || '',
    city: order?.invoiceCity || order?.city || '',
    countrycode: order?.invoiceCountrycode || order?.countrycode || '',
  };
}

class UpgradeInvoices {
  private static instance: UpgradeInvoices;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): UpgradeInvoices {
    if (!UpgradeInvoices.instance) {
      UpgradeInvoices.instance = new UpgradeInvoices();
    }
    return UpgradeInvoices.instance;
  }

  public pdfPath(invoiceNumber: string): string {
    return `${process.env['PRIVATE_DIR']}/invoice/upgrade/${invoiceNumber}.pdf`;
  }

  /**
   * EUR (incl. VAT) that upgrades with their own invoice added to this
   * order's `totalPrice`. The order invoice leaves it out, or the customer
   * would be invoiced for it twice.
   */
  public async amountBookedOnOrder(paymentId: number): Promise<number> {
    const result = await this.prisma.upgradeInvoice.aggregate({
      where: { paymentId, type: { in: ORDER_BOOKED_UPGRADE_TYPES } },
      _sum: { totalPrice: true },
    });
    return round2(result._sum.totalPrice || 0);
  }

  /**
   * Create the invoice for a paid upgrade, render its PDF and mail it.
   * Idempotent on the Mollie payment: a replayed webhook finds the existing
   * invoice and only retries what did not happen yet (the mail). Never
   * throws: an invoice problem must not make Mollie retry a purchase that
   * was recorded fine.
   */
  public async issue(params: {
    type: UpgradeInvoiceType;
    molliePayment: { id: string; method?: string | null; amount?: { value: string; currency: string } };
    userId: number | null;
    paymentId?: number | null;
    email: string;
    locale: string;
    customer: UpgradeInvoiceCustomer;
    taxRate: number;
    items: UpgradeInvoiceItem[];
  }): Promise<void> {
    try {
      let invoice = await this.prisma.upgradeInvoice.findUnique({
        where: { molliePaymentId: params.molliePayment.id },
      });
      if (!invoice) {
        invoice = await this.create(params);
      }
      if (!invoice) return;
      if (!invoice.mailedAt) {
        const pdf = await this.renderPdf(invoice.invoiceNumber, invoice.molliePaymentId);
        await Mail.getInstance().sendUpgradeInvoiceEmail(invoice, pdf);
        await this.prisma.upgradeInvoice.update({
          where: { id: invoice.id },
          data: { mailedAt: new Date() },
        });
      }
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Upgrade invoice for ${white.bold(params.molliePayment.id)} failed: ${white.bold(
            error?.message || String(error)
          )}`
        )
      );
    }
  }

  private async create(params: Parameters<UpgradeInvoices['issue']>[0]) {
    const { lines, totalIncl, totalExcl, totalVat } = buildUpgradeInvoiceLines(
      params.items,
      params.taxRate
    );
    if (!lines.length) return null;
    const charged = params.molliePayment.amount;
    const currency = charged?.currency || 'EUR';
    const amountCharged = charged ? parseFloat(charged.value) || totalIncl : totalIncl;
    const year = new Date().getFullYear();

    // Next number in this year's range. Two webhooks at the same moment can
    // pick the same sequence; the unique index refuses the second, which
    // then takes the next one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.upgradeInvoice.findFirst({
        where: { year },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const sequence = (last?.sequence || 0) + 1;
      try {
        const invoice = await this.prisma.upgradeInvoice.create({
          data: {
            invoiceNumber: upgradeInvoiceNumber(year, sequence),
            year,
            sequence,
            type: params.type,
            molliePaymentId: params.molliePayment.id,
            userId: params.userId,
            paymentId: params.paymentId ?? null,
            email: params.email,
            locale: params.locale || 'en',
            customer: params.customer as any,
            lines: lines as any,
            totalPrice: totalIncl,
            totalPriceWithoutTax: totalExcl,
            totalVAT: totalVat,
            taxRate: params.taxRate,
            currency,
            amountCharged,
            paymentMethod: params.molliePayment.method || null,
          },
        });
        this.logger.log(
          color.green.bold(
            `Upgrade invoice ${white.bold(invoice.invoiceNumber)} (${white.bold(
              params.type
            )}) for ${white.bold(params.molliePayment.id)}`
          )
        );
        return invoice;
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
        const target = String(error?.meta?.target || '');
        if (target.includes('molliePaymentId')) {
          return this.prisma.upgradeInvoice.findUnique({
            where: { molliePaymentId: params.molliePayment.id },
          });
        }
        // taken sequence: try the next one
      }
    }
    throw new Error('Could not reserve an upgrade invoice number');
  }

  /** The PDF, rendered once from the invoice route and kept on disk. */
  public async renderPdf(invoiceNumber: string, molliePaymentId: string): Promise<string> {
    const pdfPath = this.pdfPath(invoiceNumber);
    try {
      await fs.access(pdfPath);
      return pdfPath;
    } catch {
      // not rendered yet
    }
    await fs.mkdir(`${process.env['PRIVATE_DIR']}/invoice/upgrade`, { recursive: true });
    const pdf = new PDF();
    await pdf.generateFromUrl(`${process.env['API_URI']}/invoice/upgrade/${molliePaymentId}`, pdfPath, {
      format: 'a4',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
    });
    await pdf.resizePDFPages(pdfPath, 210, 297);
    return pdfPath;
  }
}

export default UpgradeInvoices;
