/**
 * What a printed deck costs us and what we ask for it. One place for both
 * Print&Bind API versions (calculateSingleItem in printenbindV1.ts and
 * printenbindV2.ts) and for the "add more tracks" upgrade.
 *
 * The amounts are EUR ex VAT and come from Print&Bind's invoices, not from
 * their price list: our account has a fixed price per card whatever the deck
 * size. Print&Bind changed it three times without telling us (7.0 ct until
 * 13 Nov 2025, 7.7 ct until 28 Apr 2026, 8.0 ct until 26 Jun 2026, 7.9 ct
 * since), and until 2026-11-11 this formula still assumed 7.0 ct and a
 * handling of 1.80, so a printed deck earned about EUR 10.50 instead of the
 * EUR 12 it aims for. When an invoice shows another rate, change it here.
 */

/** One 60x60 mm card, colour, printed on both sides (invoice week 44 2026). */
export const CARD_PRINT_COST = 0.079;

/** Print&Bind's service cost per order. */
export const ORDER_SERVICE_COST = 1.5;

/**
 * What shipping a cut-card order costs us beyond what the customer pays for
 * it: checkout charges less than Print&Bind's delivery amount (NL EUR 2.47
 * against 3.45, DE 6.74 against 8.45) and a heavier deck moves to a dearer
 * parcel. Measured over 289 plain orders of 11 Sep to 10 Nov 2026 as the
 * printer's total minus the shipping charged: 2.49 + 0.0813 per card, of
 * which 1.50 + 0.079 is the print itself. Take these two out again once
 * checkout passes the printer's delivery amount on in full.
 */
export const SHIPPING_SHORTFALL_PER_ORDER = 0.99;
export const SHIPPING_SHORTFALL_PER_CARD = 0.0023;

/** One A4 sheet of 12 cards, both sides (invoiced at 0.28). */
export const SHEET_PRINT_COST = 0.09 * 2 + 0.104;

/** Handling assumed for a sheets order; unchanged, the sheets price is right. */
export const SHEET_ORDER_HANDLING = 1.8;

export const CARDS_PER_SHEET = 12;

/** A smaller deck is priced as this many cards. */
export const MINIMUM_CARDS = 50;

/** The price is the cost times this, but never less than cost + MIN_PROFIT. */
export const PROFIT_MARGIN = 1.5;
export const MIN_PROFIT = 12;

/** The quantity a deck is priced at. */
export function pricedQuantity(quantity: number): number {
  return quantity < MINIMUM_CARDS ? MINIMUM_CARDS : quantity;
}

/** Our cost of one printed deck, ex VAT, to cents. */
export function printedDeckCost(quantity: number, sheets: boolean): number {
  const cards = pricedQuantity(quantity);
  const cost = sheets
    ? Math.ceil(cards / CARDS_PER_SHEET) * SHEET_PRINT_COST + SHEET_ORDER_HANDLING
    : cards * (CARD_PRINT_COST + SHIPPING_SHORTFALL_PER_CARD) +
      ORDER_SERVICE_COST +
      SHIPPING_SHORTFALL_PER_ORDER;
  return parseFloat(cost.toFixed(2));
}

/** The ex-VAT price of a deck that costs `cost`. */
export function priceWithProfit(cost: number): number {
  const withMargin = cost * PROFIT_MARGIN;
  return withMargin - cost < MIN_PROFIT ? cost + MIN_PROFIT : withMargin;
}
