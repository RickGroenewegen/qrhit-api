import { describe, it, expect } from 'vitest';
import {
  allocateDiscount,
  buildDiscountBase,
  digitalGoodsGross,
  goodsVatAfterDiscount,
  percentCodeAmount,
  splitPercentsApplied,
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

/**
 * A percent code with its own digital percentage (`percentDigital`), e.g.
 * BF2026: 50% off digital, 10% off printed cards and sheets.
 */
describe('digitalGoodsGross', () => {
  const digital = { type: 'digital', productType: 'cards', price: 13, amount: 1 };
  const physical = { type: 'physical', productType: 'cards', price: 34, amount: 1 };
  const sheets = { type: 'sheets', productType: 'cards', price: 20, amount: 1 };

  it('is the whole goods for an all-digital order, App Designer and QRGames included', () => {
    expect(
      digitalGoodsGross({
        items: [{ ...digital, gamesEnabled: true }],
        productsGross: 13,
        volumeDiscount: 0,
        gamesFee: 3,
        appDesignFee: 9,
      })
    ).toBe(25);
  });

  it('is 0 without a digital playlist (cards and sheets are physical)', () => {
    expect(
      digitalGoodsGross({
        items: [physical, sheets],
        productsGross: 54,
        volumeDiscount: 0,
        gamesFee: 0,
        appDesignFee: 9,
      })
    ).toBe(0);
  });

  it('takes a digital playlist\'s own share in a mixed order, with its QRGames', () => {
    // 13 + 34 products, QRGames on both (2 x 3), App Designer goes with the
    // physical order
    expect(
      digitalGoodsGross({
        items: [
          { ...digital, gamesEnabled: true },
          { ...physical, gamesEnabled: true },
        ],
        productsGross: 47,
        volumeDiscount: 0,
        gamesFee: 6,
        appDesignFee: 9,
      })
    ).toBe(16);
  });

  it('keeps fast track proportional and the volume discount on digital', () => {
    // Fast track: (13 + 13 + 34) x 1.2 = 72, volume discount 2 on the digital pair
    expect(
      digitalGoodsGross({
        items: [digital, digital, physical],
        productsGross: 70,
        volumeDiscount: 2,
        gamesFee: 0,
        appDesignFee: 0,
      })
    ).toBe(round2(72 * (26 / 60) - 2));
  });

  // calculateOrder charges price x amount for cards and gift card lines only;
  // a line it charged nothing for must not count as digital, or a printed
  // order would get the digital percentage (uncapped on BF2026)
  it('ignores a digital line with amount 0 that was charged nothing', () => {
    expect(
      digitalGoodsGross({
        items: [physical, { ...digital, price: 10000, amount: 0 }],
        productsGross: 34,
        volumeDiscount: 0,
        gamesFee: 0,
        appDesignFee: 0,
      })
    ).toBe(0);
  });

  it('ignores a digital line of a product type that is not charged', () => {
    expect(
      digitalGoodsGross({
        items: [physical, { ...digital, productType: 'something', price: 10000 }],
        productsGross: 34,
        volumeDiscount: 0,
        gamesFee: 0,
        appDesignFee: 0,
      })
    ).toBe(0);
  });

  it('counts a gift card as goods that are not digital', () => {
    // 13 digital + 50 gift card: only the 13 is digital, App Designer too
    // since nothing is shipped
    const giftcard = { type: 'digital', productType: 'giftcard', price: 50, amount: 1 };
    expect(
      digitalGoodsGross({
        items: [digital, giftcard],
        productsGross: 63,
        volumeDiscount: 0,
        gamesFee: 0,
        appDesignFee: 9,
      })
    ).toBe(22);
  });
});

describe('percentCodeAmount', () => {
  it('takes `percent` off everything for a code without a digital percentage, as before', () => {
    expect(percentCodeAmount({ percent: 10 }, 47, 13)).toBe(4.7);
    expect(percentCodeAmount({ percent: 10, percentDigital: null }, 47, undefined)).toBe(4.7);
  });

  it('takes each percentage off its own share', () => {
    const bf = { percent: 10, percentDigital: 50 };
    expect(percentCodeAmount(bf, 13, 13)).toBe(6.5); // all digital
    expect(percentCodeAmount(bf, 34, 0)).toBe(3.4); // all physical
    expect(percentCodeAmount(bf, 47, 13)).toBe(round2(6.5 + 3.4)); // mixed
  });

  it('caps a code without a digital percentage as a whole, as before', () => {
    expect(percentCodeAmount({ percent: 50, maxDiscountAmount: 5 }, 25, 25)).toBe(5);
  });

  it('caps each part of a split code with its own maximum, none when empty', () => {
    // BF2026: 50% digital without a maximum, 10% printed at most €10
    const bf = { percent: 10, maxDiscountAmount: 10, percentDigital: 50, maxDiscountAmountDigital: null };
    expect(percentCodeAmount(bf, 26, 26)).toBe(13); // two digital playlists: no maximum
    expect(percentCodeAmount(bf, 150, 0)).toBe(10); // printed: capped at 10
    expect(percentCodeAmount(bf, 176, 26)).toBe(23); // 13 + 10
    expect(percentCodeAmount({ ...bf, maxDiscountAmountDigital: 8 }, 26, 26)).toBe(8);
  });

  it('treats a missing digital share as physical and never exceeds the goods', () => {
    const bf = { percent: 10, percentDigital: 50 };
    expect(percentCodeAmount(bf, 34, undefined)).toBe(3.4);
    expect(percentCodeAmount(bf, 10, 99)).toBe(5);
  });
});

describe('splitPercentsApplied', () => {
  const bf = { percent: 10, percentDigital: 50 };

  it('is null for a code without a digital percentage', () => {
    expect(splitPercentsApplied({ percent: 10 }, 47, 13)).toBeNull();
  });

  it('names the percentages the order gets', () => {
    expect(splitPercentsApplied(bf, 13, 13)).toEqual({ digital: 50, physical: null });
    expect(splitPercentsApplied(bf, 34, 0)).toEqual({ digital: null, physical: 10 });
    expect(splitPercentsApplied(bf, 47, 13)).toEqual({ digital: 50, physical: 10 });
    expect(splitPercentsApplied(bf, 0, 0)).toEqual({ digital: null, physical: 10 });
  });
});

describe('buildDiscountBase with the cart', () => {
  it('adds the digital share only when the items are passed', () => {
    const calc = { total: 47, shipping: 0, gamesFee: 0, taxRate: 21 };
    expect(buildDiscountBase(calc).digitalGoodsGross).toBeUndefined();
    expect(
      buildDiscountBase(calc, [
        { type: 'digital', productType: 'cards', price: 13, amount: 1 },
        { type: 'physical', productType: 'cards', price: 34, amount: 1 },
      ]).digitalGoodsGross
    ).toBe(13);
  });
});
