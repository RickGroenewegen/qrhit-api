import { ApiResult } from './interfaces/ApiResult';
import { createMollieClient, Locale, PaymentMethod } from '@mollie/api-client';
import { Payment, Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import Data from './data';
import Order from './order';
import Translation from './translation';
import Utils from './utils';
import Generator from './generator';
import { CartItem } from './interfaces/CartItem';
import { OrderSearch } from './interfaces/OrderSearch';
import Discount from './discount';
import { CronJob } from 'cron';
import cluster from 'cluster';
import { promises as fs } from 'fs';
import Cache from './cache';
import Promotional from './promotional';
import { QRGAMES_UPGRADE_PRICE } from './game';
import { BOX_PRICE } from './config/constants';
import MusicServiceRegistry from './services/MusicServiceRegistry';
import AppTheme from './apptheme';
import Bingo from './bingo';
import PrintEnBind from './printers/printenbind';
import Mail from './mail';
import Fx from './services/fx';
import {
  isSupportedCurrency,
  SupportedCurrency,
} from './data/currency-map';

class Mollie {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private data = Data.getInstance();
  private discount = new Discount();
  private order = Order.getInstance();
  private appTheme = AppTheme.getInstance();
  private translation: Translation = new Translation();
  private utils = new Utils();
  private generator = Generator.getInstance();
  private openPaymentStatus = ['open', 'pending', 'authorized'];
  private paidPaymentStatus = ['paid'];
  private failedPaymentStatus = ['failed', 'canceled', 'expired'];
  private cache = Cache.getInstance();
  private promotional = Promotional.getInstance();
  private musicServiceRegistry = MusicServiceRegistry.getInstance();
  private bingo = Bingo.getInstance();
  private printenbind = PrintEnBind.getInstance();
  private mail = Mail.getInstance();
  private fx = Fx.getInstance();

  constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.startCron();
        }
      });
    }
  }

  public async getPaymentsByDay(): Promise<any> {
    let ignoreEmails: string[] = [];

    if (process.env['ENVIRONMENT'] == 'production') {
      ignoreEmails = ['west14@gmail.com', 'info@rickgroenewegen.nl'];
    }

    const where = {
      vibe: false,
      AND: [
        {
          createdAt: {
            gt: new Date('2024-12-05'),
          },
        },
      ],
      email: {
        notIn: ignoreEmails,
      },
      status: {
        in: ['paid'],
      },
    };

    const report = await this.prisma.payment.groupBy({
      by: ['createdAt'],
      where,
      _count: {
        _all: true,
      },
      _sum: {
        totalPrice: true,
        totalPriceWithoutTax: true,
      },
    });

    const refundAdjustments = await this.getRefundAdjustmentsByKey(
      where,
      (p) => new Date(p.createdAt).toISOString().split('T')[0]
    );

    // Process the results to group by day and calculate totals
    const dailyReport = report.reduce((acc: any[], entry) => {
      const day = new Date(entry.createdAt).toISOString().split('T')[0];

      const existingDay = acc.find((item) => item.day === day);
      if (existingDay) {
        existingDay.numberOfSales += entry._count._all;
        existingDay.totalPrice += entry._sum.totalPrice || 0;
        existingDay.totalPriceWithoutTax +=
          entry._sum.totalPriceWithoutTax || 0;
      } else {
        acc.push({
          day,
          numberOfSales: entry._count._all,
          totalPrice: entry._sum.totalPrice || 0,
          totalPriceWithoutTax: entry._sum.totalPriceWithoutTax || 0,
          totalRefunded: 0,
        });
      }
      return acc;
    }, []);

    // Net out refunds proportionally per day
    for (const row of dailyReport) {
      const adj = refundAdjustments.get(row.day);
      if (adj) {
        row.totalPrice -= adj.refundedTotal;
        row.totalPriceWithoutTax -= adj.refundedExVAT;
        row.totalRefunded = adj.refundedTotal;
      }
    }

    // Sort by day descending (newest first)
    return dailyReport.sort((a, b) => b.day.localeCompare(a.day));
  }

  public async getSalesReport(groupBy: 'day' | 'month', filter: string = 'all'): Promise<any> {
    const ignoreEmails = process.env['ENVIRONMENT'] === 'production'
      ? ['west14@gmail.com', 'info@rickgroenewegen.nl']
      : [];

    const emailFilter = ignoreEmails.length
      ? `AND p.email NOT IN (${ignoreEmails.map(e => `'${e}'`).join(',')})`
      : '';

    const dateExpr = groupBy === 'day'
      ? "DATE_FORMAT(p.createdAt, '%Y-%m-%d')"
      : "DATE_FORMAT(p.createdAt, '%Y-%m')";

    const gamesDateExpr = groupBy === 'day'
      ? "DATE_FORMAT(gp.createdAt, '%Y-%m-%d')"
      : "DATE_FORMAT(gp.createdAt, '%Y-%m')";

    if (filter === 'all') {
      // Net out refunds proportionally. For partial refunds we scale the
      // ex-VAT portion by (totalPriceWithoutTax / totalPrice) so refund VAT
      // is allocated correctly against gross revenue.
      const results: any[] = await this.prisma.$queryRawUnsafe(`
        SELECT
          ${dateExpr} as period,
          COUNT(*) as numberOfSales,
          COALESCE(SUM(p.totalPrice - COALESCE(p.refundAmount, 0)), 0) as totalPrice,
          COALESCE(
            SUM(
              p.totalPriceWithoutTax
              - CASE
                  WHEN p.totalPrice > 0 THEN COALESCE(p.refundAmount, 0) * (p.totalPriceWithoutTax / p.totalPrice)
                  ELSE 0
                END
            ),
            0
          ) as totalPriceWithoutTax,
          COALESCE(SUM(p.refundAmount), 0) as totalRefunded,
          COALESCE(SUM(
            CASE
              WHEN EXISTS (
                SELECT 1 FROM payment_has_playlist php
                WHERE php.paymentId = p.id AND php.type = 'physical'
              )
                THEN (CASE WHEN p.printApiPrice > 0 THEN p.profit ELSE 0 END)
              ELSE p.profit
            END
          ), 0) as totalProfit,
          COALESCE(SUM(
            CASE
              WHEN EXISTS (
                SELECT 1 FROM payment_has_playlist php
                WHERE php.paymentId = p.id AND php.type = 'physical'
              )
                THEN (CASE WHEN p.printApiPrice > 0 THEN 1 ELSE 0 END)
              ELSE 1
            END
          ), 0) as profitAssignedCount
        FROM payments p
        WHERE p.status = 'paid'
          AND p.vibe = 0
          AND p.createdAt > '2024-12-05'
          ${emailFilter}
        GROUP BY ${dateExpr}
        ORDER BY period DESC
      `);

      // Count all games (initial + upgrade), but only sum upgrade prices (initial prices are already in payment totals)
      const gamesResults: any[] = await this.prisma.$queryRawUnsafe(`
        SELECT
          ${gamesDateExpr} as period,
          COUNT(*) as gamesAmount,
          COALESCE(SUM(CASE WHEN gp.type = 'upgrade' THEN gp.totalPrice ELSE 0 END), 0) as gamesTotal
        FROM games_purchases gp
        WHERE gp.createdAt > '2024-12-05'
        GROUP BY ${gamesDateExpr}
      `);

      const gamesMap = new Map(gamesResults.map(g => [g.period, g]));

      // Count boxes ordered per period
      const boxResults: any[] = await this.prisma.$queryRawUnsafe(`
        SELECT
          ${dateExpr} as period,
          COALESCE(SUM(php.boxQuantity), 0) as boxAmount
        FROM payment_has_playlist php
        JOIN payments p ON php.paymentId = p.id
        WHERE p.status = 'paid'
          AND p.vibe = 0
          AND p.createdAt > '2024-12-05'
          AND php.boxEnabled = 1
          ${emailFilter}
        GROUP BY ${dateExpr}
      `);

      const boxMap = new Map(boxResults.map(b => [b.period, b]));

      return results.map(r => ({
        period: r.period,
        numberOfSales: Number(r.numberOfSales),
        totalPrice: Number(r.totalPrice) || 0,
        totalPriceWithoutTax: Number(r.totalPriceWithoutTax) || 0,
        boxAmount: Number(boxMap.get(r.period)?.boxAmount) || 0,
        totalRefunded: Number(r.totalRefunded) || 0,
        gamesAmount: Number(gamesMap.get(r.period)?.gamesAmount) || 0,
        gamesTotal: Number(gamesMap.get(r.period)?.gamesTotal) || 0,
        totalProfit: Number(r.totalProfit) || 0,
        profitAssignedCount: Number(r.profitAssignedCount) || 0,
      }));
    }

    let typeFilter = '';
    if (filter === 'digital') {
      typeFilter = "AND php.type = 'digital'";
    } else if (filter === 'sheets') {
      typeFilter = "AND php.type = 'physical' AND php.subType = 'sheets'";
    } else if (filter === 'cards') {
      typeFilter = "AND php.type = 'physical' AND (php.subType = 'none' OR php.subType IS NULL)";
    }

    // For filtered views we approximate refund share per line item as
    // (line gross / payment gross). Partial refunds on multi-line orders
    // therefore distribute across the order's line items uniformly.
    const results: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT
        ${dateExpr} as period,
        COUNT(DISTINCT p.id) as numberOfSales,
        COALESCE(
          SUM(
            php.price
            - CASE
                WHEN p.totalPrice > 0 THEN COALESCE(p.refundAmount, 0) * (php.price / p.totalPrice)
                ELSE 0
              END
          ),
          0
        ) as totalPrice,
        COALESCE(
          SUM(
            php.priceWithoutVAT
            - CASE
                WHEN p.totalPrice > 0 THEN COALESCE(p.refundAmount, 0) * (php.priceWithoutVAT / p.totalPrice)
                ELSE 0
              END
          ),
          0
        ) as totalPriceWithoutTax,
        COALESCE(
          SUM(
            CASE
              WHEN p.totalPrice > 0 THEN COALESCE(p.refundAmount, 0) * (php.price / p.totalPrice)
              ELSE 0
            END
          ),
          0
        ) as totalRefunded
      FROM payment_has_playlist php
      JOIN payments p ON php.paymentId = p.id
      WHERE p.status = 'paid'
        AND p.vibe = 0
        AND p.createdAt > '2024-12-05'
        ${emailFilter}
        ${typeFilter}
      GROUP BY ${dateExpr}
      ORDER BY period DESC
    `);

    // Profit summed at the payment level (once per payment) restricted to
    // payments that have at least one line item matching the filter.
    const profitResults: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT
        ${dateExpr} as period,
        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_has_playlist php
              WHERE php.paymentId = p.id AND php.type = 'physical'
            )
              THEN (CASE WHEN p.printApiPrice > 0 THEN p.profit ELSE 0 END)
            ELSE p.profit
          END
        ), 0) as totalProfit,
        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_has_playlist php
              WHERE php.paymentId = p.id AND php.type = 'physical'
            )
              THEN (CASE WHEN p.printApiPrice > 0 THEN 1 ELSE 0 END)
            ELSE 1
          END
        ), 0) as profitAssignedCount
      FROM payments p
      WHERE p.status = 'paid'
        AND p.vibe = 0
        AND p.createdAt > '2024-12-05'
        ${emailFilter}
        AND EXISTS (
          SELECT 1 FROM payment_has_playlist php
          WHERE php.paymentId = p.id
          ${typeFilter}
        )
      GROUP BY ${dateExpr}
    `);
    const profitMap = new Map(profitResults.map(p => [p.period, p]));

    return results.map(r => ({
      period: r.period,
      numberOfSales: Number(r.numberOfSales),
      totalPrice: Number(r.totalPrice) || 0,
      totalPriceWithoutTax: Number(r.totalPriceWithoutTax) || 0,
      boxAmount: 0,
      totalRefunded: Number(r.totalRefunded) || 0,
      gamesAmount: 0,
      gamesTotal: 0,
      totalProfit: Number(profitMap.get(r.period)?.totalProfit) || 0,
      profitAssignedCount: Number(profitMap.get(r.period)?.profitAssignedCount) || 0,
    }));
  }

  public async getPaymentsByMonth(
    startDate: Date,
    endDate: Date
  ): Promise<any> {
    let ignoreEmails: string[] = [];

    if (process.env['ENVIRONMENT'] == 'production') {
      ignoreEmails = ['west14@gmail.com', 'info@rickgroenewegen.nl'];
    }

    const where = {
      vibe: false,
      AND: [
        {
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        {
          createdAt: {
            gt: new Date('2024-12-05'),
          },
        },
      ],
      email: {
        notIn: ignoreEmails,
      },
    };

    const report = await this.prisma.payment.groupBy({
      by: ['countrycode'],
      where,
      _count: {
        _all: true,
      },
      _sum: {
        totalPrice: true,
        totalPriceWithoutTax: true,
      },
      _max: {
        taxRate: true,
      },
    });

    const refundAdjustments = await this.getRefundAdjustmentsByKey(
      where,
      (p) => p.countrycode || 'Unknown'
    );

    // Count all games (initial + upgrade), but only sum upgrade prices (initial prices are already in payment totals)
    const gamesByCountryCount = await this.prisma.gamesPurchase.groupBy({
      by: ['countrycode'],
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: { _all: true },
    });
    const gamesByCountryTotal = await this.prisma.gamesPurchase.groupBy({
      by: ['countrycode'],
      where: {
        type: 'upgrade',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: { totalPrice: true },
    });
    const gamesTotalMap = new Map(gamesByCountryTotal.map(g => [g.countrycode || 'Unknown', g._sum.totalPrice || 0]));
    const gamesMap = new Map<string, { amount: number; total: number }>(
      gamesByCountryCount.map(g => {
        const key = g.countrycode || 'Unknown';
        return [key, { amount: g._count._all, total: gamesTotalMap.get(key) || 0 }];
      })
    );

    // Count boxes by country
    const boxByCountry: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT p.countrycode, COALESCE(SUM(php.boxQuantity), 0) as boxAmount
      FROM payment_has_playlist php
      JOIN payments p ON php.paymentId = p.id
      WHERE p.status = 'paid'
        AND p.vibe = 0
        AND p.createdAt >= '${startDate.toISOString()}'
        AND p.createdAt <= '${endDate.toISOString()}'
        AND php.boxEnabled = 1
      GROUP BY p.countrycode
    `);
    const boxMap = new Map(boxByCountry.map(b => [b.countrycode || 'Unknown', Number(b.boxAmount) || 0]));

    // Count payments whose profit has been assigned. Digital orders get profit
    // at creation; physical orders only after submission to the print API
    // (printApiPrice > 0). Mirrors the groupBy `where` so it shares the same
    // denominator as numberOfSales.
    const monthEmailFilter = ignoreEmails.length
      ? `AND p.email NOT IN (${ignoreEmails.map(e => `'${e}'`).join(',')})`
      : '';
    const profitAssignedByCountry: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT
        p.countrycode,
        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_has_playlist php
              WHERE php.paymentId = p.id AND php.type = 'physical'
            )
              THEN (CASE WHEN p.printApiPrice > 0 THEN p.profit ELSE 0 END)
            ELSE p.profit
          END
        ), 0) as totalProfit,
        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM payment_has_playlist php
              WHERE php.paymentId = p.id AND php.type = 'physical'
            )
              THEN (CASE WHEN p.printApiPrice > 0 THEN 1 ELSE 0 END)
            ELSE 1
          END
        ), 0) as profitAssignedCount
      FROM payments p
      WHERE p.vibe = 0
        AND p.createdAt >= '${startDate.toISOString()}'
        AND p.createdAt <= '${endDate.toISOString()}'
        AND p.createdAt > '2024-12-05'
        ${monthEmailFilter}
      GROUP BY p.countrycode
    `);
    const profitAssignedMap = new Map(
      profitAssignedByCountry.map(p => [
        p.countrycode || 'Unknown',
        {
          totalProfit: Number(p.totalProfit) || 0,
          profitAssignedCount: Number(p.profitAssignedCount) || 0,
        },
      ])
    );

    const detailedReport = await Promise.all(
      report.map(async (entry) => {
        const payments = await this.prisma.payment.findMany({
          where: {
            countrycode: entry.countrycode,
            createdAt: {
              gte: startDate,
              lte: endDate,
              gt: new Date('2024-12-05'),
            },
          },
          select: {
            id: true,
          },
        });

        let totalPlaylistsSold = 0;
        for (const payment of payments) {
          const playlistsCount = await this.prisma.paymentHasPlaylist.count({
            where: {
              paymentId: payment.id,
            },
          });
          totalPlaylistsSold += playlistsCount;
        }

        const countryKey = entry.countrycode || 'Unknown';
        const gamesData = gamesMap.get(countryKey);
        const adj = refundAdjustments.get(countryKey);

        const grossTotal = entry._sum.totalPrice || 0;
        const grossExVAT = entry._sum.totalPriceWithoutTax || 0;

        return {
          country: countryKey,
          numberOfSales: entry._count._all,
          totalPrice: grossTotal - (adj?.refundedTotal || 0),
          totalPriceWithoutTax: grossExVAT - (adj?.refundedExVAT || 0),
          totalRefunded: adj?.refundedTotal || 0,
          taxRate: entry._max.taxRate,
          totalPlaylists: totalPlaylistsSold,
          boxAmount: boxMap.get(countryKey) || 0,
          gamesAmount: gamesData?.amount || 0,
          gamesTotal: gamesData?.total || 0,
          totalProfit: profitAssignedMap.get(countryKey)?.totalProfit || 0,
          profitAssignedCount: profitAssignedMap.get(countryKey)?.profitAssignedCount || 0,
        };
      })
    );

    return detailedReport.sort((a, b) => b.totalPrice - a.totalPrice);
  }

  public async getPaymentsByTaxRate(
    startDate: Date,
    endDate: Date
  ): Promise<any> {
    let ignoreEmails: string[] = [];

    if (process.env['ENVIRONMENT'] == 'production') {
      ignoreEmails = ['west14@gmail.com', 'info@rickgroenewegen.nl'];
    }

    const where = {
      status: 'paid',
      vibe: false,
      AND: [
        {
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        {
          createdAt: {
            gt: new Date('2024-12-05'),
          },
        },
      ],
      email: {
        notIn: ignoreEmails,
      },
    };

    // Group payments by (zone, taxRate). Zone is derived from countrycode:
    //   NL     → Binnenland
    //   EU !NL → EU
    //   other  → Export (non-EU, charged 0% VAT)
    const rows = await this.prisma.payment.findMany({
      where,
      select: {
        paymentId: true,
        countrycode: true,
        taxRate: true,
        totalPrice: true,
        totalPriceWithoutTax: true,
        productVATPrice: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    type Agg = {
      zone: string;
      countrycode: string;
      taxRate: number;
      firstPaymentId: string;
      numberOfSales: number;
      totalPrice: number;
      totalPriceWithoutTax: number;
      productVATPrice: number;
    };
    const paymentKey = (zone: string, countrycode: string, taxRate: number) =>
      `${zone}|${countrycode}|${taxRate}`;
    const agg = new Map<string, Agg>();
    for (const r of rows) {
      const zone = this.getTaxZone(r.countrycode);
      const countrycode = (r.countrycode || '').toUpperCase();
      const taxRate = r.taxRate || 0;
      const key = paymentKey(zone, countrycode, taxRate);
      const cur = agg.get(key) || {
        zone,
        countrycode,
        taxRate,
        firstPaymentId: r.paymentId,
        numberOfSales: 0,
        totalPrice: 0,
        totalPriceWithoutTax: 0,
        productVATPrice: 0,
      };
      cur.numberOfSales += 1;
      cur.totalPrice += r.totalPrice || 0;
      cur.totalPriceWithoutTax += r.totalPriceWithoutTax || 0;
      cur.productVATPrice += r.productVATPrice || 0;
      agg.set(key, cur);
    }

    const refundAdjustments = await this.getRefundAdjustmentsByKey(where, (p) =>
      paymentKey(
        this.getTaxZone(p.countrycode),
        (p.countrycode || '').toUpperCase(),
        p.taxRate || 0
      )
    );

    // Games: count all rows (initial + upgrade) but only sum upgrade prices.
    // Initial games are free signups so they have no VAT impact, but the count
    // mirrors the monthly report so the two reports reconcile.
    const gameRows = await this.prisma.gamesPurchase.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
      },
      select: {
        countrycode: true,
        taxRate: true,
        totalPrice: true,
        type: true,
      },
    });
    const gamesMap = new Map<string, { amount: number; total: number }>();
    for (const g of gameRows) {
      const zone = this.getTaxZone(g.countrycode);
      const countrycode = (g.countrycode || '').toUpperCase();
      const taxRate = g.taxRate || 0;
      const key = paymentKey(zone, countrycode, taxRate);
      const cur = gamesMap.get(key) || { amount: 0, total: 0 };
      cur.amount += 1;
      if (g.type === 'upgrade') cur.total += g.totalPrice || 0;
      gamesMap.set(key, cur);
    }

    const detailedReport = Array.from(agg.values()).map((entry) => {
      const key = paymentKey(entry.zone, entry.countrycode, entry.taxRate);
      const gamesData = gamesMap.get(key);
      const adj = refundAdjustments.get(key);
      return {
        zone: entry.zone,
        countrycode: entry.countrycode,
        taxRate: entry.taxRate,
        firstPaymentId: entry.firstPaymentId,
        numberOfSales: entry.numberOfSales,
        totalPrice: entry.totalPrice - (adj?.refundedTotal || 0),
        totalPriceWithoutTax:
          entry.totalPriceWithoutTax - (adj?.refundedExVAT || 0),
        totalVAT: entry.productVATPrice - (adj?.refundedVAT || 0),
        totalRefunded: adj?.refundedTotal || 0,
        gamesAmount: gamesData?.amount || 0,
        gamesTotal: gamesData?.total || 0,
      };
    });

    const zoneOrder = { NL: 0, EU: 1, EXPORT: 2 } as const;
    detailedReport.sort((a, b) => {
      const za = zoneOrder[a.zone as keyof typeof zoneOrder] ?? 9;
      const zb = zoneOrder[b.zone as keyof typeof zoneOrder] ?? 9;
      if (za !== zb) return za - zb;
      if (a.countrycode !== b.countrycode)
        return a.countrycode.localeCompare(b.countrycode);
      return b.taxRate - a.taxRate;
    });

    // OSS breakdown: per-country × taxRate within EU (excluding NL).
    // Required for the Unieregeling (One Stop Shop) quarterly return.
    const ossKey = (country: string, taxRate: number) =>
      `${country}|${taxRate}`;
    const ossAgg = new Map<
      string,
      {
        country: string;
        taxRate: number;
        numberOfSales: number;
        totalPrice: number;
        totalPriceWithoutTax: number;
        productVATPrice: number;
      }
    >();
    for (const r of rows) {
      if (this.getTaxZone(r.countrycode) !== 'EU') continue;
      const country = (r.countrycode || '').toUpperCase();
      const taxRate = r.taxRate || 0;
      const key = ossKey(country, taxRate);
      const cur = ossAgg.get(key) || {
        country,
        taxRate,
        numberOfSales: 0,
        totalPrice: 0,
        totalPriceWithoutTax: 0,
        productVATPrice: 0,
      };
      cur.numberOfSales += 1;
      cur.totalPrice += r.totalPrice || 0;
      cur.totalPriceWithoutTax += r.totalPriceWithoutTax || 0;
      cur.productVATPrice += r.productVATPrice || 0;
      ossAgg.set(key, cur);
    }

    const ossRefundAdjustments = await this.getRefundAdjustmentsByKey(
      where,
      (p) => {
        if (this.getTaxZone(p.countrycode) !== 'EU') return '';
        return ossKey((p.countrycode || '').toUpperCase(), p.taxRate || 0);
      }
    );

    const ossGamesMap = new Map<string, { amount: number; total: number }>();
    for (const g of gameRows) {
      if (this.getTaxZone(g.countrycode) !== 'EU') continue;
      const country = (g.countrycode || '').toUpperCase();
      const taxRate = g.taxRate || 0;
      const key = ossKey(country, taxRate);
      const cur = ossGamesMap.get(key) || { amount: 0, total: 0 };
      cur.amount += 1;
      if (g.type === 'upgrade') cur.total += g.totalPrice || 0;
      ossGamesMap.set(key, cur);
    }

    const ossBreakdown = Array.from(ossAgg.values()).map((entry) => {
      const key = ossKey(entry.country, entry.taxRate);
      const gamesData = ossGamesMap.get(key);
      const adj = ossRefundAdjustments.get(key);
      return {
        country: entry.country,
        taxRate: entry.taxRate,
        numberOfSales: entry.numberOfSales,
        totalPrice: entry.totalPrice - (adj?.refundedTotal || 0),
        totalPriceWithoutTax:
          entry.totalPriceWithoutTax - (adj?.refundedExVAT || 0),
        totalVAT: entry.productVATPrice - (adj?.refundedVAT || 0),
        totalRefunded: adj?.refundedTotal || 0,
        gamesAmount: gamesData?.amount || 0,
        gamesTotal: gamesData?.total || 0,
      };
    });

    ossBreakdown.sort((a, b) => {
      if (a.country !== b.country) return a.country.localeCompare(b.country);
      return b.taxRate - a.taxRate;
    });

    return { rows: detailedReport, ossBreakdown };
  }

  private getTaxZone(countryCode: string | null | undefined): string {
    if (!countryCode) return 'EXPORT';
    const cc = countryCode.toUpperCase();
    if (cc === 'NL') return 'NL';
    if (this.data.euCountryCodes.includes(cc)) return 'EU';
    return 'EXPORT';
  }

  /**
   * Fetch refunded payments matching `where` and aggregate refund shares per
   * key. Partial refunds are split proportionally across ex-VAT and VAT using
   * the original row's (totalPriceWithoutTax / totalPrice) ratio so tax
   * reports stay balanced after netting.
   */
  private async getRefundAdjustmentsByKey<K>(
    where: Prisma.PaymentWhereInput,
    keyFn: (p: {
      createdAt: Date;
      countrycode: string | null;
      taxRate: number | null;
    }) => K
  ): Promise<
    Map<
      K,
      {
        refundedTotal: number;
        refundedExVAT: number;
        refundedVAT: number;
      }
    >
  > {
    const refunded = await this.prisma.payment.findMany({
      where: {
        ...where,
        refundAmount: { gt: 0 },
      },
      select: {
        createdAt: true,
        countrycode: true,
        taxRate: true,
        totalPrice: true,
        totalPriceWithoutTax: true,
        productVATPrice: true,
        refundAmount: true,
      },
    });

    const adjustments = new Map<
      K,
      { refundedTotal: number; refundedExVAT: number; refundedVAT: number }
    >();
    for (const p of refunded) {
      const gross = p.totalPrice || 0;
      const refund = p.refundAmount || 0;
      if (gross <= 0 || refund <= 0) continue;
      const ratio = refund / gross;
      const key = keyFn(p);
      const current = adjustments.get(key) || {
        refundedTotal: 0,
        refundedExVAT: 0,
        refundedVAT: 0,
      };
      current.refundedTotal += refund;
      current.refundedExVAT += (p.totalPriceWithoutTax || 0) * ratio;
      current.refundedVAT += (p.productVATPrice || 0) * ratio;
      adjustments.set(key, current);
    }
    return adjustments;
  }

  public startCron(): void {
    new CronJob('0 1 * * *', async () => {
      await this.cleanPayments();
    }).start();
  }

  private async cleanPayments(): Promise<void> {
    try {
      const expiredPayments = await this.prisma.payment.findMany({
        where: {
          status: {
            in: ['expired', 'canceled'],
          },
        },
        select: {
          id: true,
        },
      });

      const expiredPaymentIds = expiredPayments.map((payment) => payment.id);

      if (expiredPaymentIds.length > 0) {
        await this.prisma.payment.deleteMany({
          where: {
            id: { in: expiredPaymentIds },
          },
        });

        this.logger.log(
          color.green.bold(
            `Deleted ${color.white.bold(
              expiredPaymentIds.length
            )} expired payments.`
          )
        );
      } else {
        this.logger.log(
          color.yellow.bold('No expired payments found to delete.')
        );
      }
    } catch (error: any) {
      this.logger.log(color.red.bold('Error cleaning expired payments!'));
    }
  }

  private async refreshCartTrackCounts(
    cart: { items: CartItem[] },
    _locale: string
  ): Promise<void> {
    for (const item of cart.items) {
      if (item.productType !== 'giftcard') {
        let tracksResult: ApiResult & { data?: { totalTracks: number } };

        // Use the correct provider based on serviceType
        const serviceType = item.serviceType || 'spotify';
        const provider = this.musicServiceRegistry.getProviderByString(serviceType);

        if (provider) {
          const result = await provider.getTracks(item.playlistId);
          tracksResult = {
            success: result.success,
            error: result.error,
            data: result.data ? { totalTracks: result.data.total } : undefined
          };
        } else {
          this.logger.log(
            color.yellow.bold(
              `Unknown service type '${serviceType}' for playlist ${item.playlistId}`
            )
          );
          tracksResult = { success: false, error: 'Unknown service type' };
        }

        if (tracksResult.success && tracksResult.data) {
          const freshTrackCount = tracksResult.data.totalTracks;
          if (freshTrackCount !== item.numberOfTracks) {
            this.logger.log(
              color.blue.bold(
                `Updated track count for playlist ${color.white.bold(item.playlistId)}: ` +
                `${color.white.bold(item.numberOfTracks.toString())} → ${color.white.bold(freshTrackCount.toString())}`
              )
            );
            item.numberOfTracks = freshTrackCount;

            // Recalculate price based on new track count
            const orderType = await this.order.getOrderType(
              freshTrackCount,
              item.type === 'digital',
              'cards',
              item.playlistId,
              item.subType || 'none'
            );
            if (orderType && orderType.amount) {
              item.price = orderType.amount;
            }
          }
        }
      }
    }
  }

  /**
   * Per-country payment method order, most popular first. Mollie renders
   * methods in array order, so the first item is the highlighted choice on
   * the checkout page. Only methods activated in our Mollie account should
   * appear here (see CLAUDE.md / mollie dashboard for the live list).
   */
  private static readonly METHODS_BY_COUNTRY: Record<string, PaymentMethod[]> = {
    NL: [
      PaymentMethod.ideal,
      PaymentMethod.applepay,
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.klarna,
      PaymentMethod.in3,
    ],
    BE: [
      PaymentMethod.bancontact,
      PaymentMethod.applepay,
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.klarna,
      PaymentMethod.belfius,
    ],
    DE: [
      // Ordered by German consumer popularity (PayPal + SEPA dominate;
      // Klarna/card/ApplePay tier next; Riverty/Trustly/paysafecard niche).
      PaymentMethod.paypal,
      PaymentMethod.directdebit,
      PaymentMethod.klarna,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.riverty,
      PaymentMethod.trustly,
      PaymentMethod.paysafecard,
    ],
    AT: [
      // EPS is the Austrian local favourite, then the same DE tiers.
      // Riverty intentionally omitted: very low penetration in AT
      // (Klarna dominates the BNPL slot here).
      PaymentMethod.eps,
      PaymentMethod.klarna,
      PaymentMethod.paypal,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.directdebit,
      PaymentMethod.trustly,
      PaymentMethod.paysafecard,
    ],
    CH: [
      // TWINT is by far the dominant Swiss method.
      // Riverty intentionally omitted: very low Swiss penetration
      // (Klarna fills the BNPL slot here).
      PaymentMethod.twint,
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.applepay,
      PaymentMethod.klarna,
    ],
    FR: [
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.applepay,
      PaymentMethod.klarna,
    ],
    ES: [
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.applepay,
      PaymentMethod.satispay,
      PaymentMethod.klarna,
    ],
    IT: [
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.satispay,
      PaymentMethod.bancomatpay,
      PaymentMethod.applepay,
      PaymentMethod.klarna,
    ],
    PT: [
      PaymentMethod.multibanco,
      PaymentMethod.mbway,
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.applepay,
    ],
    PL: [
      PaymentMethod.blik,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.paypal,
      PaymentMethod.klarna,
    ],
    SE: [
      PaymentMethod.swish,
      PaymentMethod.klarna,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
    ],
    NO: [
      PaymentMethod.klarna,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.paypal,
    ],
    DK: [
      PaymentMethod.klarna,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.paypal,
    ],
    GB: [
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.paypal,
      PaymentMethod.klarna,
    ],
    IE: [
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.paypal,
      PaymentMethod.klarna,
    ],
  };

  /**
   * Fallback when no country signal is available. Card-first because it works
   * everywhere; PayPal as the recognisable APM; Apple Pay last because it's
   * device-gated.
   */
  private static readonly METHODS_FALLBACK: PaymentMethod[] = [
    PaymentMethod.creditcard,
    PaymentMethod.paypal,
    PaymentMethod.applepay,
    PaymentMethod.klarna,
  ];

  /**
   * Language → country fallback. Two roles: (1) additive when the country
   * signal differs from the language country (a Swedish-speaker in Germany
   * still gets Swish/Klarna), and (2) sole signal when no country header is
   * available (CSR/dev — no SSR injection). Ambiguous Western languages map
   * to their largest market — country signal still wins when present, so
   * production behaviour with CloudFront-Viewer-Country is unchanged.
   */
  private static readonly LANGUAGE_IMPLIES_COUNTRY: Record<string, string> = {
    nl: 'NL',
    sv: 'SE',
    nb: 'NO',
    no: 'NO',
    da: 'DK',
    pl: 'PL',
    pt: 'PT',
    it: 'IT',
    en: 'GB',
    de: 'DE',
    fr: 'FR',
    es: 'ES',
  };

  /**
   * Mollie locale resolution. Some locales depend on the country (de_DE vs
   * de_AT vs de_CH, fr_FR vs fr_BE, nl_NL vs nl_BE).
   */
  private resolveMollieLocale(language: string, country: string | null): Locale {
    const lang = (language || '').toLowerCase();
    const cc = (country || '').toUpperCase();

    if (lang === 'de') {
      if (cc === 'AT') return Locale.de_AT;
      if (cc === 'CH') return Locale.de_CH;
      return Locale.de_DE;
    }
    if (lang === 'fr') {
      if (cc === 'BE') return Locale.fr_BE;
      return Locale.fr_FR;
    }
    if (lang === 'nl') {
      if (cc === 'BE') return Locale.nl_BE;
      return Locale.nl_NL;
    }

    const map: Record<string, Locale> = {
      en: Locale.en_US,
      es: Locale.es_ES,
      it: Locale.it_IT,
      pt: Locale.pt_PT,
      pl: Locale.pl_PL,
      sv: Locale.sv_SE,
      nb: Locale.nb_NO,
      no: Locale.nb_NO,
      da: Locale.da_DK,
      hin: Locale.en_US,
      hi: Locale.en_US,
    };
    return map[lang] || Locale.en_US;
  }

  /**
   * Currencies for which each method is accepted by Mollie. Method is
   * filtered out if the presentment currency isn't in its list. Methods not
   * in this map are treated as EUR-only.
   * See https://docs.mollie.com/reference/payment-method-availability
   */
  private static readonly METHOD_CURRENCY_SUPPORT: Partial<
    Record<PaymentMethod, ReadonlyArray<SupportedCurrency>>
  > = {
    [PaymentMethod.creditcard]: [
      'EUR', 'NOK', 'SEK', 'DKK', 'GBP', 'CHF', 'CZK', 'USD', 'CAD', 'AUD',
    ],
    [PaymentMethod.applepay]: [
      'EUR', 'NOK', 'SEK', 'DKK', 'GBP', 'CHF', 'CZK', 'USD', 'CAD', 'AUD',
    ],
    [PaymentMethod.paypal]: [
      'EUR', 'NOK', 'SEK', 'DKK', 'GBP', 'CHF', 'CZK', 'USD', 'CAD', 'AUD', 'PLN',
    ],
    [PaymentMethod.klarna]: ['EUR', 'NOK', 'SEK', 'DKK', 'GBP', 'CHF'],
    [PaymentMethod.riverty]: ['EUR', 'NOK', 'SEK', 'DKK', 'GBP', 'CHF'],
    [PaymentMethod.trustly]: ['EUR', 'NOK', 'SEK', 'DKK', 'GBP'],
    [PaymentMethod.twint]: ['EUR', 'CHF'],
    [PaymentMethod.swish]: ['SEK'],
    [PaymentMethod.blik]: ['EUR', 'PLN'],
    [PaymentMethod.przelewy24]: ['EUR', 'PLN'],
    [PaymentMethod.paybybank]: ['GBP'],
    // EUR-only methods (explicit so future readers don't have to dig):
    [PaymentMethod.ideal]: ['EUR'],
    [PaymentMethod.bancontact]: ['EUR'],
    [PaymentMethod.belfius]: ['EUR'],
    [PaymentMethod.kbc]: ['EUR'],
    [PaymentMethod.eps]: ['EUR'],
    [PaymentMethod.satispay]: ['EUR'],
    [PaymentMethod.bancomatpay]: ['EUR'],
    [PaymentMethod.multibanco]: ['EUR'],
    [PaymentMethod.mbway]: ['EUR'],
    [PaymentMethod.in3]: ['EUR'],
    [PaymentMethod.directdebit]: ['EUR'],
    [PaymentMethod.paysafecard]: ['EUR'],
  };

  public filterMethodsByCurrency(
    methods: PaymentMethod[],
    currency: SupportedCurrency
  ): PaymentMethod[] {
    return methods.filter((m) => {
      const supported = Mollie.METHOD_CURRENCY_SUPPORT[m] ?? ['EUR'];
      return supported.includes(currency);
    });
  }

  /**
   * Resolve the ordered list of payment methods + Mollie locale for a given
   * customer. Country is resolved with priority:
   *   billingCountry (form input) > viewerCountry (CloudFront) > ipCountry
   * The list is the country's popularity-ordered methods, followed by the
   * language-implied country's methods (so a Swedish-speaker in Germany
   * still sees Swish), followed by a generic fallback. Duplicates are
   * removed preserving first occurrence, then filtered by currency.
   */
  public resolveMollieMethods(input: {
    language: string;
    billingCountry?: string | null;
    viewerCountry?: string | null;
    ipCountry?: string | null;
    currency: SupportedCurrency;
  }): {
    locale: Locale;
    methods: PaymentMethod[];
    country: string | null;
    countrySource: 'billing' | 'viewer' | 'ip' | 'none';
  } {
    const norm = (c?: string | null) =>
      c && c.length === 2 ? c.toUpperCase() : null;

    let country: string | null = null;
    let countrySource: 'billing' | 'viewer' | 'ip' | 'none' = 'none';
    if (norm(input.billingCountry)) {
      country = norm(input.billingCountry);
      countrySource = 'billing';
    } else if (norm(input.viewerCountry)) {
      country = norm(input.viewerCountry);
      countrySource = 'viewer';
    } else if (norm(input.ipCountry)) {
      country = norm(input.ipCountry);
      countrySource = 'ip';
    }

    const lang = (input.language || '').toLowerCase();
    const langCountry = Mollie.LANGUAGE_IMPLIES_COUNTRY[lang] ?? null;

    const primary = country
      ? Mollie.METHODS_BY_COUNTRY[country] ?? []
      : [];
    const secondary =
      langCountry && langCountry !== country
        ? Mollie.METHODS_BY_COUNTRY[langCountry] ?? []
        : [];

    // If neither country nor language gave us anything, use the fallback.
    const ordered =
      primary.length === 0 && secondary.length === 0
        ? Mollie.METHODS_FALLBACK
        : [...primary, ...secondary, ...Mollie.METHODS_FALLBACK];

    const seen = new Set<PaymentMethod>();
    const deduped: PaymentMethod[] = [];
    for (const m of ordered) {
      if (!seen.has(m)) {
        seen.add(m);
        deduped.push(m);
      }
    }

    const methods = this.filterMethodsByCurrency(deduped, input.currency);

    return {
      locale: this.resolveMollieLocale(lang, country),
      methods,
      country,
      countrySource,
    };
  }

  public async clearPDFs(paymentId: string) {
    const payment = await this.getPayment(paymentId);
    const playlists = payment.PaymentHasPlaylist;

    this.logger.log(
      color.blue.bold(
        `Starting PDF deletion for payment ${color.white.bold(paymentId)} (${playlists.length} playlist(s))`
      )
    );

    let deletedCount = 0;
    let failedCount = 0;

    const deletePDF = async (filename: string, type: string) => {
      if (filename && filename !== '' && filename !== 'null') {
        const pdfPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
        try {
          await fs.unlink(pdfPath);
          deletedCount++;
          this.logger.log(
            color.blue.bold(`Deleted ${type} PDF: ${color.white.bold(pdfPath)}`)
          );
        } catch (e) {
          failedCount++;
          this.logger.log(
            color.yellow.bold(
              `Failed to delete ${type} PDF: ${color.white.bold(pdfPath)}`
            )
          );
        }
      }
    };

    for (const playlist of playlists) {
      await deletePDF(playlist.filename, 'standard');
      await deletePDF(playlist.filenameDigital, 'digital');
    }

    this.logger.log(
      color.blue.bold(
        `PDF deletion complete for payment ${color.white.bold(paymentId)}: ${white.bold(deletedCount.toString())} deleted, ` +
        (failedCount > 0 ? color.yellow.bold(`${failedCount} failed`) : `${white.bold(failedCount.toString())} failed`)
      )
    );
  }

  public async getPaymentList(
    search: OrderSearch & { page: number; itemsPerPage: number }
  ): Promise<{ payments: any[]; totalItems: number }> {
    const whereClause =
      Array.isArray(search.status) && search.status.length > 0
        ? { status: { in: search.status } }
        : {};

    // Check if text search is a number (for PaymentHasPlaylist.id search)
    const textSearchIsNumber =
      search.textSearch && !isNaN(parseInt(search.textSearch.trim(), 10));

    const textSearchClause =
      search.textSearch && search.textSearch.trim() !== ''
        ? {
            OR: [
              { fullname: { contains: search.textSearch } },
              { email: { contains: search.textSearch } },
              { orderId: { contains: search.textSearch } },
              { printApiOrderId: { contains: search.textSearch } },
              { paymentId: { contains: search.textSearch } },
              { shippingCode: { contains: search.textSearch } },
              {
                PaymentHasPlaylist: {
                  some: {
                    playlist: {
                      name: { contains: search.textSearch },
                    },
                  },
                },
              },
              {
                PaymentHasPlaylist: {
                  some: {
                    playlist: {
                      playlistId: { contains: search.textSearch },
                    },
                  },
                },
              },
              ...(textSearchIsNumber
                ? [
                    {
                      PaymentHasPlaylist: {
                        some: {
                          id: parseInt(search.textSearch.trim(), 10),
                        },
                      },
                    },
                  ]
                : []),
            ],
          }
        : {};

    const finalizedClause =
      typeof search.finalized === 'boolean'
        ? { finalized: search.finalized }
        : {};

    // Printer hold filter - if true, only include payments with printerHold = true AND at least one physical playlist
    const printerHoldClause =
      typeof search.printerHold === 'boolean' && search.printerHold
        ? {
            printerHold: true,
            PaymentHasPlaylist: {
              some: {
                type: 'physical',
              },
            },
          }
        : {};

    // Not submitted filter - if true, only include payments with printApiStatus = 'Created' AND at least one physical playlist with userConfirmedPrinting = true (Judged)
    const notSubmittedClause =
      typeof search.notSubmitted === 'boolean' && search.notSubmitted
        ? {
            printApiStatus: 'Created',
            PaymentHasPlaylist: {
              some: {
                type: 'physical',
                userConfirmedPrinting: true,
              },
            },
          }
        : {};

    // Printer type filter - if provided, only include payments with at least one physical playlist with matching printerType
    const printerTypeClause =
      search.printerType && search.printerType.trim() !== ''
        ? {
            PaymentHasPlaylist: {
              some: {
                type: 'physical',
                printerType: search.printerType,
              },
            },
          }
        : {};

    const totalItems = await this.prisma.payment.count({
      where: {
        vibe: false,
        ...whereClause,
        ...textSearchClause,
        ...finalizedClause,
        ...printerHoldClause,
        ...notSubmittedClause,
        ...printerTypeClause,
      },
    });

    const payments = await this.prisma.payment.findMany({
      where: {
        vibe: false,
        ...whereClause,
        ...textSearchClause,
        ...finalizedClause,
        ...printerHoldClause,
        ...notSubmittedClause,
        ...printerTypeClause,
      },
      skip: (search.page - 1) * search.itemsPerPage,
      take: search.itemsPerPage,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        paymentId: true,
        status: true,
        totalPrice: true,
        totalPriceWithoutTax: true,
        printApiPrice: true,
        createdAt: true,
        updatedAt: true,
        orderId: true,
        profit: true,
        printApiStatus: true,
        printApiTrackingLink: true,
        printApiOrderRequest: true,
        printApiOrderResponse: true,
        printApiOrderId: true,
        sentToPrinterAt: true,
        sentToPrinter: true,
        fast: true,
        printerHold: true,
        email: true,
        fullname: true,
        locale: true,
        address: true,
        city: true,
        zipcode: true,
        housenumber: true,
        printApiShipped: true,
        countrycode: true,
        isBusinessOrder: true,
        refundAmount: true,
        refundedAt: true,
        currency: true,
        totalPricePresentment: true,
        refundReason: true,
        user: {
          select: {
            hash: true,
          },
        },
        PaymentHasPlaylist: {
          select: {
            id: true,
            amount: true,
            filename: true,
            eco: true,
            doubleSided: true,
            printerType: true,
            theme: true,
            themeName: true,
            background: true,
            logo: true,
            subType: true,
            blocked: true,
            userConfirmedPrinting: true,
            orderType: {
              select: {
                name: true,
                digital: true,
              },
            },
            filenameDigital: true,
            printApiUploaded: true,
            printApiUploadResponse: true,
            type: true,
            // QR Code customization
            qrBackgroundType: true,
            qrColor: true,
            qrBackgroundColor: true,
            selectedFont: true,
            selectedFontSize: true,
            emoji: true,
            // Front side color/gradient
            backgroundFrontType: true,
            backgroundFrontColor: true,
            useFrontGradient: true,
            gradientFrontColor: true,
            gradientFrontDegrees: true,
            gradientFrontPosition: true,
            // Back side fields
            backgroundBackType: true,
            backgroundBack: true,
            backgroundBackColor: true,
            fontColor: true,
            useGradient: true,
            gradientBackgroundColor: true,
            gradientDegrees: true,
            gradientPosition: true,
            // Opacity
            frontOpacity: true,
            backOpacity: true,
            // Box
            boxEnabled: true,
            boxQuantity: true,
            boxFilename: true,
            boxFrontBackgroundType: true,
            boxFrontBackground: true,
            boxFrontBackgroundColor: true,
            boxFrontLogo: true,
            boxFrontLogoScale: true,
            boxFrontLogoPositionX: true,
            boxFrontLogoPositionY: true,
            boxFrontEmoji: true,
            boxBackBackgroundType: true,
            boxBackBackground: true,
            boxBackBackgroundColor: true,
            boxBackFontColor: true,
            boxBackUseGradient: true,
            boxBackGradientColor: true,
            boxBackGradientDegrees: true,
            boxBackGradientPosition: true,
            boxBackOpacity: true,
            boxBackText: true,
            boxBackSelectedFont: true,
            boxBackSelectedFontSize: true,
            // Bingo
            gamesEnabled: true,
            appleStoreFront: true,
            // How-to card
            addHowToCard: true,
            addHowToCardLocale: true,
            howToCardImage: true,
            playlist: {
              select: {
                name: true,
                playlistId: true,
                serviceType: true,
                featured: true,
                template: true,
                _count: {
                  select: {
                    tracks: true,
                  },
                },
                tracks: {
                  select: {
                    track: {
                      select: {
                        trackId: true,
                      },
                    },
                  },
                  orderBy: {
                    order: 'asc',
                  },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    return { payments, totalItems };
  }

  public async deletePayment(
    paymentId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if payment exists
      const payment = await this.prisma.payment.findUnique({
        where: { paymentId },
      });

      if (!payment) {
        return { success: false, error: 'Payment not found' };
      }

      // Delete the payment (cascading deletes will handle related records)
      await this.prisma.payment.delete({
        where: { paymentId },
      });

      return { success: true };
    } catch (error) {
      console.error('Error deleting payment:', error);
      return {
        success: false,
        error: 'Failed to delete payment from database',
      };
    }
  }

  private mollieClient = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY']!,
  });

  private mollieClientTest = createMollieClient({
    apiKey: process.env['MOLLIE_API_KEY_TEST']!,
  });

  private async getClient(ip: string) {
    if (
      process.env['ENVIRONMENT'] == 'development' ||
      this.utils.isTrustedIp(ip)
    ) {
      return { test: true, client: this.mollieClientTest };
    } else {
      return { test: false, client: this.mollieClient };
    }
  }

  public async getPaymentUri(
    params: any,
    clientIp: string,
    waitForDirectGeneration: boolean = false,
    skipGenerationMail: boolean = false,
    fallbackCountry: string = ''
  ): Promise<ApiResult> {
    try {
      if (!params?.extraOrderData) {
        return {
          success: false,
          error: 'Invalid request: extraOrderData is required',
        };
      }

      // Backstop for the rare case where the client submits an empty
      // countrycode (digital orders previously skipped the validator, and
      // a stale prefill from a prior empty order could overwrite the
      // CloudFront-detected value with ''). Without a country the Payment
      // row ends up with an empty countrycode and VAT zone resolution
      // falls back to "Unknown" in reports.
      if (!params.extraOrderData.countrycode && fallbackCountry) {
        params.extraOrderData.countrycode = fallbackCountry;
      }

      let useOrderType = 'digital';
      let description = '';
      let totalCards = 0;
      let molliePaymentId = '';
      let mollieCheckoutUrl = '';
      let molliePaymentStatus = 'noMollie';
      let molliePaymentAmount = 0;
      let discountAmount = 0;
      let discountUseIds: number[] = [];
      let discountUsed = false;
      let triggerDirectGeneration: boolean = false;
      let vibe: boolean = false;

      if (params.extraOrderData.vibe) {
        vibe = params.extraOrderData.vibe;
      }

      // Refresh track counts from Spotify API (uncached) before calculating price
      await this.refreshCartTrackCounts(params.cart, params.locale);

      // Re-run the calculation server-side so we never trust a client-
      // tampered `taxRate` / `total`. MUST include the business/VAT-ID
      // fields — otherwise reverse-charge is silently lost here and the
      // Payment row ends up with mismatched taxRate vs productVATPrice.
      const calculateResult = await this.order.calculateOrder({
        orderType: params.orderType,
        countrycode: params.extraOrderData.countrycode,
        cart: params.cart,
        fast: params.extraOrderData.fast || false,
        isBusinessOrder: !!params.extraOrderData.isBusinessOrder,
        vatId: params.extraOrderData.vatId || null,
      });

      const discountResult = await this.discount.calculateDiscounts(
        params.cart,
        calculateResult.data.total
      );

      discountAmount = discountResult.discountAmount;
      discountUseIds = discountResult.discountUseIds;
      discountUsed = discountResult.discountUsed;

      if (discountAmount > calculateResult.data.total) {
        discountAmount = calculateResult.data.total;
      }

      calculateResult.data.total -= discountAmount;
      calculateResult.data.discount = discountAmount;

      const paymentClientResult = await this.getClient(clientIp);
      const paymentClient = paymentClientResult.client;

      const translations = await this.translation.getTranslationsByPrefix(
        params.locale,
        'payment'
      );

      // if any of params.items has a type of 'physical' then we need to set useOrderType to 'physical'
      for (let i = 0; i < params.cart.items.length; i++) {
        if (params.cart.items[i].type == 'physical') {
          useOrderType = 'physical';
          totalCards += params.cart.items[i].amount;
        }
      }

      if (params.cart.items[0].productType == 'giftcard') {
        description = `${translations!.giftcard}`;
      } else {
        description = `${translations!.playlist} : ${
          params.cart.items[0].playlistName
        }`;
      }

      if (params.cart.items.length > 1) {
        // If it only contains giftcards, we can use the giftcard translation
        if (
          params.cart.items.every((item: any) => item.productType == 'giftcard')
        ) {
          description = `${params.cart.items.length}x ${
            translations!.giftcards
          }`;
        } else if (
          // If it only contains playlists, we can use the playlist translation
          params.cart.items.every((item: any) => item.productType == 'playlist')
        ) {
          description = `${params.cart.items.length}x ${
            translations!.playlists
          }`;
        } else {
          // If it contains a mix of playlists and giftcards, we can use the items translation
          description = `${params.cart.items.length}x ${translations!.items}`;
        }
      }

      // Description is 255 characters max
      if (description.length > 255) {
        description = description.substring(0, 250);
      }

      // Resolve the presentment currency: request override → EUR fallback.
      const requestedCurrency: string = isSupportedCurrency(params.currency)
        ? params.currency
        : 'EUR';

      // Single FX call with built-in EUR fallback (shared with merchantcenter).
      const converted = await this.fx.tryConvert(
        calculateResult.data.total,
        requestedCurrency
      );
      const presentmentAmount = converted.amount;
      const presentmentRate = converted.rate;
      const presentmentCurrency: SupportedCurrency = converted.currency;

      // Handle free orders (with discount) OR vibe orders with low totals
      if ((calculateResult.data.total === 0 && discountUsed) || (vibe && calculateResult.data.total <= 10)) {
        molliePaymentId = `free_${this.utils.generateRandomString(10)}`;
        molliePaymentAmount = 0;
        molliePaymentStatus = 'paid';
        mollieCheckoutUrl = `${process.env['FRONTEND_URI']}/${params.locale}/generate/progress`;
        triggerDirectGeneration = true;
      } else {
        if (calculateResult.data.total <= 3) {
          throw new Error('Order calculation');
        }

        // IP-based country is the lowest-trust fallback; only used when the
        // billing form and CloudFront viewer header don't give us anything.
        let ipCountry = '';
        try {
          const location = await this.utils.lookupIp(clientIp);
          if (location && location.country_code) {
            ipCountry = location.country_code;
          }
        } catch (error) {
          console.error('Error looking up IP for payment methods:', error);
        }

        const resolved = this.resolveMollieMethods({
          language: params.locale,
          billingCountry: params.extraOrderData?.countrycode,
          viewerCountry: params.viewerCountry,
          ipCountry,
          currency: presentmentCurrency,
        });
        const paymentMethods = resolved.methods;

        this.logger.log(
          color.blue.bold(
            `Mollie methods resolved: country=${color.white.bold(
              resolved.country || '-'
            )} (source=${color.white.bold(resolved.countrySource)}) language=${color.white.bold(
              params.locale
            )} currency=${color.white.bold(presentmentCurrency)} → ${color.white.bold(
              paymentMethods.join(',')
            )}`
          )
        );

        const payment = await paymentClient.payments.create({
          amount: {
            currency: presentmentCurrency,
            value: presentmentAmount.toFixed(2),
          },
          metadata: {
            clientIp,
            refreshPlaylists: params.refreshPlaylists.join(','),
          },
          method: paymentMethods,
          description: description,
          redirectUrl: `${process.env['FRONTEND_URI']}/${params.locale}/generate/check_payment`,
          webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
          locale: resolved.locale,
        });

        molliePaymentId = payment.id;
        molliePaymentAmount = Math.round(calculateResult.data.total * 100) / 100;
        molliePaymentStatus = payment.status;
        mollieCheckoutUrl = payment.getCheckoutUrl()!;
      }

      const userDatabaseId = await this.data.storeUser({
        userId: params.extraOrderData.email,
        email: params.extraOrderData.email,
        displayName: params.extraOrderData.fullname,
        locale: params.locale,
      });

      const playlistDatabaseIds = await this.data.storePlaylists(
        userDatabaseId,
        params.cart.items
      );

      // Look up any AI-generated playlist prompts so we can persist them
      // on the payment_has_playlist records below.
      const cartSpotifyIds = Array.from(
        new Set(
          (params.cart.items || [])
            .map((it: any) => it?.playlistId)
            .filter((id: any) => typeof id === 'string' && id.length > 0)
        )
      ) as string[];
      const aiPromptsBySpotifyId = new Map<string, string>();
      if (cartSpotifyIds.length > 0) {
        try {
          const { aiPlaylistPromptKey } = await import('./aiPlaylist');
          for (const spId of cartSpotifyIds) {
            const cached = await this.cache.get(aiPlaylistPromptKey(spId));
            if (typeof cached === 'string' && cached.length > 0) {
              aiPromptsBySpotifyId.set(spId, cached);
            }
          }
        } catch (err) {
          this.logger.log(
            color.yellow.bold(
              `Failed to look up AI playlist prompts: ${err}`
            )
          );
        }
      }

      const productPriceWithoutTax = parseFloat(
        parseFloat(calculateResult.data.price).toFixed(2)
      );

      let shippingPriceWithoutTax = 0;
      let shippingVATPrice = 0;

      if (useOrderType == 'physical') {
        shippingPriceWithoutTax = parseFloat(
          (
            parseFloat(calculateResult.data.payment) /
            (1 + calculateResult.data.taxRateShipping / 100)
          ).toFixed(2)
        );

        shippingVATPrice = parseFloat(
          (
            parseFloat(calculateResult.data.payment) - shippingPriceWithoutTax
          ).toFixed(2)
        );
      }

      const productVATPrice = parseFloat(
        (
          parseFloat(calculateResult.data.price) *
          (calculateResult.data.taxRate / 100)
        ).toFixed(2)
      );

      // Box and QRGames fees are VAT-INCLUSIVE add-ons charged at the product
      // tax rate (boxTierPrice / QRGAMES_UPGRADE_PRICE are gross amounts) and
      // are folded straight into `total`. Back out the embedded VAT so the
      // order's total output VAT (and the invoice) reflects it — otherwise
      // the line items under-sum the total by the add-on VAT. When reverse
      // charge applies taxRate is 0, so this is correctly 0 as well.
      const addonsTaxRate = calculateResult.data.taxRate ?? 0;
      const addonsGross =
        (calculateResult.data.boxFee || 0) +
        (calculateResult.data.gamesFee || 0);
      const addonsVATPrice = parseFloat(
        (
          addonsGross -
          addonsGross / (1 + addonsTaxRate / 100)
        ).toFixed(2)
      );

      const totalVATPrice = parseFloat(
        (productVATPrice + shippingVATPrice + addonsVATPrice).toFixed(2)
      );

      const playlists = await Promise.all(
        params.cart.items.map(async (item: CartItem, index: number) => {
          const orderType = await this.order.getOrderType(
            item.numberOfTracks,
            item.type === 'digital',
            item.productType,
            item.playlistId,
            item.subType
          );

          const printApiItemPrice = orderType.amount * item.amount;

          let itemPrice = item.price * item.amount;
          const itemPriceWithoutVAT = parseFloat(
            (itemPrice / (1 + calculateResult.data.taxRate / 100)).toFixed(2)
          );
          const itemPriceVAT = parseFloat(
            (itemPrice - itemPriceWithoutVAT).toFixed(2)
          );

          return {
            playlistId: playlistDatabaseIds[index],
            orderTypeId: orderType.id,
            amount: item.amount,
            numberOfTracks: item.numberOfTracks,
            type: item.type == 'sheets' ? 'physical' : item.type,
            subType: item.type == 'sheets' ? 'sheets' : 'none',
            doubleSided: item.doubleSided,
            eco: item.eco,
            qrColor: item.qrColor || '#000000',
            qrBackgroundColor: item.qrBackgroundColor || '#ffffff',
            hideCircle: item.hideCircle,
            qrBackgroundType:
              item.qrBackgroundType || (item.hideCircle ? 'none' : 'square'),
            price: itemPrice,
            priceWithoutVAT: itemPriceWithoutVAT,
            priceVAT: itemPriceVAT,
            printApiPrice: printApiItemPrice,
            emoji: item.emoji || '',
            background: item.background || '',
            logo: item.logo || '',
            selectedFont: item.selectedFont || 'Arial, sans-serif',
            selectedFontSize: item.selectedFontSize || '16px',
            // Front side color/gradient
            backgroundFrontType: item.backgroundFrontType || 'image',
            backgroundFrontColor: item.backgroundFrontColor || '#ffffff',
            useFrontGradient: item.useFrontGradient || false,
            gradientFrontColor: item.gradientFrontColor || '#ffffff',
            gradientFrontDegrees: item.gradientFrontDegrees || 180,
            gradientFrontPosition: item.gradientFrontPosition || 50,
            // Back side
            backgroundBackType: item.backgroundBackType || 'image',
            backgroundBack: item.backgroundBack || '',
            backgroundBackColor: item.backgroundBackColor || '#ffffff',
            fontColor: item.fontColor || '#000000',
            useGradient: item.useGradient || false,
            gradientBackgroundColor: item.gradientBackgroundColor || '#ffffff',
            gradientDegrees: item.gradientDegrees || 180,
            gradientPosition: item.gradientPosition || 50,
            // Opacity
            frontOpacity:
              item.frontOpacity !== undefined ? item.frontOpacity : 100,
            backOpacity: item.backOpacity !== undefined ? item.backOpacity : 50,
            // Bingo enabled flag and price
            gamesEnabled: item.productType === 'cards' ? (item.gamesEnabled === true) : false,
            gamesPrice: (item.productType === 'cards' && item.gamesEnabled === true) ? QRGAMES_UPGRADE_PRICE : 0,
            // Box add-on
            boxEnabled: item.boxEnabled === true,
            boxQuantity: item.boxQuantity || 0,
            boxPrice: (item.boxQuantity || 0) * BOX_PRICE,
            // Box front design
            boxFrontBackgroundType: item.boxFrontBackgroundType || 'image',
            boxFrontBackground: item.boxFrontBackground || '',
            boxFrontBackgroundColor: item.boxFrontBackgroundColor || '#ffffff',
            boxFrontUseFrontGradient: item.boxFrontUseFrontGradient || false,
            boxFrontGradientColor: item.boxFrontGradientColor || '#ffffff',
            boxFrontGradientDegrees: item.boxFrontGradientDegrees || 180,
            boxFrontGradientPosition: item.boxFrontGradientPosition || 50,
            boxFrontLogo: item.boxFrontLogo || '',
            boxFrontLogoScale: item.boxFrontLogoScale ?? 50,
            boxFrontLogoPositionX: item.boxFrontLogoPositionX ?? 50,
            boxFrontLogoPositionY: item.boxFrontLogoPositionY ?? 50,
            boxFrontEmoji: item.boxFrontEmoji || '',
            // Box back design
            boxBackBackgroundType: item.boxBackBackgroundType || 'solid',
            boxBackBackground: item.boxBackBackground || '',
            boxBackBackgroundColor: item.boxBackBackgroundColor || '#ffffff',
            boxBackFontColor: item.boxBackFontColor || '#000000',
            boxBackUseGradient: item.boxBackUseGradient || false,
            boxBackGradientColor: item.boxBackGradientColor || '#ffffff',
            boxBackGradientDegrees: item.boxBackGradientDegrees || 180,
            boxBackGradientPosition: item.boxBackGradientPosition || 50,
            boxBackOpacity: item.boxBackOpacity !== undefined ? item.boxBackOpacity : 50,
            boxBackText: item.boxBackText || '',
            boxBackSelectedFont: item.boxBackSelectedFont || 'Arial, sans-serif',
            boxBackSelectedFontSize: item.boxBackFontSize ? `${item.boxBackFontSize}px` : (item.boxBackSelectedFontSize || '14px'),
            aiPrompt: aiPromptsBySpotifyId.get(item.playlistId) || null,
          };
        })
      );

      let totalProfit = parseFloat(
        (productPriceWithoutTax + shippingPriceWithoutTax).toFixed(2)
      );

      if (params.cart.items[0].productType == 'giftcard') {
        if (useOrderType == 'physical') {
          totalProfit =
            molliePaymentAmount - (shippingPriceWithoutTax + shippingVATPrice);
        } else {
          totalProfit = params.cart.items[0].price;
        }
      }

      delete params.extraOrderData.orderType;
      delete params.extraOrderData.total;
      delete params.extraOrderData.price;
      delete params.extraOrderData.agreeTerms;
      delete params.extraOrderData.agreeNoRefund;
      // Strip form-echoed fields the server recomputes below. Without this,
      // the client's remembered values (from the /order/calculate response)
      // would spread in via `...params.extraOrderData` and overwrite our
      // authoritative numbers — masking reverse-charge bugs (taxRate=0 on
      // row, productVATPrice=2.26 stored from a stale calc) and in general
      // opening a trust-the-client hole on VAT / shipping / totals.
      delete params.extraOrderData.taxRate;
      delete params.extraOrderData.taxRateShipping;
      delete params.extraOrderData.shipping;
      delete params.extraOrderData.volumeDiscount;
      delete params.extraOrderData.gamesFee;

      // Use the tax rate the calculateOrder pipeline resolved (which
      // already reflects reverse charge when applicable) instead of the
      // raw country VAT — otherwise totalPriceWithoutTax ends up backed
      // out of the wrong denominator for B2B reverse-charge orders.
      const effectiveTaxRate = calculateResult.data.taxRate ?? 0;
      const molliePaymentAmountWithoutTax = parseFloat(
        (molliePaymentAmount / (1 + effectiveTaxRate / 100)).toFixed(2)
      );

      const insertResult = await this.prisma.payment.create({
        data: {
          paymentId: molliePaymentId,
          vibe,
          user: {
            connect: { id: userDatabaseId },
          },
          totalPrice: molliePaymentAmount,
          totalPriceWithoutTax: molliePaymentAmountWithoutTax,
          status: molliePaymentStatus,
          locale: params.locale,
          taxRate: calculateResult.data.taxRate,
          taxRateShipping: calculateResult.data.taxRateShipping,
          productPriceWithoutTax,
          shippingPriceWithoutTax,
          productVATPrice,
          shippingVATPrice,
          totalVATPrice,
          clientIp,
          test: false,
          profit: totalProfit,
          printApiPrice: 0,
          discount: discountAmount,
          boxFee: calculateResult.data.boxFee || 0,
          gamesFee: calculateResult.data.gamesFee || 0,
          currency: presentmentCurrency,
          exchangeRate: presentmentRate,
          totalPricePresentment:
            presentmentCurrency === 'EUR' ? molliePaymentAmount : presentmentAmount,
          reverseCharge: !!calculateResult.data.reverseCharge,
          vatIdChecked: calculateResult.data.vatIdChecked || null,
          boxInstructionsMailSent: false,
          PaymentHasPlaylist: { create: playlists },
          ...params.extraOrderData,
        },
      });

      const paymentId = insertResult.id;

      // AI prompts have been persisted on the PaymentHasPlaylist rows above;
      // delete the transient Redis copies so they don't linger past their use.
      if (aiPromptsBySpotifyId.size > 0) {
        try {
          const { aiPlaylistPromptKey } = await import('./aiPlaylist');
          for (const spId of aiPromptsBySpotifyId.keys()) {
            await this.cache.del(aiPlaylistPromptKey(spId));
          }
        } catch (err) {
          this.logger.log(
            color.yellow.bold(
              `Failed to clean up AI playlist prompts from cache: ${err}`
            )
          );
        }
      }

      // Log QRGames purchase if any playlists have gamesEnabled
      const gamesPlaylists = playlists.filter((p: any) => p.gamesEnabled === true);
      if (gamesPlaylists.length > 0) {
        await this.prisma.gamesPurchase.create({
          data: {
            userId: userDatabaseId,
            totalPrice: gamesPlaylists.length * QRGAMES_UPGRADE_PRICE,
            playlistCount: gamesPlaylists.length,
            pricePerPlaylist: QRGAMES_UPGRADE_PRICE,
            type: 'initial',
            countrycode: params.extraOrderData.countrycode || null,
            taxRate: calculateResult.data.taxRate || null,
            molliePaymentId,
          },
        });
      }

      // Reload app theme cache to include new payment_has_playlist entries
      this.appTheme.reload();

      const newOrderId = 100000000 + paymentId;

      // Update the users marketingEmails field
      await this.prisma.user.update({
        where: {
          id: userDatabaseId,
        },
        data: {
          marketingEmails: params.extraOrderData.marketingEmails,
          sync: true,
        },
      });

      // Associate the payment with each discount use
      for (const discountUseId of discountUseIds) {
        await this.discount.associatePaymentWithDiscountUse(
          discountUseId,
          paymentId
        );
      }
      await this.prisma.payment.update({
        where: {
          id: paymentId,
        },
        data: {
          orderId: newOrderId.toString(),
        },
      });

      if (triggerDirectGeneration) {
        if (waitForDirectGeneration) {
          await this.generator.queueGenerate(
            molliePaymentId,
            clientIp,
            params.refreshPlaylists.join(','),
            false,
            skipGenerationMail,
            false
          );
        } else {
          this.generator.queueGenerate(
            molliePaymentId,
            clientIp,
            params.refreshPlaylists.join(','),
            false,
            false,
            false
          );
        }
      }

      return {
        success: true,
        data: {
          paymentId: molliePaymentId,
          paymentUri: mollieCheckoutUrl,
          userId: userDatabaseId,
          generationQueued: triggerDirectGeneration, // Flag to indicate generation was already queued
        },
      };
    } catch (e) {
      this.logger.log(
        color.red.bold('Payment creation failed: ') +
          color.white(e instanceof Error ? e.message : String(e))
      );

      // Log full stack trace for debugging
      if (e instanceof Error && e.stack) {
        console.error(e.stack);
      }

      return {
        success: false,
        error: 'Failed to create payment',
      };
    }
  }

  public async canDownloadPDF(
    playlistId: string,
    paymentId: string
  ): Promise<boolean> {
    const payment = await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
      select: {
        PaymentHasPlaylist: {
          select: {
            playlist: {
              select: {
                playlistId: true,
              },
            },
          },
        },
      },
    });

    if (payment) {
      return payment.PaymentHasPlaylist.some(
        (relation) => relation.playlist.playlistId === playlistId
      );
    } else {
      return false;
    }
  }

  public async processWebhook(params: any): Promise<ApiResult> {
    if (params.id) {
      this.logger.log(
        color.blue.bold('Processing webhook with ID: ') +
          color.white.bold(params.id)
      );

      // Check if this is a valid Mollie payment ID format (starts with "tr_")
      if (!params.id.startsWith('tr_')) {
        this.logger.log(
          color.red.bold('Invalid payment ID format in webhook: ') +
            color.white.bold(params.id)
        );
        return {
          success: false,
          error: 'Invalid payment ID format',
        };
      }

      let payment;

      // Try the live client first, with a fallback to test
      try {
        payment = await this.mollieClient.payments.get(params.id);
      } catch (e) {
        payment = await this.mollieClientTest.payments.get(params.id);
      }

      // Check if this is a bingo upgrade payment (special handling - not a regular order)
      const metadata = payment.metadata as any;
      if (metadata?.type === 'bingo_upgrade' && payment.status === 'paid') {
        // Handle both old single ID format and new multiple IDs format
        const paymentHasPlaylistIds = metadata.paymentHasPlaylistIds || metadata.paymentHasPlaylistId;
        const userId = parseInt(metadata.userId);
        const pricePerPlaylist = metadata.pricePerPlaylist ? parseFloat(metadata.pricePerPlaylist) : undefined;

        if (paymentHasPlaylistIds && userId) {
          const result = await this.bingo.processBingoUpgradePayment(
            paymentHasPlaylistIds,
            userId,
            pricePerPlaylist,
            payment.id
          );
          return result.success
            ? { success: true }
            : { success: false, error: result.error || 'Failed to process bingo upgrade' };
        }
      }

      // Check if this is a box upgrade payment
      if (metadata?.type === 'box_upgrade' && payment.status === 'paid') {
        const paymentHasPlaylistId = parseInt(metadata.paymentHasPlaylistId);
        const userId = parseInt(metadata.userId);
        const originalPaymentId = metadata.originalPaymentId as string;
        const quantity = parseInt(metadata.quantity) || 1;

        if (paymentHasPlaylistId && userId && originalPaymentId) {
          // Idempotency guard: skip if box is already enabled
          const php = await this.prisma.paymentHasPlaylist.findUnique({
            where: { id: paymentHasPlaylistId },
            include: { payment: { select: { sentToPrinter: true } } },
          });
          if (php?.boxEnabled === true) {
            this.logger.log(
              color.yellow.bold(`Box upgrade already processed for PHP ${paymentHasPlaylistId}, skipping`)
            );
            return { success: true };
          }

          try {
            // Set boxEnabled and boxPrice on PaymentHasPlaylist
            const unitPrice = metadata.boxPrice
              ? parseFloat(metadata.boxPrice)
              : BOX_PRICE;
            const boxLineTotal = parseFloat((unitPrice * quantity).toFixed(2));
            await this.prisma.paymentHasPlaylist.update({
              where: { id: paymentHasPlaylistId },
              data: {
                boxEnabled: true,
                boxPrice: boxLineTotal,
              },
            });

            // Roll the upgrade total into Payment.totalPrice so books reflect
            // the customer's full lifetime spend on this order. Include the
            // settled amount (subtotal + VAT + any shipping carried in the
            // metadata) to match what was actually charged.
            const upgradeShipping = metadata.shippingCost
              ? parseFloat(metadata.shippingCost)
              : 0;
            // Re-derive VAT from the box subtotal using the original payment's
            // country, the same way `Upgrade.calculateBoxUpgradePrice` does.
            const phpForVat = await this.prisma.paymentHasPlaylist.findUnique({
              where: { id: paymentHasPlaylistId },
              select: { payment: { select: { countrycode: true } } },
            });
            const upgradeTaxRate =
              (await this.data.getTaxRate(phpForVat?.payment?.countrycode || 'NL')) || 0;
            const upgradeVat = parseFloat(
              (boxLineTotal * (upgradeTaxRate / 100)).toFixed(2)
            );
            const upgradeChargedEur = parseFloat(
              (boxLineTotal + upgradeVat + upgradeShipping).toFixed(2)
            );
            await this.prisma.payment.update({
              where: { paymentId: originalPaymentId },
              data: {
                totalPrice: { increment: upgradeChargedEur },
              },
            });

            // Generate box insert card PDF. Pass the purchased box total
            // explicitly: the my-account upgrade stores the user-chosen
            // TOTAL in boxQuantity while the usersuggestions upgrade stores
            // a per-copy value, so deriving boxQuantity × amount here would
            // be wrong for the former.
            try {
              await this.generator.generateBoxInsertPdf(paymentHasPlaylistId, originalPaymentId, quantity);
            } catch (pdfError) {
              this.logger.log(
                color.yellow.bold(`Failed to generate box PDF for PHP ${paymentHasPlaylistId}: ${pdfError}`)
              );
            }

            // Create a separate Print&Bind box-only order — but only when
            // the main order has already been sent to the printer. Before
            // that point (usersuggestions upgrades) the box rides along
            // with the main order: boxEnabled/boxFilename are now set, so
            // sendToPrinter attaches the packaging accessory and the insert
            // card article itself. Creating a separate order here too would
            // ship the boxes twice.
            if (php?.payment?.sentToPrinter) {
              try {
                await this.printenbind.createBoxUpgradeOrder(paymentHasPlaylistId, quantity);
              } catch (printError) {
                this.logger.log(
                  color.yellow.bold(`Failed to create box Print&Bind order for PHP ${paymentHasPlaylistId}: ${printError}`)
                );
              }
            } else {
              this.logger.log(
                color.blue.bold(
                  `Main order not sent to printer yet — box for PHP ${color.white.bold(
                    paymentHasPlaylistId.toString()
                  )} will ride along with the main Print&Bind order`
                )
              );
            }

            // Clear user cache
            const phpRecord = await this.prisma.paymentHasPlaylist.findUnique({
              where: { id: paymentHasPlaylistId },
              include: { payment: { include: { user: { select: { hash: true } } } } },
            });
            if (phpRecord?.payment?.user?.hash) {
              await this.cache.del(`playlists:user:${phpRecord.payment.user.hash}`);
            }

            this.logger.log(
              color.blue.bold('Processed box upgrade payment for PHP: ') +
                color.white.bold(paymentHasPlaylistId.toString())
            );

            return { success: true };
          } catch (error: any) {
            this.logger.log(
              color.red.bold(`Error processing box upgrade: ${error.message}`)
            );
            return { success: false, error: 'Failed to process box upgrade' };
          }
        }
      }

      // Check if this is a tracks upgrade payment
      if (metadata?.type === 'tracks_upgrade' && payment.status === 'paid') {
        const paymentHasPlaylistId = parseInt(metadata.paymentHasPlaylistId);
        const userId = parseInt(metadata.userId);
        const originalPaymentId = metadata.originalPaymentId as string;
        const extraTracks = parseInt(metadata.extraTracks);
        const previousNumberOfTracks = parseInt(metadata.previousNumberOfTracks) || 0;
        const extraBoxes = parseInt(metadata.extraBoxes) || 0;
        const newBoxQuantity = parseInt(metadata.newBoxQuantity) || 0;
        const boxUnitPriceEur = metadata.boxUnitPriceEur
          ? parseFloat(metadata.boxUnitPriceEur)
          : 0;

        if (paymentHasPlaylistId && userId && originalPaymentId && extraTracks) {
          // Idempotency guard via Redis: a webhook for the same Mollie payment
          // ID must only be applied once, even if Mollie retries.
          const idemKey = `tracks_upgrade_processed:${payment.id}`;
          const alreadyProcessed = await this.cache.get(idemKey);
          if (alreadyProcessed) {
            this.logger.log(
              color.yellow.bold(`Tracks upgrade ${payment.id} already processed, skipping`)
            );
            return { success: true };
          }

          try {
            const php = await this.prisma.paymentHasPlaylist.findUnique({
              where: { id: paymentHasPlaylistId },
            });
            if (!php) {
              return { success: false, error: 'PaymentHasPlaylist not found' };
            }

            const newCount = (php.numberOfTracks || previousNumberOfTracks) + extraTracks;

            const result = await this.data.updatePlaylistDetails(
              paymentHasPlaylistId,
              newCount,
              undefined
            );
            if (!result.success) {
              this.logger.log(
                color.red.bold(`Failed to update track count for tracks upgrade: ${result.error}`)
              );
              return { success: false, error: result.error || 'Failed to update track count' };
            }

            // If the new track total spilled into another physical box, bump
            // boxQuantity to the new total and roll the extra-box cost into
            // boxPrice. Only orders that already had boxEnabled get this —
            // the calculator only emits extraBoxes > 0 for those.
            if (extraBoxes > 0 && newBoxQuantity > 0 && boxUnitPriceEur > 0) {
              const extraBoxesCost = parseFloat(
                (boxUnitPriceEur * extraBoxes).toFixed(2)
              );
              await this.prisma.paymentHasPlaylist.update({
                where: { id: paymentHasPlaylistId },
                data: {
                  boxQuantity: newBoxQuantity,
                  boxPrice: { increment: extraBoxesCost },
                },
              });
              this.logger.log(
                color.blue.bold('Tracks upgrade added boxes: ') +
                  color.white.bold(`+${extraBoxes} → ${newBoxQuantity}`) +
                  color.blue.bold(' for PHP: ') +
                  color.white.bold(paymentHasPlaylistId.toString())
              );
            }

            // Roll the charged amount into Payment.totalPrice so the books
            // reflect the customer's full lifetime spend on this order.
            const chargedAmountEur =
              (payment as any).amount && (payment as any).amount.currency === 'EUR'
                ? parseFloat((payment as any).amount.value)
                : null;
            if (chargedAmountEur !== null) {
              await this.prisma.payment.update({
                where: { paymentId: originalPaymentId },
                data: { totalPrice: { increment: chargedAmountEur } },
              });
            } else {
              // Non-EUR settlement: prefer settlementAmount in EUR if present.
              const settlementEur =
                (payment as any).settlementAmount &&
                (payment as any).settlementAmount.currency === 'EUR'
                  ? parseFloat((payment as any).settlementAmount.value)
                  : null;
              if (settlementEur !== null) {
                await this.prisma.payment.update({
                  where: { paymentId: originalPaymentId },
                  data: { totalPrice: { increment: settlementEur } },
                });
              }
            }

            // Mark as processed for 60 days; webhook replays after that are
            // vanishingly unlikely.
            await this.cache.set(idemKey, '1', 60 * 60 * 24 * 60);

            // Clear user cache so the new track count surfaces on dashboards.
            const phpRecord = await this.prisma.paymentHasPlaylist.findUnique({
              where: { id: paymentHasPlaylistId },
              include: { payment: { include: { user: { select: { hash: true } } } } },
            });
            if (phpRecord?.payment?.user?.hash) {
              await this.cache.del(`playlists:user:${phpRecord.payment.user.hash}`);
            }

            this.logger.log(
              color.blue.bold('Processed tracks upgrade payment: ') +
                color.white.bold(`+${extraTracks} → ${newCount}`) +
                color.blue.bold(' for PHP: ') +
                color.white.bold(paymentHasPlaylistId.toString())
            );

            return { success: true };
          } catch (error: any) {
            this.logger.log(
              color.red.bold(`Error processing tracks upgrade: ${error.message}`)
            );
            return { success: false, error: 'Failed to process tracks upgrade' };
          }
        }
      }

      const dbPayment = await this.prisma.payment.findUnique({
        select: {
          id: true,
          paymentId: true,
          status: true,
          user: {
            select: {
              hash: true,
            },
          },
        },
        where: {
          paymentId: payment.id,
        },
      });

      if (!dbPayment) {
        this.logger.log(
          color.yellow.bold('Webhook received for unknown payment: ') +
            color.white.bold(payment.id)
        );
        return { success: true };
      }

      // Atomic state-transition claim: only the webhook that flips the status
      // proceeds with side effects. Concurrent or replayed webhooks see count=0
      // and return without re-firing downstream work.
      let statusChanged = false;
      const settlementAmountEur =
        (payment as any).settlementAmount &&
        (payment as any).settlementAmount.currency === 'EUR'
          ? parseFloat((payment as any).settlementAmount.value)
          : null;
      try {
        const claim = await this.prisma.payment.updateMany({
          where: {
            paymentId: payment.id,
            status: { not: payment.status },
          },
          data: {
            status: payment.status,
            paymentMethod: payment.method,
            ...(settlementAmountEur !== null ? { settlementAmountEur } : {}),
          },
        });
        statusChanged = claim.count > 0;
      } catch (e) {
        this.logger.log(
          color.red.bold('Failed to update payment in database: ') +
            color.white.bold(payment.id)
        );
        return {
          success: false,
          error: 'Failed to update payment',
        };
      }

      this.logger.log(
        color.blue.bold('Processed webhook for payment: ') +
          color.bold.white(payment.id) +
          color.blue.bold(' with status: ') +
          color.bold.white(payment.status) +
          (statusChanged ? '' : color.yellow.bold(' (replay — side effects skipped)'))
      );

      if (statusChanged || process.env['ENVIRONMENT'] == 'development') {
        if (payment.status == 'paid') {
          const metadata = payment.metadata as {
            clientIp: string;
            refreshPlaylists: string;
          };

          // Clear the playlist cache for this user since they may have purchased new playlists
          if (dbPayment.user?.hash) {
            // Clear the user's playlist cache
            await this.cache.del(`playlists:user:${dbPayment.user.hash}`);
            this.logger.log(
              color.blue.bold('Cleared playlist cache for user: ') +
                color.white.bold(dbPayment.user.hash)
            );
          }

          // Credit promotional discount for each playlist in this payment (one-time only)
          const paymentPlaylists = await this.prisma.paymentHasPlaylist.findMany({
            where: { paymentId: dbPayment.id },
            select: { playlistId: true },
          });

          for (const pp of paymentPlaylists) {
            try {
              await this.promotional.creditPromotionalDiscount(pp.playlistId, dbPayment.id);
            } catch (e) {
              this.logger.log(
                color.yellow.bold(`Failed to credit promotional discount for playlist ${pp.playlistId}: ${e}`)
              );
            }
          }

          this.generator.queueGenerate(
            params.id,
            metadata.clientIp,
            metadata.refreshPlaylists,
            false,
            false,
            false
          );
        } else if (this.failedPaymentStatus.includes(payment.status)) {
          await this.discount.removeDiscountUsesByPaymentId(dbPayment.id);
        }
      }
    }
    return {
      success: true,
    };
  }

  public async checkPaymentStatus(paymentId: string): Promise<ApiResult> {
    // Get the payment from the database
    const payment = await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
      select: {
        status: true,
        user: {
          select: {
            userId: true, // Selectively retrieve only the userId from the user record
            hash: true,
          },
        },
      },
    });

    if (payment && this.paidPaymentStatus.includes(payment.status)) {
      return {
        success: true,
        data: {
          status: 'paid',
          payment,
        },
      };
    } else if (payment && this.openPaymentStatus.includes(payment.status)) {
      return {
        success: false,
        data: {
          status: 'open',
        },
      };
    } else if (payment && this.failedPaymentStatus.includes(payment.status)) {
      return {
        success: false,
        data: {
          status: 'failed',
        },
      };
    } else {
      return {
        success: false,
        error: 'Error checking payment status',
      };
    }
  }

  public async getPayment(paymentId: string): Promise<any> {
    return (await this.prisma.payment.findUnique({
      where: {
        paymentId: paymentId,
      },
      select: {
        id: true,
        userId: true,
        paymentId: true,
        status: true,
        createdAt: true,
        taxRate: true,
        profit: true,
        finalized: true,
        taxRateShipping: true,
        updatedAt: true,
        orderId: true,
        totalPrice: true,
        paymentMethod: true,
        printApiOrderId: true,
        locale: true,
        productPriceWithoutTax: true,
        shippingPriceWithoutTax: true,
        productVATPrice: true,
        shippingVATPrice: true,
        totalVATPrice: true,
        differentInvoiceAddress: true,
        invoiceAddress: true,
        invoiceHousenumber: true,
        invoiceCity: true,
        invoiceZipcode: true,
        invoiceCountrycode: true,
        shipping: true,
        fullname: true,
        email: true,
        address: true,
        housenumber: true,
        city: true,
        zipcode: true,
        qrSubDir: true,
        countrycode: true,
        isBusinessOrder: true,
        companyName: true,
        vatId: true,
        vibe: true,
        discount: true,
        volumeDiscount: true,
        currency: true,
        exchangeRate: true,
        totalPricePresentment: true,
        reverseCharge: true,
        vatIdChecked: true,
        boxFee: true,
        gamesFee: true,
        DiscountCodedUses: {
          select: {
            amount: true,
            discountCode: {
              select: {
                code: true,
                description: true,
              },
            },
          },
        },
        user: {
          select: {
            email: true,
            hash: true,
          },
        },
        PaymentHasPlaylist: {
          select: {
            filename: true,
            filenameDigital: true,
            playlist: {
              select: {
                playlistId: true, // Only selecting the playlistId from the related Playlist
              },
            },
          },
        },
      },
    })) as Payment | null; // Add 'as Payment | null' to explicitly cast the returned object.
  }

  public async createPaymentLink(
    amount: number,
    description?: string
  ): Promise<ApiResult> {
    try {
      // Format amount to 2 decimal places
      const formattedAmount = amount.toFixed(2);

      // Use the live Mollie client for payment links
      const paymentLink = await this.mollieClient.paymentLinks.create({
        amount: {
          currency: 'EUR',
          value: formattedAmount,
        },
        description: description || `QRSong! Custom Payment - EUR ${formattedAmount}`,
      });

      const paymentUrl = paymentLink.getPaymentUrl();

      this.logger.log(
        color.green.bold('Created payment link: ') +
          color.white.bold(paymentUrl || 'No URL')
      );

      return {
        success: true,
        data: {
          paymentLinkId: paymentLink.id,
          paymentLink: paymentUrl,
          amount: formattedAmount,
          description: paymentLink.description,
        },
      };
    } catch (e) {
      this.logger.log(
        color.red.bold('Failed to create payment link: ') +
          color.white(e instanceof Error ? e.message : String(e))
      );

      return {
        success: false,
        error: e instanceof Error ? e.message : 'Failed to create payment link',
      };
    }
  }

  /**
   * Shared helper for routes that create a one-off Mollie payment (e.g. the
   * bingo/QRGames upgrade flow). Handles FX conversion, method filtering per
   * currency, and Mollie locale resolution so callers don't reimplement the
   * multi-currency plumbing. Amount is always passed in EUR — conversion to
   * the presentment currency happens inside.
   */
  public async createUpgradePayment(params: {
    amountEur: number;
    requestedCurrency?: string;
    description: string;
    locale: string;
    redirectUrl: string;
    metadata: Record<string, string>;
    clientIp: string;
    billingCountry?: string | null;
    viewerCountry?: string | null;
  }): Promise<{
    id: string;
    checkoutUrl: string | null;
    currency: SupportedCurrency;
    amount: number;
  }> {
    const requestedCurrency = isSupportedCurrency(params.requestedCurrency)
      ? params.requestedCurrency
      : 'EUR';
    const converted = await this.fx.tryConvert(
      params.amountEur,
      requestedCurrency
    );

    const paymentClientResult = await this.getClient(params.clientIp);
    const paymentClient = paymentClientResult.client;

    let ipCountry = '';
    try {
      const location = await this.utils.lookupIp(params.clientIp);
      if (location && location.country_code) {
        ipCountry = location.country_code;
      }
    } catch (error) {
      console.error('Error looking up IP for upgrade payment methods:', error);
    }

    const resolved = this.resolveMollieMethods({
      language: params.locale,
      billingCountry: params.billingCountry,
      viewerCountry: params.viewerCountry,
      ipCountry,
      currency: converted.currency,
    });

    this.logger.log(
      color.blue.bold(
        `Mollie upgrade methods resolved: country=${color.white.bold(
          resolved.country || '-'
        )} (source=${color.white.bold(resolved.countrySource)}) language=${color.white.bold(
          params.locale
        )} currency=${color.white.bold(converted.currency)} → ${color.white.bold(
          resolved.methods.join(',')
        )}`
      )
    );

    const payment = await paymentClient.payments.create({
      amount: {
        currency: converted.currency,
        value: converted.amount.toFixed(2),
      },
      method: resolved.methods,
      metadata: params.metadata,
      description: params.description,
      redirectUrl: params.redirectUrl,
      webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
      locale: resolved.locale,
    });

    return {
      id: payment.id,
      checkoutUrl: payment.getCheckoutUrl(),
      currency: converted.currency,
      amount: converted.amount,
    };
  }

  public async createRefund(
    molliePaymentId: string,
    amount: number
  ): Promise<ApiResult> {
    try {
      const dbPayment = await this.prisma.payment.findUnique({
        where: { paymentId: molliePaymentId },
        select: {
          currency: true,
          exchangeRate: true,
          totalPrice: true,
          totalPricePresentment: true,
        },
      });

      const currency: SupportedCurrency =
        dbPayment && isSupportedCurrency(dbPayment.currency)
          ? (dbPayment.currency as SupportedCurrency)
          : 'EUR';

      let refundValue = amount;
      if (currency !== 'EUR' && dbPayment) {
        // Caller passes the refund amount in EUR. Convert to presentment currency
        // proportionally to how much of the order is being refunded.
        const eurTotal = dbPayment.totalPrice || 0;
        const presentmentTotal = dbPayment.totalPricePresentment || 0;
        if (eurTotal > 0 && presentmentTotal > 0) {
          refundValue = (amount / eurTotal) * presentmentTotal;
        } else if (dbPayment.exchangeRate) {
          refundValue = amount * dbPayment.exchangeRate;
        }
      }

      const formattedAmount = refundValue.toFixed(2);

      const refund = await this.mollieClient.paymentRefunds.create({
        paymentId: molliePaymentId,
        amount: {
          currency,
          value: formattedAmount,
        },
      });

      this.logger.log(
        color.green.bold('Created refund: ') +
          color.white.bold(refund.id) +
          color.gray(' for ') +
          color.white.bold(`${currency} ${formattedAmount}`)
      );

      return {
        success: true,
        data: {
          refundId: refund.id,
          amount: formattedAmount,
          currency,
          status: refund.status,
        },
      };
    } catch (e) {
      this.logger.log(
        color.red.bold('Failed to create refund: ') +
          color.white(e instanceof Error ? e.message : String(e))
      );

      return {
        success: false,
        error: e instanceof Error ? e.message : 'Failed to create refund',
      };
    }
  }
}

export default Mollie;
