import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';

/**
 * Gift-box upgrade routes (boxRoutes.ts + upgrade.ts price calculation).
 */
describe('box upgrade routes', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let stranger: Awaited<ReturnType<typeof createTestUser>>;
  let phpId: number;
  let digitalPhpId: number;
  let unfinalizedPhpId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    owner = await createTestUser({ groups: ['users'] });
    stranger = await createTestUser({ groups: ['users'] });

    await prisma().taxRate.create({
      data: { rate: 21, countryCode: 'NL' },
    });

    const orderType = await prisma().orderType.create({
      data: {
        name: 'cards-500',
        type: 'cards',
        description: 'Physical cards',
        amount: 50,
        maxCards: 500,
      },
    });
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: 'box-playlist',
        name: 'Box Mix',
        slug: 'box-mix',
        image: 'img.png',
      },
    });

    const mkPayment = (paymentId: string, finalized: boolean) =>
      prisma().payment.create({
        data: {
          userId: owner.user.id,
          paymentId,
          status: 'paid',
          finalized,
          fullname: 'Box Buyer',
          email: owner.user.email,
          totalPrice: 50,
          productPriceWithoutTax: 40,
          shippingPriceWithoutTax: 0,
          productVATPrice: 10,
          shippingVATPrice: 0,
          totalVATPrice: 10,
          countrycode: 'NL',
          address: 'Boxstraat 1',
          housenumber: '1',
          city: 'Leiden',
          zipcode: '2311GJ',
        },
      });

    const physicalPayment = await mkPayment('tr_box_physical', true);
    const php = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: physicalPayment.id,
        playlistId: playlist.id,
        amount: 1,
        numberOfTracks: 250,
        orderTypeId: orderType.id,
        type: 'physical',
        price: 50,
        priceWithoutVAT: 40,
        priceVAT: 10,
      },
    });
    phpId = php.id;

    const digitalPayment = await mkPayment('tr_box_digital', true);
    const digitalPhp = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: digitalPayment.id,
        playlistId: playlist.id,
        amount: 1,
        numberOfTracks: 100,
        orderTypeId: orderType.id,
        type: 'digital',
        price: 50,
        priceWithoutVAT: 40,
        priceVAT: 10,
      },
    });
    digitalPhpId = digitalPhp.id;

    const unfinalizedPayment = await mkPayment('tr_box_unfinalized', false);
    const unfinalizedPhp = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: unfinalizedPayment.id,
        playlistId: playlist.id,
        amount: 1,
        numberOfTracks: 100,
        orderTypeId: orderType.id,
        type: 'physical',
        price: 50,
        priceWithoutVAT: 40,
        priceVAT: 10,
      },
    });
    unfinalizedPhpId = unfinalizedPhp.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('calculate-price', () => {
    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        payload: { paymentHasPlaylistId: phpId },
      });
      expect(res.statusCode).toBe(401);
    });

    it('requires the paymentHasPlaylistId parameter', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        headers: authHeader(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s an unknown line item', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: 999999 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("403s another user's line item", async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        headers: authHeader(stranger.token),
        payload: { paymentHasPlaylistId: phpId },
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses digital orders', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: digitalPhpId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('physical');
    });

    it('refuses unfinalized orders', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: unfinalizedPhpId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('finalized');
    });

    it('calculates the tiered VAT-inclusive box price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-price',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: phpId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      // 250 tracks at 190 cards per box -> 2 boxes; tier price for 2 boxes is 6.00
      expect(body.boxQuantity).toBe(2);
      expect(body.totalBoxes).toBe(2);
      expect(body.boxUnitPriceEur).toBe(6);
      expect(body.totalEur).toBe(12);
      expect(body.totalPrice).toBe(12);
      expect(body.taxRate).toBe(21);
      // VAT is derived back out of the inclusive total
      expect(body.boxSubtotalEur).toBe(9.92);
      expect(body.vatEur).toBe(2.08);
    });
  });

  describe('calculate-shipping', () => {
    it('uses the fixed NL shipping rate and returns the address', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/box/calculate-shipping',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: phpId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.shipping).toBe(2.99);
      expect(body.total).toBe(12 + 2.99);
      expect(body.address.city).toBe('Leiden');
      expect(body.address.countrycode).toBe('NL');
    });
  });

  describe('box design', () => {
    it('returns the stored design defaults', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/box/design/${phpId}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const { design } = res.json();
      expect(design).toHaveProperty('boxFrontBackgroundType');
      expect(design).toHaveProperty('boxBackText');
    });

    it('400s an invalid id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/box/design/abc',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it("403s another user's design", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/box/design/${phpId}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
