import { describe, it, expect } from 'vitest';
import {
  bandSheets,
  suppliesAddressError,
  suppliesArticles,
  suppliesDefaultAddress,
  suppliesQuantitiesError,
  suppliesQuote,
} from '../../../src/printers/printenbindSupplies';

// The bands and stickers order (bulk actions, "Order bands & stickers").

describe('bandSheets', () => {
  it('rounds up to whole A4 sheets of six bands', () => {
    expect(bandSheets(0)).toBe(0);
    expect(bandSheets(1)).toBe(1);
    expect(bandSheets(6)).toBe(1);
    expect(bandSheets(7)).toBe(2);
    expect(bandSheets(600)).toBe(100);
  });
});

describe('suppliesQuantitiesError', () => {
  it('accepts whole numbers with at least one above zero', () => {
    expect(suppliesQuantitiesError({ bands: 600, stickers: 500 })).toBeNull();
    expect(suppliesQuantitiesError({ bands: 0, stickers: 100 })).toBeNull();
  });

  it('refuses nothing, fractions, negatives, text and huge numbers', () => {
    expect(suppliesQuantitiesError({ bands: 0, stickers: 0 })).toMatch(/at least/);
    expect(suppliesQuantitiesError({ bands: 1.5, stickers: 0 })).toMatch(/bands/);
    expect(suppliesQuantitiesError({ bands: 10, stickers: -1 })).toMatch(/stickers/);
    expect(suppliesQuantitiesError({ bands: '10', stickers: 1 })).toMatch(/bands/);
    expect(suppliesQuantitiesError({ bands: 1, stickers: 20001 })).toMatch(/more than/);
    expect(suppliesQuantitiesError(undefined)).toMatch(/bands/);
  });
});

describe('suppliesArticles', () => {
  it('orders the bands as A4 flyers and the stickers per piece', () => {
    const articles = suppliesArticles({ bands: 601, stickers: 500 });
    expect(articles.map((entry) => entry.kind)).toEqual(['bands', 'stickers']);
    expect(articles[0].article).toMatchObject({
      product: 'flyer',
      size: 'a4',
      papertype: 'mc_170',
      printside: 'single',
      borderless: true,
      number: 101,
    });
    expect(articles[1].article).toMatchObject({
      product: 'sticker-rond',
      size: 'o30',
      papertype: 'sticker_paper',
      cutting: 'sheet',
      number: 500,
      copies: 1,
    });
    expect(articles[0].article).not.toHaveProperty('file_url');
  });

  it('leaves out what is not ordered', () => {
    expect(
      suppliesArticles({ bands: 0, stickers: 100 }).map((entry) => entry.kind)
    ).toEqual(['stickers']);
    expect(
      suppliesArticles({ bands: 6, stickers: 0 }).map((entry) => entry.kind)
    ).toEqual(['bands']);
  });

  it('attaches the print files by URL when given', () => {
    const articles = suppliesArticles(
      { bands: 6, stickers: 1 },
      { band: 'https://x/band.pdf', sticker: 'https://x/sticker.pdf' }
    );
    expect(articles[0].article).toMatchObject({
      add_file_method: 'url',
      file_url: 'https://x/band.pdf',
      file_overwrite: true,
    });
    expect(articles[1].article['file_url']).toBe('https://x/sticker.pdf');
  });
});

describe('suppliesQuote', () => {
  // Print&Bind's answer for 100 sheets and 500 stickers on 2026-11-23
  const order = {
    amount: 45.55,
    delivery_amount: 3.45,
    amount_tax_standard: 9.57,
    amount_tax_reduced: 0,
    delivery_method: 'mailbox',
    delivery_at: '2026-11-25T18:00:00+01:00',
    articles: [{ amount: 0.14 }, { amount: 0.05 }],
  };

  it('reads the total, delivery, VAT and the unit prices', () => {
    const quote = suppliesQuote(
      order,
      suppliesArticles({ bands: 600, stickers: 500 })
    );
    expect(quote).toMatchObject({
      total: 45.55,
      delivery: 3.45,
      goods: 42.1,
      vat: 9.57,
      totalInclVat: 55.12,
      deliveryMethod: 'mailbox',
      deliveryAt: '2026-11-25T18:00:00+01:00',
    });
    expect(quote.lines).toEqual([
      { kind: 'bands', quantity: 600, printed: 100, unitPrice: 0.14 },
      { kind: 'stickers', quantity: 500, printed: 500, unitPrice: 0.05 },
    ]);
  });

  it('survives an empty answer', () => {
    const quote = suppliesQuote(null, suppliesArticles({ bands: 6, stickers: 0 }));
    expect(quote.total).toBe(0);
    expect(quote.lines[0].unitPrice).toBe(0);
    expect(quote.deliveryAt).toBeNull();
  });
});

describe('the delivery address', () => {
  it('starts as our own PostNL sender address', () => {
    expect(
      suppliesDefaultAddress({
        POSTNL_SENDER_COMPANY: 'QRSong!',
        POSTNL_SENDER_STREET: 'Prinsenhof',
        POSTNL_SENDER_HOUSENR: '1',
        POSTNL_SENDER_HOUSENR_EXT: 'A',
        POSTNL_SENDER_ZIPCODE: '2171XZ',
        POSTNL_SENDER_CITY: 'Sassenheim',
      })
    ).toMatchObject({
      company: 'QRSong!',
      address: 'Prinsenhof',
      housenumber: '1A',
      zipcode: '2171XZ',
      city: 'Sassenheim',
      countrycode: 'NL',
    });
  });

  it('names the first missing field', () => {
    const address = suppliesDefaultAddress({
      POSTNL_SENDER_STREET: 'Prinsenhof',
      POSTNL_SENDER_HOUSENR: '1',
      POSTNL_SENDER_ZIPCODE: '2171XZ',
      POSTNL_SENDER_CITY: 'Sassenheim',
    });
    expect(suppliesAddressError(address)).toBeNull();
    expect(suppliesAddressError({ ...address, city: ' ' })).toMatch(/city/);
    expect(suppliesAddressError({ ...address, zipcode: undefined })).toMatch(
      /postal code/
    );
  });
});
