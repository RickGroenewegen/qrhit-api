import { APP_DESIGN_PRICE, MAX_CARDS } from './config/constants';
import { QRGAMES_UPGRADE_PRICE } from './game';

/**
 * What the scan app sells through the App Store and Google Play (2.1.0).
 *
 * Apple (3.1.1) and Google (Payments §2) require their own billing for
 * digital goods, so a PDF deck bought in the app is a store purchase. Printed
 * orders may not use store billing (Apple 3.1.3(e), Google §3) and go through
 * Mollie as on the website.
 *
 * A store product is a fixed thing with a fixed price, so the app sells one
 * deck per order and a product per deck size, with the add-ons baked in:
 * `deck.<maxCards>[.games][.app]`. The `addon.*` products add QRGames! or App
 * Designer to an order that is already paid (a printed one, for instance).
 *
 * Prices: the same as on the website (Rick, 2026-10-31). Apple's Small
 * Business Program and Google (US/EEA/UK since 30 June 2026) keep 15%, which
 * we take as the cost of selling in the app: a deck of up to 500 cards in NL
 * earns 13/1.21 − ~€0.35 Mollie = €10.39 on the web, 13/1.21 × 0.85 = €9.13
 * in the app.
 *
 * The prices below are the Netherlands storefront (App Store Connect) and the
 * default price (Play Console), EUR incl. VAT; the stores set every other
 * country from them. They are what the order row records; the buyer sees the
 * store's own price string. Changing a price here means changing it in both
 * consoles too.
 */

export type StorePlatform = 'ios' | 'android';

export interface StoreProduct {
  /** The product id in App Store Connect and the Play Console. */
  id: string;
  /** The largest deck it pays for; 0 for an add-on. */
  maxCards: number;
  games: boolean;
  appDesign: boolean;
  /** EUR incl. VAT, the NL storefront price. */
  priceEur: number;
}

// The web prices of a digital deck (calculateCardPrice); a deck of
// 1501–2500 cards costs €33 on the web either way, so it is one product.
export const STORE_DECK_TIERS = [
  { maxCards: 500, priceEur: 13 },
  { maxCards: 1000, priceEur: 23 },
  { maxCards: 1500, priceEur: 30 },
  { maxCards: 2500, priceEur: 33 },
  { maxCards: MAX_CARDS, priceEur: 39 },
] as const;

export const STORE_GAMES_PRICE = QRGAMES_UPGRADE_PRICE;
export const STORE_APP_DESIGN_PRICE = APP_DESIGN_PRICE;

// What the store pays out of a sale, ex VAT. Profit on a store order is its
// ex-VAT total times this.
export const STORE_PROCEEDS_SHARE = 0.85;

/** The order row's `paymentMethod` for each store. */
export const STORE_PAYMENT_METHOD: Record<StorePlatform, string> = {
  ios: 'appstore',
  android: 'googleplay',
};

// A bundle costs what its parts cost, as on the website.
function inCents(sum: number): number {
  return Math.round(sum * 100) / 100;
}

function deckId(maxCards: number, games: boolean, appDesign: boolean): string {
  return `deck.${maxCards}${games ? '.games' : ''}${appDesign ? '.app' : ''}`;
}

export const STORE_PRODUCTS: StoreProduct[] = [
  ...STORE_DECK_TIERS.flatMap((tier) =>
    [false, true].flatMap((games) =>
      [false, true].map((appDesign) => ({
        id: deckId(tier.maxCards, games, appDesign),
        maxCards: tier.maxCards,
        games,
        appDesign,
        priceEur: inCents(
          tier.priceEur +
            (games ? STORE_GAMES_PRICE : 0) +
            (appDesign ? STORE_APP_DESIGN_PRICE : 0)
        ),
      }))
    )
  ),
  { id: 'addon.games', maxCards: 0, games: true, appDesign: false, priceEur: STORE_GAMES_PRICE },
  { id: 'addon.app', maxCards: 0, games: false, appDesign: true, priceEur: STORE_APP_DESIGN_PRICE },
];

/**
 * Whether an order was paid through an app store. The store is the seller
 * to the buyer (it sends the receipt and pays the VAT), so such an order
 * gets no invoice from us and stays out of the OSS figures; the stores'
 * monthly payouts are booked as their own revenue.
 */
/**
 * A store test purchase (App Review, TestFlight, Play license testers,
 * `storeEnvironment = 'sandbox'`) is paid by nobody, so no turnover report
 * counts it: a raw SQL condition on a payments row, with a leading " AND ".
 */
export function notStoreTestSql(alias?: string): string {
  const column = alias ? `${alias}.storeEnvironment` : 'storeEnvironment';
  return ` AND (${column} IS NULL OR ${column} <> 'sandbox')`;
}

export function isStorePayment(paymentMethod: string | null | undefined): boolean {
  return !!paymentMethod && Object.values(STORE_PAYMENT_METHOD).includes(paymentMethod);
}

export function storeProduct(id: string): StoreProduct | undefined {
  return STORE_PRODUCTS.find((product) => product.id === id);
}

export function parseStorePlatform(value: unknown): StorePlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

/**
 * The deck product a store order must be paid with: the smallest tier that
 * holds the deck (a playlist longer than MAX_CARDS prints MAX_CARDS cards),
 * with the add-ons the order carries.
 */
export function requiredDeckProduct(
  numberOfTracks: number,
  games: boolean,
  appDesign: boolean
): StoreProduct | null {
  const cards = Math.min(Math.max(0, Math.floor(Number(numberOfTracks) || 0)), MAX_CARDS);
  if (cards < 1) return null;
  const tier = STORE_DECK_TIERS.find((t) => cards <= t.maxCards);
  return tier ? storeProduct(deckId(tier.maxCards, games, appDesign)) ?? null : null;
}

/**
 * Why a cart cannot be a store order, or null. The app sends one digital
 * deck and no codes: a discount or gift code may not unlock digital content
 * bought in the app (Apple 3.1.1), and a printed deck may not be paid
 * through the store at all.
 */
export function storeCartRefusal(cart: any): string | null {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (items.length !== 1) return 'store_cart';
  const item = items[0];
  if (item?.type !== 'digital' || item?.productType !== 'cards') return 'store_cart';
  if (Number(item.amount) !== 1) return 'store_cart';
  if (Array.isArray(cart.discounts) && cart.discounts.length > 0) return 'store_discount';
  return null;
}

/**
 * Turns `calculateOrder`'s answer for a store cart into the store price, so
 * the order row is written from what the buyer paid: the deck line takes the
 * product price minus the add-ons at their store prices (it keeps the extra
 * cent of the .99 rounding), and nothing else is charged.
 */
export function applyStorePrice(calc: any, item: any, product: StoreProduct): void {
  const taxRate = Number(calc.taxRate) || 0;
  const gamesFee = product.games ? STORE_GAMES_PRICE : 0;
  const appDesignFee = product.appDesign ? STORE_APP_DESIGN_PRICE : 0;
  const deckGross = Math.round((product.priceEur - gamesFee - appDesignFee) * 100) / 100;
  item.price = deckGross;
  calc.total = product.priceEur;
  calc.price = (deckGross / (1 + taxRate / 100)).toFixed(2);
  calc.gamesFee = gamesFee;
  calc.appDesignFee = appDesignFee;
  calc.volumeDiscount = 0;
  calc.boxFee = 0;
  calc.shipping = 0;
  calc.payment = 0;
}
