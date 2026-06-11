import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { outbound } from '../helpers/recording-mock';
import Cache from '../../src/cache';

// Mollie talks to the real Mollie API, so the class is fully mocked. The
// hoisted holder lets each test program per-case return values while the
// route module keeps its own `new Mollie()` instance.
const mollieMock = vi.hoisted(() => ({
  getPaymentUri: vi.fn(),
  checkPaymentStatus: vi.fn(),
  processWebhook: vi.fn(),
}));

vi.mock('../../src/mollie', () => ({
  default: class MollieMock {
    getPaymentUri = mollieMock.getPaymentUri;
    checkPaymentStatus = mollieMock.checkPaymentStatus;
    processWebhook = mollieMock.processWebhook;
  },
}));

describe('payment routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // The harness globally mocks PrintEnBind (it can place real print
    // orders), but Order.calculateOrder delegates entirely to
    // PrintEnBind.calculateOrder, which is pure DB/cache/math. Wire the
    // recording proxy back to the real implementation so /order/calculate
    // exercises production code; every other printer method stays mocked.
    const actual = await vi.importActual<
      typeof import('../../src/printers/printenbind')
    >('../../src/printers/printenbind');
    const realPrinter = (actual.default as any).getInstance();
    outbound.respondWith('PrintEnBind', 'calculateOrder', (params: any) =>
      realPrinter.calculateOrder(params)
    );

    // Reference data for calculateOrder: VAT + shipping tiers.
    await prisma().taxRate.create({
      data: { rate: 21, countryCode: 'NL' },
    });
    await prisma().shippingCostNew.createMany({
      data: [
        { country: 'NL', size: 80, cost: 4.95 },
        { country: 'NL', size: 405, cost: 5.95 },
        { country: 'NL', size: 1000, cost: 6.95 },
        { country: 'US', size: 405, cost: 9.95 },
      ],
    });

    // Order types for GET /ordertypes.
    await prisma().orderType.createMany({
      data: [
        {
          name: 'digital',
          description: 'Digital cards',
          amount: 13,
          amountWithMargin: 13,
          maxCards: 3000,
          digital: true,
        },
        {
          name: 'physical-small',
          description: 'Up to 80 cards',
          amount: 29,
          amountWithMargin: 34,
          maxCards: 80,
        },
        {
          name: 'physical-large',
          description: 'Up to 1000 cards',
          amount: 89,
          amountWithMargin: 99,
          maxCards: 1000,
        },
        {
          name: 'hidden',
          description: 'Not visible',
          amount: 1,
          amountWithMargin: 1,
          maxCards: 10,
          visible: false,
        },
      ],
    });

    // Pre-seed the FX cache through the exact code path Fx reads (same
    // Cache instance, same version-prefixed key) so /currency/rates and
    // presentment conversion never hit the ECB feed.
    await Cache.getInstance().set(
      'fx:rates:latest',
      JSON.stringify({
        asOf: '2026-06-10',
        rates: { EUR: 1, USD: 1.1, NOK: 11.5 },
      })
    );
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mollieMock.getPaymentUri.mockReset();
    mollieMock.checkPaymentStatus.mockReset();
    mollieMock.processWebhook.mockReset();
  });

  describe('POST /mollie/payment', () => {
    it('passes body, client ip and uppercased cloudfront country to Mollie and returns the payload verbatim', async () => {
      const mollieResult = {
        success: true,
        data: { paymentUri: 'https://mock.mollie.test/checkout/123' },
      };
      mollieMock.getPaymentUri.mockResolvedValue(mollieResult);

      const payload = {
        extraOrderData: { email: 'buyer@test.qrsong.io' },
        cart: { items: [] },
      };
      const res = await app.inject({
        method: 'POST',
        url: '/mollie/payment',
        payload,
        headers: {
          'x-forwarded-for': '203.0.113.10',
          'cloudfront-viewer-country': 'nl',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(mollieResult);
      expect(mollieMock.getPaymentUri).toHaveBeenCalledTimes(1);
      const [body, clientIp, wait, skipMail, country] =
        mollieMock.getPaymentUri.mock.calls[0];
      expect(body).toEqual(payload);
      expect(clientIp).toBe('203.0.113.10');
      expect(wait).toBe(false);
      expect(skipMail).toBe(false);
      expect(country).toBe('NL');
    });

    it('falls back to x-country-code, uppercased', async () => {
      mollieMock.getPaymentUri.mockResolvedValue({ success: true });
      await app.inject({
        method: 'POST',
        url: '/mollie/payment',
        payload: { extraOrderData: {} },
        headers: { 'x-country-code': 'de' },
      });
      expect(mollieMock.getPaymentUri.mock.calls[0][4]).toBe('DE');
    });

    it('passes an empty country when no header is present', async () => {
      mollieMock.getPaymentUri.mockResolvedValue({ success: true });
      await app.inject({
        method: 'POST',
        url: '/mollie/payment',
        payload: { extraOrderData: {} },
      });
      expect(mollieMock.getPaymentUri.mock.calls[0][4]).toBe('');
    });
  });

  describe('POST /mollie/check', () => {
    it('returns the paid status shape verbatim', async () => {
      const paid = {
        success: true,
        data: { status: 'paid', payment: { status: 'paid' } },
      };
      mollieMock.checkPaymentStatus.mockResolvedValue(paid);
      const res = await app.inject({
        method: 'POST',
        url: '/mollie/check',
        payload: { paymentId: 'tr_paid' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(paid);
      expect(mollieMock.checkPaymentStatus).toHaveBeenCalledWith('tr_paid');
    });

    it('returns the open status shape verbatim', async () => {
      const open = { success: false, data: { status: 'open' } };
      mollieMock.checkPaymentStatus.mockResolvedValue(open);
      const res = await app.inject({
        method: 'POST',
        url: '/mollie/check',
        payload: { paymentId: 'tr_open' },
      });
      expect(res.json()).toEqual(open);
    });

    it('returns the failed status shape verbatim', async () => {
      const failed = { success: false, data: { status: 'failed' } };
      mollieMock.checkPaymentStatus.mockResolvedValue(failed);
      const res = await app.inject({
        method: 'POST',
        url: '/mollie/check',
        payload: { paymentId: 'tr_failed' },
      });
      expect(res.json()).toEqual(failed);
    });
  });

  describe('POST /mollie/webhook', () => {
    it('hands the body to processWebhook and stays 200 on repeat delivery', async () => {
      // Route-level idempotency only: the webhook endpoint itself never
      // rejects a re-delivery — dedup lives inside Mollie (mocked here),
      // so we assert the route forwards both calls and returns 200 twice.
      mollieMock.processWebhook.mockResolvedValue({ success: true });
      const payload = { id: 'tr_webhook_1' };

      const first = await app.inject({
        method: 'POST',
        url: '/mollie/webhook',
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/mollie/webhook',
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(mollieMock.processWebhook).toHaveBeenCalledTimes(2);
      expect(mollieMock.processWebhook).toHaveBeenNthCalledWith(1, payload);
      expect(mollieMock.processWebhook).toHaveBeenNthCalledWith(2, payload);
    });
  });

  describe('GET /ordertypes', () => {
    it('returns visible card order types, digital first then by maxCards', async () => {
      const res = await app.inject({ method: 'GET', url: '/ordertypes' });
      expect(res.statusCode).toBe(200);
      const types = res.json();
      expect(Array.isArray(types)).toBe(true);
      expect(types.map((t: any) => t.name)).toEqual([
        'digital',
        'physical-small',
        'physical-large',
      ]);
      expect(types[0]).toMatchObject({
        name: 'digital',
        maxCards: 3000,
        amountWithMargin: 13,
      });
      expect(types[0].id).toBeGreaterThan(0);
      // The hidden type must not leak.
      expect(types.find((t: any) => t.name === 'hidden')).toBeUndefined();
    });
  });

  describe('POST /order/calculate', () => {
    const digitalItem = {
      productType: 'cards',
      type: 'digital',
      numberOfTracks: 100,
      amount: 1,
      price: 13,
    };
    const physicalItem = {
      productType: 'cards',
      type: 'physical',
      numberOfTracks: 100,
      amount: 1,
      price: 49,
    };

    it('digital order: no shipping, NL VAT stripped from the net price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/calculate',
        payload: { cart: { items: [digitalItem] } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.total).toBeCloseTo(13, 2);
      expect(body.data.shipping).toBe(0);
      expect(body.data.payment).toBe(0);
      expect(body.data.taxRate).toBe(21);
      expect(body.data.price).toBeCloseTo(10.74, 2); // 13 / 1.21
      expect(body.data.volumeDiscount).toBe(0);
      expect(body.data.gamesFee).toBe(0);
      expect(body.data.reverseCharge).toBe(false);
      expect(body.data.vatIdStatus).toBe('not-checked');
      // EUR presentment mirrors the EUR amounts at rate 1.
      expect(body.data.presentment).toMatchObject({ currency: 'EUR', rate: 1 });
      expect(body.data.presentment.total).toBeCloseTo(13, 2);
    });

    it('physical order to NL: 2.99 shipping for a single playlist, 21% VAT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/calculate',
        payload: { countrycode: 'NL', cart: { items: [physicalItem] } },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.shipping).toBeCloseTo(2.99, 2);
      expect(body.data.total).toBeCloseTo(51.99, 2);
      expect(body.data.payment).toBeCloseTo(2.99, 2);
      expect(body.data.taxRate).toBe(21);
      expect(body.data.price).toBeCloseTo(40.5, 2); // 49 / 1.21
    });

    it('physical order to NL with 2+ playlists ships free', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/calculate',
        payload: {
          countrycode: 'NL',
          cart: { items: [physicalItem, physicalItem] },
        },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.shipping).toBe(0);
      expect(body.data.total).toBeCloseTo(98, 2);
    });

    it('physical order to the US (non-EU): 0% VAT and seeded shipping cost', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/calculate',
        payload: { countrycode: 'US', cart: { items: [physicalItem] } },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.taxRate).toBe(0);
      expect(body.data.shipping).toBeCloseTo(9.95, 2);
      expect(body.data.total).toBeCloseTo(58.95, 2);
      expect(body.data.price).toBeCloseTo(49, 2); // no VAT to strip
      expect(body.data.reverseCharge).toBe(false);
    });

    it('converts presentment to USD using the buffered cached rate', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/calculate',
        payload: { currency: 'USD', cart: { items: [digitalItem] } },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      // EUR totals stay the source of truth.
      expect(body.data.total).toBeCloseTo(13, 2);
      expect(body.data.presentment.currency).toBe('USD');
      expect(body.data.presentment.rate).toBeCloseTo(1.1 * 1.05, 10);
      // 13 * 1.155 = 15.015 → USD totals snap to 0.5 increments.
      expect(body.data.presentment.total).toBeCloseTo(15, 2);
    });

    it('returns the error shape for an invalid payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/calculate',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: false });
    });
  });

  describe('GET /currency/rates', () => {
    it('returns effective rates (ECB × 1.05 buffer) with EUR pinned to 1', async () => {
      const res = await app.inject({ method: 'GET', url: '/currency/rates' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.asOf).toBe('2026-06-10');
      expect(body.data.currencies).toContain('EUR');
      expect(body.data.currencies).toContain('USD');
      expect(body.data.rates.EUR).toBe(1);
      expect(body.data.rates.USD).toBeCloseTo(1.1 * 1.05, 10);
      expect(body.data.rates.NOK).toBeCloseTo(11.5 * 1.05, 10);
    });
  });

  describe('GET /currency/for-country/:countryCode', () => {
    it('maps NO to NOK (case-insensitive)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/currency/for-country/NO',
      });
      expect(res.json()).toEqual({ success: true, data: { currency: 'NOK' } });

      const lower = await app.inject({
        method: 'GET',
        url: '/currency/for-country/no',
      });
      expect(lower.json().data.currency).toBe('NOK');
    });

    it('falls back to EUR for unknown countries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/currency/for-country/XX',
      });
      expect(res.json()).toEqual({ success: true, data: { currency: 'EUR' } });
    });
  });

  describe('POST /order/volume-discount', () => {
    it('returns the volume discount for two digital playlists (1000 cards → 12.5% tier)', async () => {
      const item = {
        productType: 'cards',
        type: 'digital',
        numberOfTracks: 500,
        amount: 1,
        price: 13,
      };
      const res = await app.inject({
        method: 'POST',
        url: '/order/volume-discount',
        payload: { cart: { items: [item, { ...item }] } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      // 1000 cards volume-priced at 23 vs 2 × 13 individually → 3 discount.
      expect(body.volumeDiscount).toBeCloseTo(3, 2);
    });

    it('returns 0 for a single digital playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/volume-discount',
        payload: {
          cart: {
            items: [
              {
                productType: 'cards',
                type: 'digital',
                numberOfTracks: 500,
                amount: 1,
                price: 13,
              },
            ],
          },
        },
      });
      expect(res.json()).toEqual({ success: true, volumeDiscount: 0 });
    });

    it('returns the failure shape when the cart is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/order/volume-discount',
        payload: {},
      });
      expect(res.json()).toEqual({ success: false, volumeDiscount: 0 });
    });
  });
});
