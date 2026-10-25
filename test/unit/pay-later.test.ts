import { describe, it, expect } from 'vitest';
import {
  payLaterDetails,
  splitName,
  PayLaterInput,
  PayLaterLine,
} from '../../src/services/pay-later';

/**
 * Lines and addresses that make Klarna, in3 and Riverty appear at Mollie's
 * checkout. The worked example: one set of €49.95 incl. 21% VAT, €2.99 NL
 * shipping and a €5 code, so Mollie charges €47.94.
 */

const LABELS = {
  playlist: 'Playlist',
  giftBox: 'Gift box',
  qrGames: 'QRGames',
  appDesigner: 'App Designer',
  shipping: 'Shipping',
  discount: 'Discount',
};

const ORDER = {
  fullname: 'Jan van der Berg',
  email: 'jan@example.com',
  address: 'Kerkstraat',
  housenumber: '12',
  zipcode: '1012 AB',
  city: 'Amsterdam',
  countrycode: 'nl',
};

function input(over: Partial<PayLaterInput> = {}): PayLaterInput {
  return {
    items: [{ productType: 'cards', type: 'physical', playlistName: '80s Hits', amount: 1, price: 49.95 }],
    base: { productsGross: 49.95, shippingGross: 2.99, taxRate: 21, taxRateShipping: 21 },
    fees: {},
    allocation: { discountGoods: 5, discountShipping: 0 },
    currency: 'EUR',
    amount: 47.94,
    rate: 1,
    decimals: 2,
    snap: 0,
    order: ORDER,
    labels: LABELS,
    ...over,
  };
}

const total = (lines: PayLaterLine[]) =>
  Math.round(lines.reduce((sum, l) => sum + Number(l.totalAmount.value) * 100, 0)) / 100;

describe('splitName', () => {
  it('keeps the family name prefix together', () => {
    expect(splitName('Jan van der Berg')).toEqual({ givenName: 'Jan', familyName: 'van der Berg' });
    expect(splitName('  Anna   Müller ')).toEqual({ givenName: 'Anna', familyName: 'Müller' });
  });

  it('refuses what Mollie refuses', () => {
    expect(splitName('Madonna')).toBeNull();
    expect(splitName('J Smith')).toBeNull();
    expect(splitName('Jan 12')).toBeNull();
    expect(splitName('')).toBeNull();
  });
});

