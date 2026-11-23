import {
  BOX_MAX_CARDS,
  MAX_CARDS,
  MAX_CARDS_PHYSICAL,
  boxTierPrice,
  productTakesQuantity,
} from './config/constants';
import { QRGAMES_UPGRADE_PRICE } from './game';
import { cardPrice, CARD_PRODUCTS } from './priceTokens';
import type { CardProduct } from './priceTokens';

/**
 * The support chat's price quote (tool `getPriceQuote` in _data/chat.json).
 *
 * The chat used to answer "I cannot name prices" (chat 663, 2026-11-23: "Was
 * kostet es 50 oder 100 Titel als digitale Version?"). The amounts here come
 * from the calculators checkout uses: `cardPrice` for a deck and
 * `Order.calculateOrder` for the cart (shipping, the digital volume discount,
 * free shipping from two playlists, the gift box tiers, QRGames), so the chat
 * cannot disagree with the payment page.
 *
 * The answer is English text for the chat model, which writes the reply in
 * the customer's language. It ends with what to ask next while something that
 * changes the price is still unknown (the number of cards, the format, the
 * country for printed cards).
 */

/** What the chat pulled out of the conversation: all strings, any may be missing. */
export interface PriceQuoteData {
  numberOfCards?: string | null;
  productType?: string | null;
  countryCode?: string | null;
  sameOrder?: string | null;
  sets?: string | null;
  giftBox?: string | null;
  games?: string | null;
}

interface CartItem {
  productType: 'cards';
  type: CardProduct;
  numberOfTracks: number;
  amount: number;
  price: number;
  gamesEnabled: boolean;
  boxEnabled: boolean;
  boxQuantity: number;
}

interface CalculateResult {
  success: boolean;
  error?: string;
  data?: {
    total: number;
    shipping: number;
    shippingSaved: number;
    volumeDiscount: number;
    gamesFee: number;
    boxFee: number;
    totalBoxCount: number;
  };
}

export interface PriceQuoteDeps {
  priceOfDeck: (quantity: number, product: CardProduct) => Promise<number | null>;
  calculateOrder: (params: {
    cart: { items: CartItem[] };
    countrycode?: string;
    fast: boolean;
  }) => Promise<CalculateResult>;
}

const defaultDeps: PriceQuoteDeps = {
  priceOfDeck: cardPrice,
  calculateOrder: async (params) => {
    const { default: Order } = await import('./order');
    return Order.getInstance().calculateOrder(params) as Promise<CalculateResult>;
  },
};

/** At most this many deck sizes in one answer ("50, 100 or 200 cards"). */
const MAX_QUANTITIES = 3;
/** More copies than this is a business request, which the chat handles itself. */
const MAX_SETS = 20;
/** Fewer free extra cards than this is not worth telling. */
const MIN_FREE_EXTRA_CARDS = 5;
/** Where an order starts: the customer pastes a playlist link. `[lang]` is filled in by the chat. */
const ORDER_URL = 'https://www.qrsong.io/[lang]/generate';

const PRODUCT_LABELS: Record<CardProduct, string> = {
  digital: 'Digital (a PDF to print and cut yourself)',
  sheets: 'Printed sheets (printed by us on A4 sheets of 350g paper, cut them yourself)',
  physical: 'Printed cards (printed and cut by us, ready to play)',
};

