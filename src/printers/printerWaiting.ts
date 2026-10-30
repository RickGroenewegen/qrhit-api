import Log from '../logger';
import PrismaInstance from '../prisma';
import PushoverClient from '../pushover';
import { color } from 'console-log-colors';

/**
 * Print&Bind's status for an order it will not produce until something is
 * resolved: a file its processing check refused (sub status `Verwerkingscontrole`
 * / `Bestanden`) or a question it asked us (`Antwoord klant`). Nothing on their
 * side moves it on, and they send no webhook. Order 100009123 sat in it for
 * three and a half weeks (6 to 30 October 2026) until the customer asked.
 */
export const PB_WAITING_STATUS = 'Wachten';

/**
 * Right after placing, an order passes through `Wachten` with sub status
 * `Bestandsverwerking` for some seconds while Print&Bind fetches the PDF
 * (order 1531054, 2026-10-29). An order sent this recently is left for the
 * next poll; healthy orders read `In opdracht` within about a minute.
 */
export const PRINTER_WAITING_GRACE_MS = 15 * 60 * 1000;

export type PrinterWaitingAction = 'start' | 'update' | 'clear' | 'none';

export interface PrinterWaitingState {
  sentToPrinterAt: Date | null;
  printApiWaitingAt: Date | null;
  printApiWaitingDetail: string | null;
}

/**
 * The sub status as one line ("Verwerkingscontrole, Bestanden"); null when
 * there is none. Only the REST API (v2) reports it; v1 knows the status alone.
 */
export function printerWaitingDetail(subStatus: unknown): string | null {
  const parts = (Array.isArray(subStatus) ? subStatus : [subStatus])
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(', ').slice(0, 255) : null;
}

/**
 * What the tracking poll does with an order's Print&Bind status: `start` the
 * first time it is seen waiting (store it, send the one alert), `update` a
 * changed sub status without alerting again, `clear` once it is out of
 * `Wachten`, otherwise `none`.
 */
export function printerWaitingDecision(
  state: PrinterWaitingState,
  status: string | null | undefined,
  detail: string | null,
  now: Date
): PrinterWaitingAction {
  if (status !== PB_WAITING_STATUS) {
    return state.printApiWaitingAt ? 'clear' : 'none';
  }
  if (state.printApiWaitingAt) {
    // v1 reports no sub status: keep what v2 stored rather than wipe it
    return detail !== null && detail !== state.printApiWaitingDetail
      ? 'update'
      : 'none';
  }
  if (
    state.sentToPrinterAt &&
    now.getTime() - state.sentToPrinterAt.getTime() < PRINTER_WAITING_GRACE_MS
  ) {
    return 'none';
  }
  return 'start';
}

/**
 * Keeps `payments.printApiWaitingAt` / `printApiWaitingDetail` in step with
 * Print&Bind, called by both integrations' tracking poll for every order it
 * fetched. A set `printApiWaitingAt` puts the order under the dashboard's
 * "Needs attention" filter (reason `printer-waiting`, mollie.ts).
 */
export class PrinterWaiting {
  private prisma = PrismaInstance.getInstance();
  private pushover = new PushoverClient();
  private logger = new Log();

  public async observe(
    payment: PrinterWaitingState & {
      id: number;
      orderId: string;
      printApiOrderId: string;
    },
    status: string | null | undefined,
    subStatus: unknown,
    now: Date = new Date()
  ): Promise<void> {
    try {
      const detail = printerWaitingDetail(subStatus);
      const action = printerWaitingDecision(payment, status, detail, now);

      if (action === 'start') {
        // Claimed on the empty column, so two polls never alert twice
        const claimed = await this.prisma.payment.updateMany({
          where: { id: payment.id, printApiWaitingAt: null },
          data: { printApiWaitingAt: now, printApiWaitingDetail: detail },
        });
        if (claimed.count !== 1) return;
        await this.alert(payment, detail);
      } else if (action === 'update') {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { printApiWaitingDetail: detail },
        });
      } else if (action === 'clear') {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { printApiWaitingAt: null, printApiWaitingDetail: null },
        });
        this.logger.log(
          color.blue.bold(
            `Print&Bind order ${color.white.bold(
              payment.printApiOrderId
            )} is no longer waiting (${color.white.bold(status || 'unknown')})`
          )
        );
      }
    } catch (error) {
      // Never let the alert cost the poll its tracking mails
      this.logger.log(
        color.red.bold(
          `Could not record the Print&Bind waiting state of order ${payment.printApiOrderId}: ${error}`
        )
      );
    }
  }

  private async alert(
    payment: PrinterWaitingState & { orderId: string; printApiOrderId: string },
    detail: string | null
  ): Promise<void> {
    const sent = payment.sentToPrinterAt
      ? ` Sent to the printer on ${payment.sentToPrinterAt.toISOString().slice(0, 10)}.`
      : '';
    const message =
      `Order ${payment.orderId} (Print&Bind ${payment.printApiOrderId}) is on "${PB_WAITING_STATUS}"` +
      `${detail ? `: ${detail}` : ''}.${sent} It is not produced until this is resolved in the Print&Bind portal.`;
    this.logger.log(color.red.bold(message));
    await this.pushover.sendMessage(
      { title: 'Print&Bind order waiting', message },
      '',
      true
    );
  }
}
