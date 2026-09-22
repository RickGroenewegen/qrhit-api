import { describe, it, expect } from 'vitest';
import {
  allocateDiscount,
  buildDiscountBase,
  goodsVatAfterDiscount,
  round2,
  exVat,
} from '../../src/services/discount-allocation';

/**
 * Pure money math shared by payment creation and the invoice. The worked
 * example throughout: €25 product incl. 21% VAT, €2.99 NL shipping, a 10%
 * code (€2.50) and a €5 voucher.
 */

describe('buildDiscountBase', () => {
  it('derives the product share from the calculated total', () => {
    const base = buildDiscountBase({
      total: 37.99, // 25 products + 2.99 shipping + 10 add-ons
      shipping: 2.99,
      payment: 2.99,
      boxFee: 6,
      gamesFee: 4,
      volumeDiscount: 0,
      taxRate: 21,
      taxRateShipping: 21,
    });
    expect(base).toEqual({
      productsGross: 25,
      addonsGross: 10,
      volumeDiscount: 0,
      shippingGross: 2.99,
      total: 37.99,
      taxRate: 21,
      taxRateShipping: 21,
    });
  });

  it('counts App Designer bought at checkout as an add-on, not as product revenue', () => {
    const base = buildDiscountBase({
      total: 43,
      shipping: 0,
      boxFee: 6,
      gamesFee: 3,
      appDesignFee: 9,
      taxRate: 21,
    });
    expect(base.addonsGross).toBe(18);
    expect(base.productsGross).toBe(25);
  });

  it('falls back to `payment` for shipping and never goes negative', () => {
    const base = buildDiscountBase({ total: 1, payment: '2.99', boxFee: 5 });
    expect(base.shippingGross).toBe(2.99);
    expect(base.productsGross).toBe(0);
  });
});

describe('allocateDiscount', () => {
  const base = {
    productsGross: 25,
    addonsGross: 0,
    shippingGross: 2.99,
    taxRate: 21,
    taxRateShipping: 21,
  };

  it('covers the goods first and splits the ex-VAT / VAT share', () => {
    const a = allocateDiscount(7.5, base);
    expect(a).toEqual({
      totalDiscount: 7.5,
      discountGoods: 7.5,
      discountShipping: 0,
      discountGoodsExcl: 6.2,
      discountShippingExcl: 0,
      discountShippingVAT: 0,
      discountWithoutTax: 6.2,
      discountVAT: 1.3,
    });
  });

  it('spills over onto shipping only when the goods are fully covered', () => {
    const a = allocateDiscount(27.99, base);
    expect(a.discountGoods).toBe(25);
    expect(a.discountShipping).toBe(2.99);
    expect(a.discountShippingExcl).toBe(2.47);
    expect(a.discountShippingVAT).toBe(0.52);
    expect(a.discountWithoutTax).toBe(20.66 + 2.47);
    expect(a.discountVAT).toBe(round2(27.99 - 23.13));
  });

  it('never allocates more than goods + shipping, or a negative amount', () => {
    expect(allocateDiscount(100, base).discountShipping).toBe(2.99);
    expect(allocateDiscount(-3, base).totalDiscount).toBe(0);
  });

  it('has no VAT share under reverse charge', () => {
    const a = allocateDiscount(7.5, { ...base, taxRate: 0, taxRateShipping: 0 });
    expect(a.discountWithoutTax).toBe(7.5);
    expect(a.discountVAT).toBe(0);
  });
});

describe('goodsVatAfterDiscount', () => {
  it('extracts VAT from the discounted gross', () => {
    expect(goodsVatAfterDiscount(25, 7.5, 21)).toBe(3.04);
    expect(goodsVatAfterDiscount(25, 0, 21)).toBe(4.34);
    expect(goodsVatAfterDiscount(25, 25, 21)).toBe(0);
  });

  it('is zero at a zero rate', () => {
    expect(goodsVatAfterDiscount(25, 0, 0)).toBe(0);
  });
});

describe('rounding helpers', () => {
  it('rounds half-cents the way money is rounded', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(exVat(25, 21)).toBe(20.66);
    expect(exVat(10, 0)).toBe(10);
  });
});