describe('payLaterDetails', () => {
  it('gives products, shipping and discount lines that add up to the charge', () => {
    const details = payLaterDetails(input())!;
    expect(details.lines).toEqual([
      {
        type: 'physical',
        description: 'Playlist: 80s Hits',
        quantity: 1,
        unitPrice: { currency: 'EUR', value: '49.95' },
        totalAmount: { currency: 'EUR', value: '49.95' },
        vatRate: '21.00',
        vatAmount: { currency: 'EUR', value: '8.67' }, // 49.95 × 21/121
      },
      {
        type: 'shipping_fee',
        description: 'Shipping',
        quantity: 1,
        unitPrice: { currency: 'EUR', value: '2.99' },
        totalAmount: { currency: 'EUR', value: '2.99' },
        vatRate: '21.00',
        vatAmount: { currency: 'EUR', value: '0.52' },
      },
      {
        type: 'discount',
        description: 'Discount',
        quantity: 1,
        unitPrice: { currency: 'EUR', value: '-5.00' },
        totalAmount: { currency: 'EUR', value: '-5.00' },
        vatRate: '21.00',
        vatAmount: { currency: 'EUR', value: '-0.87' },
      },
    ]);
    expect(total(details.lines)).toBe(47.94);
  });

  it('sends the delivery address as billing and shipping address', () => {
    const details = payLaterDetails(input())!;
    const address = {
      givenName: 'Jan',
      familyName: 'van der Berg',
      streetAndNumber: 'Kerkstraat 12',
      postalCode: '1012 AB',
      city: 'Amsterdam',
      country: 'NL',
      email: 'jan@example.com',
    };
    expect(details.billingAddress).toEqual(address);
    expect(details.shippingAddress).toEqual(address);
  });

  it('bills a different invoice address and ships to the delivery address', () => {
    const details = payLaterDetails(
      input({
        order: {
          ...ORDER,
          differentInvoiceAddress: true,
          invoiceAddress: 'Hauptstraße',
          invoiceHousenumber: '5',
          invoiceZipcode: '10115',
          invoiceCity: 'Berlin',
          invoiceCountrycode: 'DE',
        },
      })
    )!;
    expect(details.billingAddress).toMatchObject({ streetAndNumber: 'Hauptstraße 5', city: 'Berlin', country: 'DE' });
    expect(details.shippingAddress).toMatchObject({ streetAndNumber: 'Kerkstraat 12', city: 'Amsterdam', country: 'NL' });
  });

  it('gives nothing without a complete postal address (digital orders)', () => {
    expect(payLaterDetails(input({ order: { fullname: 'Jan Jansen', email: 'j@example.com', countrycode: 'NL' } }))).toBeNull();
    expect(payLaterDetails(input({ order: { ...ORDER, city: ' ' } }))).toBeNull();
  });

  it('gives nothing for a cart with a gift card, a one-word name or no e-mail', () => {
    expect(
      payLaterDetails(input({ items: [...input().items, { productType: 'giftcard', type: 'digital', amount: 1, price: 25 }] }))
    ).toBeNull();
    expect(payLaterDetails(input({ order: { ...ORDER, fullname: 'Cher' } }))).toBeNull();
    expect(payLaterDetails(input({ order: { ...ORDER, email: '' } }))).toBeNull();
  });

  it('lists the add-ons, leaves out free ones and splits the products per set', () => {
    const details = payLaterDetails(
      input({
        items: [
          { productType: 'cards', type: 'physical', playlistName: 'Rock', amount: 2, price: 30 },
          { productType: 'cards', type: 'digital', playlistName: 'Pop', amount: 1, price: 15 },
        ],
        // 75 of products after a 10% volume discount, so the split is 60:15.
        base: { productsGross: 67.5, shippingGross: 0, taxRate: 21, taxRateShipping: 21 },
        fees: { boxFee: 13.9, gamesFee: 4.99, appDesignFee: 0 },
        allocation: { discountGoods: 0, discountShipping: 0 },
        amount: 86.39,
      })
    )!;
    expect(details.lines.map((l) => [l.type, l.description, l.totalAmount.value])).toEqual([
      ['physical', '2× Playlist: Rock', '54.00'],
      ['digital', 'Playlist: Pop', '13.50'],
      ['physical', 'Gift box', '13.90'],
      ['digital', 'QRGames', '4.99'],
    ]);
    expect(total(details.lines)).toBe(86.39);
  });

  it('puts a discount larger than the goods on the shipping at its own VAT rate', () => {
    const details = payLaterDetails(
      input({
        base: { productsGross: 20, shippingGross: 4.95, taxRate: 21, taxRateShipping: 9 },
        allocation: { discountGoods: 20, discountShipping: 2 },
        amount: 2.95,
      })
    )!;
    expect(details.lines.slice(-2).map((l) => [l.description, l.totalAmount.value, l.vatRate])).toEqual([
      ['Discount', '-20.00', '21.00'],
      ['Discount (shipping)', '-2.00', '9.00'],
    ]);
    expect(total(details.lines)).toBe(2.95);
  });

  it('carries 0% VAT for a reverse-charge order', () => {
    const details = payLaterDetails(
      input({ base: { productsGross: 41.28, shippingGross: 2.47, taxRate: 0, taxRateShipping: 0 }, allocation: { discountGoods: 0, discountShipping: 0 }, amount: 43.75 })
    )!;
    expect(details.lines.every((l) => l.vatRate === '0.00' && l.vatAmount.value === '0.00')).toBe(true);
  });

  it('lets the products absorb the snap of a converted amount (NOK to 5)', () => {
    // €37.90 × 11.87 = 449.87, snapped to NOK 450. Shipping converts on its
    // own (46.29), the products take the rest (403.71, against 403.58).
    const details = payLaterDetails(
      input({
        base: { productsGross: 34, shippingGross: 3.9, taxRate: 25, taxRateShipping: 25 },
        allocation: { discountGoods: 0, discountShipping: 0 },
        currency: 'NOK',
        amount: 450,
        rate: 11.87,
        snap: 5,
        order: { ...ORDER, countrycode: 'NO' },
      })
    )!;
    expect(details.lines.map((l) => l.totalAmount)).toEqual([
      { currency: 'NOK', value: '403.71' },
      { currency: 'NOK', value: '46.29' },
    ]);
  });

  it('charges whole forints on every line', () => {
    // €45.20 × 403.7 = 18,247 → HUF 18,200; shipping 4,521.
    const details = payLaterDetails(
      input({
        base: { productsGross: 34, shippingGross: 11.2, taxRate: 27, taxRateShipping: 27 },
        allocation: { discountGoods: 0, discountShipping: 0 },
        currency: 'HUF',
        amount: 18200,
        rate: 403.7,
        decimals: 0,
        snap: 100,
        order: { ...ORDER, countrycode: 'HU' },
      })
    )!;
    expect(details.lines.map((l) => l.totalAmount.value)).toEqual(['13679.00', '4521.00']);
  });

  it('gives nothing when the products would have to absorb more than rounding', () => {
    // A €6.95 fee the lines do not know about.
    expect(payLaterDetails(input({ amount: 54.89 }))).toBeNull();
  });
});
