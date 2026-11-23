import PrismaInstance from './prisma';

/**
 * Redo a Print&Bind order after it was cancelled there (the qrsong toolkit's `order printer-reset` and
 * `order rebuild-pdfs`; first: Esther Brauhardt, 100009410, 2026-11-10). Her design change landed three minutes
 * before the order went to Print&Bind (1541189) with every tenth card on the wrong front. Rick cancelled it in
 * their portal and put the order on printer hold, but our row still said "at the printer": the corrections page
 * answers `orderInProduction`, the toolkit refuses to change or regenerate, and nothing could be fixed.
 *
 * `printer-reset` makes the row say "not at the printer" again: `sentToPrinter` off, the Print&Bind order id,
 * status, tracking link and waiting state back to their defaults. Only on printer hold (without it the hourly
 * pass would place the order again at once), only when the caller names the Print&Bind order it cancelled (so a
 * typo or a stale id changes nothing), and never for an order that shipped. The approval, the timer and the
 * printer price stay: once Rick lifts the hold the order goes like any approved order, and its new printer
 * order books the price again.
 *
 * `rebuild-pdfs` rebuilds the printer PDF of every Print&Bind line whose design no longer matches its file
 * (`Generator.rebuildStalePrinterPdfs`, the printer pass's own rebuild): from the stored tracks, so a playlist the
 * customer changed since her approval does not change her cards, without a mail and without touching the printer.
 */

export class PrinterRedoError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface PrinterRowState {
  orderId: string;
  status: string;
  printerHold: boolean;
  sentToPrinter: boolean;
  printApiOrderId: string;
  printApiShipped: boolean;
  printApiTrackingLink: string | null;
}

/** Why the printer state of this order cannot be reset, or null when it can. */
export function printerResetRefusal(row: PrinterRowState, cancelledOrderId: string): string | null {
  if (!/^\d+$/.test(cancelledOrderId)) {
    return `give the Print&Bind order number you cancelled (now ${row.printApiOrderId || 'none'})`;
  }
  if (row.status !== 'paid') return `order ${row.orderId} is not paid (${row.status})`;
  if (!row.sentToPrinter && !row.printApiOrderId) return `order ${row.orderId} is not at the printer: nothing to reset`;
  if (row.printApiOrderId !== cancelledOrderId) {
    return `order ${row.orderId} is at Print&Bind as ${row.printApiOrderId || '(no number)'}, not ${cancelledOrderId}: nothing changed`;
  }
  if (row.printApiShipped || row.printApiTrackingLink) return `order ${row.orderId} has shipped: too late to redo it`;
  if (!row.printerHold) {
    return `put order ${row.orderId} on printer hold first: without it the hourly pass places it at Print&Bind again at once`;
  }
  return null;
}

/** Why the printer PDFs of this order cannot be rebuilt now, or null when they can. */
export function rebuildRefusal(row: PrinterRowState & { finalized: boolean }): string | null {
  if (row.status !== 'paid') return `order ${row.orderId} is not paid (${row.status})`;
  if (!row.finalized) return `order ${row.orderId} is not finalized: its cards are still being made`;
  if (row.sentToPrinter || row.printApiOrderId) {
    return `order ${row.orderId} is at the printer (${row.printApiOrderId || 'sent'}): cancel it at Print&Bind and run printer-reset first`;
  }
  if (!row.printerHold) {
    return `put order ${row.orderId} on printer hold first, so nothing sends it while its PDFs are rebuilt and checked`;
  }
  return null;
}

const STATE_SELECT = {
  id: true,
  orderId: true,
  paymentId: true,
  status: true,
  finalized: true,
  printerHold: true,
  sentToPrinter: true,
  sentToPrinterAt: true,
  printApiOrderId: true,
  printApiStatus: true,
  printApiShipped: true,
  printApiTrackingLink: true,
  printApiWaitingAt: true,
  printApiPrice: true,
} as const;

export async function printerRow(paymentId: string) {
  const prisma = PrismaInstance.getInstance();
  const row = await prisma.payment.findUnique({ where: { paymentId }, select: STATE_SELECT });
  if (!row) throw new PrinterRedoError(`no order ${paymentId}`, 404);
  return row;
}

export function rowState(row: Awaited<ReturnType<typeof printerRow>>): PrinterRowState & { finalized: boolean } {
  return {
    orderId: String(row.orderId),
    status: row.status,
    finalized: !!row.finalized,
    printerHold: !!row.printerHold,
    sentToPrinter: !!row.sentToPrinter,
    printApiOrderId: row.printApiOrderId ?? '',
    printApiShipped: !!row.printApiShipped,
    printApiTrackingLink: row.printApiTrackingLink || null,
  };
}

