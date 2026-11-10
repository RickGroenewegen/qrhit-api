import { describe, it, expect } from 'vitest';
import { MAX_SETS, paymentTotalsAfter, setsPricing, setsRefusal, type SetsState } from '../../src/orderLineSets';

// Esther Brauhardt, 100009410, line 10457 "Rock the Dancefloor": one set, on hold after the cancel at Print&Bind
const line = (extra: Partial<SetsState> = {}): SetsState => ({
  orderId: '100009410',
  status: 'paid',
  printerHold: true,
  sentToPrinter: false,
  printApiOrderId: '',
  fast: false,
  type: 'physical',
  printerType: 'printnbind',
  amount: 1,
  boxEnabled: false,
  boxQuantity: 0,
  gifted: false,
  ...extra,
});

describe('order sets: when the number of sets may change', () => {
  it('lets a paid printed line on hold go from one set to two', () => {
    expect(setsRefusal(line(), 2)).toBeNull();
    expect(setsRefusal(line({ amount: 2 }), 1)).toBeNull();
  });

  it('takes a whole number from 1 to the cap, and refuses the same amount', () => {
    for (const bad of [0, -1, 1.5, NaN, MAX_SETS + 1]) expect(setsRefusal(line(), bad)).toMatch(/whole number from 1/);
    expect(setsRefusal(line(), 1)).toMatch(/already has 1 set$/);
  });

  it('refuses while the order is at the printer or not on hold', () => {
    expect(setsRefusal(line({ sentToPrinter: true, printApiOrderId: '1541189' }), 2)).toMatch(/at the printer \(1541189\).*printer-reset/);
    expect(setsRefusal(line({ printerHold: false }), 2)).toMatch(/printer hold first/);
  });

  it('refuses what it cannot price or print as a set', () => {
    expect(setsRefusal(line({ status: 'open' }), 2)).toMatch(/not paid/);
    expect(setsRefusal(line({ type: 'digital' }), 2)).toMatch(/only printed cards/);
    expect(setsRefusal(line({ printerType: 'schneiders' }), 2)).toMatch(/Print&Bind lines only/);
    expect(setsRefusal(line({ boxQuantity: 1 }), 2)).toMatch(/gift boxes/);
    expect(setsRefusal(line({ gifted: true }), 2)).toMatch(/given as a gift/);
    expect(setsRefusal(line({ fast: true }), 2)).toMatch(/express/);
  });
});

describe('order sets: what it costs', () => {
  // A second set at today's list price of €52 incl. VAT, the German rate of 19 %, on a line paid at €39
  const second = setsPricing({ from: 1, to: 2, listPricePerSet: 52, linePrice: 39, printApiPrice: 30, taxRate: 19 });

  it('adds a set at the list price, split at the order tax rate', () => {
    expect(second.perSet).toBe(52);
    expect(second.deltaGross).toBe(52);
    expect(second.deltaExVat).toBe(43.7);
    expect(second.deltaVat).toBe(8.3);
    expect(second.line).toEqual({ price: 91, priceWithoutVAT: 76.47, priceVAT: 14.53, printApiPrice: 60 });
  });

  it('books the difference on the order totals and leaves the rest', () => {
    const before = {
      totalPrice: 125.64,
      totalPriceWithoutTax: 105.58,
      productPriceWithoutTax: 104.2,
      productVATPrice: 20.06,
      totalVATPrice: 19.8,
      profit: 12.6,
    };
    expect(paymentTotalsAfter(before, second)).toEqual({
      totalPrice: 177.64,
      totalPriceWithoutTax: 149.28,
      productPriceWithoutTax: 147.9,
      productVATPrice: 28.36,
      totalVATPrice: 28.1,
      profit: 56.3,
    });
  });

  it('gives back what was paid per set when a set goes', () => {
    const fewer = setsPricing({ from: 2, to: 1, listPricePerSet: 0, linePrice: 91, printApiPrice: 60, taxRate: 19 });
    expect(fewer.perSet).toBe(45.5);
    expect(fewer.deltaGross).toBe(-45.5);
    expect(fewer.line).toEqual({ price: 45.5, priceWithoutVAT: 38.24, priceVAT: 7.26, printApiPrice: 30 });
  });

  it('prices more than one extra set at once', () => {
    const p = setsPricing({ from: 1, to: 3, listPricePerSet: 52, linePrice: 52, printApiPrice: 0, taxRate: 21 });
    expect(p.deltaGross).toBe(104);
    expect(p.deltaExVat).toBe(85.95);
    expect(p.line.price).toBe(156);
  });
});
