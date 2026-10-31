/**
 * The customer report (Financial → Customer report): the top customers of
 * the site by what they spent, with the figures the day and month reports
 * show, added up per customer (a `users` row: one per e-mail address).
 *
 * Consumer orders only. Left out are the business orders: an order placed
 * with "business order" ticked at checkout, a toolkit or reseller order, an
 * order that belongs to a company list, and the company lists sold
 * themselves (the reports' Business segment, which has no customer). The
 * reports' start date and test addresses apply here too.
 *
 * Per customer, as in the reports: orders gross with refunds netted, profit
 * ex VAT of the orders whose print cost is known (`profitAssignedCount` says
 * how many), every QRGames purchase counted but only upgrades summed (an
 * initial one is in its order's total), and App Designer the same way (one
 * bought at checkout is in its order).
 *
 * `channel` (salesChannel.ts) narrows it to the orders placed on the website
 * or in the scan app, the QRGames and App Designer bought with them, and on
 * the website's side the upgrades and account purchases.
 */
import PrismaInstance from './prisma';
import { round2 } from './listPricing';
import { SalesChannel, channelSql, ledgerChannelSql } from './salesChannel';
import { notStoreTestSql } from './storeProducts';

export type CustomerReportPeriod = 'all' | 'year' | '12m';
export type CustomerReportSort = 'spend' | 'orders' | 'profit';

export const CUSTOMER_REPORT_LIMIT = 100;

/** The reports count paid orders from this day on. */
const REPORT_START = new Date('2024-12-05T00:00:00.000Z');

const TEST_EMAILS = ['west14@gmail.com', 'info@rickgroenewegen.nl'];

export function parseCustomerReportPeriod(value: unknown): CustomerReportPeriod {
  return value === 'year' || value === '12m' ? value : 'all';
}

export function parseCustomerReportSort(value: unknown): CustomerReportSort {
  return value === 'orders' || value === 'profit' ? value : 'spend';
}

/** The first day the period counts, never before the reports' start. */
export function customerReportSince(
  period: CustomerReportPeriod,
  now: Date = new Date()
): Date {
  let since = REPORT_START;
  if (period === 'year') {
    since = new Date(now.getFullYear(), 0, 1);
  } else if (period === '12m') {
    since = new Date(now);
    since.setFullYear(since.getFullYear() - 1);
  }
  return since > REPORT_START ? since : REPORT_START;
}

