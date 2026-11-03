import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Logger from './logger';
import Data from './data';
import { paymentTaxRate } from './printers/paymentTaxRate';
import { boxCount, printedOrderFigures } from './printers/paymentFigures';

/**
 * Books a paid printed order's ex-VAT turnover (`totalPriceWithoutTax`) and
 * its `profit` again from what was paid, for a row the printer step booked
 * wrong before a fix. POST /admin/payment/:paymentId/recompute-turnover
 * (admin only), used by the qrsong toolkit's `order turnover`.
 *
 * First: order 100009253 (DE business, reverse charge 0%, €42.02 paid) was
 * booked as €35.31 ex VAT and €9.72 profit, because setPaymentInfo backed the
 * country's 19% out of a payment charged 0% (fixed in 7c742f2d, 2026-10-24).
 * The stored row stayed wrong and held up the October 2026 tax report
 * invoice; until this route the only way to correct it was SQL by hand.
 *
 * - Recompute only: the caller never sends amounts. The figures are the
 *   printer step's own (./printers/paymentFigures.ts, shared with
 *   setPaymentInfo in printenbindV2.ts), at the rate the payment was charged
 *   (paymentTaxRate, as setPaymentInfo takes it).
 * - The print cost is the one stored on the payment (`printApiPrice`):
 *   Print&Bind is not asked. (POST /admin/printenbind/update-payments asks it
 *   again, for every printed order at once.)
 * - Writes `totalPriceWithoutTax` and `profit` only, as setPaymentInfo does.
 *   `totalVATPrice` stays checkout's: the tax and OSS reports take the VAT as
 *   totalPrice − totalPriceWithoutTax, never from that column.
 * - Refuses (409) a payment that is not paid, and one without a print cost
 *   (`printApiPrice` 0): a physical order the printer step has not booked yet
 *   keeps checkout's figures until it goes to the printer, and a digital order
 *   never gets this calculation (its profit is set at checkout), so a profit
 *   from it would mean nothing. Also refused: a reverse-charge payment whose
 *   rate does not come out at 0% (no stored rate falls back to the country's).
 * - `dryRun`: the same answer, nothing written.
 * - The write only lands when the row still holds what was read (totalPrice,
 *   printApiPrice, extraPrintCost and both figures); when an upgrade or a
 *   printer pass changed it in between, 409 and nothing is written.
 */

export class PaymentTurnoverError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface TurnoverFigures {
  totalPriceWithoutTax: number;
  profit: number;
}

export interface TurnoverRecompute {
  paymentId: string;
  orderId: string;
  countrycode: string | null;
  reverseCharge: boolean;
  totalPrice: number;
  /** The rate backed out of totalPrice. */
  taxRate: number;
  /** 'payment': payments.taxRate, the rate it was charged; 'country': none stored, the country's rate. */
  taxRateSource: 'payment' | 'country';
  printApiPrice: number;
  boxes: number;
  boxCost: number;
  extraPrintCost: number;
  before: TurnoverFigures;
  after: TurnoverFigures;
  changed: boolean;
  dryRun: boolean;
  written: boolean;
  /** The row after the write; null when nothing was written. */
  readBack: TurnoverFigures | null;
}

interface TurnoverPayment {
  status: string;
  printApiPrice: number;
}

/** Why this payment's turnover cannot be recomputed; null when it can. Exported for the tests. */
export function turnoverProblem(p: TurnoverPayment): string | null {
  if (p.status !== 'paid') {
    return `the payment is ${p.status}: only a paid order is booked`;
  }
  if (!(p.printApiPrice > 0)) {
    return (
      'no print cost stored (printApiPrice is 0), so a profit would mean nothing: ' +
      'a physical order is booked when it goes to the printer, a digital order keeps the figures checkout gave it'
    );
  }
  return null;
}

class PaymentTurnover {
  private static instance: PaymentTurnover;
  private prisma = PrismaInstance.getInstance();
  private data = Data.getInstance();
  private logger = new Logger();

  public static getInstance(): PaymentTurnover {
    if (!PaymentTurnover.instance) PaymentTurnover.instance = new PaymentTurnover();
    return PaymentTurnover.instance;
  }

