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
import { createTestUser } from '../helpers/auth';

/**
 * Reseller API: API-key authentication (resellerAuth.ts) and the read
 * endpoints of resellerRoutes.ts/resellers.ts.
 */
describe('reseller API routes', () => {
  let app: FastifyInstance;
  const API_KEY = 'rk_test_1234567890abcdef';
  const auth = { authorization: `Bearer ${API_KEY}` };
  let resellerId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    await prisma().userGroup.create({ data: { id: 10, name: 'api_users' } });
    // getPresetBackgrounds resolves the system user via the first admin.
    await createTestUser({ groups: ['admin'] });
    const reseller = await prisma().user.create({
      data: {
        userId: 'reseller-user',
        email: 'reseller@test.qrsong.io',
        displayName: 'Reseller User',
        hash: 'reseller-hash',
        apiKey: API_KEY,
        verified: true,
      },
    });
    resellerId = reseller.id;
    const group = await prisma().userGroup.findFirst({
      where: { name: 'api_users' },
    });
    await prisma().userInGroup.create({
      data: { userId: reseller.id, groupId: group!.id },
    });

    // A non-api user with an API key (should be rejected with 403)
    await prisma().user.create({
      data: {
        userId: 'fake-reseller',
        email: 'fake-reseller@test.qrsong.io',
        displayName: 'Fake Reseller',
        hash: 'fake-reseller-hash',
        apiKey: 'rk_fake_key_0000000000',
      },
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('API key authentication', () => {
    it('rejects a missing API key', async () => {
      const res = await app.inject({ method: 'GET', url: '/reseller/fonts' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a key without the rk_ prefix', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reseller/fonts',
        headers: { authorization: 'Bearer not-a-reseller-key' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unknown key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reseller/fonts',
        headers: { authorization: 'Bearer rk_unknown_key_123456' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a user outside the api_users group', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reseller/fonts',
        headers: { authorization: 'Bearer rk_fake_key_0000000000' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('accepts a valid key (and caches it for the next call)', async () => {
      const first = await app.inject({
        method: 'GET',
        url: '/reseller/fonts',
        headers: auth,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'GET',
        url: '/reseller/fonts',
        headers: auth,
      });
      expect(second.statusCode).toBe(200);
    });
  });

  describe('read endpoints', () => {
    it('lists the available fonts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reseller/fonts',
        headers: auth,
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toHaveProperty('displayName');
      // Arial maps to an empty selectedFont id
      expect(body.data[0].id).toBe('');
    });

    it('lists preset backgrounds', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reseller/backgrounds',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('protects the swagger docs and accepts the key as query param', async () => {
      const noKey = await app.inject({ method: 'GET', url: '/reseller/docs' });
      expect(noKey.statusCode).toBe(401);

      const withKey = await app.inject({
        method: 'GET',
        url: `/reseller/docs?key=${API_KEY}`,
      });
      expect([200, 302]).toContain(withKey.statusCode);
    });
  });

  describe('order status', () => {
    it('404s an unknown order', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reseller/orders/QR000000',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    });

    it('reports the status of a reseller order', async () => {
      const orderType = await prisma().orderType.create({
        data: {
          name: 'digital',
          description: 'Digital',
          amount: 5,
          digital: true,
        },
      });
      const playlist = await prisma().playlist.create({
        data: {
          playlistId: 'reseller-playlist',
          name: 'Reseller Mix',
          slug: 'reseller-mix',
          image: 'img.png',
        },
      });
      const payment = await prisma().payment.create({
        data: {
          userId: resellerId,
          paymentId: 'tr_reseller_1',
          orderId: 'QR777777',
          status: 'paid',
          finalized: false,
          fullname: 'Reseller User',
          email: 'reseller@test.qrsong.io',
          totalPrice: 100,
          productPriceWithoutTax: 80,
          shippingPriceWithoutTax: 0,
          productVATPrice: 20,
          shippingVATPrice: 0,
          totalVATPrice: 20,
        },
      });
      await prisma().paymentHasPlaylist.create({
        data: {
          paymentId: payment.id,
          playlistId: playlist.id,
          amount: 1,
          numberOfTracks: 10,
          orderTypeId: orderType.id,
          type: 'digital',
          printerType: 'reseller',
          price: 100,
          priceWithoutVAT: 80,
          priceVAT: 20,
        } as any,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/reseller/orders/QR777777',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.orderId).toBe('QR777777');
      expect(body.data.status).toBe('processing');
    });
  });
});
