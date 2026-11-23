import { describe, it, expect, vi } from 'vitest';

/**
 * The support chat's price quote (src/chatPriceQuote.ts): what it tells the
 * chat model for what the customer described, with the deck price and the
 * checkout calculator stubbed.
 */

import { buildPriceQuote, PriceQuoteDeps } from '../../src/chatPriceQuote';
import { MAX_CARDS, MAX_CARDS_PHYSICAL } from '../../src/config/constants';

/** Digital: €13 up to 500 cards, then more. Printed: a euro per 10 cards. */
function deckPrice(quantity: number, product: string): number {
  if (product === 'digital') return quantity <= 500 ? 13 : 13 + Math.ceil((quantity - 500) / 100);
  const base = product === 'sheets' ? 10 : 20;
  return base + Math.ceil(Math.max(quantity, 50) / 10);
}

function makeDeps(overrides: Partial<PriceQuoteDeps> = {}) {
  const calculateOrder = vi.fn(async (params: any) => {
    const items = params.cart.items;
    const printed = items.some((item: any) => item.type !== 'digital');
    const cards = items.reduce((sum: number, item: any) => sum + item.price * item.amount, 0);
    const boxes = items.reduce((sum: number, item: any) => sum + (item.boxEnabled ? item.boxQuantity * item.amount : 0), 0);
    const boxFee = boxes * 6.99;
    const gamesFee = items.filter((item: any) => item.gamesEnabled).length * 5;
    const playlists = items.reduce((sum: number, item: any) => sum + item.amount, 0);
    const rate = printed && params.countrycode ? 8.02 : 0;
    const free = rate > 0 && playlists >= 2;
    const volumeDiscount = !printed && items.length > 1 ? 4 : 0;
    return {
      success: true,
      data: {
        total: cards + boxFee + gamesFee - volumeDiscount + (free ? 0 : rate),
        shipping: free ? 0 : rate,
        shippingSaved: free ? rate : 0,
        volumeDiscount,
        gamesFee,
        boxFee,
        totalBoxCount: boxes,
      },
    };
  });
  const deps: PriceQuoteDeps = {
    priceOfDeck: vi.fn(async (quantity, product) => deckPrice(quantity, product)),
    calculateOrder,
    ...overrides,
  };
  return { deps, calculateOrder };
}

