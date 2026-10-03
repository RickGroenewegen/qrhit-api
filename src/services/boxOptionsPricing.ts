import Cache from '../cache';

/**
 * The client price of a QRSong! Box (Schneider) for 48, 96 and 192 cards at
 * one quantity, worked out exactly as the admin calculator does it
 * (qrhit admin-calculator-schneider.component.ts `calculatedPrices`, mirrored
 * in skill-qrsong-quotation src/pricing.ts): the printer's cost per box from
 * calculateSchneiderPricing, then the shared profit table in Redis, with the
 * calculator's tier pick and its rounding at every step. A three-size
 * quotation made here prints the prices the calculator would have shown.
 */

export const BOX_OPTION_CARDS = [48, 96, 192] as const;
export type BoxOptionCards = (typeof BOX_OPTION_CARDS)[number];

/** Business boxes are sold from 100. */
export const MIN_BOX_OPTIONS_QUANTITY = 100;

/** The calculator's tier steps (the profit table also has 75; the calculator never uses it). */
export const PROFIT_TIERS = [
  100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000, 10000,
];

export interface ProfitEntry {
  qrsong: number;
  reseller: number;
}
export type ProfitMatrix = Record<string, Record<string, ProfitEntry>>;

export interface BoxOption {
  cards: BoxOptionCards;
  quantity: number;
  printerCost: number;
  profit: ProfitEntry;
  resellerPrice: number;
  retailPrice: number;
  /** What the client pays per box, excl. VAT. */
  pricePerBox: number;
  /** pricePerBox × quantity, excl. VAT. */
  total: number;
  ourProfit: number;
}

/** The calculator component's rounding. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export function profitTier(quantity: number): number {
  let closest = PROFIT_TIERS[0];
  for (const tier of PROFIT_TIERS) {
    if (tier <= quantity) closest = tier;
    else break;
  }
  return closest;
}

export function productId(cards: number): string {
  if (cards === 96) return 'schneider-96';
  if (cards === 144 || cards === 192) return 'schneider-192';
  return 'schneider-48';
}

export function profitFor(
  matrix: ProfitMatrix,
  cards: number,
  quantity: number
): ProfitEntry | null {
  return matrix[productId(cards)]?.[String(profitTier(quantity))] ?? null;
}

/** One box size priced from the printer's cost per box. */
export function priceFromCost(
  cards: BoxOptionCards,
  quantity: number,
  printerCost: number,
  profit: ProfitEntry,
  isReseller: boolean
): BoxOption {
  const qrsongProfitAmount = round2(printerCost * (profit.qrsong / 100));
  const resellerPrice = round2(printerCost + qrsongProfitAmount);
  const resellerProfitAmount = round2(resellerPrice * (profit.reseller / 100));
  const retailPrice = round2(resellerPrice + resellerProfitAmount);
  const pricePerBox = isReseller ? resellerPrice : retailPrice;
  const ourProfit = isReseller
    ? round2(qrsongProfitAmount * quantity)
    : round2((qrsongProfitAmount + resellerProfitAmount) * quantity);
  return {
    cards,
    quantity,
    printerCost,
    profit,
    resellerPrice,
    retailPrice,
    pricePerBox,
    total: round2(pricePerBox * quantity),
    ourProfit,
  };
}

export async function loadProfitMatrix(): Promise<ProfitMatrix | null> {
  const raw = await Cache.getInstance().get('pricing_tables:profit_matrix', false);
  return raw ? (JSON.parse(raw) as ProfitMatrix) : null;
}

export type CostCalculator = (params: {
  quantity: number;
  cardCount: number;
  includeStansmes: boolean;
  profitMargin: number;
}) => Promise<any>;

export class BoxOptionsError extends Error {}

/**
 * The three options for `quantity` boxes. Throws a BoxOptionsError below the
 * minimum or when the profit table has no margin for a size, so a quotation is
 * never printed at the printer's cost. No cutting die, like the calculator.
 */
export async function priceBoxOptions(
  quantity: number,
  opts: {
    isReseller?: boolean;
    matrix?: ProfitMatrix | null;
    calculate?: CostCalculator;
  } = {}
): Promise<BoxOption[]> {
  if (!Number.isInteger(quantity) || quantity < MIN_BOX_OPTIONS_QUANTITY) {
    throw new BoxOptionsError(
      `The minimum is ${MIN_BOX_OPTIONS_QUANTITY} boxes (asked: ${quantity})`
    );
  }
  const matrix = opts.matrix !== undefined ? opts.matrix : await loadProfitMatrix();
  if (!matrix) {
    throw new BoxOptionsError('The profit table is empty: fill admin → Pricing Tables');
  }
  const calculate: CostCalculator =
    opts.calculate ??
    (async (params) => {
      const Vibe = (await import('../vibe')).default;
      return Vibe.getInstance().calculateSchneiderPricing(params);
    });

  const options: BoxOption[] = [];
  for (const cards of BOX_OPTION_CARDS) {
    const result = await calculate({
      quantity,
      cardCount: cards,
      includeStansmes: false,
      profitMargin: 0,
    });
    if (!result?.success) {
      throw new BoxOptionsError(result?.error || `No printer price for ${cards} cards`);
    }
    const profit = profitFor(matrix, cards, quantity);
    if (!profit || (profit.qrsong <= 0 && profit.reseller <= 0)) {
      throw new BoxOptionsError(
        `The profit table has no margin for ${cards} cards at ${profitTier(quantity)} boxes`
      );
    }
    options.push(
      priceFromCost(
        cards,
        quantity,
        result.calculation.pricePerBox || 0,
        profit,
        !!opts.isReseller
      )
    );
  }
  return options;
}
