import { describe, it, expect } from 'vitest';
import { SHIPMENT_RESET, shippedOrderResend } from '../../../src/printers/printerResend';
import { printedOrderFigures } from '../../../src/printers/paymentFigures';

describe('shippedOrderResend', () => {
  it('moves a shipped order’s print cost to extraPrintCost and clears its shipment', () => {
    // Order 100009549: the first parcel (1533139, €25.04 ex VAT) came back
    expect(
      shippedOrderResend({ printApiOrderId: '1533139', printApiShipped: true, printApiPrice: 25.04 })
    ).toEqual({
      ...SHIPMENT_RESET,
      extraPrintCost: { increment: 25.04 },
      printApiPrice: 0,
      printApiPriceInclVat: 0,
    });
  });

  it('clears the shipment without booking when the shipped order’s price is unknown', () => {
    expect(
      shippedOrderResend({ printApiOrderId: '1533139', printApiShipped: true, printApiPrice: 0 })
    ).toEqual(SHIPMENT_RESET);
    expect(
      shippedOrderResend({ printApiOrderId: '1533139', printApiShipped: true, printApiPrice: null })
    ).toEqual(SHIPMENT_RESET);
  });

  it('does nothing when the previous order did not ship or there was none', () => {
    // not shipped: it may have been cancelled at Print&Bind
    expect(
      shippedOrderResend({ printApiOrderId: '1541189', printApiShipped: false, printApiPrice: 30.1 })
    ).toBeNull();
    // printer-reset cleared the id
    expect(shippedOrderResend({ printApiOrderId: '', printApiShipped: true, printApiPrice: 30.1 })).toBeNull();
    expect(shippedOrderResend(null)).toBeNull();
    expect(shippedOrderResend(undefined)).toBeNull();
  });

  it('clears every field the tracking poll and the PostNL lookup filter on', () => {
    expect(SHIPMENT_RESET.printApiShipped).toBe(false); // both pollers: printApiShipped: false
    expect(SHIPMENT_RESET.shippingStatus).toBeNull(); // a delivered status is never updated again
    expect(SHIPMENT_RESET.shippingCode).toBeNull(); // createShipment skips the code it already has
  });

  it('keeps the profit as it was until the new price is in, and right after', () => {
    const before = printedOrderFigures({
      totalPrice: 41.02,
      taxRate: 19,
      printApiPrice: 25.04,
      boxCount: 0,
      extraPrintCost: 0,
    });
    // the moment of the reprint: the cost moved column, profit unchanged
    const moved = printedOrderFigures({
      totalPrice: 41.02,
      taxRate: 19,
      printApiPrice: 0,
      boxCount: 0,
      extraPrintCost: 25.04,
    });
    expect(moved.profit).toBe(before.profit);
    // the new order's price booked: both print runs off the profit
    const after = printedOrderFigures({
      totalPrice: 41.02,
      taxRate: 19,
      printApiPrice: 24.66,
      boxCount: 0,
      extraPrintCost: 25.04,
    });
    expect(after.profit).toBe(-15.23);
  });
});
