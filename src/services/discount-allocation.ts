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
  /**
   * The digital share of the goods (products + add-ons) incl. VAT, for a
   * percent code with its own digital percentage (`percentDigital`). Only
   * set when the cart's items were passed; see `digitalGoodsGross`.
   */
  digitalGoodsGross?: number;
}

/**
 * Derive the discount base from a `calculateOrder()` result. `total` already
 * has shipping, add-ons and the volume discount folded in, so the product
 * share is what is left after taking the known parts back out. With the
 * cart's items the digital share of the goods comes along.
 */
export function buildDiscountBase(calc: any, items?: any[]): DiscountBase {
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
  const volumeDiscount = Number(calc?.volumeDiscount) || 0;
  const base: DiscountBase = {
    productsGross,
    addonsGross,
    volumeDiscount,
    shippingGross,
    total,
    taxRate: Number(calc?.taxRate) || 0,
    taxRateShipping: Number(calc?.taxRateShipping) || 0,
  };
  if (Array.isArray(items)) {
    base.digitalGoodsGross = digitalGoodsGross({
      items,
      productsGross,
      volumeDiscount,
      gamesFee,
      appDesignFee,
    });
  }
  return base;
}

/** Shipped to the customer: printed cards and sheets. */
function isPhysicalItem(item: any): boolean {
  return item?.type === 'physical' || item?.type === 'sheets';
}

/**
 * What part of the goods (products + add-ons, incl. VAT) is digital, so a
 * percent code can take a different percentage off digital and physical
 * (`percentDigital` on the code). The website's mirror is
 * `digitalGoodsGross` in qrhit's `shared/discount-math.util.ts`; change both.
 *
 * - A digital playlist's share of the products, from the items' own prices
 *   (fast track raises them all alike), less the volume discount, which only
 *   digital playlists get.
 * - QRGames follows its playlist (`gamesEnabled === true`, the rule
 *   calculateOrder charges by).
 * - The gift box is physical only, so never digital.
 * - App Designer is one per order: digital when nothing in the order is
 *   shipped, otherwise it goes with the physical order.
 *
 * A cart that is all digital gives the whole goods, one with nothing digital
 * gives 0, so the split only ever rounds in a mixed cart.
 */
export function digitalGoodsGross(input: {
  items: any[];
  productsGross: number;
  volumeDiscount: number;
  gamesFee: number;
  appDesignFee: number;
}): number {
  // Only the lines calculateOrder charges (cards and gift cards), each at what
  // it charged for it (price × amount), so a line charged nothing (amount 0,
  // an unknown product type) cannot move the goods under the digital
  // percentage. A gift card counts as goods but never as digital.
  const charged = (input.items || []).filter(
    (i) => i?.productType === 'cards' || i?.productType === 'giftcard'
  );
  const lineGross = (i: any): number => {
    const value = Number(i?.price) * Number(i?.amount);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const productsGross = Math.max(0, input.productsGross || 0);
  const volumeDiscount = Math.max(0, input.volumeDiscount || 0);
  const gamesFee = Math.max(0, input.gamesFee || 0);
  const appDesignFee = Math.max(0, input.appDesignFee || 0);
  const goods = round2(productsGross + gamesFee + appDesignFee);

  const cards = charged.filter((i) => i.productType === 'cards');
  const digital = cards.filter((i) => i.type === 'digital' && lineGross(i) > 0);
  if (digital.length === 0) return 0;
  const anyPhysical = cards.some((i) => isPhysicalItem(i) && Number(i.amount) > 0);
  const anyGiftcard = charged.some((i) => i.productType === 'giftcard' && lineGross(i) > 0);
  // The box fee is in the goods too, but only a physical order has one.
  if (!anyPhysical && !anyGiftcard) return goods;

  const sum = (list: any[]) => list.reduce((total, i) => total + lineGross(i), 0);
  const allRaw = sum(charged);
  const itemsGross = productsGross + volumeDiscount;
  const digitalProducts =
    allRaw > 0 ? Math.max(0, (itemsGross * sum(digital)) / allRaw - volumeDiscount) : 0;

  // calculateOrder charges QRGames per cards line with gamesEnabled
  const withGames = cards.filter((i) => i.gamesEnabled === true);
  const digitalGames =
    withGames.length > 0
      ? (gamesFee * withGames.filter((i) => i.type === 'digital').length) / withGames.length
      : 0;
  const digitalAppDesign = anyPhysical ? 0 : appDesignFee;

  return round2(Math.min(goods, digitalProducts + digitalGames + digitalAppDesign));
}

/**
 * EUR a percent code takes off the goods (`percentBase`: products + add-ons
 * incl. VAT), its maximum applied. A code without `percentDigital` takes
 * `percent` off everything and caps the whole at `maxDiscountAmount`, exactly
 * as before those columns existed. With it, the digital share
 * (`base.digitalGoodsGross`) gets `percentDigital` capped at
 * `maxDiscountAmountDigital`, and the rest (printed cards and sheets, the gift
 * box) gets `percent` capped at `maxDiscountAmount`; no maximum when null.
 */
export function percentCodeAmount(
  code: {
    percent: number | null;
    maxDiscountAmount?: number | null;
    percentDigital?: number | null;
    maxDiscountAmountDigital?: number | null;
  },
  percentBase: number,
  digitalGoods: number | undefined
): number {
  const capped = (amount: number, max: number | null | undefined) =>
    max ? Math.min(amount, max) : amount;
  if (code.percentDigital === null || code.percentDigital === undefined) {
    return capped(round2((percentBase * (code.percent || 0)) / 100), code.maxDiscountAmount);
  }
  const digital = Math.min(Math.max(0, digitalGoods || 0), percentBase);
  const physical = Math.max(0, percentBase - digital);
  return round2(
    capped(round2((digital * code.percentDigital) / 100), code.maxDiscountAmountDigital) +
      capped(round2((physical * (code.percent || 0)) / 100), code.maxDiscountAmount)
  );
}

/**
 * Which percentages of a split code an order gets: only the digital one, only
 * the physical one, or both (a mixed cart). Null for a code without a split.
 */
export function splitPercentsApplied(
  code: { percent: number | null; percentDigital?: number | null },
  percentBase: number,
  digitalGoods: number | undefined
): { digital: number | null; physical: number | null } | null {
  if (code.percentDigital === null || code.percentDigital === undefined) return null;
  const digital = Math.min(Math.max(0, digitalGoods || 0), percentBase);
  const physical = Math.max(0, percentBase - digital);
  return {
    digital: digital > 0 ? code.percentDigital : null,
    physical: physical > 0 || digital <= 0 ? code.percent : null,
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
