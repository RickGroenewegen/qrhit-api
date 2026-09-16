import { exVat, round2 } from './discount-allocation';

/**
 * Invoice arithmetic for payments written with `pricingVersion >= 2`.
 *
 * Product, add-on and shipping lines are shown at their pre-discount price;
 * discounts appear as negative lines with their own VAT share, so the ex-VAT
 * column sums to the subtotal, the VAT column to the VAT lines and both to
 * the total the customer paid. Everything is read from the Payment snapshot,
 * never from the mutable discount-use join.
 */

export type InvoiceLineKind =
  | 'product'
  | 'box'
  | 'games'
  | 'shipping'
  | 'volumeDiscount'
  | 'discountPercent'
  | 'discountCode';

export interface InvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unitExcl: number;
  totalExcl: number;
  /** null when reverse charged */
  rate: number | null;
  vat: number;
  totalIncl: number;
}

export interface InvoiceSummary {
  subtotalExcl: number;
  goodsVatBase: number;
  goodsVat: number;
  shippingVatBase: number;
  shippingVat: number;
  totalIncl: number;
}

export interface InvoiceLines {
  lines: InvoiceLine[];
  summary: InvoiceSummary;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** `{{code}}`-style interpolation for the plain locale bundle. */
export function interpolate(
  template: string,
  vars: Record<string, string | number> = {}
): string {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
    vars[key] !== undefined ? String(vars[key]) : ''
  );
}

export function makeTranslator(translations: Record<string, string>): Translate {
  return (key, vars) => interpolate(translations?.[key] ?? key, vars);
}

/**
 * Split "SUMMER10 (10%), GIFT-1234" into the percent code and the rest.
 */
function splitCodes(discountCodes: string | null | undefined): {
  percentCode: string;
  fixedCodes: string;
} {
  const parts = String(discountCodes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const percentCode = parts.find((p) => /\(\s*[\d.,]+%\s*\)$/.test(p)) || '';
  const fixedCodes = parts.filter((p) => p !== percentCode).join(', ');
  return {
    percentCode: percentCode.replace(/\s*\([^)]*\)$/, ''),
    fixedCodes,
  };
}

