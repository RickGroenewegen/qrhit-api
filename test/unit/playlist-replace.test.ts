import { describe, it, expect } from 'vitest';
import { openOrders, type ReplaceOrderRow } from '../../src/playlistReplace';

const row = (extra: Partial<ReplaceOrderRow>): ReplaceOrderRow => ({
  orderId: '100000001',
  paymentId: 'tr_abc',
  status: 'paid',
  type: 'physical',
  finalized: true,
  sentToPrinter: true,
  ...extra,
});

describe('replace-spotify: which orders block a swap', () => {
  it('lets finished orders through: printed, digital and unpaid', () => {
    expect(
      openOrders([
        row({}),
        row({ type: 'digital', sentToPrinter: false }),
        row({ status: 'expired', finalized: false, sentToPrinter: false }),
        row({ status: 'open', finalized: false }),
      ])
    ).toEqual([]);
  });

  it('blocks a paid order that is not finalized, whatever its type', () => {
    expect(openOrders([row({ finalized: false }), row({ type: 'digital', finalized: false })])).toHaveLength(2);
  });

  it('blocks a finalized Print&Bind physical line not yet sent to the printer', () => {
    expect(openOrders([row({ orderId: '1', sentToPrinter: false })]).map((o) => o.orderId)).toEqual(['1']);
  });

  it('judges our own business orders (toolkit_) on finalized only: they never go to Print&Bind', () => {
    expect(openOrders([row({ paymentId: 'toolkit_x', sentToPrinter: false })])).toEqual([]);
    expect(openOrders([row({ paymentId: 'toolkit_x', finalized: false })])).toHaveLength(1);
  });
});
