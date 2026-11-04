import { describe, it, expect } from 'vitest';
import {
  blockingOrders,
  openOrders,
  parseAllowOpenOrders,
  PlaylistReplaceError,
  type ReplaceOrderRow,
} from '../../src/playlistReplace';

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

describe('replace-spotify: allowOpenOrders', () => {
  // Esther Brauhardt's order asked for the fix (2026-11-04): open by nature, so allowed by name.
  const esther = row({ orderId: '100009410', paymentId: 'tr_esther', sentToPrinter: false });
  const other = row({ orderId: '100009500', paymentId: 'tr_other', finalized: false });
  const printed = row({ orderId: '100009001' });

  it('without an allowance every open order blocks, as before', () => {
    const r = blockingOrders([esther, other, printed]);
    expect(r.blocking.map((o) => o.orderId)).toEqual(['100009410', '100009500']);
    expect(r.allowed).toEqual([]);
  });

  it('an allowed open order no longer blocks; every other open order still does', () => {
    const r = blockingOrders([esther, other, printed], ['100009410']);
    expect(r.blocking.map((o) => o.orderId)).toEqual(['100009500']);
    expect(r.allowed.map((o) => o.orderId)).toEqual(['100009410']);
    expect(blockingOrders([esther, printed], ['100009410']).blocking).toEqual([]);
  });

  it('an allowance for an order that is not open (or not on the row) allows nothing', () => {
    const r = blockingOrders([printed, other], ['100009001', '100000077']);
    expect(r.allowed).toEqual([]);
    expect(r.blocking.map((o) => o.orderId)).toEqual(['100009500']);
  });

  it('matches orderIds stored as numbers too', () => {
    const r = blockingOrders([row({ orderId: 100009410, finalized: false })], ['100009410']);
    expect(r.blocking).toEqual([]);
    expect(r.allowed).toHaveLength(1);
  });

  it('takes the body field only as a list of orderId strings', () => {
    expect(parseAllowOpenOrders(undefined)).toEqual([]);
    expect(parseAllowOpenOrders(null)).toEqual([]);
    expect(parseAllowOpenOrders(['100009410', '100009410'])).toEqual(['100009410']);
    for (const bad of ['100009410', [100009410], ['tr_abc'], [''], {}]) {
      expect(() => parseAllowOpenOrders(bad)).toThrow(PlaylistReplaceError);
    }
    expect(() => parseAllowOpenOrders(Array(101).fill('1'))).toThrow(/orderIds/);
  });
});
