import { describe, expect, it } from 'vitest';
import {
  boxCount,
  exVatAtRate,
  printedOrderFigures,
} from '../../../src/printers/paymentFigures';

describe('paymentFigures', () => {
  it('backs the rate out of what was paid, to cents', () => {
    expect(exVatAtRate(42.02, 0)).toBe(42.02);
    // The country's 19% taken off a 0% payment: what order 100009253 got.
    expect(exVatAtRate(42.02, 19)).toBe(35.31);
    expect(exVatAtRate(60.5, 21)).toBe(50);
  });

  it('counts gift boxes per copy, only on lines with boxes switched on', () => {
    expect(boxCount([])).toBe(0);
    expect(
      boxCount([
        { boxEnabled: true, boxQuantity: 2, amount: 3 },
        { boxEnabled: false, boxQuantity: 5, amount: 1 },
        { boxEnabled: true, boxQuantity: 0, amount: 4 },
        { boxEnabled: true, boxQuantity: 1, amount: 0 },
      ])
    ).toBe(7);
  });

  it('books order 100009253 at the 0% it was charged, and reproduces the wrong 19% booking', () => {
    const at0 = printedOrderFigures({
      totalPrice: 42.02,
      taxRate: 0,
      printApiPrice: 25.59,
      boxCount: 0,
      extraPrintCost: 0,
    });
    expect(at0).toEqual({
      totalPriceWithoutTax: 42.02,
      boxCost: 0,
      extraPrintCost: 0,
      profit: 16.43,
    });
    const at19 = printedOrderFigures({
      totalPrice: 42.02,
      taxRate: 19,
      printApiPrice: 25.59,
      boxCount: 0,
    });
    expect(at19.totalPriceWithoutTax).toBe(35.31);
    expect(at19.profit).toBe(9.72);
  });

  it('takes the print cost, the boxes and a later printer order off the profit', () => {
    expect(
      printedOrderFigures({
        totalPrice: 60.5,
        taxRate: 21,
        printApiPrice: 20,
        boxCount: 2,
        extraPrintCost: 3.1,
      })
    ).toEqual({
      totalPriceWithoutTax: 50,
      boxCost: 1.5,
      extraPrintCost: 3.1,
      profit: 25.4,
    });
    expect(
      printedOrderFigures({
        totalPrice: 60.5,
        taxRate: 21,
        printApiPrice: 20,
        boxCount: 0,
        extraPrintCost: null,
      }).profit
    ).toBe(30);
  });
});