export interface CustomerFigures {
  userId: number;
  numberOfSales: number;
  totalPrice: number;
  totalPriceWithoutTax: number;
  totalRefunded: number;
  boxAmount: number;
  gamesAmount: number;
  gamesTotal: number;
  gamesExVat: number;
  appDesignAmount: number;
  appDesignTotal: number;
  appDesignExVat: number;
  totalProfit: number;
  profitAssignedCount: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

export interface CustomerReportRow extends CustomerFigures {
  name: string;
  email: string;
  country: string | null;
}

function emptyFigures(userId: number): CustomerFigures {
  return {
    userId,
    numberOfSales: 0,
    totalPrice: 0,
    totalPriceWithoutTax: 0,
    totalRefunded: 0,
    boxAmount: 0,
    gamesAmount: 0,
    gamesTotal: 0,
    gamesExVat: 0,
    appDesignAmount: 0,
    appDesignTotal: 0,
    appDesignExVat: 0,
    totalProfit: 0,
    profitAssignedCount: 0,
    firstOrderAt: null,
    lastOrderAt: null,
  };
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return isNaN(date.getTime()) ? null : date.toISOString();
}

const num = (value: unknown): number => Number(value) || 0;

/**
 * One row per customer from the three queries' rows. A customer who only
 * bought QRGames or App Designer on the account has no orders.
 */
export function mergeCustomerFigures(
  orderRows: any[],
  gamesRows: any[],
  appDesignRows: any[]
): CustomerFigures[] {
  const byUser = new Map<number, CustomerFigures>();
  const get = (userId: unknown) => {
    const id = Number(userId);
    let row = byUser.get(id);
    if (!row) {
      row = emptyFigures(id);
      byUser.set(id, row);
    }
    return row;
  };

  for (const r of orderRows) {
    const row = get(r.userId);
    row.numberOfSales = num(r.numberOfSales);
    row.totalPrice = round2(num(r.totalPrice));
    row.totalPriceWithoutTax = round2(num(r.totalPriceWithoutTax));
    row.totalRefunded = round2(num(r.totalRefunded));
    row.boxAmount = num(r.boxAmount);
    row.totalProfit = round2(num(r.totalProfit));
    row.profitAssignedCount = num(r.profitAssignedCount);
    row.firstOrderAt = toIso(r.firstOrderAt);
    row.lastOrderAt = toIso(r.lastOrderAt);
  }
  for (const r of gamesRows) {
    const row = get(r.userId);
    row.gamesAmount = num(r.gamesAmount);
    row.gamesTotal = round2(num(r.gamesTotal));
    row.gamesExVat = round2(num(r.gamesExVat));
  }
  for (const r of appDesignRows) {
    const row = get(r.userId);
    row.appDesignAmount = num(r.appDesignAmount);
    row.appDesignTotal = round2(num(r.appDesignTotal));
    row.appDesignExVat = round2(num(r.appDesignExVat));
  }
  return [...byUser.values()];
}

/** The reports' "Combined €": gross, refunds netted. */
export function customerSpend(r: CustomerFigures): number {
  return r.totalPrice + r.gamesTotal + r.appDesignTotal;
}

/** The reports' "Profit €": ex VAT. */
export function customerProfit(r: CustomerFigures): number {
  return r.totalProfit + r.gamesExVat + r.appDesignExVat;
}

/** The best `limit` customers, ties broken by spend. */
export function rankCustomers<T extends CustomerFigures>(
  rows: T[],
  sort: CustomerReportSort,
  limit: number = CUSTOMER_REPORT_LIMIT
): T[] {
  const key = (r: T): number =>
    sort === 'orders' ? r.numberOfSales : sort === 'profit' ? customerProfit(r) : customerSpend(r);
  return [...rows]
    .sort((a, b) => key(b) - key(a) || customerSpend(b) - customerSpend(a))
    .slice(0, limit);
}

// A consumer order, on a `payments` row aliased p.
const CONSUMER_ORDER = `
  p.status = 'paid'
  AND p.isBusinessOrder = 0
  AND p.paymentId NOT LIKE 'toolkit\\_%'
  AND p.paymentId NOT LIKE 'reseller\\_%'
  AND NOT EXISTS (SELECT 1 FROM company_lists cl WHERE cl.paymentId = p.id)
 ${notStoreTestSql('p')}
`;

export async function getCustomerReport(
  period: CustomerReportPeriod = 'all',
  sort: CustomerReportSort = 'spend',
  channel: SalesChannel = 'all',
  limit: number = CUSTOMER_REPORT_LIMIT
): Promise<CustomerReportRow[]> {
  const prisma = PrismaInstance.getInstance();
  const since = customerReportSince(period);

  const [orderRows, gamesRows, appDesignRows] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        p.userId AS userId,
        COUNT(*) AS numberOfSales,
        COALESCE(SUM(p.totalPrice - COALESCE(p.refundAmount, 0)), 0) AS totalPrice,
        COALESCE(SUM(
          p.totalPriceWithoutTax
          - CASE
              WHEN p.totalPrice > 0 THEN COALESCE(p.refundAmount, 0) * (p.totalPriceWithoutTax / p.totalPrice)
              ELSE 0
            END
        ), 0) AS totalPriceWithoutTax,
        COALESCE(SUM(p.refundAmount), 0) AS totalRefunded,
        COALESCE(SUM(bx.boxes), 0) AS boxAmount,
        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_has_playlist php
              WHERE php.paymentId = p.id AND php.type = 'physical'
            )
              THEN (CASE WHEN p.printApiPrice > 0 THEN p.profit ELSE 0 END)
            ELSE p.profit
          END
        ), 0) AS totalProfit,
        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_has_playlist php
              WHERE php.paymentId = p.id AND php.type = 'physical'
            )
              THEN (CASE WHEN p.printApiPrice > 0 THEN 1 ELSE 0 END)
            ELSE 1
          END
        ), 0) AS profitAssignedCount,
        MIN(p.createdAt) AS firstOrderAt,
        MAX(p.createdAt) AS lastOrderAt
      FROM payments p
      LEFT JOIN (
        SELECT php.paymentId, SUM(php.boxQuantity) AS boxes
        FROM payment_has_playlist php
        WHERE php.boxEnabled = 1
        GROUP BY php.paymentId
      ) bx ON bx.paymentId = p.id
      WHERE ${CONSUMER_ORDER}
        AND p.createdAt >= ?${channelSql(channel, 'p')}
      GROUP BY p.userId
      `,
      since
    ),
    // An initial QRGames purchase belongs to an order (its Mollie id); it
    // counts when that order does.
    prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        gp.userId AS userId,
        COUNT(*) AS gamesAmount,
        COALESCE(SUM(CASE WHEN gp.type = 'upgrade' THEN gp.totalPrice ELSE 0 END), 0) AS gamesTotal,
        COALESCE(SUM(
          CASE WHEN gp.type = 'upgrade'
            THEN gp.totalPrice / (1 + COALESCE(gp.taxRate, 0) / 100)
            ELSE 0
          END
        ), 0) AS gamesExVat
      FROM games_purchases gp
      LEFT JOIN payments p ON gp.type <> 'upgrade' AND p.paymentId = gp.molliePaymentId
      WHERE gp.createdAt >= ?
        AND (gp.type = 'upgrade' OR (p.id IS NOT NULL AND ${CONSUMER_ORDER}))${ledgerChannelSql(channel, 'gp')}
      GROUP BY gp.userId
      `,
      since
    ),
    prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        adp.userId AS userId,
        COUNT(*) AS appDesignAmount,
        COALESCE(SUM(CASE WHEN adp.paymentId IS NULL THEN adp.totalPrice ELSE 0 END), 0) AS appDesignTotal,
        COALESCE(SUM(CASE WHEN adp.paymentId IS NULL THEN adp.totalPriceWithoutTax ELSE 0 END), 0) AS appDesignExVat
      FROM app_design_purchases adp
      LEFT JOIN payments p ON p.id = adp.paymentId
      WHERE adp.createdAt >= ?
        AND (adp.paymentId IS NULL OR (p.id IS NOT NULL AND ${CONSUMER_ORDER}))${ledgerChannelSql(channel, 'adp')}
      GROUP BY adp.userId
      `,
      since
    ),
  ]);

  const merged = mergeCustomerFigures(orderRows, gamesRows, appDesignRows);
  if (!merged.length) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: merged.map((r) => r.userId) } },
    select: { id: true, email: true, displayName: true, country: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  // Our own addresses only test, in production; locally they are the data.
  const ignored = process.env['ENVIRONMENT'] === 'production' ? TEST_EMAILS : [];
  const counted = merged.filter((r) => {
    const email = userById.get(r.userId)?.email?.toLowerCase();
    return !email || !ignored.includes(email);
  });

  const top = rankCustomers(counted, sort, limit);

  // Name and country as on the customer's latest order: the account's
  // display name is often empty or a nickname.
  const latest = await prisma.payment.findMany({
    where: { userId: { in: top.map((r) => r.userId) }, status: 'paid' },
    orderBy: { createdAt: 'desc' },
    select: { userId: true, fullname: true, countrycode: true },
  });
  const latestByUser = new Map<number, { fullname: string; countrycode: string | null }>();
  for (const p of latest) {
    if (!latestByUser.has(p.userId)) latestByUser.set(p.userId, p);
  }

  return top.map((r) => {
    const user = userById.get(r.userId);
    const order = latestByUser.get(r.userId);
    return {
      ...r,
      name: order?.fullname?.trim() || user?.displayName?.trim() || '',
      email: user?.email || '',
      country: order?.countrycode || user?.country || null,
    };
  });
}
