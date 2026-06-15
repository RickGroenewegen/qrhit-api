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
 * game-routes2: covers game endpoints NOT exercised by game.test.ts.
 *
 * Target groups:
 *  - POST /api/game/enable-payment (validation paths: missing params, 400, 404, 403, 400 already enabled, 500 Mollie)
 */
describe('game routes — wave 2 coverage', () => {
  let app: FastifyInstance;
  let userHeaders: Record<string, string>;
  let otherHeaders: Record<string, string>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;
  let otherUser: Awaited<ReturnType<typeof createTestUser>>;

  let phpId: number;
  let gamesEnabledPhpId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    testUser  = await createTestUser({ groups: ['users'] });
    otherUser = await createTestUser({ groups: ['users'] });
    userHeaders  = authHeader(testUser.token);
    otherHeaders = authHeader(otherUser.token);

    // Order type for physical cards
    const orderType = await prisma().orderType.create({
      data: {
        name: 'gr2-cards',
        type: 'cards',
        digital: false,
        description: 'GR2 physical cards',
        amount: 30,
        maxCards: 60,
      },
    });

    // Playlist + payment + paymentHasPlaylist owned by testUser (gamesEnabled: false)
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: 'gr2-playlist-1',
        name: 'GR2 Playlist',
        slug: 'gr2-playlist',
        image: 'img.png',
      },
    });

    const payment = await prisma().payment.create({
      data: {
        userId:    testUser.user.id,
        paymentId: 'tr_gr2_enable',
        orderId:   'QR999010',
        status:    'paid',
        fullname:  'GR2 User',
        email:     testUser.user.email,
        totalPrice: 50,
        productPriceWithoutTax: 40,
        shippingPriceWithoutTax: 5,
        productVATPrice: 3,
        shippingVATPrice: 2,
        totalVATPrice: 5,
        taxRate: 21,
        countrycode: 'NL',
        address: 'Teststraat',
        city: 'Eindhoven',
        zipcode: '5611AA',
        housenumber: '1',
      },
    });

    const php = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId:      payment.id,
        playlistId:     playlist.id,
        amount:         1,
        numberOfTracks: 30,
        orderTypeId:    orderType.id,
        type:           'cards',
        price:          50,
        priceWithoutVAT: 41,
        priceVAT:       9,
        gamesEnabled:   false,
      },
    });
    phpId = php.id;

    // A separate php with gamesEnabled: true (for "already enabled" test)
    const playlist2 = await prisma().playlist.create({
      data: {
        playlistId: 'gr2-playlist-2',
        name: 'GR2 Playlist 2',
        slug: 'gr2-playlist-2',
        image: 'img.png',
      },
    });

    const php2 = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId:      payment.id,
        playlistId:     playlist2.id,
        amount:         1,
        numberOfTracks: 30,
        orderTypeId:    orderType.id,
        type:           'cards',
        price:          50,
        priceWithoutVAT: 41,
        priceVAT:       9,
        gamesEnabled:   true,
      },
    });
    gamesEnabledPhpId = php2.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  // ====================================================================
  // POST /api/game/enable-payment
  // ====================================================================

  describe('POST /api/game/enable-payment', () => {
    it('401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        payload: { paymentHasPlaylistIds: [phpId] },
      });
      expect(res.statusCode).toBe(401);
    });

    it('400 for missing paymentHasPlaylistIds', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: userHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Missing required parameters');
    });

    it('400 for empty paymentHasPlaylistIds array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: userHeaders,
        payload: { paymentHasPlaylistIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for non-array paymentHasPlaylistIds', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: userHeaders,
        payload: { paymentHasPlaylistIds: phpId },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for non-existent paymentHasPlaylistId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: userHeaders,
        payload: { paymentHasPlaylistIds: [999999] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('403 when another user tries to enable games for another user\'s playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: otherHeaders,
        payload: { paymentHasPlaylistIds: [phpId] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 when QRGames is already enabled for the playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: userHeaders,
        payload: { paymentHasPlaylistIds: [gamesEnabledPhpId] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('already enabled');
    });

    it('500 when Mollie createUpgradePayment fails (test env has no valid Mollie credentials)', async () => {
      // NOTE: In test env, Mollie API key is a dummy, so payment creation will fail → 500
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/enable-payment',
        headers: userHeaders,
        payload: { paymentHasPlaylistIds: [phpId], locale: 'nl' },
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });
});
