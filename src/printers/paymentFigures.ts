import { BOX_UNIT_COST } from '../config/constants';

/**
 * The ex-VAT turnover and the profit of a printed order, as the printer step
 * books them (setPaymentInfo in printenbindV2.ts, once Print&Bind has the
 * order) and as the admin recompute writes them again
 * (src/paymentTurnover.ts, POST /admin/payment/:paymentId/recompute-turnover).
 * One formula for both, so a corrected row is exactly what a fresh printer
 * pass would have booked:
 *
 *   totalPriceWithoutTax = totalPrice / (1 + rate / 100), rounded to cents,
 *                          at the rate the payment was charged (paymentTaxRate)
 *   profit               = totalPriceWithoutTax − printApiPrice
 *                          − gift boxes × BOX_UNIT_COST − extraPrintCost
 *
 * printApiPrice is the printer's ex-VAT price of the order; empty gift boxes
 * are bought from a supplier outside the printer's invoice; extraPrintCost is
 * a later printer order for the same payment (a box shipped on its own).
 */
export interface BoxLine {
  boxEnabled: boolean | null;
  boxQuantity: number | null;
  amount: number | null;
}

/** Gift boxes shipped with an order: boxes per copy × copies, per line. */
export function boxCount(lines: BoxLine[]): number {
  return lines.reduce((sum, p) => {
    if (p.boxEnabled && (p.boxQuantity ?? 0) > 0) {
      return sum + (p.boxQuantity ?? 0) * (p.amount || 1);
    }
    return sum;
  }, 0);
}

/** `totalPrice` with the VAT at `taxRate` backed out, to cents. */
export function exVatAtRate(totalPrice: number, taxRate: number): number {
  return parseFloat((totalPrice / (1 + taxRate / 100)).toFixed(2));
}

export interface PrintedOrderFigures {
  totalPriceWithoutTax: number;
  boxCost: number;
  extraPrintCost: number;
  profit: number;
}

export function printedOrderFigures(input: {
  totalPrice: number;
  taxRate: number;
  printApiPrice: number;
  boxCount: number;
  extraPrintCost?: number | null;
}): PrintedOrderFigures {
  const totalPriceWithoutTax = exVatAtRate(input.totalPrice, input.taxRate);
  const boxCost = parseFloat((input.boxCount * BOX_UNIT_COST).toFixed(2));
  const extraPrintCost = input.extraPrintCost || 0;
  const profit = parseFloat(
    (totalPriceWithoutTax - input.printApiPrice - boxCost - extraPrintCost).toFixed(2)
  );
  return { totalPriceWithoutTax, boxCost, extraPrintCost, profit };
}
