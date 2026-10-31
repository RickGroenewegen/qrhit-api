import { PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';
import { round2 } from './listPricing';
import { getFirstSale, periodOf, reportPeriods } from './reportPeriods';
import { SalesChannel, channelSql, ledgerChannelSql } from './salesChannel';
import { notStoreTestSql } from './storeProducts';

const MOVING_AVERAGE_DAYS = 30;

/** A day of the moving average chart. */
export interface MovingAverageDay {
  /** Midnight UTC of the day. */
  date: Date;
  daily_sales: number;
  daily_profit: number;
  payment_count: number;
  /** Null on a day without orders. */
  daily_aov: number | null;
  /** Null on the first day of the range, which has no days before it. */
  sales_ma_30d: number | null;
  profit_ma_30d: number | null;
  orders_ma_30d: number | null;
  aov_ma_30d: number | null;
}

/** The mean of the known values, to the cent; null when none is known. */
function average(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length ? round2(known.reduce((sum, v) => sum + v, 0) / known.length) : null;
}

class Charts {
  private static instance: Charts;
  private prisma: PrismaClient;

  private constructor() {
    this.prisma = PrismaInstance.getInstance();
  }

  public static getInstance(): Charts {
    if (!Charts.instance) {
      Charts.instance = new Charts();
    }
    return Charts.instance;
  }

  /**
   * Build date filter for chart queries
   */
  private buildDateFilter(days?: number, startDate?: string, endDate?: string, tableAlias?: string): string {
    const col = tableAlias ? `${tableAlias}.createdAt` : 'createdAt';
    // Custom date range. The dates come from the query string and end up in
    // the SQL text, so nothing but a plain YYYY-MM-DD gets through.
    if (startDate && endDate) {
      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (!isoDate.test(startDate) || !isoDate.test(endDate)) {
        throw new Error('Invalid date range. Dates must be YYYY-MM-DD');
      }
      return `AND DATE(${col}) BETWEEN '${startDate}' AND '${endDate}'`;
    }
    // Predefined date ranges
    if (days) {
      if (![30, 90, 180, 365].includes(days)) {
        throw new Error('Invalid days parameter. Must be 30, 90, 180, or 365');
      }
      return `AND ${col} >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`;
    }
    // Default to 90 days
    return `AND ${col} >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)`;
  }

  /**
   * The first and last day buildDateFilter lets through, as UTC days like
   * DATE(createdAt).
   */
  private dateRange(days?: number, startDate?: string, endDate?: string): { from: string; to: string } {
    if (startDate && endDate) return { from: startDate, to: endDate };
    const today = new Date();
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days || 90)));
    return { from: periodOf(from, 'day'), to: periodOf(today, 'day') };
  }

  /**
   * Get chart data with 30-day moving averages for sales, profit, orders, and AOV
   * @param days Number of days to fetch (30, 90, 180, 365)
   * @param startDate Optional custom start date (YYYY-MM-DD)
   * @param endDate Optional custom end date (YYYY-MM-DD)
   * @param channel Website or scan-app orders only (salesChannel.ts); all by default
   * @returns Every day of the range from the first sale's up to today, oldest
   *   first, with its figures (zero on a day without sales) and the averages
   *   of the 30 days before it
   */
  public async getMovingAverage(
    days?: number,
    startDate?: string,
    endDate?: string,
    channel: SalesChannel = 'all'
  ): Promise<MovingAverageDay[]> {
    const dateFilter = this.buildDateFilter(days, startDate, endDate, 'p');

    // The days that had a sale. The rest are added below, so the averages
    // run over calendar days, not over the last 30 days with a sale (which
    // for the app's few orders reached back months).
    const query = `
      SELECT
        DATE(p.createdAt) as date,
        ROUND(SUM(p.totalPrice) + COALESCE((
          SELECT SUM(adp.totalPrice) FROM app_design_purchases adp
          WHERE DATE(adp.createdAt) = DATE(p.createdAt)
            AND adp.paymentId IS NULL${ledgerChannelSql(channel, 'adp')}
        ), 0), 2) as daily_sales,
        ROUND(SUM(p.profit) + COALESCE((
          SELECT SUM(gp.totalPrice) FROM games_purchases gp
          WHERE DATE(gp.createdAt) = DATE(p.createdAt)${ledgerChannelSql(channel, 'gp')}
        ), 0) + COALESCE((
          SELECT SUM(adp.totalPriceWithoutTax) FROM app_design_purchases adp
          WHERE DATE(adp.createdAt) = DATE(p.createdAt)
            AND adp.paymentId IS NULL${ledgerChannelSql(channel, 'adp')}
        ), 0), 2) as daily_profit,
        COUNT(*) as payment_count,
        ROUND(AVG(p.totalPrice), 2) as daily_aov
      FROM payments p
      WHERE
        p.status = 'paid'
        ${dateFilter}${notStoreTestSql('p')}${channelSql(channel, 'p')}
      GROUP BY DATE(p.createdAt)
      ORDER BY date ASC
    `;

    const rows: any[] = (await this.prisma.$queryRawUnsafe(query)) || [];
    const firstSale = await getFirstSale();

    // Every day of the range from the first sale's (whatever the channel)
    // up to today (reportPeriods.ts).
    const range = this.dateRange(days, startDate, endDate);
    const today = periodOf(new Date(), 'day');
    const firstDay = firstSale ? periodOf(firstSale, 'day') : null;
    const byDay = new Map(rows.map((r) => [periodOf(new Date(r.date), 'day'), r]));
    const daysShown = reportPeriods(
      byDay.keys(),
      'day',
      firstDay && (firstDay > range.from ? firstDay : range.from),
      range.to < today ? range.to : today
    );

    const series = daysShown.map((day) => {
      const r = byDay.get(day);
      return {
        date: new Date(`${day}T00:00:00.000Z`),
        daily_sales: Number(r?.daily_sales) || 0,
        daily_profit: Number(r?.daily_profit) || 0,
        payment_count: Number(r?.payment_count) || 0,
        // A day without orders has no order value, and leaves the AOV
        // average to the days that had one.
        daily_aov: r ? Number(r.daily_aov) || 0 : null,
      };
    });

    // The averages of the 30 days before each day, the day itself left out;
    // the first days of the range have fewer before them.
    return series.map((day, i) => {
      const before = series.slice(Math.max(0, i - MOVING_AVERAGE_DAYS), i);
      return {
        ...day,
        sales_ma_30d: average(before.map((d) => d.daily_sales)),
        profit_ma_30d: average(before.map((d) => d.daily_profit)),
        orders_ma_30d: average(before.map((d) => d.payment_count)),
        aov_ma_30d: average(before.map((d) => d.daily_aov)),
      };
    });
  }

  /**
   * Get average sales data grouped by hour of day for charts
   * @param days Number of days to fetch (30, 90, 180, 365)
   * @param startDate Optional custom start date (YYYY-MM-DD)
   * @param endDate Optional custom end date (YYYY-MM-DD)
   * @param channel Website or scan-app orders only (salesChannel.ts); all by default
   * @returns Array of hourly data with averages (0-23 hours)
   */
  public async getHourlySales(
    days?: number,
    startDate?: string,
    endDate?: string,
    channel: SalesChannel = 'all'
  ): Promise<any[]> {
    const dateFilter = this.buildDateFilter(days, startDate, endDate);

    const query = `
      SELECT
        HOUR(createdAt) as hour,
        ROUND(AVG(totalPrice), 2) as avg_sales,
        ROUND(AVG(profit), 2) as avg_profit,
        ROUND(COUNT(*) / COUNT(DISTINCT DATE(createdAt)), 2) as avg_orders
      FROM payments
      WHERE
        status = 'paid'
        ${dateFilter}${notStoreTestSql()}${channelSql(channel)}
      GROUP BY HOUR(createdAt)
      ORDER BY hour ASC
    `;

    const hourlyData = await this.prisma.$queryRawUnsafe(query);
    return hourlyData as any[];
  }

  /**
   * Get average sales data grouped by day of week for charts
   * @param days Number of days to fetch (30, 90, 180, 365)
   * @param startDate Optional custom start date (YYYY-MM-DD)
   * @param endDate Optional custom end date (YYYY-MM-DD)
   * @param channel Website or scan-app orders only (salesChannel.ts); all by default
   * @returns Array of daily data with averages (1=Sunday to 7=Saturday in MySQL)
   */
  public async getDailySales(
    days?: number,
    startDate?: string,
    endDate?: string,
    channel: SalesChannel = 'all'
  ): Promise<any[]> {
    const dateFilter = this.buildDateFilter(days, startDate, endDate);

    const query = `
      SELECT
        DAYOFWEEK(createdAt) as day_of_week,
        ROUND(AVG(totalPrice), 2) as avg_sales,
        ROUND(AVG(profit), 2) as avg_profit,
        ROUND(COUNT(*) / COUNT(DISTINCT DATE(createdAt)), 2) as avg_orders
      FROM payments
      WHERE
        status = 'paid'
        ${dateFilter}${notStoreTestSql()}${channelSql(channel)}
      GROUP BY DAYOFWEEK(createdAt)
      ORDER BY day_of_week ASC
    `;

    const dailyData = await this.prisma.$queryRawUnsafe(query);
    return dailyData as any[];
  }
}

export default Charts;
