/**
 * What a new Print&Bind order does to a payment whose previous one had
 * already shipped: the dashboard's "Send to printer" on a delivered or
 * returned order (a reprint), or an inlay-only send after delivery.
 *
 * The payment holds one printer order at a time. Before 2026-11-12 a reprint
 * kept the old shipment's state, with two results (order 100009549, Maria
 * Kalinowski: her parcel came back "Address incorrect", reprinted as 1542477):
 *
 * - `printApiShipped` stayed true, and the hourly tracking poll (v1 and v2)
 *   only asks Print&Bind about orders with `printApiShipped: false`. The new
 *   order was never followed: no tracking link, no tracking mail, status
 *   "Submitted" for good. A delivered `shippingStatus` would also have
 *   stopped the PostNL lookup of the new parcel (shipping.ts never updates a
 *   delivered one).
 * - The new order's price replaced `printApiPrice`, so the profit lost the
 *   first order's print cost (€25.04 there) although we paid it.
 *
 * So the shipped order's price moves to `extraPrintCost` (where every later
 * printer order of a payment is booked, see printedOrderFigures) and
 * `printApiPrice` goes to 0 until the new order's setPaymentInfo books its
 * own price. The profit does not change at that moment (the cost only moves
 * column) and comes out right once the new price is in. The shipment's
 * tracking fields are cleared, as setupForPrinter already cleared the
 * tracking link.
 *
 * Only a shipped order counts: it was certainly produced and charged. A
 * previous order that never shipped may have been cancelled at Print&Bind
 * (printer-reset clears its id, but Rick can also cancel in their portal and
 * press "Send to printer" straight away), so it is left as before.
 */

export interface PreviousPrinterOrder {
  printApiOrderId: string | null;
  printApiShipped: boolean;
  printApiPrice: number | null;
}

/** The tracking state of a shipped printer order, empty again. */
export const SHIPMENT_RESET = {
  printApiShipped: false,
  printApiShippedAt: null,
  shippingCode: null,
  shippingCountry: null,
  shippingPostalCode: null,
  shippingStatus: null,
  shippingMessage: null,
  shippingStartDateTime: null,
  shippingDeliveryDateTime: null,
  shippingLastTrackedAt: null,
  shippingLastChangeType: null,
  shippingIgnore: false,
} as const;

/**
 * The payment update for a new printer order after a shipped one, or null
 * when the previous order did not ship (or there was none).
 */
export function shippedOrderResend(previous: PreviousPrinterOrder | null | undefined) {
  if (!previous || !previous.printApiShipped || !previous.printApiOrderId) return null;
  const cost = Number(previous.printApiPrice) || 0;
  return {
    ...SHIPMENT_RESET,
    ...(cost > 0
      ? {
          extraPrintCost: { increment: cost },
          printApiPrice: 0,
          printApiPriceInclVat: 0,
        }
      : {}),
  };
}
