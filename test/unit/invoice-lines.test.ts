import { describe, it, expect } from 'vitest';
import {
  buildInvoiceLines,
  interpolate,
  makeTranslator,
} from '../../src/services/invoice-lines';

/**
 * Invoice arithmetic for pricingVersion 2 payments. The rows must
 * reconcile: ex-VAT lines sum to the subtotal, VAT lines to the VAT summary,
 * and subtotal + VAT equals the total the customer paid.
 */

const t = makeTranslator({
  giftcard: 'Gift card',
  giftBox: 'Gift box',
  qrGames: 'QRGames',
  shippingAndHandling: 'Shipping and handling',
  volumeDiscount: 'Volume discount',
  discountPercentLine: 'Discount {{code}} ({{percent}}%)',
  discountCodeLine: 'Discount code {{code}}',
});

const sum = (lines: any[], key: string) =>
  Math.round(lines.reduce((s, l) => s + l[key], 0) * 100) / 100;

// €25 incl. 21% + €2.99 shipping, SUMMER10 (10% → 2.50) + €5 voucher.
const workedExample = {
  pricingVersion: 2,
  reverseCharge: false,
  taxRate: 21,
  taxRateShipping: 21,
  totalPrice: 20.49,
  totalPriceWithoutTax: 16.93,
  totalVATPrice: 3.56,
  productPriceWithoutTax: 20.66,
  productVATPrice: 3.04,
  shipping: 2.99,
  shippingPriceWithoutTax: 2.47,
  shippingVATPrice: 0.52,
  boxFee: 0,
  gamesFee: 0,
  volumeDiscount: 0,
  discount: 7.5,
  discountPercent: 10,
  discountPercentAmount: 2.5,
  discountCodes: 'SUMMER10 (10%), GIFT-AB12',
  discountWithoutTax: 6.2,
  discountVAT: 1.3,
  discountShipping: 0,
};

const playlists = [
  { name: 'Best Hits', productType: 'cards', price: 25, priceVAT: 4.34, amount: 1 },
];

describe('interpolate / makeTranslator', () => {
  it('fills {{vars}} and leaves unknown keys as the key', () => {
    expect(interpolate('Hi {{ name }}!', { name: 'Rick' })).toBe('Hi Rick!');
    expect(interpolate('{{missing}}')).toBe('');
    expect(t('nope')).toBe('nope');
  });
});

describe('buildInvoiceLines', () => {
  it('renders the worked example so that every column reconciles', () => {
    const { lines, summary } = buildInvoiceLines(
      workedExample,
      playlists,
      'physical',
      t
    );

    expect(lines.map((l) => [l.kind, l.description, l.totalExcl, l.vat, l.totalIncl])).toEqual([
      ['product', 'Best Hits', 20.66, 4.34, 25],
      ['shipping', 'Shipping and handling', 2.47, 0.52, 2.99],
      ['discountPercent', 'Discount SUMMER10 (10%)', -2.07, -0.43, -2.5],
      ['discountCode', 'Discount code GIFT-AB12', -4.13, -0.87, -5],
    ]);

    expect(sum(lines, 'totalExcl')).toBe(summary.subtotalExcl);
    expect(sum(lines, 'vat')).toBe(summary.goodsVat + summary.shippingVat);
    expect(sum(lines, 'totalIncl')).toBe(summary.totalIncl);
    expect(summary).toEqual({
      subtotalExcl: 16.93,
      goodsVatBase: 14.46,
      goodsVat: 3.04,
      shippingVatBase: 2.47,
      shippingVat: 0.52,
      totalIncl: 20.49,
    });
  });

  it('shows add-ons and the volume discount as their own lines', () => {
    const payment = {
      ...workedExample,
      totalPrice: 30,
      totalPriceWithoutTax: 24.79,
      totalVATPrice: 5.21,
      productVATPrice: 5.21,
      shipping: 0,
      shippingPriceWithoutTax: 0,
      shippingVATPrice: 0,
      boxFee: 6,
      gamesFee: 5,
      volumeDiscount: 6,
      discount: 0,
      discountPercent: null,
      discountPercentAmount: 0,
      discountCodes: null,
      discountWithoutTax: 0,
      discountVAT: 0,
    };
    const { lines } = buildInvoiceLines(
      payment,
      [{ ...playlists[0], boxEnabled: true, boxQuantity: 2, gamesEnabled: true }],
      'digital',
      t
    );
    expect(lines.map((l) => [l.kind, l.quantity, l.totalIncl])).toEqual([
      ['product', 1, 25],
      ['box', 2, 6],
      ['games', 1, 5],
      ['volumeDiscount', 1, -6],
    ]);
    expect(lines.find((l) => l.kind === 'box')!.unitExcl).toBe(2.48);
  });

  it('adds App Designer bought at checkout as one line at the goods rate', () => {
    const payment = {
      ...workedExample,
      totalPrice: 34,
      totalPriceWithoutTax: 28.1,
      totalVATPrice: 5.9,
      productVATPrice: 5.9,
      shipping: 0,
      shippingPriceWithoutTax: 0,
      shippingVATPrice: 0,
      appDesignFee: 9,
      discount: 0,
      discountPercent: null,
      discountPercentAmount: 0,
      discountCodes: null,
      discountWithoutTax: 0,
      discountVAT: 0,
    };
    const translate = makeTranslator({ appDesigner: 'App Designer (one-off, for your whole account)' });
    const { lines, summary } = buildInvoiceLines(payment, playlists, 'digital', translate);
    const line = lines.find((l) => l.kind === 'appDesign')!;
    expect(line).toEqual({
      kind: 'appDesign',
      description: 'App Designer (one-off, for your whole account)',
      quantity: 1,
      unitExcl: 7.44,
      totalExcl: 7.44,
      rate: 21,
      vat: 1.56,
      totalIncl: 9,
    });
    // The lines still add up to what was paid.
    expect(sum(lines, 'totalIncl')).toBe(summary.totalIncl);

    const reverse = buildInvoiceLines(
      { ...payment, reverseCharge: true, taxRate: 0 },
      playlists,
      'digital',
      translate
    ).lines.find((l) => l.kind === 'appDesign')!;
    expect(reverse).toMatchObject({ totalExcl: 9, vat: 0, rate: null });
  });

  it('prints no VAT under reverse charge', () => {
    const { lines, summary } = buildInvoiceLines(
      { ...workedExample, reverseCharge: true, taxRate: 0, taxRateShipping: 0 },
      playlists,
      'physical',
      t
    );
    expect(lines.every((l) => l.rate === null && l.vat === 0)).toBe(true);
    expect(summary.goodsVat).toBe(0);
    expect(summary.shippingVat).toBe(0);
  });

  it('leaves out shipping for digital orders and labels gift cards', () => {
    const { lines } = buildInvoiceLines(
      { ...workedExample, discount: 0, discountPercentAmount: 0, discountWithoutTax: 0, discountVAT: 0 },
      [{ productType: 'giftcard', price: 25, priceVAT: 4.34, amount: 1 }],
      'digital',
      t
    );
    expect(lines.map((l) => l.kind)).toEqual(['product']);
    expect(lines[0].description).toBe('Gift card');
  });
});
