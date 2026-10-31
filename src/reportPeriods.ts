/**
 * Every day or month gets a row (Rick, 2026-10-31). The day and month
 * reports and the charts' moving average show each period from the first
 * sale's up to the current one, zeros where nothing was sold, instead of
 * only the periods that had a sale.
 *
 * The first sale is the first one any of those reports counts, whatever the
 * channel, product filter or segment, so those toggles change the figures
 * and never which rows there are.
 *
 * Periods are UTC days and months, the calendar of the rows themselves:
 * MySQL's DATE and DATE_FORMAT of the UTC timestamps Prisma stores, and
 * businessPeriodKey for the sold company lists.
 */
import PrismaInstance from './prisma';
import { notStoreTestSql } from './storeProducts';

export type ReportGrouping = 'day' | 'month';

/** 'YYYY-MM-DD' or 'YYYY-MM' of a moment, in UTC like the report rows. */
export function periodOf(date: Date, groupBy: ReportGrouping): string {
  return date.toISOString().slice(0, groupBy === 'day' ? 10 : 7);
}

function nextPeriod(period: string, groupBy: ReportGrouping): string {
  const [year, month, day] = period.split('-').map(Number);
  const next =
    groupBy === 'day'
      ? new Date(Date.UTC(year, month - 1, day + 1))
      : new Date(Date.UTC(year, month, 1));
  return periodOf(next, groupBy);
}

/**
 * The periods a report shows, oldest first: every one from `first` (the
 * first sale's) to `last` (the current one). A row outside that range keeps
 * its period and widens the range, so no figure is ever dropped. Without a
 * first sale nothing has been sold, and the rows' own periods are all there
 * is.
 */
export function reportPeriods(
  rowPeriods: Iterable<string>,
  groupBy: ReportGrouping,
  first: string | null,
  last: string
): string[] {
  const own = [...new Set(rowPeriods)].sort();
  if (!first) return own;
  const from = own.length && own[0] < first ? own[0] : first;
  const to = own.length && own[own.length - 1] > last ? own[own.length - 1] : last;
  const periods: string[] = [];
  for (let period = from; period <= to; period = nextPeriod(period, groupBy)) {
    periods.push(period);
  }
  return periods;
}

/**
 * Rick's own orders, which the day and month reports leave out in
 * production: a raw SQL condition on a payments row, with a leading " AND ".
 */
export function notOwnOrderSql(alias: string): string {
  if (process.env['ENVIRONMENT'] !== 'production') return '';
  return ` AND ${alias}.email NOT IN ('west14@gmail.com','info@rickgroenewegen.nl')`;
}

/**
 * The moment of the first sale: the first paid order the day and month
 * reports count (after 2024-12-05, not Rick's own, not an app store test
 * purchase), QRGames, App Designer or sold company list, whichever came
 * first. No channel: the website's first sale is also the app's first row.
 * Null while nothing has been sold.
 */
export async function getFirstSale(): Promise<Date | null> {
  const prisma = PrismaInstance.getInstance();
  const rows: any[] =
    (await prisma.$queryRawUnsafe(`
      SELECT MIN(firstSale) AS firstSale FROM (
        SELECT MIN(p.createdAt) AS firstSale
        FROM payments p
        WHERE p.status = 'paid'
          AND p.createdAt > '2024-12-05'${notOwnOrderSql('p')}${notStoreTestSql('p')}
        UNION ALL
        SELECT MIN(gp.createdAt) FROM games_purchases gp WHERE gp.createdAt > '2024-12-05'
        UNION ALL
        SELECT MIN(adp.createdAt) FROM app_design_purchases adp
        UNION ALL
        SELECT MIN(cl.soldAt) FROM company_lists cl WHERE cl.sold = 1
      ) firsts
    `)) || [];
  const first = rows[0]?.firstSale;
  return first ? new Date(first) : null;
}
