import { describe, it, expect } from 'vitest';
import { printerResetRefusal, rebuildRefusal, takeBackDecision, type PrinterRowState } from '../../src/printerRedo';

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

// 100010037: Judged switched off in the dashboard while the order was at Print&Bind, the corrections page stayed shut
describe('Judged off: taking a line back from the printer', () => {
  const atPrinter = row({ printerHold: false });

  it('has nothing to do for a digital line or an order that was never sent', () => {
    expect(takeBackDecision('digital', atPrinter, '')).toEqual({ action: 'none' });
    expect(takeBackDecision('physical', row({ sentToPrinter: false, printApiOrderId: '' }), '')).toEqual({ action: 'none' });
  });

  it('resets once the cancelled Print&Bind order is confirmed, without asking for the hold it sets itself', () => {
    expect(takeBackDecision('physical', atPrinter, '1541189')).toEqual({ action: 'reset' });
  });

  it('refuses without the confirmed number, with another number, and after shipping', () => {
    expect(takeBackDecision('physical', atPrinter, '')).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/at Print&Bind as 1541189: cancel it there first/),
    });
    expect(takeBackDecision('physical', atPrinter, '1541190')).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/not 1541190/),
    });
    expect(takeBackDecision('physical', row({ printApiShipped: true }), '1541189')).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/has shipped/),
    });
  });

  it('refuses a row marked as sent that has no Print&Bind number to confirm', () => {
    expect(takeBackDecision('physical', row({ printApiOrderId: '' }), '')).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/without a Print&Bind order number/),
    });
  });
});