function shown(row: Awaited<ReturnType<typeof printerRow>>) {
  return {
    sentToPrinter: !!row.sentToPrinter,
    sentToPrinterAt: row.sentToPrinterAt,
    printApiOrderId: row.printApiOrderId,
    printApiStatus: row.printApiStatus,
    printApiTrackingLink: row.printApiTrackingLink,
    printerHold: !!row.printerHold,
    printApiPrice: row.printApiPrice,
  };
}

export async function resetPrinterState(paymentId: string, cancelledOrderId: string, apply: boolean) {
  const prisma = PrismaInstance.getInstance();
  const row = await printerRow(paymentId);
  const refusal = printerResetRefusal(rowState(row), cancelledOrderId);
  if (refusal) throw new PrinterRedoError(refusal, /give the Print&Bind/.test(refusal) ? 400 : 409);
  const before = shown(row);
  if (!apply) return { applied: false, orderId: String(row.orderId), before };

  // Only while the row still holds what was read: a printer pass or a tracking poll in between wins
  const { count } = await prisma.payment.updateMany({
    where: { id: row.id, printApiOrderId: cancelledOrderId, printerHold: true, printApiShipped: false },
    data: {
      sentToPrinter: false,
      sentToPrinterAt: null,
      printApiOrderId: '',
      printApiStatus: 'Created',
      printApiTrackingLink: '',
      printApiWaitingAt: null,
      printApiWaitingDetail: null,
    },
  });
  if (count !== 1) throw new PrinterRedoError(`order ${row.orderId} changed while resetting: nothing written, look again`, 409);
  const after = shown(await printerRow(paymentId));
  return { applied: true, orderId: String(row.orderId), cancelled: cancelledOrderId, before, after };
}

/**
 * "Judged" switched off in the dashboard for a printed line whose order is at Print&Bind (first: 100010037,
 * 2026-11-23). Taking the approval back did not open the corrections page, which stays shut for as long as the
 * row says "at the printer", and the button gave no hint why. Now the same click does the whole redo, once the
 * admin has confirmed the Print&Bind order they cancelled there: the order goes on printer hold (so the hourly
 * pass does not place it again while the customer is still correcting) and the printer state is reset as
 * `printer-reset` does, with its refusals: the number must match, and a shipped order stays shut.
 *
 * Returns false when there was nothing at the printer to take back (a digital line, or an order not sent yet).
 */
/** What switching "Judged" off has to do about the printer: nothing, the reset, or why it cannot. */
export function takeBackDecision(
  lineType: string,
  state: PrinterRowState,
  cancelledOrderId: string
): { action: 'none' } | { action: 'reset' } | { action: 'refuse'; reason: string } {
  if (lineType !== 'physical') return { action: 'none' };
  if (!state.sentToPrinter && !state.printApiOrderId) return { action: 'none' };
  if (!state.printApiOrderId) {
    return {
      action: 'refuse',
      reason: `order ${state.orderId} is marked as sent to the printer without a Print&Bind order number: it cannot be reopened from here`,
    };
  }
  if (!cancelledOrderId) {
    return {
      action: 'refuse',
      reason: `order ${state.orderId} is at Print&Bind as ${state.printApiOrderId}: cancel it there first, then confirm that number here`,
    };
  }
  // The hold is ours to set, so it is not a reason to refuse
  const refusal = printerResetRefusal({ ...state, printerHold: true }, cancelledOrderId);
  return refusal ? { action: 'refuse', reason: refusal } : { action: 'reset' };
}

export async function takeLineBackFromPrinter(paymentHasPlaylistId: number, cancelledOrderId: string): Promise<boolean> {
  const prisma = PrismaInstance.getInstance();
  const line = await prisma.paymentHasPlaylist.findUnique({
    where: { id: paymentHasPlaylistId },
    select: { type: true, payment: { select: { paymentId: true } } },
  });
  if (!line) throw new PrinterRedoError('PaymentHasPlaylist not found', 404);

  const row = await printerRow(line.payment.paymentId);
  const decision = takeBackDecision(line.type, rowState(row), cancelledOrderId);
  if (decision.action === 'none') return false;
  if (decision.action === 'refuse') throw new PrinterRedoError(decision.reason, 409);

  if (!row.printerHold) {
    await prisma.payment.update({ where: { id: row.id }, data: { printerHold: true } });
  }
  await resetPrinterState(line.payment.paymentId, cancelledOrderId, true);
  return true;
}