/** "€13" or "€8.02": no cents when there are none. */
function eur(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return `€${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}

function isYes(value: string | null | undefined): boolean {
  return /^(yes|true|ja|1)$/i.test(String(value || '').trim());
}

/** Whole numbers in the text, in the order given, without repeats. */
function parseQuantities(value: string | null | undefined): number[] {
  const numbers = (String(value || '').match(/\d+/g) || [])
    .map((n) => parseInt(n, 10))
    .filter((n) => n > 0);
  return [...new Set(numbers)].slice(0, MAX_QUANTITIES);
}

function parseProduct(value: string | null | undefined): CardProduct | null {
  const text = String(value || '').trim().toLowerCase();
  return (CARD_PRODUCTS as readonly string[]).includes(text) ? (text as CardProduct) : null;
}

function parseCountry(value: string | null | undefined): string | null {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

function describeCart(quantities: number[], sets: number): string {
  const decks =
    quantities.length === 1
      ? `a playlist of ${quantities[0]} cards`
      : `${quantities.length} playlists (${quantities.join(', ')} cards) in one order`;
  return sets > 1 ? `${sets} sets of ${decks}` : decks;
}

/**
 * The biggest deck that costs the same as this one. A deck's price only goes
 * up with its size, so the last size at this price is found by halving the
 * range up to the format's maximum. Digital is the telling case: every deck
 * up to 500 cards has one price, so 50 cards leave room for 450 more songs.
 */
async function samePriceUpTo(
  quantity: number,
  product: CardProduct,
  price: number,
  deps: PriceQuoteDeps
): Promise<number> {
  let low = quantity;
  let high = product === 'digital' ? MAX_CARDS : MAX_CARDS_PHYSICAL;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((await deps.priceOfDeck(middle, product)) === price) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * One cart in one format: the lines of the quote, or why it cannot be ordered.
 */
async function quoteCart(
  quantities: number[],
  product: CardProduct,
  options: { sets: number; country: string | null; giftBox: boolean; games: boolean },
  deps: PriceQuoteDeps
): Promise<string> {
  const label = PRODUCT_LABELS[product];
  const printed = product !== 'digital';

  const tooBig = quantities.find((quantity) => !productTakesQuantity(product, quantity));
  if (tooBig !== undefined) {
    const max = printed ? MAX_CARDS_PHYSICAL : MAX_CARDS;
    return `- ${label}: not possible for ${tooBig} cards, the maximum is ${max} cards per playlist. A bigger playlist can be split over several playlists.`;
  }

  const items: CartItem[] = [];
  for (const quantity of quantities) {
    const price = await deps.priceOfDeck(quantity, product);
    if (price === null) {
      return `- ${label}: no price available right now.`;
    }
    const withBox = printed && options.giftBox;
    items.push({
      productType: 'cards',
      type: product,
      numberOfTracks: quantity,
      amount: options.sets,
      price,
      gamesEnabled: options.games,
      boxEnabled: withBox,
      boxQuantity: withBox ? Math.ceil(quantity / BOX_MAX_CARDS) : 0,
    });
  }

  const result = await deps.calculateOrder({
    cart: { items },
    ...(printed && options.country ? { countrycode: options.country } : {}),
    fast: false,
  });
  if (!result.success || !result.data) {
    if (result.error === 'no_shipping') {
      return `- ${label}: we cannot ship printed products to ${options.country}. The digital version can be ordered from anywhere.`;
    }
    return `- ${label}: no price available right now.`;
  }
  const data = result.data;

  const parts: string[] = [];
  const cards = items.reduce((sum, item) => sum + item.price * item.amount, 0);
  if (items.length === 1 && options.sets === 1) {
    parts.push(`cards ${eur(cards)}`);
  } else {
    const each = items.map((item) => `${item.numberOfTracks} cards ${eur(item.price)}`).join(', ');
    parts.push(`cards ${eur(cards)} (per set: ${each})`);
  }
  if (data.volumeDiscount > 0) {
    parts.push(`volume discount for several digital playlists -${eur(data.volumeDiscount)}`);
  }
  if (data.boxFee > 0) {
    parts.push(
      `gift box ${eur(data.boxFee)} (${data.totalBoxCount} x ${eur(boxTierPrice(data.totalBoxCount))}, one box holds up to ${BOX_MAX_CARDS} cards)`
    );
  }
  if (data.gamesFee > 0) {
    parts.push(`QRGames ${eur(data.gamesFee)} (${eur(QRGAMES_UPGRADE_PRICE)} per playlist)`);
  }
  if (printed && options.country) {
    if (data.shippingSaved > 0) {
      parts.push(`shipping to ${options.country} free (normally ${eur(data.shippingSaved)}, free from 2 playlists or sets)`);
    } else {
      parts.push(`shipping to ${options.country} ${eur(data.shipping)}`);
    }
  }

  const total = printed && !options.country ? `${eur(data.total)} plus shipping` : eur(data.total);
  let line = parts.length === 1 ? `- ${label}: ${total}` : `- ${label}: ${parts.join(', ')}; total ${total}`;

  // Room left at this price, for a single playlist: the customer's cue to
  // add songs for free.
  if (items.length === 1) {
    const { numberOfTracks: quantity, price } = items[0];
    const upTo = await samePriceUpTo(quantity, product, price, deps);
    if (upTo - quantity >= MIN_FREE_EXTRA_CARDS) {
      line += `. Same price for the cards up to ${upTo} cards: they can add up to ${upTo - quantity} more songs at no extra cost.`;
    }
  }
  return line;
}

/**
 * The quote for what the customer described, as context for the chat model.
 */
export async function buildPriceQuote(
  input: PriceQuoteData,
  deps: PriceQuoteDeps = defaultDeps
): Promise<string> {
  const quantities = parseQuantities(input.numberOfCards);
  const product = parseProduct(input.productType);
  const country = parseCountry(input.countryCode);
  const sets = Math.min(MAX_SETS, Math.max(1, parseInt(String(input.sets || ''), 10) || 1));
  const giftBox = isYes(input.giftBox);
  const games = isYes(input.games);
  const sameOrder = isYes(input.sameOrder) && quantities.length > 1;

  const formats =
    'digital (a PDF they print and cut themselves), printed sheets (we print A4 sheets, they cut), or printed cards (printed and cut by us, ready to play)';

  if (quantities.length === 0) {
    const ask = [
      '- roughly how many songs the playlist will have (one card per song)',
      ...(product ? [] : [`- which format they want: ${formats}`]),
      ...(product && product !== 'digital' && !country ? ['- which country the cards go to, for the shipping cost'] : []),
    ];
    return (
      `PRICE QUOTE: not possible yet. The price depends on the number of cards and the format, so do not name an amount yet. ` +
      `Ask the customer, in one short friendly message:\n${ask.join('\n')}\n` +
      `Tell them you will give the exact price as soon as you know.`
    );
  }

  const products = product ? [product] : [...CARD_PRODUCTS];
  const carts = sameOrder ? [quantities] : quantities.map((quantity) => [quantity]);
  const options = { sets, country, giftBox, games };

  const sections: string[] = [];
  for (const cart of carts) {
    const lines = await Promise.all(
      products.map((format) =>
        quoteCart(cart, format, options, deps).catch(
          () => `- ${PRODUCT_LABELS[format]}: no price available right now.`
        )
      )
    );
    sections.push(`For ${describeCart(cart, sets)}:\n${lines.join('\n')}`);
  }

  const notes: string[] = [
    'All amounts are in EUR including VAT, a one-time payment, no subscription. The website shows the same prices in the visitor\'s own currency.',
    'These are the regular prices: a discount code or a running offer on the website comes off at checkout.',
    `One playlist can have up to ${MAX_CARDS} cards as a digital PDF and up to ${MAX_CARDS_PHYSICAL} as printed cards or sheets.`,
  ];
  notes.push(
    'Where a line says more songs fit at the same price, tell the customer as good news, with the numbers: ' +
      'they can make the playlist that much longer and pay nothing extra. When several sizes they asked about cost the same, say so the same way.'
  );
  if (giftBox && product === 'digital') {
    notes.push('The gift box is only available with printed cards or printed sheets, not with the digital version.');
  }

  const ask: string[] = [];
  if (!product) {
    ask.push(`which format they want: ${formats}`);
  }
  if (!country && (!product || product !== 'digital')) {
    ask.push(
      product
        ? 'which country the cards go to, so you can add the shipping cost'
        : 'for a printed format: which country the cards go to, so you can add the shipping cost'
    );
  }

  return (
    `PRICE QUOTE (from the checkout calculator; quote these amounts exactly and do not calculate others yourself)\n\n` +
    `${sections.join('\n\n')}\n\n` +
    `${notes.join('\n')}` +
    (ask.length > 0
      ? `\n\nStill unknown. Give the prices above first, then ask the customer:\n${ask.map((a) => `- ${a}`).join('\n')}`
      : `\n\nThe quote is complete. Close by helping them order: they paste the link of their playlist on ${ORDER_URL} (a markdown link), choose the format and design the cards; the price is shown there before they pay.`)
  );
}
