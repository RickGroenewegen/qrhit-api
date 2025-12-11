import { PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';

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
  private buildDateFilter(days?: number, startDate?: string, endDate?: string): string {
    // Custom date range
    if (startDate && endDate) {
      return `AND DATE(createdAt) BETWEEN '${startDate}' AND '${endDate}'`;
    }
    // Predefined date ranges
    if (days) {
      if (![30, 90, 180, 365].includes(days)) {
        throw new Error('Invalid days parameter. Must be 30, 90, 180, or 365');
      }
      return `AND createdAt >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`;
    }
    // Default to 90 days
    return 'AND createdAt >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)';
  }

  /**
   * Get chart data with 30-day moving averages for sales, profit, orders, and AOV
   * @param days Number of days to fetch (30, 90, 180, 365)
   * @param startDate Optional custom start date (YYYY-MM-DD)
   * @param endDate Optional custom end date (YYYY-MM-DD)
   * @returns Array of daily data with moving averages
   */
  public async getMovingAverage(
    days?: number,
    startDate?: string,
    endDate?: string
  ): Promise<any[]> {
    const dateFilter = this.buildDateFilter(days, startDate, endDate);

    const query = `
      SELECT
        date,
        daily_sales,
        daily_profit,
        payment_count,
        daily_aov,
        ROUND(AVG(daily_sales) OVER (
          ORDER BY date
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ), 2) as sales_ma_30d,
        ROUND(AVG(daily_profit) OVER (
          ORDER BY date
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ), 2) as profit_ma_30d,
        ROUND(AVG(payment_count) OVER (
          ORDER BY date
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ), 2) as orders_ma_30d,
        ROUND(AVG(daily_aov) OVER (
          ORDER BY date
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ), 2) as aov_ma_30d
      FROM (
        SELECT
          DATE(createdAt) as date,
          ROUND(SUM(totalPrice), 2) as daily_sales,
          ROUND(SUM(profit), 2) as daily_profit,
          COUNT(*) as payment_count,
          ROUND(AVG(totalPrice), 2) as daily_aov
        FROM payments
        WHERE
          status = 'paid'
          AND test = FALSE
          AND vibe = FALSE
          ${dateFilter}
        GROUP BY DATE(createdAt)
      ) daily_data
      ORDER BY date ASC
    `;

    const chartData = await this.prisma.$queryRawUnsafe(query);
    return chartData as any[];
  }

  /**
   * Get average sales data grouped by hour of day for charts
   * @param days Number of days to fetch (30, 90, 180, 365)
   * @param startDate Optional custom start date (YYYY-MM-DD)
   * @param endDate Optional custom end date (YYYY-MM-DD)
   * @returns Array of hourly data with averages (0-23 hours)
   */
  public async getHourlySales(
    days?: number,
    startDate?: string,
    endDate?: string
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
        AND test = FALSE
        AND vibe = FALSE
        ${dateFilter}
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
   * @returns Array of daily data with averages (1=Sunday to 7=Saturday in MySQL)
   */
  public async getDailySales(
    days?: number,
    startDate?: string,
    endDate?: string
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
        AND test = FALSE
        AND vibe = FALSE
        ${dateFilter}
      GROUP BY DAYOFWEEK(createdAt)
      ORDER BY day_of_week ASC
    `;

    const dailyData = await this.prisma.$queryRawUnsafe(query);
    return dailyData as any[];
  }
}

export default Charts;
