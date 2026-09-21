import {
  APP_DESIGN_PRICE,
  BOX_PRICE,
  BOX_TIER_PRICES,
  PRICE_TABLE_QUANTITIES,
} from './config/constants';
import { QRGAMES_UPGRADE_PRICE } from './game';

/**
 * Named prices, so copy can quote a price without typing the number.
 *
 * A blog post writes `[price:<name>]` (the same bracket style as `[lang]` and
 * `[post:N]`); src/blog.ts turns it into a marked span and the site fills in
 * the amount in the visitor's currency. The amount always comes from the
 * constants and calculators checkout itself uses, so changing a price is still
 * one edit.
 *
 * Names:
 *   appDesign                    APP_DESIGN_PRICE
 *   box                          BOX_PRICE (one box)
 *   box.from                     the lowest per-box tier price
 *   games                        QRGAMES_UPGRADE_PRICE (per playlist)
 *   cards.<type>.<quantity>      one deck; type digital | sheets | physical,
 *                                quantity from PRICE_TABLE_QUANTITIES
 *
 * `priceTokenNames()` needs no database, so tooling (growth-oracle's blog
 * lint, through `npm run price-tokens`) can list them without a running API.
 */

export type CardProduct = 'digital' | 'sheets' | 'physical';
export const CARD_PRODUCTS: readonly CardProduct[] = ['digital', 'sheets', 'physical'];

/** `[price:name]` in markdown or rendered HTML. */
export const PRICE_TOKEN_RE = /\[price:([a-zA-Z0-9.]+)\]/g;

function fixedPrices(): Record<string, number> {
  return {
    appDesign: APP_DESIGN_PRICE,
    box: BOX_PRICE,
    'box.from': Math.min(...BOX_TIER_PRICES),
    games: QRGAMES_UPGRADE_PRICE,
  };
}

export function priceTokenNames(): string[] {
  return [
    ...Object.keys(fixedPrices()),
    ...CARD_PRODUCTS.flatMap((product) =>
      PRICE_TABLE_QUANTITIES.map((quantity) => `cards.${product}.${quantity}`)
    ),
  ];
}

/**
 * One deck of `quantity` cards, EUR incl. VAT, from the calculator checkout
 * uses (order.getOrderType). Null when it cannot be priced right now.
 */
export async function cardPrice(quantity: number, product: CardProduct): Promise<number | null> {
  const { default: Order } = await import('./order');
  const orderType = await Order.getInstance().getOrderType(
    quantity,
    product === 'digital',
    'cards',
    '',
    product === 'sheets' ? 'sheets' : 'none'
  );
  const amount = orderType?.amount;
  return typeof amount === 'number' && amount > 0 ? amount : null;
}

/**
 * Every named price in EUR. A card price that cannot be computed is left
 * out rather than guessed; the site then shows the fallback text.
 */
export async function priceTokenValues(
  priceOfDeck: (quantity: number, product: CardProduct) => Promise<number | null> = cardPrice
): Promise<Record<string, number>> {
  const values: Record<string, number> = { ...fixedPrices() };
  await Promise.all(
    CARD_PRODUCTS.flatMap((product) =>
      PRICE_TABLE_QUANTITIES.map(async (quantity) => {
        try {
          const amount = await priceOfDeck(quantity, product);
          if (amount !== null) values[`cards.${product}.${quantity}`] = amount;
        } catch {
          // left out, see above
        }
      })
    )
  );
  return values;
}

/** The EUR text shown where the site cannot convert (no JavaScript, feeds). */
export function formatEurFallback(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

/**
 * Turn every known `[price:name]` in rendered HTML into
 * `<span class="qr-price" data-price="name">€9.00</span>`. The site swaps the
 * text for the visitor's currency; the EUR text is the no-JavaScript
 * fallback. An unknown name is left as written (and reported) so it gets
 * noticed instead of silently vanishing.
 */
export function markPriceTokens(
  html: string,
  prices: Record<string, number>,
  onUnknown: (token: string) => void = () => {}
): string {
  const known = new Set(priceTokenNames());
  return html.replace(PRICE_TOKEN_RE, (match, name: string) => {
    if (!known.has(name)) {
      onUnknown(match);
      return match;
    }
    const eur = prices[name];
    const fallback = typeof eur === 'number' ? formatEurFallback(eur) : '';
    return `<span class="qr-price" data-price="${name}">${fallback}</span>`;
  });
}