  public async recompute(
    paymentId: string,
    opts: { dryRun?: boolean } = {}
  ): Promise<TurnoverRecompute> {
    const dryRun = opts.dryRun === true;
    if (!paymentId) throw new PaymentTurnoverError('Payment ID is required');

    const p = await this.prisma.payment.findUnique({
      where: { paymentId },
      select: {
        id: true,
        paymentId: true,
        orderId: true,
        status: true,
        countrycode: true,
        taxRate: true,
        reverseCharge: true,
        totalPrice: true,
        totalPriceWithoutTax: true,
        profit: true,
        printApiPrice: true,
        extraPrintCost: true,
      },
    });
    if (!p) throw new PaymentTurnoverError('Payment not found', 404);

    const problem = turnoverProblem(p);
    if (problem) throw new PaymentTurnoverError(problem, 409);

    const taxRate = await paymentTaxRate(p, this.data);
    const taxRateSource =
      typeof p.taxRate === 'number' && Number.isFinite(p.taxRate) ? 'payment' : 'country';
    if (p.reverseCharge && taxRate !== 0) {
      throw new PaymentTurnoverError(
        `a reverse-charge payment is charged 0%, but its rate comes out at ${taxRate}% (${taxRateSource}): look at payments.taxRate first`,
        409
      );
    }

    const lines = await this.prisma.paymentHasPlaylist.findMany({
      where: { paymentId: p.id },
      select: { boxEnabled: true, boxQuantity: true, amount: true },
    });
    const boxes = boxCount(lines);
    const figures = printedOrderFigures({
      totalPrice: p.totalPrice,
      taxRate,
      printApiPrice: p.printApiPrice,
      boxCount: boxes,
      extraPrintCost: p.extraPrintCost,
    });

    const before: TurnoverFigures = {
      totalPriceWithoutTax: p.totalPriceWithoutTax,
      profit: p.profit,
    };
    const after: TurnoverFigures = {
      totalPriceWithoutTax: figures.totalPriceWithoutTax,
      profit: figures.profit,
    };
    const changed =
      before.totalPriceWithoutTax !== after.totalPriceWithoutTax ||
      before.profit !== after.profit;

    const result: TurnoverRecompute = {
      paymentId: p.paymentId,
      orderId: p.orderId,
      countrycode: p.countrycode,
      reverseCharge: p.reverseCharge,
      totalPrice: p.totalPrice,
      taxRate,
      taxRateSource,
      printApiPrice: p.printApiPrice,
      boxes,
      boxCost: figures.boxCost,
      extraPrintCost: figures.extraPrintCost,
      before,
      after,
      changed,
      dryRun,
      written: false,
      readBack: null,
    };
    if (dryRun || !changed) return result;

    const { count } = await this.prisma.payment.updateMany({
      where: {
        id: p.id,
        totalPrice: p.totalPrice,
        printApiPrice: p.printApiPrice,
        extraPrintCost: p.extraPrintCost,
        totalPriceWithoutTax: p.totalPriceWithoutTax,
        profit: p.profit,
      },
      data: after,
    });
    if (count !== 1) {
      throw new PaymentTurnoverError(
        'the payment changed while it was recomputed (an upgrade or a printer pass): nothing written, run it again',
        409
      );
    }

    const back = await this.prisma.payment.findUnique({
      where: { id: p.id },
      select: { totalPriceWithoutTax: true, profit: true },
    });

    this.logger.log(
      color.blue.bold('Turnover recomputed for order ') +
        white.bold(p.orderId) +
        color.blue.bold(` at ${taxRate}%: ex VAT `) +
        white.bold(`${before.totalPriceWithoutTax.toFixed(2)} → ${after.totalPriceWithoutTax.toFixed(2)}`) +
        color.blue.bold(', profit ') +
        white.bold(`${before.profit.toFixed(2)} → ${after.profit.toFixed(2)}`)
    );

    return {
      ...result,
      written: true,
      readBack: back
        ? { totalPriceWithoutTax: back.totalPriceWithoutTax, profit: back.profit }
        : null,
    };
  }
}

export default PaymentTurnover;
