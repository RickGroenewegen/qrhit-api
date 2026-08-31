/**
 * growth-oracle KPI adapter — the revenue source of truth for QRSong.
 *
 * Contract (growth.config.json -> kpi.command):
 *   prints ONE JSON object on stdout, keys subset of kpi.keys, "?" for
 *   anything this adapter cannot know, exit 0.
 *
 * Reads paid, non-test orders straight from the payments table. Analytics
 * purchase counts are never a substitute for this.
 *
 * Which database: GROWTH_KPI_DATABASE (default "qrhit", the production
 * database) is read using the DATABASE_URL credentials. The local .env points
 * DATABASE_URL at qrhit_dev, so without this override the adapter would report
 * development data as revenue.
 *
 * revenue_28d is EX-VAT (totalPriceWithoutTax). VAT is collected on behalf of
 * the tax authority and is not revenue; reporting it as such would inflate
 * every contribution-margin figure the finance pillar computes. The gross
 * (customer-paid) total is carried in `note` so it stays reconcilable against
 * Mollie and the dashboard.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';

const WINDOW_DAYS = 28;

interface Row {
  orders: number;
  revenue_exvat: number;
  revenue_gross: number;
  profit: number;
  print_cost: number;
  discount: number;
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const url = new URL(connectionString);
  const database = process.env.GROWTH_KPI_DATABASE || 'qrhit';
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: parseInt(url.port) || 3306,
    user: url.username,
    password: url.password,
    database,
    connectionLimit: 2,
  });
  return new PrismaClient({ adapter });
}

async function main(): Promise<void> {
  const prisma = createClient();
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT
      COUNT(*)                              AS orders,
      COALESCE(SUM(totalPriceWithoutTax),0) AS revenue_exvat,
      COALESCE(SUM(totalPrice),0)           AS revenue_gross,
      COALESCE(SUM(profit),0)               AS profit,
      COALESCE(SUM(printApiPrice),0)        AS print_cost,
      COALESCE(SUM(discount),0)             AS discount
    FROM payments
    WHERE status = 'paid'
      AND test = 0
      AND createdAt >= DATE_SUB(NOW(), INTERVAL ${WINDOW_DAYS} DAY)
  `);

  const r = rows[0];
  const orders = Number(r.orders) || 0;
  const revenue = round2(Number(r.revenue_exvat));
  const gross = round2(Number(r.revenue_gross));
  const profit = round2(Number(r.profit));
  const printCost = round2(Number(r.print_cost));
  const discount = round2(Number(r.discount));

  const note =
    `revenue=ex-VAT paid non-test orders (payments table, ${WINDOW_DAYS}d); ` +
    `gross=${gross}; order_profit=${profit} (pre ad-spend, pre payment fees); ` +
    `print_cost=${printCost}; discounts=${discount}`;

  process.stdout.write(
    JSON.stringify({
      purchases_28d: orders,
      revenue_28d: revenue,
      aov_28d: orders > 0 ? round2(revenue / orders) : 0,
      visitors_28d: '?',
      ad_spend_28d: '?',
      ad_clicks_28d: '?',
      organic_clicks_28d: '?',
      note,
    }) + '\n'
  );
  process.exit(0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  process.stderr.write(`kpi adapter failed: ${e?.message || e}\n`);
  process.exit(1);
});
