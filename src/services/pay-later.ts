/**
 * Order lines and addresses for Mollie's pay-later methods (Klarna, in3,
 * Riverty). Pure, no I/O, so it is unit-testable.
 *
 * Mollie only offers those methods when the payment carries `lines` that add
 * up to its amount and a billing address with a given and family name,
 * street, postal code, city, country and e-mail. Without them it leaves the
 * methods out of the checkout without an error: until 2026-10 payments were
 * created with neither, and in two years not one customer paid with Klarna
 * although it was activated and on the homepage badges.
 *
 * `payLaterDetails()` returns null when an order cannot carry them, and the
 * payment is then created as before (pay-later just does not show):
 *  - no complete postal address (digital orders are not asked for one);
 *  - a gift card in the cart (stored value is the classic pay-later fraud,
 *    and the pay-later providers do not finance it);
 *  - a name Mollie refuses (one word, or a part under two characters);
 *  - lines that cannot add up to the charged amount.
 *
 * Amounts are worked in minor units (cents) of the charged currency. Every
 * line except the products is converted on its own; the products take what
 * is left of the charged amount, so the conversion's rounding and snapping
 * (NOK to 5, HUF to 100) end up in them and the lines always add up.
 */
import type { DiscountAllocation, DiscountBase } from './discount-allocation';

export interface PayLaterLabels {
  playlist: string;
  giftBox: string;
  qrGames: string;
  appDesigner: string;
  shipping: string;
  discount: string;
}

/** The checkout form's fields (`extraOrderData`). */
export interface PayLaterOrder {
  fullname?: string;
  email?: string;
  address?: string;
  housenumber?: string;
  zipcode?: string;
  city?: string;
  countrycode?: string;
  differentInvoiceAddress?: boolean;
  invoiceAddress?: string;
  invoiceHousenumber?: string;
  invoiceZipcode?: string;
  invoiceCity?: string;
  invoiceCountrycode?: string;
}

export interface PayLaterItem {
  productType?: string;
  type?: string;
  playlistName?: string;
  amount?: number;
  price?: number;
}

export interface PayLaterInput {
  items: PayLaterItem[];
  /** From buildDiscountBase(): EUR incl. VAT, before discount codes. */
  base: Pick<
    DiscountBase,
    'productsGross' | 'shippingGross' | 'taxRate' | 'taxRateShipping'
  >;
  /** The add-ons inside `base.addonsGross`, EUR incl. VAT. */
  fees: { boxFee?: number; gamesFee?: number; appDesignFee?: number };
  allocation: Pick<DiscountAllocation, 'discountGoods' | 'discountShipping'>;
  /** What Mollie charges: the currency and the amount in it. */
  currency: string;
  amount: number;
  /** EUR → charged currency, the rate `amount` was converted at (1 for EUR). */
  rate: number;
  /** Decimals the currency is charged in (HUF: 0). */
  decimals: number;
  /** The step the charged amount was snapped to, in major units (0: cents). */
  snap: number;
  order: PayLaterOrder;
  labels: PayLaterLabels;
}

interface MollieAmount {
  currency: string;
  value: string;
}

export interface PayLaterLine {
  type: 'physical' | 'digital' | 'shipping_fee' | 'discount';
  description: string;
  quantity: number;
  unitPrice: MollieAmount;
  totalAmount: MollieAmount;
  vatRate: string;
  vatAmount: MollieAmount;
}

export interface PayLaterAddress {
  givenName: string;
  familyName: string;
  streetAndNumber: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
}

export interface PayLaterDetails {
  lines: PayLaterLine[];
  billingAddress: PayLaterAddress;
  shippingAddress: PayLaterAddress;
}

interface DraftLine {
  type: PayLaterLine['type'];
  description: string;
  minor: number;
  vatRate: number;
}

const DESCRIPTION_MAX = 200;

const text = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

/** Mollie: at least two characters, and not only digits. */
const validNamePart = (part: string): boolean =>
  part.length >= 2 && !/^\d+$/.test(part);

/**
 * "Jan van der Berg" → Jan / van der Berg: split at the first space, so the
 * family name keeps its prefix. Null for a name Mollie would refuse.
 */
export function splitName(
  fullname: string | undefined
): { givenName: string; familyName: string } | null {
  const name = text(fullname);
  const space = name.indexOf(' ');
  if (space < 0) return null;
  const givenName = name.slice(0, space);
  const familyName = name.slice(space + 1);
  return validNamePart(givenName) && validNamePart(familyName)
    ? { givenName, familyName }
    : null;
}

function postalAddress(
  street: unknown,
  number: unknown,
  postalCode: unknown,
  city: unknown,
  country: unknown
): Omit<PayLaterAddress, 'givenName' | 'familyName' | 'email'> | null {
  const streetName = text(street);
  const houseNumber = text(number);
  const zip = text(postalCode);
  const town = text(city);
  const cc = text(country).toUpperCase();
  if (!streetName || !zip || !town || cc.length !== 2) return null;
  return {
    streetAndNumber: houseNumber ? `${streetName} ${houseNumber}` : streetName,
    postalCode: zip,
    city: town,
    country: cc,
  };
}

