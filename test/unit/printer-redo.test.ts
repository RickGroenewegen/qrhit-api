import { describe, it, expect } from 'vitest';
import { printerResetRefusal, rebuildRefusal, type PrinterRowState } from '../../src/printerRedo';

// Esther Brauhardt, 100009410: cancelled at Print&Bind as 1541189 and put on hold, our row still "at the printer"
const row = (extra: Partial<PrinterRowState & { finalized: boolean }> = {}) => ({
  orderId: '100009410',
  status: 'paid',
  finalized: true,
  printerHold: true,
  sentToPrinter: true,
  printApiOrderId: '1541189',
  printApiShipped: false,
  printApiTrackingLink: null,
  ...extra,
});

describe('printer-reset: when the printer state may be reset', () => {
  it('lets the cancelled order through when it is on hold and names its Print&Bind number', () => {
    expect(printerResetRefusal(row(), '1541189')).toBeNull();
  });

  it('needs the Print&Bind number that was cancelled, and refuses another one', () => {
    expect(printerResetRefusal(row(), '')).toMatch(/give the Print&Bind order number you cancelled \(now 1541189\)/);
    expect(printerResetRefusal(row(), '1541190')).toMatch(/at Print&Bind as 1541189, not 1541190/);
  });

  it('refuses without printer hold: the hourly pass would place it again at once', () => {
    expect(printerResetRefusal(row({ printerHold: false }), '1541189')).toMatch(/printer hold first/);
  });

  it('refuses an order that shipped or has a tracking link', () => {
    expect(printerResetRefusal(row({ printApiShipped: true }), '1541189')).toMatch(/has shipped/);
    expect(printerResetRefusal(row({ printApiTrackingLink: 'https://jouw.postnl.nl/x' }), '1541189')).toMatch(/has shipped/);
  });

  it('refuses an order that is not at the printer, or not paid', () => {
    expect(printerResetRefusal(row({ sentToPrinter: false, printApiOrderId: '' }), '1541189')).toMatch(/nothing to reset/);
    expect(printerResetRefusal(row({ status: 'refunded' }), '1541189')).toMatch(/not paid/);
  });
});

describe('rebuild-printer-pdfs: when the PDFs may be rebuilt', () => {
  const reset = { sentToPrinter: false, printApiOrderId: '' };

  it('lets a reset order on hold through', () => {
    expect(rebuildRefusal(row(reset))).toBeNull();
  });

  it('refuses an order still at the printer and points at printer-reset', () => {
    expect(rebuildRefusal(row())).toMatch(/printer-reset/);
  });

  it('refuses without hold, before finalizing and when not paid', () => {
    expect(rebuildRefusal(row({ ...reset, printerHold: false }))).toMatch(/printer hold first/);
    expect(rebuildRefusal(row({ ...reset, finalized: false }))).toMatch(/not finalized/);
    expect(rebuildRefusal(row({ ...reset, status: 'open' }))).toMatch(/not paid/);
  });
});
