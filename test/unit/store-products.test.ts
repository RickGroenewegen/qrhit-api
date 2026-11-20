/**
 * The scan app's store catalogue (src/storeProducts.ts): the product ids the
 * App Store Connect and Play Console products must carry, their prices, and
 * which product a store cart must be paid with.
 */
import { describe, it, expect } from 'vitest';
import {
  STORE_DECK_TIERS,
  STORE_PRODUCTS,
  STORE_SALES,
  StoreSale,
  activeStoreSale,
  applyStorePrice,
  isStorePayment,
  requiredDeckProduct,
  storeCartRefusal,
  storePrice,
  storeProduct,
} from '../../src/storeProducts';

// Outside every sale, and the first and last moments of Black Friday 2026.
const REGULAR = Date.parse('2026-11-20T12:00:00+01:00');
const BF_FIRST = Date.parse('2026-11-27T00:00:00+01:00');
const BF_LAST = Date.parse('2026-11-30T23:59:59+01:00');

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
    applyStorePrice(calc, item, storeProduct('deck.1000')!, REGULAR);
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

describe('store sales', () => {
  it('prices Black Friday 2026 at half of every deck, as BF2026 on the website', () => {
    const bf = STORE_SALES.find((sale) => sale.name === 'BF2026')!;
    expect(Object.keys(bf.prices).sort()).toEqual(STORE_PRODUCTS.map((p) => p.id).sort());
    for (const product of STORE_PRODUCTS) {
      expect(bf.prices[product.id]).toBe(product.priceEur / 2);
    }
  });

  it('only names products that exist, and ends after it starts', () => {
    for (const sale of STORE_SALES) {
      expect(Object.keys(sale.prices).every((id) => storeProduct(id))).toBe(true);
      expect(Date.parse(sale.endsAt)).toBeGreaterThan(Date.parse(sale.startsAt));
    }
  });

  it('applies from the first to the last moment, Amsterdam time', () => {
    const deck = storeProduct('deck.500')!;
    expect(storePrice(deck, REGULAR)).toBe(13);
    expect(storePrice(deck, BF_FIRST - 1000)).toBe(13);
    expect(storePrice(deck, BF_FIRST)).toBe(6.5);
    expect(storePrice(deck, BF_LAST)).toBe(6.5);
    expect(storePrice(deck, BF_LAST + 1000)).toBe(13);
    expect(activeStoreSale('deck.500', BF_FIRST)!.name).toBe('BF2026');
    expect(activeStoreSale('deck.500', REGULAR)).toBeNull();
  });

  it('leaves a product the sale does not name at its price', () => {
    const sales: StoreSale[] = [
      { name: 'X', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-01-02T00:00:00Z', prices: { 'deck.500': 5 } },
    ];
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(storePrice(storeProduct('deck.500')!, now, sales)).toBe(5);
    expect(storePrice(storeProduct('deck.1000')!, now, sales)).toBe(23);
    expect(activeStoreSale('deck.1000', now, sales)).toBeNull();
  });

  it('puts the sale price on the order, so turnover and profit follow it', () => {
    const calc: any = { total: 25, price: '19.01', taxRate: 21, volumeDiscount: 2, shipping: 4 };
    const item: any = { price: 23 };
    applyStorePrice(calc, item, storeProduct('deck.1000')!, BF_FIRST);
    expect(item.price).toBe(11.5);
    expect(calc).toMatchObject({ total: 11.5, price: '9.50', volumeDiscount: 0, shipping: 0 });
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