/** Sign-symmetric rounding to a multiple of `step`. */
function roundTo(value: number, step: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) / step) * step;
}

/** EUR → minor units of the charged currency, at its decimals. */
function toMinor(eur: number, rate: number, decimals: number): number {
  const cents = roundTo(Number((eur * rate * 100).toFixed(6)), 1);
  return decimals >= 2 ? cents : roundTo(cents, 10 ** (2 - decimals));
}

const formatMinor = (minor: number): string => (minor / 100).toFixed(2);

/** Mollie's formula: totalAmount × vatRate / (100 + vatRate), to the cent. */
const vatMinor = (minor: number, rate: number): number =>
  rate > 0 ? roundTo((minor * rate) / (100 + rate), 1) : 0;

/**
 * Split `total` over `weights` in multiples of `step`, the remainder going to
 * the heaviest share, so the parts add up to `total` exactly.
 */
function splitProportionally(
  total: number,
  weights: number[],
  step: number
): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const parts = weights.map((w) => roundTo((total * w) / sum, step));
  const heaviest = weights.indexOf(Math.max(...weights));
  parts[heaviest] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

function itemDescription(item: PayLaterItem, labels: PayLaterLabels): string {
  const name = text(item.playlistName);
  const label = name ? `${labels.playlist}: ${name}` : labels.playlist;
  const amount = Math.max(1, Math.floor(Number(item.amount) || 1));
  return amount > 1 ? `${amount}× ${label}` : label;
}

export function payLaterDetails(input: PayLaterInput): PayLaterDetails | null {
  const { base, fees, allocation, rate, decimals, labels, order } = input;

  if (input.items.length === 0) return null;
  if (input.items.some((item) => item.productType === 'giftcard')) return null;

  const name = splitName(order.fullname);
  const email = text(order.email);
  if (!name || !email) return null;

  const delivery = postalAddress(
    order.address,
    order.housenumber,
    order.zipcode,
    order.city,
    order.countrycode
  );
  if (!delivery) return null;
  const invoice = order.differentInvoiceAddress
    ? postalAddress(
        order.invoiceAddress,
        order.invoiceHousenumber,
        order.invoiceZipcode,
        order.invoiceCity,
        order.invoiceCountrycode
      )
    : null;

  const goodsRate = Number(base.taxRate) || 0;
  const shippingRate = Number(base.taxRateShipping) || 0;
  const minor = (eur: number | undefined) =>
    toMinor(Number(eur) || 0, rate, decimals);

  // Everything but the products, each converted on its own.
  const others: DraftLine[] = [
    { type: 'physical', description: labels.giftBox, minor: minor(fees.boxFee), vatRate: goodsRate },
    { type: 'digital', description: labels.qrGames, minor: minor(fees.gamesFee), vatRate: goodsRate },
    { type: 'digital', description: labels.appDesigner, minor: minor(fees.appDesignFee), vatRate: goodsRate },
    { type: 'shipping_fee', description: labels.shipping, minor: minor(base.shippingGross), vatRate: shippingRate },
    { type: 'discount', description: labels.discount, minor: -minor(allocation.discountGoods), vatRate: goodsRate },
    {
      type: 'discount',
      description: `${labels.discount} (${labels.shipping.toLowerCase()})`,
      minor: -minor(allocation.discountShipping),
      vatRate: shippingRate,
    },
  ].filter((line) => line.minor !== 0) as DraftLine[];

  // The products take what is left of the charged amount. They may absorb
  // the snap and a rounding step per line, never a missing line.
  const step = 10 ** (2 - Math.min(decimals, 2));
  const targetMinor = Math.round(input.amount * 100);
  const productsMinor =
    targetMinor - others.reduce((sum, line) => sum + line.minor, 0);
  const slack = ((Number(input.snap) || 0) * 100) / 2 + step * (others.length + 2);
  if (
    productsMinor < 0 ||
    Math.abs(productsMinor - minor(base.productsGross)) > slack
  ) {
    return null;
  }

  const products = splitProportionally(
    productsMinor,
    input.items.map((item) =>
      Math.max(0, (Number(item.price) || 0) * (Number(item.amount) || 1))
    ),
    step
  ).map(
    (part, i): DraftLine => ({
      type: input.items[i].type === 'digital' ? 'digital' : 'physical',
      description: itemDescription(input.items[i], labels),
      minor: part,
      vatRate: goodsRate,
    })
  );

  const drafts = [...products, ...others];
  if (drafts.reduce((sum, line) => sum + line.minor, 0) !== targetMinor) {
    return null;
  }

  const amount = (value: number): MollieAmount => ({
    currency: input.currency,
    value: formatMinor(value),
  });
  const lines = drafts.map(
    (line): PayLaterLine => ({
      type: line.type,
      description: line.description.slice(0, DESCRIPTION_MAX),
      quantity: 1,
      unitPrice: amount(line.minor),
      totalAmount: amount(line.minor),
      vatRate: line.vatRate.toFixed(2),
      vatAmount: amount(vatMinor(line.minor, line.vatRate)),
    })
  );

  return {
    lines,
    billingAddress: { ...name, ...(invoice ?? delivery), email },
    shippingAddress: { ...name, ...delivery, email },
  };
}
