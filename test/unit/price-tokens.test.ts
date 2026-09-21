import { describe, it, expect } from 'vitest';

/**
 * Blog price tokens (src/priceTokens.ts): the names tooling lints against,
 * the values that come from the constants and the checkout calculator, and
 * the span a token becomes in rendered HTML.
 */

import {
  CardProduct,
  markPriceTokens,
  priceTokenNames,
  priceTokenValues,
} from '../../src/priceTokens';
import {
  APP_DESIGN_PRICE,
  BOX_PRICE,
  PRICE_TABLE_QUANTITIES,
} from '../../src/config/constants';
import { QRGAMES_UPGRADE_PRICE } from '../../src/game';

describe('priceTokenNames', () => {
  it('names every fixed price and every deck in the price table', () => {
    const names = priceTokenNames();
    expect(names).toEqual(expect.arrayContaining(['appDesign', 'box', 'box.from', 'games']));
    for (const quantity of PRICE_TABLE_QUANTITIES) {
      expect(names).toContain(`cards.digital.${quantity}`);
      expect(names).toContain(`cards.sheets.${quantity}`);
      expect(names).toContain(`cards.physical.${quantity}`);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

// Stands in for the checkout calculator (order.getOrderType).
const deck = async (quantity: number, product: CardProduct) =>
  product === 'digital' ? 13 : product === 'sheets' ? 20 + quantity / 100 : 30 + quantity / 10;

describe('priceTokenValues', () => {
  it('reads the constants and the checkout calculator', async () => {
    const values = await priceTokenValues(deck);
    expect(values['appDesign']).toBe(APP_DESIGN_PRICE);
    expect(values['box']).toBe(BOX_PRICE);
    expect(values['games']).toBe(QRGAMES_UPGRADE_PRICE);
    expect(values['box.from']).toBeLessThanOrEqual(BOX_PRICE);
    expect(values['cards.digital.100']).toBe(13);
    expect(values['cards.physical.100']).toBe(40);
    expect(Object.keys(values).sort()).toEqual(priceTokenNames().sort());
  });

  it('leaves out a deck the calculator cannot price', async () => {
    const values = await priceTokenValues(async (quantity, product) => {
      if (product === 'sheets' && quantity === 50) throw new Error('db down');
      if (product === 'physical' && quantity === 500) return null;
      return deck(quantity, product);
    });
    expect(values['cards.sheets.50']).toBeUndefined();
    expect(values['cards.physical.500']).toBeUndefined();
    expect(Object.keys(values).length).toBe(priceTokenNames().length - 2);
  });
});

describe('markPriceTokens', () => {
  it('turns a known token into a marked span with the EUR fallback', () => {
    const html = markPriceTokens('<p>Only [price:appDesign], once.</p>', { appDesign: 9 });
    expect(html).toBe(
      '<p>Only <span class="qr-price" data-price="appDesign">€9.00</span>, once.</p>'
    );
  });

  it('keeps an unknown token visible and reports it', () => {
    const unknown: string[] = [];
    const html = markPriceTokens('<p>[price:nope] and [price:box]</p>', { box: 6.99 }, (t) =>
      unknown.push(t)
    );
    expect(html).toContain('[price:nope]');
    expect(html).toContain('data-price="box">€6.99<');
    expect(unknown).toEqual(['[price:nope]']);
  });

  it('marks a token without a value with an empty fallback', () => {
    expect(markPriceTokens('[price:cards.sheets.50]', {})).toBe(
      '<span class="qr-price" data-price="cards.sheets.50"></span>'
    );
  });
});
