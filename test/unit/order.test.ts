import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { outbound } from '../helpers/recording-mock';

// Order delegates printing to PrintEnBind (globally mocked by test/setup.ts)
// and persistence to Prisma/Cache (mocked here). Spotify/PDF are mocked so
// nothing touches the network or Lambda.
const { prismaMock, cacheStore, pdfGenerateFromUrl, pdfResizePages } = vi.hoisted(
  () => ({
    prismaMock: {
      payment: { findUnique: vi.fn(), update: vi.fn() },
      paymentHasPlaylist: { count: vi.fn() },
      orderType: { findMany: vi.fn() },
    },
    cacheStore: new Map<string, string>(),
    pdfGenerateFromUrl: vi.fn().mockResolvedValue(undefined),
    pdfResizePages: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => {
        cacheStore.set(key, value);
      },
    }),
  },
}));
vi.mock('../../src/spotify', () => ({
  default: { getInstance: () => ({}) },
}));
vi.mock('../../src/pdf', () => ({
  default: class {
    generateFromUrl = pdfGenerateFromUrl;
    resizePDFPages = pdfResizePages;
  },
}));

import Order from '../../src/order';

const order = Order.getInstance();
const INVOICE_DIR = path.join(process.env['PRIVATE_DIR']!, 'invoice');

beforeEach(async () => {
  outbound.reset();
  cacheStore.clear();
  prismaMock.payment.findUnique.mockReset();
  prismaMock.payment.update.mockReset();
  prismaMock.paymentHasPlaylist.count.mockReset();
  prismaMock.orderType.findMany.mockReset();
  pdfGenerateFromUrl.mockClear();
  pdfResizePages.mockClear();
  await fs.rm(INVOICE_DIR, { recursive: true, force: true });
});

describe('calculateDigitalCardPrice', () => {
  it('clamps small quantities to the base price with no discount', async () => {
    const result = await order.calculateDigitalCardPrice(13, 100);
    expect(result).toEqual({
      totalPrice: 13, // 100 * 0.026 = 2.6 -> ceil 3 -> clamped to base
      pricePerCard: 0.026,
      discountPercentage: 0,
    });
  });

  it('gives no discount at exactly the 500-card threshold', async () => {
    const result = await order.calculateDigitalCardPrice(13, 500);
    expect(result.discountPercentage).toBe(0);
    expect(result.totalPrice).toBe(13); // 500 * 0.026 = 13
  });

  it('interpolates the discount linearly between 500 and 2500 cards', async () => {
    const result = await order.calculateDigitalCardPrice(13, 1500);
    expect(result.discountPercentage).toBe(25);
    expect(result.pricePerCard).toBeCloseTo(0.0195, 4);
    expect(result.totalPrice).toBe(Math.ceil(1500 * 0.026 * 0.75)); // 30
  });

  it('caps the discount at 50% from 2500 cards up', async () => {
    const at2500 = await order.calculateDigitalCardPrice(13, 2500);
    expect(at2500.discountPercentage).toBe(50);
    expect(at2500.pricePerCard).toBe(0.013);
    expect(at2500.totalPrice).toBe(33); // ceil(2500 * 0.013) = 33

    const at5000 = await order.calculateDigitalCardPrice(13, 5000);
    expect(at5000.discountPercentage).toBe(50);
    expect(at5000.totalPrice).toBe(65);
  });
});

describe('getOrderTypes', () => {
  const rows = [
    { id: 1, name: 'digital', maxCards: 500, amountWithMargin: 5 },
    { id: 2, name: 'small', maxCards: 100, amountWithMargin: 20 },
  ];

  it('queries visible order types for the product type and caches them', async () => {
    prismaMock.orderType.findMany.mockResolvedValue(rows);
    const result = await order.getOrderTypes('cards');
    expect(result).toEqual(rows);
    expect(prismaMock.orderType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { visible: true, type: 'cards' },
        orderBy: [{ digital: 'desc' }, { maxCards: 'asc' }],
      })
    );
    expect(JSON.parse(cacheStore.get('orderTypes_cards')!)).toEqual(rows);
  });

  it('serves from the cache without hitting the database', async () => {
    cacheStore.set('orderTypes_giftcard', JSON.stringify(rows));
    const result = await order.getOrderTypes('giftcard');
    expect(result).toEqual(rows);
    expect(prismaMock.orderType.findMany).not.toHaveBeenCalled();
  });
});

describe('getInvoice', () => {
  it('returns the existing invoice path without generating', async () => {
    await fs.mkdir(INVOICE_DIR, { recursive: true });
    const pdfPath = path.join(INVOICE_DIR, 'inv-1.pdf');
    await fs.writeFile(pdfPath, '%PDF-fake');

    expect(await order.getInvoice('inv-1')).toBe(
      `${process.env['PRIVATE_DIR']}/invoice/inv-1.pdf`
    );
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled();
    expect(pdfGenerateFromUrl).not.toHaveBeenCalled();
  });

  it('throws when the invoice is missing and the payment is unknown', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null);
    await expect(order.getInvoice('ghost')).rejects.toThrow('Payment not found');
  });

  it('generates the invoice on demand for a known payment', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ paymentId: 'inv-2' });

    const result = await order.getInvoice('inv-2');
    expect(result).toBe(`${process.env['PRIVATE_DIR']}/invoice/inv-2.pdf`);
    expect(pdfGenerateFromUrl).toHaveBeenCalledWith(
      `${process.env['API_URI']}/invoice/inv-2`,
      result,
      expect.objectContaining({ format: 'a4' })
    );
    // A4 portrait resize
    expect(pdfResizePages).toHaveBeenCalledWith(result, 210, 297);
    // invoice dir was created
    await expect(fs.access(INVOICE_DIR)).resolves.toBeUndefined();
  });
});

