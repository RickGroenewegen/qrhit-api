import crypto from 'crypto';
import {
  BOX_OPTION_CARDS,
  BoxOptionCards,
  CostCalculator,
  PROFIT_TIERS,
  ProfitMatrix,
  loadProfitMatrix,
  priceFromCost,
  profitFor,
} from './services/boxOptionsPricing';

/**
 * The business price lists (admin → Pricing Tables, a company's Documents
 * tab), priced exactly like a three-size quotation: the printer's cost per
 * box, the shared profit table and the calculator's rounding at every step
 * (priceFromCost). A price list and a quotation for the same quantity show
 * the same cents.
 *
 * - retail: advice prices, for companies ordering from us directly
 * - reseller: purchase and advice prices
 * - client: an informative brochure for a reseller to forward to their own
 *   client, without any prices and without our contact details
 */
export const PRICE_LIST_EDITIONS = ['retail', 'reseller', 'client'] as const;
export type PriceListEdition = (typeof PRICE_LIST_EDITIONS)[number];

export interface PriceListCell {
  /** What a reseller pays per box. */
  purchase: number;
  /** What an end client pays per box, from us or from a reseller. */
  advice: number;
  /** The reseller's mark-up on the purchase price, in percent. */
  markupPercent: number;
}

export interface PriceListRow {
  quantity: number;
  cells: Record<BoxOptionCards, PriceListCell>;
}

export interface PriceList {
  sizes: readonly BoxOptionCards[];
  rows: PriceListRow[];
  /** The mark-up when every tier uses the same one, so the list can say it once. */
  uniformMarkupPercent: number | null;
}

export class PriceListError extends Error {}

/**
 * Throws unless every size has a margin of ours at every tier, so a list can
 * never print the printer's cost as a purchase price.
 */
export function assertProfitTable(matrix: ProfitMatrix | null | undefined): void {
  if (!matrix || typeof matrix !== 'object') {
    throw new PriceListError('The profit table is empty: fill admin → Pricing Tables');
  }
  for (const quantity of PROFIT_TIERS) {
    for (const cards of BOX_OPTION_CARDS) {
      const profit = profitFor(matrix, cards, quantity);
      if (!profit || !(profit.qrsong > 0)) {
        throw new PriceListError(
          `The profit table has no margin for ${cards} cards at ${quantity} boxes`
        );
      }
    }
  }
}

/** The matrix sent by the admin page when it has one, otherwise the saved one. */
export async function resolveProfitMatrix(given: unknown): Promise<ProfitMatrix> {
  if (given && typeof given === 'object' && Object.keys(given).length > 0) {
    return given as ProfitMatrix;
  }
  const stored = await loadProfitMatrix();
  if (!stored) {
    throw new PriceListError('The profit table is empty: fill admin → Pricing Tables');
  }
  return stored;
}

export async function buildPriceList(
  matrix: ProfitMatrix | null,
  calculate?: CostCalculator
): Promise<PriceList> {
  assertProfitTable(matrix);
  const table = matrix as ProfitMatrix;
  const calc: CostCalculator =
    calculate ??
    (async (params) => {
      const Vibe = (await import('./vibe')).default;
      return Vibe.getInstance().calculateSchneiderPricing(params);
    });

  const rows: PriceListRow[] = [];
  const markups = new Set<number>();
  for (const quantity of PROFIT_TIERS) {
    const cells = {} as Record<BoxOptionCards, PriceListCell>;
    for (const cards of BOX_OPTION_CARDS) {
      const result = await calc({
        quantity,
        cardCount: cards,
        includeStansmes: false,
        profitMargin: 0,
      });
      if (!result?.success) {
        throw new PriceListError(
          result?.error || `No printer price for ${cards} cards at ${quantity} boxes`
        );
      }
      const profit = profitFor(table, cards, quantity)!;
      const option = priceFromCost(
        cards,
        quantity,
        result.calculation.pricePerBox || 0,
        profit,
        true
      );
      cells[cards] = {
        purchase: option.resellerPrice,
        advice: option.retailPrice,
        markupPercent: profit.reseller,
      };
      markups.add(profit.reseller);
    }
    rows.push({ quantity, cells });
  }

  return {
    sizes: BOX_OPTION_CARDS,
    rows,
    uniformMarkupPercent: markups.size === 1 ? [...markups][0] : null,
  };
}

/**
 * The Lambda that prints a list carries no session, so the matrix travels in
 * the URL. The signature keeps the view from being rendered with a matrix of
 * someone else's choosing, which would show the printer's cost per box.
 */
export function priceListSignature(
  edition: string,
  locale: string,
  matrixJson: string
): string {
  return crypto
    .createHmac('sha256', process.env['JWT_SECRET'] || 'qrsong')
    .update(`price-list:${edition}:${locale}:${matrixJson}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyPriceListSignature(
  edition: string,
  locale: string,
  matrixJson: string,
  sig: unknown
): boolean {
  if (typeof sig !== 'string' || sig.length !== 32) return false;
  const expected = Buffer.from(priceListSignature(edition, locale, matrixJson));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The query string of the signed view URL the Lambda prints. */
export function priceListQuery(
  edition: PriceListEdition,
  locale: string,
  matrix: ProfitMatrix
): string {
  const matrixJson = JSON.stringify(matrix);
  return new URLSearchParams({
    locale,
    profitMatrix: matrixJson,
    sig: priceListSignature(edition, locale, matrixJson),
  }).toString();
}
