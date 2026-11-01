/**
 * The scan app's store catalogue (src/storeProducts.ts): the product ids the
 * App Store Connect and Play Console products must carry, their prices, and
 * which product a store cart must be paid with.
 */
import { describe, it, expect } from 'vitest';
import {
  STORE_DECK_TIERS,
  STORE_PRODUCTS,
  applyStorePrice,
  isStorePayment,
  requiredDeckProduct,
  storeCartRefusal,
  storeProduct,
} from '../../src/storeProducts';

describe('STORE_PRODUCTS', () => {
  it('has a product per deck size and nothing else, as in both consoles', () => {
    expect(STORE_PRODUCTS.map((p) => p.id)).toEqual([
      'deck.500', 'deck.1000', 'deck.1500', 'deck.2500', 'deck.3000',
    ]);
    expect(STORE_PRODUCTS.every((p) => !p.games && !p.appDesign)).toBe(true);
  });

  it('prices every product as the website does', () => {
    expect(STORE_DECK_TIERS.map((tier) => tier.priceEur)).toEqual([13, 23, 30, 33, 39]);
    expect(STORE_PRODUCTS.map((p) => p.priceEur)).toEqual([13, 23, 30, 33, 39]);
  });
});

describe('requiredDeckProduct', () => {
  it('takes the smallest tier that holds the deck', () => {
    expect(requiredDeckProduct(1, false, false)!.id).toBe('deck.500');
    expect(requiredDeckProduct(500, false, false)!.id).toBe('deck.500');
    expect(requiredDeckProduct(501, false, false)!.id).toBe('deck.1000');
    expect(requiredDeckProduct(1501, false, false)!.id).toBe('deck.2500');
    expect(requiredDeckProduct(2600, false, false)!.id).toBe('deck.3000');
  });

  it('has none for a deck with QRGames! or App Designer, which the store does not sell', () => {
    expect(requiredDeckProduct(1200, true, false)).toBeNull();
    expect(requiredDeckProduct(1200, false, true)).toBeNull();
  });

  it('caps a longer playlist at the largest deck, and refuses an empty one', () => {
    expect(requiredDeckProduct(4200, false, false)!.id).toBe('deck.3000');
    expect(requiredDeckProduct(0, false, false)).toBeNull();
  });
});

describe('storeCartRefusal', () => {
  const deck = { type: 'digital', productType: 'cards', amount: 1 };

  it('takes one digital deck without codes', () => {
    expect(storeCartRefusal({ items: [deck] })).toBeNull();
    expect(storeCartRefusal({ items: [deck], discounts: [] })).toBeNull();
  });

  it('refuses printed decks, gift cards, more than one deck and codes', () => {
    expect(storeCartRefusal({ items: [{ ...deck, type: 'physical' }] })).toBe('store_cart');
    expect(storeCartRefusal({ items: [{ ...deck, productType: 'giftcard' }] })).toBe('store_cart');
    expect(storeCartRefusal({ items: [deck, deck] })).toBe('store_cart');
    expect(storeCartRefusal({ items: [] })).toBe('store_cart');
    expect(storeCartRefusal({ items: [deck], discounts: [{ code: 'X' }] })).toBe('store_discount');
  });
});

describe('applyStorePrice', () => {
  it('puts the store price on the order and nothing else', () => {
    const calc: any = { total: 25, price: '19.01', taxRate: 21, volumeDiscount: 2, shipping: 4 };
    const item: any = { price: 23 };
    applyStorePrice(calc, item, storeProduct('deck.1000')!);
    expect(item.price).toBe(23);
    expect(calc).toMatchObject({
      total: 23,
      price: '19.01',
      gamesFee: 0,
      appDesignFee: 0,
      volumeDiscount: 0,
      shipping: 0,
      payment: 0,
    });
  });
});

describe('isStorePayment', () => {
  it('knows the stores, not Mollie', () => {
    expect(isStorePayment('appstore')).toBe(true);
    expect(isStorePayment('googleplay')).toBe(true);
    expect(isStorePayment('applepay')).toBe(false);
    expect(isStorePayment(null)).toBe(false);
  });
});
