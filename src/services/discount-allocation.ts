/**
 * Pure money math for discounts. No I/O, so it is unit-testable and shared
 * between payment creation (src/mollie.ts) and the invoice renderer.
 *
 * All inputs are VAT-inclusive EUR amounts as returned by
 * `calculateOrder()`. A discount is treated as a price reduction on the
 * goods first (products + add-ons, one tax rate) and only spills over onto
 * shipping when the vouchers exceed the goods. That keeps VAT on shipping
 * intact for the common case and makes the invoice lines add up.
 */

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Gross → ex-VAT for a VAT-inclusive amount at `rate` percent. */
export function exVat(gross: number, rate: number): number {
  return round2(gross / (1 + (rate || 0) / 100));
}

export interface DiscountBase {
  /** Products incl. VAT, after fast-track surcharge and volume discount. */
  productsGross: number;
  /** Gift box, QRGames and App Designer fees incl. VAT. */
  addonsGross: number;
  volumeDiscount: number;
  shippingGross: number;
  /** Order total incl. VAT before discount codes. */
  total: number;
  taxRate: number;
  taxRateShipping: number;
}

/**
 * Derive the discount base from a `calculateOrder()` result. `total` already
 * has shipping, add-ons and the volume discount folded in, so the product
 * share is what is left after taking the known parts back out.
 */
export function buildDiscountBase(calc: any): DiscountBase {
  const total = Number(calc?.total) || 0;
  // calculateOrder returns the shipping cost as both `shipping` and `payment`.
  const shippingGross = Number(calc?.shipping ?? calc?.payment) || 0;
  const boxFee = Number(calc?.boxFee) || 0;
  const gamesFee = Number(calc?.gamesFee) || 0;
  const appDesignFee = Number(calc?.appDesignFee) || 0;
  const addonsGross = round2(boxFee + gamesFee + appDesignFee);
  const productsGross = round2(
    Math.max(0, total - shippingGross - addonsGross)
  );
  return {
    productsGross,
    addonsGross,
    volumeDiscount: Number(calc?.volumeDiscount) || 0,
    shippingGross,
    total,
    taxRate: Number(calc?.taxRate) || 0,
    taxRateShipping: Number(calc?.taxRateShipping) || 0,
  };
}

export interface DiscountAllocation {
  totalDiscount: number;
  discountGoods: number;
  discountShipping: number;
  discountGoodsExcl: number;
  discountShippingExcl: number;
  discountShippingVAT: number;
  discountWithoutTax: number;
  discountVAT: number;
}

export function allocateDiscount(
  totalDiscount: number,
  base: Pick<
    DiscountBase,
    'productsGross' | 'addonsGross' | 'shippingGross' | 'taxRate' | 'taxRateShipping'
  >
): DiscountAllocation {
  const discount = round2(Math.max(0, totalDiscount));
  const goodsGross = round2(base.productsGross + base.addonsGross);
  const discountGoods = round2(Math.min(discount, goodsGross));
  const discountShipping = round2(
    Math.min(discount - discountGoods, base.shippingGross)
  );
  const discountGoodsExcl = exVat(discountGoods, base.taxRate);
  const discountShippingExcl = exVat(discountShipping, base.taxRateShipping);
  const discountWithoutTax = round2(discountGoodsExcl + discountShippingExcl);
  return {
    totalDiscount: discount,
    discountGoods,
    discountShipping,
    discountGoodsExcl,
    discountShippingExcl,
    discountShippingVAT: round2(discountShipping - discountShippingExcl),
    discountWithoutTax,
    discountVAT: round2(discountGoods + discountShipping - discountWithoutTax),
  };
}

/**
 * VAT actually collected on the goods (products + add-ons) after the goods
 * share of the discount. `rate / (100 + rate)` extracts VAT from a gross
 * amount.
 */
export function goodsVatAfterDiscount(
  goodsGross: number,
  discountGoods: number,
  taxRate: number
): number {
  const rate = taxRate || 0;
  if (rate <= 0) return 0;
  const net = Math.max(0, goodsGross - discountGoods);
  return round2((net * rate) / (100 + rate));
}