describe('createInvoice', () => {
  it('skips generation when the PDF already exists', async () => {
    await fs.mkdir(INVOICE_DIR, { recursive: true });
    await fs.writeFile(path.join(INVOICE_DIR, 'inv-3.pdf'), '%PDF-fake');

    const result = await order.createInvoice({ paymentId: 'inv-3' });
    expect(result).toBe(`${process.env['PRIVATE_DIR']}/invoice/inv-3.pdf`);
    expect(pdfGenerateFromUrl).not.toHaveBeenCalled();
  });
});

describe('updatePaymentInfo', () => {
  it('updates the payment, nulls missing optionals and regenerates the invoice', async () => {
    prismaMock.payment.update.mockResolvedValue({});
    prismaMock.payment.findUnique.mockResolvedValue({ paymentId: 'pay-9' });

    await order.updatePaymentInfo('pay-9', {
      fullname: 'Rick G',
      email: 'rick@example.com',
      isBusinessOrder: true,
      companyName: 'QRSong BV',
      address: 'Main St',
    });

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay-9' },
      data: expect.objectContaining({
        fullname: 'Rick G',
        email: 'rick@example.com',
        isBusinessOrder: true,
        companyName: 'QRSong BV',
        address: 'Main St',
        vatId: null,
        housenumber: null,
        city: null,
        zipcode: null,
        countrycode: null,
        invoiceAddress: null,
        invoiceCountrycode: null,
      }),
    });
    // Regenerated via the PDF pipeline
    expect(pdfGenerateFromUrl).toHaveBeenCalledTimes(1);
  });

  it('deletes a stale invoice PDF before regenerating', async () => {
    prismaMock.payment.update.mockResolvedValue({});
    prismaMock.payment.findUnique.mockResolvedValue(null); // no regen
    await fs.mkdir(INVOICE_DIR, { recursive: true });
    const stale = path.join(INVOICE_DIR, 'pay-8.pdf');
    await fs.writeFile(stale, 'old');

    await order.updatePaymentInfo('pay-8', {});
    await expect(fs.access(stale)).rejects.toThrow();
    expect(pdfGenerateFromUrl).not.toHaveBeenCalled();
  });
});

describe('calculateWilsonScore (private ranking helper)', () => {
  // Private and currently unreferenced elsewhere; tested via any-cast to pin
  // the ranking math down.
  const score = (downloads: number, createdAt: Date) =>
    (order as any).calculateWilsonScore(downloads, createdAt);

  it('scores a fresh single-download playlist at the Wilson lower bound', () => {
    // With phat=1 the score reduces to 1/(1+z^2/n): n=1 -> 0.2066 -> 21
    expect(score(1, new Date())).toBe(21);
  });

  it('increases with downloads (more confidence)', () => {
    const now = new Date();
    expect(score(100, now)).toBeGreaterThan(score(10, now));
    expect(score(10, now)).toBeGreaterThan(score(1, now));
    // n=100 -> 1/(1 + 3.8416/100) ~ 0.963 -> 96
    expect(score(100, now)).toBe(96);
  });

  it('decays exponentially with age (half-life one year)', () => {
    const now = Date.now();
    const oneYearAgo = new Date(now - 365.25 * 24 * 3600 * 1000);
    const fresh = score(1000, new Date());
    const aged = score(1000, oneYearAgo);
    expect(aged).toBeLessThan(fresh);
    // exp(-0.5) ~ 0.6065 of the fresh score
    expect(aged).toBe(Math.round(fresh * Math.exp(-0.5)));
  });
});

describe('getPlaylistDownloads (private)', () => {
  it('counts paid payments containing the playlist', async () => {
    prismaMock.paymentHasPlaylist.count.mockResolvedValue(7);
    const downloads = await (order as any).getPlaylistDownloads('spotify-123');
    expect(downloads).toBe(7);
    expect(prismaMock.paymentHasPlaylist.count).toHaveBeenCalledWith({
      where: {
        playlist: { playlistId: 'spotify-123' },
        payment: { status: 'paid' },
      },
    });
  });
});

describe('calculateSingleItem', () => {
  it('is currently a no-op returning undefined (body commented out)', async () => {
    expect(await order.calculateSingleItem({ anything: true })).toBeUndefined();
  });
});

describe('printer delegation', () => {
  it('forwards order operations to PrintEnBind with the same arguments', async () => {
    const payment = { paymentId: 'p1' };
    const playlists = [{ id: 1 }];

    await order.createOrder(payment, playlists, 'cards');
    await order.orderInlayCard(payment, playlists);
    await order.calculateOrder({ items: [] });
    await order.testOrder();
    await order.calculateShippingCosts(['NL', 'DE']);
    await order.processPrintApiWebhook('order-123');
    await order.getOrderType(120, true, 'cards', 'pl-1', 'none');

    expect(
      outbound.calls('PrintEnBind', 'createOrder')[0].args
    ).toEqual([payment, playlists, 'cards']);
    expect(
      outbound.calls('PrintEnBind', 'orderInlayCard')[0].args
    ).toEqual([payment, playlists]);
    expect(
      outbound.calls('PrintEnBind', 'calculateOrder')[0].args
    ).toEqual([{ items: [] }]);
    expect(outbound.calls('PrintEnBind', 'testOrder')).toHaveLength(1);
    expect(
      outbound.calls('PrintEnBind', 'calculateShippingCosts')[0].args
    ).toEqual([['NL', 'DE']]);
    expect(
      outbound.calls('PrintEnBind', 'processPrintApiWebhook')[0].args
    ).toEqual(['order-123']);
    expect(outbound.calls('PrintEnBind', 'getOrderType')[0].args).toEqual([
      120,
      true,
      'cards',
      'pl-1',
      'none',
    ]);
  });
});
