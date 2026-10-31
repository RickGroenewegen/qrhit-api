/**
 * Where a consumer order was placed, for the turnover reports' "All ·
 * Website · App" toggle (scan app 2.1.0).
 *
 * `payments.channel` is 'app' for an order the scan app placed: an App Store
 * or Google Play purchase (`store` on POST /mollie/payment) and a printed
 * order it paid through Mollie (`returnTo: 'app'`). It is null for the
 * website, and for every order from before 2.1.0.
 *
 * The day and month reports, the country report, the customer report and
 * the charts take `?channel=web|app`; anything else is all, the reports as
 * they always were. Like the product filter it narrows the consumer orders
 * only: the sold company lists (the Business segment) are neither. The tax
 * and OSS reports and the monthly consumer invoice never take it: a VAT
 * filing covers everything.
 *
 * QRGames and App Designer have ledgers of their own. A purchase that came
 * with an order (`paymentId`) is in that order's channel; one without (a
 * QRGames upgrade, App Designer bought on the account) is paid on the
 * website.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

export type SalesChannel = 'all' | 'web' | 'app';

/** The value `payments.channel` holds for an order placed in the scan app. */
export const APP_CHANNEL = 'app';

export function parseSalesChannel(value: unknown): SalesChannel {
  return value === 'web' || value === 'app' ? value : 'all';
}

/**
 * The channel as a raw SQL condition on a payments row, with a leading
 * " AND " so it can follow any condition; '' for all.
 */
export function channelSql(channel: SalesChannel, alias?: string): string {
  const column = alias ? `${alias}.channel` : 'channel';
  if (channel === 'web') return ` AND ${column} IS NULL`;
  if (channel === 'app') return ` AND ${column} = '${APP_CHANNEL}'`;
  return '';
}

/**
 * The channel as a raw SQL condition on a ledger row (games_purchases,
 * app_design_purchases) by the order it came with; null for all. A row
 * without an order never matches the EXISTS, so it is on the website.
 */
export function ledgerChannelCondition(channel: SalesChannel, alias: string): string | null {
  if (channel === 'all') return null;
  const appOrder =
    `EXISTS (SELECT 1 FROM payments cp WHERE cp.id = ${alias}.paymentId` +
    ` AND cp.channel = '${APP_CHANNEL}')`;
  return channel === 'app' ? appOrder : `NOT ${appOrder}`;
}

/** ledgerChannelCondition with a leading " AND "; '' for all. */
export function ledgerChannelSql(channel: SalesChannel, alias: string): string {
  const condition = ledgerChannelCondition(channel, alias);
  return condition ? ` AND ${condition}` : '';
}

/** The channel as a Prisma filter on payments, to spread into a `where`; {} for all. */
export function paymentChannelWhere(
  channel: SalesChannel
): Pick<Prisma.PaymentWhereInput, 'channel'> {
  if (channel === 'web') return { channel: null };
  if (channel === 'app') return { channel: APP_CHANNEL };
  return {};
}

/**
 * The ledger rows of the channel, read through Prisma (the country report):
 * one query for the app orders among the orders they came with.
 */
export async function filterLedgerByChannel<T extends { paymentId?: number | null }>(
  prisma: Pick<PrismaClient, 'payment'>,
  rows: T[],
  channel: SalesChannel
): Promise<T[]> {
  if (channel === 'all') return rows;
  const ids = [
    ...new Set(rows.map((r) => r.paymentId).filter((id): id is number => id != null)),
  ];
  const appOrders = ids.length
    ? await prisma.payment.findMany({
        where: { id: { in: ids }, channel: APP_CHANNEL },
        select: { id: true },
      })
    : [];
  const appIds = new Set(appOrders.map((p) => p.id));
  const wantApp = channel === 'app';
  return rows.filter((r) => (r.paymentId != null && appIds.has(r.paymentId)) === wantApp);
}
