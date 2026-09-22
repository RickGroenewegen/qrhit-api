/**
 * The price of a company list as the customer is quoted it, and the invoice
 * amounts derived from it.
 *
 * The calculators work the client price out in the browser (printer cost,
 * the profit table, reseller or client price, forced prices) and save it with
 * the list as a `pricing` snapshot inside the variant's calculation JSON. The
 * Sell column, the invoice preview and the MoneyBird invoices are all built
 * from that snapshot. Invoices used to recompute the price on the server from
 * the printer cost alone, so they never matched the quotation.
 *
 * `src/app/shared/list-pricing.util.ts` in the frontend mirrors these
 * functions; keep the rounding identical.
 */

export type ListVariant = 'qrsong' | 'schneider';
export type PaymentOption = 'full' | 'down' | 'remaining';

export const DOWN_PAYMENT_FRACTION = 0.3;

export interface ListPricingExtra {
  key?: string;
  keyVars?: Record<string, any>;
  name: string;
  price: number;
}

export interface ListPricing {
  quantity: number;
  /** Per box or set, excl. VAT, what the customer pays. */
  unitPrice: number;
  /** One-off extras (cutting die, die-line drawing), not app or portal. */
  extras: ListPricingExtra[];
  customAppFee: number;
  votingPortalFee: number;
  discountPercent: number;
}

export interface ListPricingTotals {
  productTotal: number;
  extrasTotal: number;
  subtotal: number;
  discountAmount: number;
  /** Excl. VAT, after discount: what the full invoice adds up to. */
  total: number;
}

export interface PaymentAmounts {
  full: number;
  down: number;
  remaining: number;
}

/**
 * Round to cents. `toPrecision(15)` first strips binary noise, so 1.005 and
 * 2610.9 * 100 round the way they read.
 */
export function round2(n: number): number {
  return Math.round(Number((n * 100).toPrecision(15))) / 100;
}

/**
 * The price variant of a list's printer. Lists saved with the retired
 * OnzeVibe printer count as Schneider, the default.
 */
export function listPrinterVariant(printer: string | null | undefined): ListVariant {
  return printer === 'qrsong' ? 'qrsong' : 'schneider';
}

export function variantCalculationColumn(
  variant: ListVariant
): 'calculationTromp' | 'calculationSchneider' {
  return variant === 'qrsong' ? 'calculationTromp' : 'calculationSchneider';
}

function money(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function parseListPricing(raw: unknown): ListPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const quantity = money(r['quantity']);
  const unitPrice = money(r['unitPrice']);
  if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
    return null;
  }
  if (unitPrice === null || unitPrice < 0) return null;

  const extras: ListPricingExtra[] = [];
  for (const e of Array.isArray(r['extras']) ? r['extras'] : []) {
    // App and portal have fee fields and lines of their own.
    if (e?.key === 'customApp' || e?.key === 'votingPortal') continue;
    const price = money(e?.price);
    if (price === null || price <= 0) continue;
    extras.push({
      ...(typeof e.key === 'string' ? { key: e.key } : {}),
      ...(e.keyVars && typeof e.keyVars === 'object'
        ? { keyVars: e.keyVars }
        : {}),
      name: typeof e.name === 'string' ? e.name : '',
      price: round2(price),
    });
  }

  const fee = (v: unknown) => Math.max(0, round2(money(v) ?? 0));
  const discount = money(r['discountPercent']) ?? 0;

  return {
    quantity,
    unitPrice: round2(unitPrice),
    extras,
    customAppFee: fee(r['customAppFee']),
    votingPortalFee: fee(r['votingPortalFee']),
    discountPercent: Math.min(100, Math.max(0, discount)),
  };
}

/** The snapshot stored in a list's calculation JSON, or null. */
export function listPricingFromCalculation(
  calculation: string | null | undefined
): ListPricing | null {
  if (!calculation) return null;
  try {
    return parseListPricing(JSON.parse(calculation)?.pricing);
  } catch {
    return null;
  }
}

export function listPricingTotals(p: ListPricing): ListPricingTotals {
  const productTotal = round2(p.quantity * p.unitPrice);
  const extrasTotal = round2(p.extras.reduce((s, e) => s + e.price, 0));
  const subtotal = round2(
    productTotal + extrasTotal + p.customAppFee + p.votingPortalFee
  );
  const discountAmount =
    p.discountPercent > 0 ? round2((subtotal * p.discountPercent) / 100) : 0;
  return {
    productTotal,
    extrasTotal,
    subtotal,
    discountAmount,
    total: round2(subtotal - discountAmount),
  };
}

/**
 * What each invoice for a list comes to, excl. VAT. The remaining payment is
 * the total minus the down payment that was actually invoiced, so the two
 * always add up to the total, even when the price changed in between or the
 * down payment was edited in MoneyBird.
 */
export function paymentAmounts(
  total: number,
  downPaymentInvoiced?: number | null
): PaymentAmounts {
  const down = round2(total * DOWN_PAYMENT_FRACTION);
  const alreadyInvoiced =
    downPaymentInvoiced != null && Number.isFinite(downPaymentInvoiced)
      ? downPaymentInvoiced
      : down;
  return { full: total, down, remaining: round2(total - alreadyInvoiced) };
}