describe('buildPriceQuote', () => {
  it('asks for the number of songs and the format when nothing is known, without an amount', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({}, deps);
    expect(quote).toContain('PRICE QUOTE: not possible yet');
    expect(quote).toContain('how many songs');
    expect(quote).toContain('which format');
    expect(quote).not.toContain('€');
    expect(calculateOrder).not.toHaveBeenCalled();
  });

  it('asks only for the number of songs when the format is known', async () => {
    const { deps } = makeDeps();
    const quote = await buildPriceQuote({ productType: 'digital' }, deps);
    expect(quote).toContain('how many songs');
    expect(quote).not.toContain('which format');
    expect(quote).not.toContain('which country');
  });

  it('quotes 50 and 100 digital cards and says how many songs fit at the same price (chat 663)', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({ numberOfCards: '50,100', productType: 'digital', sameOrder: 'no' }, deps);

    expect(quote).toContain('For a playlist of 50 cards:');
    expect(quote).toContain('For a playlist of 100 cards:');
    expect(quote).toContain('€13. Same price for the cards up to 500 cards: they can add up to 450 more songs at no extra cost.');
    expect(quote).toContain('they can add up to 400 more songs at no extra cost.');
    // Digital needs no country: the quote is complete and points at ordering.
    expect(quote).toContain('The quote is complete');
    expect(quote).toContain('https://www.qrsong.io/[lang]/generate');
    expect(quote).not.toContain('Still unknown');
    // Two separate carts, no country sent.
    expect(calculateOrder).toHaveBeenCalledTimes(2);
    expect(calculateOrder.mock.calls[0][0]).toEqual({
      cart: {
        items: [
          {
            productType: 'cards',
            type: 'digital',
            numberOfTracks: 50,
            amount: 1,
            price: 13,
            gamesEnabled: false,
            boxEnabled: false,
            boxQuantity: 0,
          },
        ],
      },
      fast: false,
    });
  });

  it('shows all three formats and asks for the format and the country when only the size is known', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({ numberOfCards: '120' }, deps);

    expect(quote).toContain('- Digital (a PDF to print and cut yourself): €13.');
    expect(quote).toContain('cut them yourself): €22 plus shipping');
    expect(quote).toContain('ready to play): €32 plus shipping');
    expect(quote).toContain('Still unknown. Give the prices above first');
    expect(quote).toContain('which format they want');
    expect(quote).toContain('for a printed format: which country');
    expect(calculateOrder).toHaveBeenCalledTimes(3);
  });

  it('asks for the country of a printed order and leaves shipping out until then', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({ numberOfCards: '120', productType: 'physical' }, deps);

    expect(quote).toContain('€32 plus shipping');
    expect(quote).toContain('which country the cards go to, so you can add the shipping cost');
    expect(calculateOrder.mock.calls[0][0].countrycode).toBeUndefined();
  });

  it('adds shipping, the gift box and QRGames for a printed order with a country', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote(
      { numberOfCards: '200', productType: 'physical', countryCode: 'de', giftBox: 'yes', games: 'yes' },
      deps
    );

    // 200 cards need two boxes of 190.
    expect(calculateOrder.mock.calls[0][0]).toMatchObject({
      countrycode: 'DE',
      cart: { items: [{ type: 'physical', numberOfTracks: 200, boxEnabled: true, boxQuantity: 2, gamesEnabled: true }] },
    });
    expect(quote).toContain('cards €40, gift box €13.98 (2 x €6, one box holds up to 190 cards), QRGames €5 (€5 per playlist), shipping to DE €8.02; total €67');
    expect(quote).toContain('The quote is complete');
  });

  it('prices several playlists in one order as one cart, with the volume discount', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({ numberOfCards: '50, 100', productType: 'digital', sameOrder: 'yes' }, deps);

    expect(calculateOrder).toHaveBeenCalledTimes(1);
    expect(calculateOrder.mock.calls[0][0].cart.items).toHaveLength(2);
    expect(quote).toContain('For 2 playlists (50, 100 cards) in one order:');
    expect(quote).toContain('cards €26 (per set: 50 cards €13, 100 cards €13), volume discount for several digital playlists -€4; total €22');
    // No "add more songs" line for a combined cart.
    expect(quote).not.toContain('more songs at no extra cost.');
  });

  it('shows free shipping from two sets', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({ numberOfCards: '100', productType: 'physical', countryCode: 'NL', sets: '2' }, deps);

    expect(calculateOrder.mock.calls[0][0].cart.items[0].amount).toBe(2);
    expect(quote).toContain('For 2 sets of a playlist of 100 cards:');
    expect(quote).toContain('shipping to NL free (normally €8.02, free from 2 playlists or sets); total €60');
  });

  it('says a size above the printed maximum cannot be printed, and still prices it digitally', async () => {
    const { deps, calculateOrder } = makeDeps();
    const quote = await buildPriceQuote({ numberOfCards: String(MAX_CARDS_PHYSICAL + 500) }, deps);

    expect(quote).toContain(`not possible for ${MAX_CARDS_PHYSICAL + 500} cards, the maximum is ${MAX_CARDS_PHYSICAL} cards per playlist`);
    expect(quote).toMatch(/- Digital \(a PDF to print and cut yourself\): €\d+/);
    expect(calculateOrder).toHaveBeenCalledTimes(1);
    expect(quote).toContain(`up to ${MAX_CARDS} cards as a digital PDF`);
  });

  it('says so when printed cards cannot be shipped to the country', async () => {
    const { deps } = makeDeps({
      calculateOrder: vi.fn(async () => ({ success: false, error: 'no_shipping' })),
    });
    const quote = await buildPriceQuote({ numberOfCards: '100', productType: 'physical', countryCode: 'BR' }, deps);
    expect(quote).toContain('we cannot ship printed products to BR');
  });

  it('gives no amount when the calculator fails or throws', async () => {
    const failing = makeDeps({ calculateOrder: vi.fn(async () => ({ success: false, error: 'boom' })) });
    expect(await buildPriceQuote({ numberOfCards: '100', productType: 'digital' }, failing.deps)).toContain(
      'no price available right now'
    );
    const throwing = makeDeps({ priceOfDeck: vi.fn(async () => { throw new Error('down'); }) });
    expect(await buildPriceQuote({ numberOfCards: '100', productType: 'digital' }, throwing.deps)).toContain(
      'no price available right now'
    );
  });

  it('ignores a format or country it does not know and notes the box is for printed formats', async () => {
    const { deps } = makeDeps();
    const unknown = await buildPriceQuote({ numberOfCards: '100', productType: 'vinyl', countryCode: 'Germany' }, deps);
    expect(unknown).toContain('which format they want');

    const digitalBox = await buildPriceQuote({ numberOfCards: '100', productType: 'digital', giftBox: 'yes' }, deps);
    expect(digitalBox).toContain('The gift box is only available with printed cards or printed sheets');
    expect(digitalBox).not.toContain('gift box €');
  });
});
