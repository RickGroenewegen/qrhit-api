import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Generator from '../../src/generator';
import PDF from '../../src/pdf';

/**
 * Admin order management: order search (mollie.getPaymentList), payment
 * info, sales/tax reports, line-item (payment_has_playlist) updates and
 * payment deletion.
 */
describe('admin order routes', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let phpId: number;

  const PAYMENT_ID = 'tr_admin_order_1';

  beforeAll(async () => {
    vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue(
      'job-admin-orders'
    );
    // updatePaymentInfo regenerates the invoice PDF; stub the renderer.
    vi.spyOn(PDF.prototype as any, 'generateFromUrl').mockResolvedValue(
      undefined
    );
    vi.spyOn(PDF.prototype as any, 'resizePDFPages').mockResolvedValue(
      undefined
    );
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const admin = await createTestUser({ groups: ['admin'] });
    headers = authHeader(admin.token);

    const user = await prisma().user.create({
      data: {
        userId: 'order-user',
        email: 'orders@test.qrsong.io',
        displayName: 'Order Customer',
        hash: 'order-user-hash',
      },
    });
    const digitalType = await prisma().orderType.create({
      data: {
        name: 'digital',
        type: 'cards',
        digital: true,
        description: 'Digital',
        amount: 5,
      },
    });
    await prisma().orderType.create({
      data: {
        name: 'cards-500',
        type: 'cards',
        digital: false,
        description: 'Physical cards up to 500',
        amount: 50,
        maxCards: 500,
      },
    });
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: 'order-playlist',
        name: 'Order Mix',
        slug: 'order-mix',
        image: 'img.png',
      },
    });
    const payment = await prisma().payment.create({
      data: {
        userId: user.id,
        paymentId: PAYMENT_ID,
        orderId: 'QR900001',
        status: 'paid',
        fullname: 'Order Customer',
        email: 'orders@test.qrsong.io',
        totalPrice: 60.5,
        productPriceWithoutTax: 50,
        shippingPriceWithoutTax: 0,
        productVATPrice: 10.5,
        shippingVATPrice: 0,
        totalVATPrice: 10.5,
        taxRate: 21,
        countrycode: 'NL',
        address: 'Orderstraat 1',
        city: 'Utrecht',
        zipcode: '3511AB',
        housenumber: '1',
      },
    });
    const php = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: payment.id,
        playlistId: playlist.id,
        amount: 1,
        numberOfTracks: 100,
        orderTypeId: digitalType.id,
        type: 'digital',
        price: 60.5,
        priceWithoutVAT: 50,
        priceVAT: 10.5,
      },
    });
    phpId = php.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('order search', () => {
    it('lists orders with pagination defaults', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalItems).toBe(1);
      expect(body.data[0].paymentId).toBe(PAYMENT_ID);
      expect(body.currentPage).toBe(1);
    });

    it('finds orders by text search on the playlist name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        headers,
        payload: { textSearch: 'Order Mix' },
      });
      expect(res.json().totalItems).toBe(1);
    });

    it('filters by status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        headers,
        payload: { status: ['open'] },
      });
      expect(res.json().totalItems).toBe(0);
    });
  });

  describe('payment info', () => {
    it('returns payment info fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/payment/${PAYMENT_ID}/info`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.fullname).toBe('Order Customer');
      expect(body.city).toBe('Utrecht');
      expect(body.isBusinessOrder).toBe(false);
    });

    it('404s for an unknown payment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/payment/tr_unknown/info',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('updates payment info', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/payment/${PAYMENT_ID}/info`,
        headers,
        payload: {
          fullname: 'Order Customer',
          email: 'orders@test.qrsong.io',
          isBusinessOrder: true,
          companyName: 'Order BV',
          vatId: 'NL123456789B01',
          address: 'Nieuwe Straat 2',
          housenumber: '2',
          city: 'Amsterdam',
          zipcode: '1011AB',
          countrycode: 'NL',
          differentInvoiceAddress: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().payment.findUnique({
        where: { paymentId: PAYMENT_ID },
      });
      expect(row!.isBusinessOrder).toBe(true);
      expect(row!.companyName).toBe('Order BV');
      expect(row!.city).toBe('Amsterdam');
    });

    it('toggles printer hold', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: `/payment/${PAYMENT_ID}/printer-hold`,
        headers,
        payload: { printerHold: 'yes' },
      });
      expect(bad.statusCode).toBe(400);

      const res = await app.inject({
        method: 'POST',
        url: `/payment/${PAYMENT_ID}/printer-hold`,
        headers,
        payload: { printerHold: true },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().payment.findUnique({
        where: { paymentId: PAYMENT_ID },
      });
      expect(row!.printerHold).toBe(true);
    });
  });

  describe('sales and tax reports', () => {
    it('returns the day report for all and filtered sales', async () => {
      for (const filter of ['all', 'digital', 'physical']) {
        const res = await app.inject({
          method: 'GET',
          url: `/day_report?filter=${filter}`,
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
      }
    });

    it('returns the monthly report', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/monthly_report',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('returns the month detail report', async () => {
      const now = new Date();
      const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const res = await app.inject({
        method: 'GET',
        url: `/month_report/${yearMonth}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns the tax report for a month and a quarter', async () => {
      const now = new Date();
      const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const quarter = `${now.getFullYear()}Q${Math.floor(now.getMonth() / 3) + 1}`;
      for (const period of [yearMonth, quarter]) {
        const res = await app.inject({
          method: 'GET',
          url: `/tax_report/${period}`,
          headers,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
      }
    });

    it('kicks off the unfinalized check', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/check_unfinalized',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('line item updates', () => {
    it('toggles games-enabled', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/games-enabled`,
        headers,
        payload: { gamesEnabled: 'yes' },
      });
      expect(bad.statusCode).toBe(400);

      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/games-enabled`,
        headers,
        payload: { gamesEnabled: true },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect((row as any).gamesEnabled).toBe(true);
    });

    it('updates the track count', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/track-count`,
        headers,
        payload: { numberOfTracks: -1 },
      });
      expect(bad.statusCode).toBe(400);

      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/track-count`,
        headers,
        payload: { numberOfTracks: 120 },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect(row!.numberOfTracks).toBe(120);
    });

    it('404s the track count of an unknown line item', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/playlist/999999/track-count',
        headers,
        payload: { numberOfTracks: 10 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('updates the amount', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/amount`,
        headers,
        payload: { amount: 0 },
      });
      expect(bad.statusCode).toBe(400);

      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/amount`,
        headers,
        payload: { amount: 3 },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect(row!.amount).toBe(3);
    });

    it('resets the judged status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/judged`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('rejects an invalid product type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/type`,
        headers,
        payload: { productType: 'vinyl' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('reports no change when the type stays the same', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/type`,
        headers,
        payload: { productType: 'digital' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toBe(false);
    });

    it('changes the type to physical cards and queues regeneration', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/type`,
        headers,
        payload: { productType: 'cards' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toBe(true);
      expect(body.jobId).toBe('job-admin-orders');
      const row = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect(row!.type).toBe('physical');
    });
  });

  describe('payment deletion', () => {
    it('404s deleting an unknown payment', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/payment/tr_does_not_exist',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('deletes a payment permanently', async () => {
      const user = await prisma().user.findFirst({
        where: { userId: 'order-user' },
      });
      await prisma().payment.create({
        data: {
          userId: user!.id,
          paymentId: 'tr_doomed',
          status: 'paid',
          fullname: 'Doomed Order',
          email: 'orders@test.qrsong.io',
          totalPrice: 10,
          productPriceWithoutTax: 8,
          shippingPriceWithoutTax: 0,
          productVATPrice: 2,
          shippingVATPrice: 0,
          totalVATPrice: 2,
        },
      });
      const res = await app.inject({
        method: 'DELETE',
        url: '/payment/tr_doomed',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().payment.findUnique({
        where: { paymentId: 'tr_doomed' },
      });
      expect(row).toBeNull();
    });
  });
});
