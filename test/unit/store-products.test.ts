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
  it('has a product per deck size and add-on mix, plus the two add-ons', () => {
    expect(STORE_PRODUCTS.map((p) => p.id)).toEqual([
      'deck.500', 'deck.500.app', 'deck.500.games', 'deck.500.games.app',
      'deck.1000', 'deck.1000.app', 'deck.1000.games', 'deck.1000.games.app',
      'deck.1500', 'deck.1500.app', 'deck.1500.games', 'deck.1500.games.app',
      'deck.2500', 'deck.2500.app', 'deck.2500.games', 'deck.2500.games.app',
      'deck.3000', 'deck.3000.app', 'deck.3000.games', 'deck.3000.games.app',
      'addon.games', 'addon.app',
    ]);
  });

  it('prices every product as the website does, a bundle at the sum of its parts', () => {
    expect(STORE_DECK_TIERS.map((tier) => tier.priceEur)).toEqual([13, 23, 30, 33, 39]);
    expect(storeProduct('deck.500')!.priceEur).toBe(13);
    expect(storeProduct('deck.500.games')!.priceEur).toBe(18);
    expect(storeProduct('deck.500.app')!.priceEur).toBe(22);
    expect(storeProduct('deck.500.games.app')!.priceEur).toBe(27);
    expect(storeProduct('deck.3000.games.app')!.priceEur).toBe(53);
    expect(storeProduct('addon.games')!.priceEur).toBe(5);
    expect(storeProduct('addon.app')!.priceEur).toBe(9);
  });

});

describe('requiredDeckProduct', () => {
  it('takes the smallest tier that holds the deck', () => {
    expect(requiredDeckProduct(1, false, false)!.id).toBe('deck.500');
    expect(requiredDeckProduct(500, false, false)!.id).toBe('deck.500');
    expect(requiredDeckProduct(501, false, false)!.id).toBe('deck.1000');
    expect(requiredDeckProduct(1501, true, false)!.id).toBe('deck.2500.games');
    expect(requiredDeckProduct(2600, false, true)!.id).toBe('deck.3000.app');
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
  it('puts the store price on the order and the add-ons at their store prices', () => {
    const calc: any = { total: 18, price: '14.88', taxRate: 21, gamesFee: 5, volumeDiscount: 2 };
    const item: any = { price: 13 };
    applyStorePrice(calc, item, storeProduct('deck.500.games')!);
    expect(item.price).toBe(13);
    expect(calc).toMatchObject({
      total: 18,
      price: '10.74',
      gamesFee: 5,
      appDesignFee: 0,
      volumeDiscount: 0,
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
