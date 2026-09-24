/**
 * Company lists marked as sold, as business sales in the financial reports.
 *
 * The Lists tab of a company has a "Sold" toggle. A sold list counts on the
 * day of its `soldAt` with the figures the Lists table shows: `sellPrice`
 * (excl. VAT, after discount, what the invoices add up to) and `sellPrice -
 * buyPrice` as profit. Turnover is reported gross like the consumer figures,
 * at the VAT the list's invoice carries: 21% for a Dutch company, 0% for the
 * rest (reverse charge in the EU, export outside it).
 *
 * The day, month and country reports take a segment (consumer, business or
 * both) and the dashboard's Finance card shows the two side by side; the tax
 * and OSS reports stay consumer only, business VAT is on the MoneyBird
 * invoices.
 */
import PrismaInstance from './prisma';
import {
  listPrinterVariant,
  round2,
  variantCalculationColumn,
} from './listPricing';
import { normalizeCountryIso, quotationVatContext } from './services/vat';

export type SalesSegment = 'consumer' | 'business' | 'both';

export function parseSalesSegment(value: unknown): SalesSegment {
  return value === 'business' || value === 'both' ? value : 'consumer';
}

export function includesConsumer(segment: SalesSegment): boolean {
  return segment !== 'business';
}

export function includesBusiness(segment: SalesSegment): boolean {
  return segment !== 'consumer';
}

export interface BusinessSale {
  listId: number;
  soldAt: Date;
  /** ISO code of the company's country, or 'Unknown'. */
  country: string;
  boxes: number;
  exVat: number;
  vatRate: number;
  /** Incl. VAT. */
  total: number;
  /** sellPrice - buyPrice; 0 while the buy price is unknown. */
  profit: number;
  profitKnown: boolean;
}

/** Per report row. Zero in the consumer segment. */
export interface BusinessFigures {
  businessAmount: number;
  businessBoxes: number;
  businessTotal: number;
  businessExVat: number;
  businessProfit: number;
  businessProfitKnownCount: number;
}

export function emptyBusinessFigures(): BusinessFigures {
  return {
    businessAmount: 0,
    businessBoxes: 0,
    businessTotal: 0,
    businessExVat: 0,
    businessProfit: 0,
    businessProfitKnownCount: 0,
  };
}

// Lists saved before numberOfBoxes existed only have the quantity inside the
// calculator JSON, the same fallback the Lists table uses.
function listBoxes(list: any): number {
  const boxes = Number(list.numberOfBoxes) || 0;
  if (boxes) return boxes;
  const column = variantCalculationColumn(listPrinterVariant(list.printer));
  try {
    return Number(JSON.parse(list[column] || '{}').quantity) || 0;
  } catch {
    return 0;
  }
}

export function toBusinessSale(list: any): BusinessSale {
  const exVat = round2(Number(list.sellPrice) || 0);
  const vatRate = quotationVatContext(list.Company?.countrycode).rate;
  const profitKnown = list.buyPrice != null && list.sellPrice != null;
  return {
    listId: list.id,
    soldAt: new Date(list.soldAt),
    country: normalizeCountryIso(list.Company?.countrycode) || 'Unknown',
    boxes: listBoxes(list),
    exVat,
    vatRate,
    total: round2(exVat * (1 + vatRate / 100)),
    profit: profitKnown ? round2(Number(list.sellPrice) - Number(list.buyPrice)) : 0,
    profitKnown,
  };
}

/**
 * Sold lists, optionally only those sold within [start, end]. Every sold
 * list counts, whatever its company's status: `Company.test` is the admin's
 * "Lead" flag, not test data, and a lead that bought a list has sold one.
 */
export async function getBusinessSales(range?: {
  start: Date;
  end: Date;
}): Promise<BusinessSale[]> {
  const prisma = PrismaInstance.getInstance();
  const lists = await prisma.companyList.findMany({
    where: {
      sold: true,
      soldAt: range ? { gte: range.start, lte: range.end } : { not: null },
    },
    select: {
      id: true,
      soldAt: true,
      sellPrice: true,
      buyPrice: true,
      numberOfBoxes: true,
      printer: true,
      calculationTromp: true,
      calculationSchneider: true,
      Company: { select: { countrycode: true } },
    },
  });
  return lists.map(toBusinessSale);
}

export function addBusinessSale(figures: BusinessFigures, sale: BusinessSale): void {
  figures.businessAmount += 1;
  figures.businessBoxes += sale.boxes;
  figures.businessTotal = round2(figures.businessTotal + sale.total);
  figures.businessExVat = round2(figures.businessExVat + sale.exVat);
  figures.businessProfit = round2(figures.businessProfit + sale.profit);
  if (sale.profitKnown) figures.businessProfitKnownCount += 1;
}

export function groupBusinessSales(
  sales: BusinessSale[],
  keyOf: (sale: BusinessSale) => string
): Map<string, BusinessFigures> {
  const groups = new Map<string, BusinessFigures>();
  for (const sale of sales) {
    const key = keyOf(sale);
    const figures = groups.get(key) || emptyBusinessFigures();
    addBusinessSale(figures, sale);
    groups.set(key, figures);
  }
  return groups;
}

/**
 * The period a sale falls in, in UTC like the consumer rows (MySQL formats
 * the UTC timestamps Prisma stores).
 */
export function businessPeriodKey(
  groupBy: 'day' | 'month'
): (sale: BusinessSale) => string {
  const length = groupBy === 'day' ? 10 : 7;
  return (sale) => sale.soldAt.toISOString().slice(0, length);
}

/**
 * A sold date is a day, stored at 12:00 UTC so it reads as the same date in
 * every timezone and falls inside the server-local month bounds of the
 * country report.
 */
export function soldDateToTimestamp(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const value = new Date(`${date}T12:00:00.000Z`);
  return Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date
    ? null
    : value;
}

export type MarkListSoldResult =
  | { success: true; sold: boolean; soldAt: Date | null }
  | { success: false; status: number; error: string };

/**
 * Turn a list's Sold toggle on or off. On: `soldAt` is the given date, or
 * the date it already had, or today. A list without a sell price cannot be
 * sold: it would add nothing to the turnover and look like it did.
 */
export async function markListSold(
  companyId: number,
  listId: number,
  sold: boolean,
  soldDate?: string | null
): Promise<MarkListSoldResult> {
  const prisma = PrismaInstance.getInstance();
  const list = await prisma.companyList.findUnique({
    where: { id: listId },
    select: { id: true, companyId: true, sellPrice: true, soldAt: true },
  });
  if (!list || list.companyId !== companyId) {
    return { success: false, status: 404, error: 'List not found' };
  }

  if (!sold) {
    await prisma.companyList.update({
      where: { id: listId },
      data: { sold: false, soldAt: null },
    });
    return { success: true, sold: false, soldAt: null };
  }

  if (list.sellPrice == null) {
    return {
      success: false,
      status: 400,
      error: 'This list has no sell price yet. Save its quotation first.',
    };
  }

  let soldAt: Date | null;
  if (soldDate) {
    soldAt = soldDateToTimestamp(soldDate);
    if (!soldAt) {
      return { success: false, status: 400, error: 'Invalid sold date' };
    }
  } else {
    soldAt =
      list.soldAt ?? soldDateToTimestamp(new Date().toISOString().slice(0, 10));
  }

  await prisma.companyList.update({
    where: { id: listId },
    data: { sold: true, soldAt },
  });
  return { success: true, sold: true, soldAt };
}