export function buildInvoiceLines(
  payment: any,
  playlists: any[],
  orderType: string,
  t: Translate
): InvoiceLines {
  const reverse = !!payment.reverseCharge;
  const rate = reverse ? null : Number(payment.taxRate) || 0;
  const shippingRate = reverse ? null : Number(payment.taxRateShipping) || 0;
  const lines: InvoiceLine[] = [];

  for (const pl of playlists || []) {
    const price = Number(pl.price) || 0;
    const vat = reverse ? 0 : Number(pl.priceVAT) || 0;
    const qty = Number(pl.amount) || 1;
    const totalExcl = round2(price - vat);
    lines.push({
      kind: 'product',
      description:
        pl.productType === 'giftcard' ? t('giftcard') : String(pl.name || ''),
      quantity: qty,
      unitExcl: round2(totalExcl / qty),
      totalExcl,
      rate,
      vat,
      totalIncl: price,
    });
  }

  const addonRate = Number(payment.taxRate) || 0;
  const boxFee = Number(payment.boxFee) || 0;
  if (boxFee > 0) {
    let boxQty = 0;
    for (const pl of playlists || []) {
      if (pl.boxEnabled) {
        boxQty += (Number(pl.boxQuantity) || 0) * (Number(pl.amount) || 1);
      }
    }
    if (boxQty < 1) boxQty = 1;
    const excl = reverse ? boxFee : exVat(boxFee, addonRate);
    lines.push({
      kind: 'box',
      description: t('giftBox'),
      quantity: boxQty,
      unitExcl: round2(excl / boxQty),
      totalExcl: excl,
      rate,
      vat: round2(boxFee - excl),
      totalIncl: boxFee,
    });
  }

  const gamesFee = Number(payment.gamesFee) || 0;
  if (gamesFee > 0) {
    let gamesQty = (playlists || []).filter((pl) => pl.gamesEnabled).length;
    if (gamesQty < 1) gamesQty = 1;
    const excl = reverse ? gamesFee : exVat(gamesFee, addonRate);
    lines.push({
      kind: 'games',
      description: t('qrGames'),
      quantity: gamesQty,
      unitExcl: round2(excl / gamesQty),
      totalExcl: excl,
      rate,
      vat: round2(gamesFee - excl),
      totalIncl: gamesFee,
    });
  }

  const shipping = Number(payment.shipping) || 0;
  const shippingVat = reverse ? 0 : Number(payment.shippingVATPrice) || 0;
  if (orderType !== 'digital' && shipping > 0) {
    const excl = round2(shipping - shippingVat);
    lines.push({
      kind: 'shipping',
      description: t('shippingAndHandling'),
      quantity: 1,
      unitExcl: excl,
      totalExcl: excl,
      rate: shippingRate,
      vat: shippingVat,
      totalIncl: shipping,
    });
  }

  const volumeDiscount = Number(payment.volumeDiscount) || 0;
  if (volumeDiscount > 0) {
    const excl = reverse ? volumeDiscount : exVat(volumeDiscount, addonRate);
    lines.push({
      kind: 'volumeDiscount',
      description: t('volumeDiscount'),
      quantity: 1,
      unitExcl: -excl,
      totalExcl: -excl,
      rate,
      vat: -round2(volumeDiscount - excl),
      totalIncl: -volumeDiscount,
    });
  }

  // Discount lines. The percent line gets its own ex-VAT/VAT split; the
  // voucher line takes the remainder so the two always sum exactly to the
  // stored discountWithoutTax / discountVAT.
  const discount = Number(payment.discount) || 0;
  const discountWithoutTax = Number(payment.discountWithoutTax) || 0;
  const discountVAT = Number(payment.discountVAT) || 0;
  const percentAmount = Number(payment.discountPercentAmount) || 0;
  const { percentCode, fixedCodes } = splitCodes(payment.discountCodes);
  let percentExcl = 0;
  let percentVat = 0;
  if (percentAmount > 0) {
    percentExcl = reverse ? percentAmount : exVat(percentAmount, addonRate);
    percentVat = round2(percentAmount - percentExcl);
    lines.push({
      kind: 'discountPercent',
      description: t('discountPercentLine', {
        code: percentCode,
        percent: payment.discountPercent ?? '',
      }),
      quantity: 1,
      unitExcl: -percentExcl,
      totalExcl: -percentExcl,
      rate,
      vat: -percentVat,
      totalIncl: -percentAmount,
    });
  }
  const fixedAmount = round2(discount - percentAmount);
  if (fixedAmount > 0) {
    const excl = reverse ? fixedAmount : round2(discountWithoutTax - percentExcl);
    const vat = reverse ? 0 : round2(discountVAT - percentVat);
    lines.push({
      kind: 'discountCode',
      description: t('discountCodeLine', { code: fixedCodes }),
      quantity: 1,
      unitExcl: -excl,
      totalExcl: -excl,
      rate,
      vat: -vat,
      totalIncl: -fixedAmount,
    });
  }

  const totalIncl = Number(payment.totalPrice) || 0;
  const totalVat = reverse ? 0 : Number(payment.totalVATPrice) || 0;
  const subtotalExcl = round2(
    Number(payment.totalPriceWithoutTax) || totalIncl - totalVat
  );
  const discountShippingExcl = exVat(
    Number(payment.discountShipping) || 0,
    Number(payment.taxRateShipping) || 0
  );
  const shippingVatBase =
    orderType !== 'digital'
      ? round2((Number(payment.shippingPriceWithoutTax) || 0) - discountShippingExcl)
      : 0;
  const shippingVatNet = round2(
    shippingVat - ((Number(payment.discountShipping) || 0) - discountShippingExcl)
  );
  const goodsVat = reverse ? 0 : Number(payment.productVATPrice) || 0;

  return {
    lines,
    summary: {
      subtotalExcl,
      goodsVatBase: round2(subtotalExcl - shippingVatBase),
      goodsVat,
      shippingVatBase,
      shippingVat: orderType !== 'digital' ? shippingVatNet : 0,
      totalIncl,
    },
  };
}
