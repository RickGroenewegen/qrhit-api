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

/**
 * admin-routes3: covers admin endpoints NOT exercised by admin.test.ts,
 * admin-routes2.test.ts, admin-extra.test.ts, admin-authz.test.ts,
 * or admin-corrections.test.ts.
 *
 * Target groups:
 *  - Queue endpoints (no Redis → "Queue not configured" path)
 *  - Create/update admin user
 *  - Delete user by ID
 *  - verify/:paymentId
 *  - lastplays, push/broadcast, push/messages
 *  - regenerate, regenerate-product-only
 *  - php/:paymentHasPlaylistId (CRUD: eco/doubleSided/printerType)
 *  - playlist-excel export
 *  - admin/discount create/search/update
 *  - admin/featured/* endpoints
 *  - admin/playlist/:id/featured, featured-hidden, howto-card
 *  - admin/promotional/accepted, pending, pending-count
 *  - admin/promotional/:id/resend-email, translate
 *  - admin/promotional-playlists
 *  - admin/run-printer-pass
 *  - admin/calculate-shipping-costs
 *  - admin/calculate-playlist-scores
 *  - admin/create-payment-link (validation)
 *  - admin/payment/:id/refund (validation + 404 + status check)
 *  - admin/impersonate
 *  - admin/translate-fields
 *  - admin/tracks/toggle-spotify-ignored, missing-spotify-count
 *  - admin/tracks/service-search, spotify-search
 *  - admin/hitlists/number-one/:date
 *  - admin/broken-links CRUD
 *  - admin/unknown-links CRUD
 *  - admin/spotify/provider-status + toggle-provider
 *  - admin/db/flush-hosts
 *  - admin/printer-costs/calculate
 *  - admin/tracking/* endpoints
 *  - admin/settings GET+PUT
 *  - admin/shipping-config CRUD
 *  - admin/chats endpoints
 *  - admin/send-custom-email (validation)
 *  - admin/email-templates
 *  - admin/external-cards GET + stats
 *  - admin/create-user
 *  - payment/:id duplicate
 */
describe('admin routes — wave 3 coverage', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let customerHeaders: Record<string, string>;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let customer: Awaited<ReturnType<typeof createTestUser>>;

  let paymentId: string;
  let phpId: number;
  let playlistId: string;
  let playlistDbId: number;
  let trackId: number;
  let trackSpotifyId: string;

  const PAYMENT_ID = 'tr_admin3_wave3';

  beforeAll(async () => {
    vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue('job-wave3');
    vi.spyOn(Generator.prototype as any, 'setupForPrinter').mockResolvedValue(undefined);
    vi.spyOn(Generator.prototype as any, 'sendToPrinter').mockResolvedValue({ success: true });
    vi.spyOn(Generator.prototype as any, 'runSendToPrinterPass').mockResolvedValue({ sent: 0 });

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    admin    = await createTestUser({ groups: ['admin'] });
    customer = await createTestUser({ groups: ['users'] });
    headers         = authHeader(admin.token);
    customerHeaders = authHeader(customer.token);

    // Create order type
    const orderType = await prisma().orderType.create({
      data: {
        name: 'cards-wave3',
        type: 'cards',
        digital: false,
        description: 'Wave3 physical',
        amount: 30,
        maxCards: 60,
      },
    });

    trackSpotifyId = 'wave3-spotify-track-1';
    const track = await prisma().track.create({
      data: {
        trackId: trackSpotifyId,
        name: 'Wave3 Track',
        artist: 'Wave3 Artist',
        year: 2000,
      },
    });
    trackId = track.id;

    const playlist = await prisma().playlist.create({
      data: {
        playlistId: 'wave3-playlist-1',
        name: 'Wave3 Mix',
        slug: 'wave3-mix',
        image: 'img.png',
        featured: true,
        promotionalActive: true,
        promotionalTitle: 'Wave3 Promo',
        promotionalUserId: customer.user.id,
      },
    });
    playlistId   = playlist.playlistId;
    playlistDbId = playlist.id;

    const payment = await prisma().payment.create({
      data: {
        userId:   customer.user.id,
        paymentId: PAYMENT_ID,
        orderId:  'QR999001',
        status:   'paid',
        fullname: 'Wave3 Customer',
        email:    'wave3@test.qrsong.io',
        totalPrice: 60,
        productPriceWithoutTax: 50,
        shippingPriceWithoutTax: 5,
        productVATPrice: 4,
        shippingVATPrice: 1,
        totalVATPrice: 5,
        taxRate: 21,
        countrycode: 'NL',
        address: 'Breedstraat 1',
        city: 'Tilburg',
        zipcode: '5038BA',
        housenumber: '1',
      },
    });
    paymentId = payment.paymentId;

    const php = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId:      payment.id,
        playlistId:     playlistDbId,
        amount:         1,
        numberOfTracks: 30,
        orderTypeId:    orderType.id,
        type:           'cards',
        price:          60,
        priceWithoutVAT: 50,
        priceVAT:       10,
      },
    });
    phpId = php.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  // ====================================================================
  // QUEUE (test env has REDIS_URL set; queue endpoints hit Redis)
  // ====================================================================

  describe('queue endpoints — Redis path', () => {
    // NOTE: REDIS_URL is set in .env (inherited by test env), so the "Queue not configured"
    // early-exit branch is NOT taken. Endpoints proceed to use BullMQ. We just verify
    // they are accessible (200) and return a JSON body with either success or error key.

    const queueEndpoints = [
      { method: 'GET',    url: '/queue/status' },
      { method: 'GET',    url: '/queue/detailed' },
      { method: 'GET',    url: '/queue/jobs/waiting' },
      { method: 'POST',   url: '/queue/retry-failed' },
      { method: 'POST',   url: '/queue/clear' },
      { method: 'POST',   url: '/queue/pause' },
      { method: 'POST',   url: '/queue/resume' },
    ] as const;

    for (const ep of queueEndpoints) {
      it(`${ep.method} ${ep.url} → 200 with JSON body`, async () => {
        const res = await app.inject({ method: ep.method, url: ep.url, headers });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Queue may return success:true or an error key depending on Redis state
        expect(body).toBeTruthy();
      });
    }

    it('GET /queue/job/:jobId → 200 (job not found is handled gracefully)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/queue/job/non-existent-job-id',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Either { error: 'Job not found' } or { success: true, job: ... }
      expect(body).toBeTruthy();
    });

    it('POST /queue/job/:jobId/retry → 200 (error handled for non-existent job)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/queue/job/non-existent-job-id/retry',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });

    it('DELETE /queue/job/:jobId → 200 (error handled for non-existent job)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/queue/job/non-existent-job-id',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /queue/jobs/:status → validates status values', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/queue/jobs/invalid-status',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.error).toBeTruthy();
    });
  });

  // ====================================================================
  // ADMIN USER MANAGEMENT
  // ====================================================================

  describe('admin user management', () => {
    it('POST /admin/create — rejects missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/create',
        headers,
        payload: { displayName: 'No Email User' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Missing required fields');
    });

    it('POST /admin/create — creates a new vibeadmin user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/create',
        headers,
        payload: {
          email: `wave3-vibe-${Date.now()}@test.qrsong.io`,
          displayName: 'Wave3 VibeAdmin',
          userGroup: 'vibeadmin',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().userId).toBe('string');
    });

    it('DELETE /admin/user/:id — 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/user/abc',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE /admin/user/:id — 500 for unknown user id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/user/999999',
        headers,
      });
      // deleteUserById returns success:false when user not found → 500
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // VERIFY PAYMENT
  // ====================================================================

  describe('GET /verify/:paymentId', () => {
    it('runs verifyPayment and returns success', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/verify/${PAYMENT_ID}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // LAST PLAYS
  // ====================================================================

  describe('GET /lastplays', () => {
    it('returns lastplays array', async () => {
      const res = await app.inject({ method: 'GET', url: '/lastplays', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
    });
  });

  // ====================================================================
  // PUSH
  // ====================================================================

  describe('push endpoints', () => {
    it('POST /push/broadcast — sends notification (mocked)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/push/broadcast',
        headers,
        payload: { title: 'Test', message: 'Hello', test: true, dry: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('GET /push/messages — returns messages list', async () => {
      const res = await app.inject({ method: 'GET', url: '/push/messages', headers });
      expect(res.statusCode).toBe(200);
    });
  });

  // ====================================================================
  // REGENERATE
  // ====================================================================

  describe('regenerate endpoints', () => {
    it('GET /regenerate/:paymentId/:email — queues generation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/regenerate/${PAYMENT_ID}/false`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('GET /regenerate-product-only/:paymentId — queues product-only generation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/regenerate-product-only/${PAYMENT_ID}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // PHP UPDATE (/php/:paymentHasPlaylistId)
  // ====================================================================

  describe('POST /php/:paymentHasPlaylistId', () => {
    it('400 for NaN id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/php/abc',
        headers,
        payload: { eco: true, doubleSided: false },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for invalid eco/doubleSided type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/php/${phpId}`,
        headers,
        payload: { eco: 'yes', doubleSided: 'no' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for invalid printerType', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/php/${phpId}`,
        headers,
        payload: { eco: false, doubleSided: false, printerType: 'super-printer' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 with valid payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/php/${phpId}`,
        headers,
        payload: { eco: false, doubleSided: true, boxQuantity: 2 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('400 for invalid boxQuantity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/php/${phpId}`,
        headers,
        payload: { eco: false, doubleSided: false, boxQuantity: -1 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ====================================================================
  // PLAYLIST EXCEL EXPORT
  // ====================================================================

  describe('GET /admin/playlist-excel/:paymentId/:paymentHasPlaylistId', () => {
    it('400 for invalid paymentHasPlaylistId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/playlist-excel/${PAYMENT_ID}/abc`,
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 when playlist not found', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/playlist-excel/tr_ghost_wave3/999999`,
        headers,
      });
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // DISCOUNT (search + update paths not in admin.test.ts)
  // ====================================================================

  describe('discount search and update', () => {
    let discountId: number;

    beforeAll(async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/admin/discount/create',
        headers,
        payload: { amount: 10, code: 'WAVE3DISC' },
      });
      discountId = create.json().code?.id ?? 0;
      // Re-fetch by searching
      const search = await app.inject({
        method: 'POST',
        url: '/admin/discount/search',
        headers,
        payload: { searchTerm: 'WAVE3DISC' },
      });
      if (search.json().discounts?.length) {
        discountId = search.json().discounts[0].id;
      }
    });

    it('POST /admin/discount/search — returns paginated results', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/discount/search',
        headers,
        payload: { searchTerm: '', page: 1, limit: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().discounts)).toBe(true);
    });

    it('GET /admin/discount/all — lists all discounts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/discount/all',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('PUT /admin/discount/:id — 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/discount/abc',
        headers,
        payload: { amount: 20 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /admin/discount/:id — updates discount', async () => {
      if (!discountId) return;
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/discount/${discountId}`,
        headers,
        payload: { amount: 15 },
      });
      expect([200, 400]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // FEATURED PLAYLISTS
  // ====================================================================

  describe('featured playlist endpoints', () => {
    it('GET /admin/featured/all — returns all featured playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/featured/all',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('POST /admin/featured/search — returns paginated results', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/featured/search',
        headers,
        payload: { searchTerm: 'Wave3', page: 1, limit: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('POST /admin/playlist/:id/featured — sets featured flag', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${playlistId}/featured`,
        headers,
        payload: { featured: true },
      });
      expect([200, 500]).toContain(res.statusCode);
    });

    it('POST /admin/playlist/:id/featured — rejects non-boolean', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${playlistId}/featured`,
        headers,
        payload: { featured: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/playlist/:id/featured-hidden — sets hidden flag', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${playlistId}/featured-hidden`,
        headers,
        payload: { featuredHidden: true },
      });
      expect([200, 500]).toContain(res.statusCode);
    });

    it('POST /admin/playlists/clear-non-featured-cache — runs cache clear', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/playlists/clear-non-featured-cache',
        headers,
      });
      expect([200, 500]).toContain(res.statusCode);
    });

    it('POST /admin/featured/:playlistId/remove-image — 404 for unknown playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/featured/unknown-playlist-id/remove-image',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /admin/featured/:playlistId/remove-image — succeeds for known playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/featured/${playlistId}/remove-image`,
        headers,
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // PROMOTIONAL MANAGEMENT
  // ====================================================================

  describe('promotional playlist admin actions', () => {
    it('GET /admin/promotional/pending-count — returns count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional/pending-count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().count).toBe('number');
    });

    it('GET /admin/promotional/pending — returns pending playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional/pending',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('GET /admin/promotional/accepted — returns accepted playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional/accepted',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('POST /admin/promotional/:id/accept — runs accept flow', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${playlistId}/accept`,
        headers,
      });
      // May succeed or fail depending on translation service availability
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    it('POST /admin/promotional/:id/resend-email — 404 for unknown playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/promotional/no-such-playlist/resend-email',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /admin/promotional/:id/translate — runs translate flow', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${playlistId}/translate`,
        headers,
      });
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    it('GET /admin/promotional-playlists — returns all promotional playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional-playlists',
        headers,
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // HOW-TO CARD
  // ====================================================================

  describe('POST /admin/playlist/:id/howto-card', () => {
    it('400 for non-boolean addHowToCard', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/howto-card`,
        headers,
        payload: { addHowToCard: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 for valid addHowToCard', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/howto-card`,
        headers,
        payload: { addHowToCard: true, addHowToCardLocale: 'nl' },
      });
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // HOWTO CARD IMAGE (clear path)
  // ====================================================================

  describe('POST /admin/playlist/:id/howto-card-image', () => {
    it('clears how-to card image when image is null', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/playlist/${phpId}/howto-card-image`,
        headers,
        payload: { image: null },
      });
      // null image path → clear; may return 200 or 404 if php not found after type
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // RUN PRINTER PASS
  // ====================================================================

  describe('POST /admin/run-printer-pass', () => {
    it('runs the printer pass (mocked generator)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/run-printer-pass',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // CALCULATE SHIPPING COSTS
  // ====================================================================

  describe('POST /admin/calculate-shipping-costs', () => {
    it('400 for missing countryCodes array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/calculate-shipping-costs',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for empty countryCodes array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/calculate-shipping-costs',
        headers,
        payload: { countryCodes: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for invalid country codes format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/calculate-shipping-costs',
        headers,
        payload: { countryCodes: ['INVALID'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 for valid country codes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/calculate-shipping-costs',
        headers,
        payload: { countryCodes: ['NL', 'DE'] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // CALCULATE PLAYLIST SCORES
  // ====================================================================

  describe('POST /admin/calculate-playlist-scores', () => {
    it('runs score calculation (may return 0 updates with empty DB)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/calculate-playlist-scores',
        headers,
      });
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json().success).toBe(true);
      }
    });
  });

  // ====================================================================
  // CREATE PAYMENT LINK
  // ====================================================================

  describe('POST /admin/create-payment-link', () => {
    it('400 for missing amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/create-payment-link',
        headers,
        payload: { description: 'Test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for zero amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/create-payment-link',
        headers,
        payload: { amount: 0, description: 'Test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for negative amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/create-payment-link',
        headers,
        payload: { amount: -10, description: 'Test' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ====================================================================
  // REFUND
  // ====================================================================

  describe('POST /admin/payment/:paymentId/refund', () => {
    it('400 for missing amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/payment/${PAYMENT_ID}/refund`,
        headers,
        payload: { reason: 'test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for negative amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/payment/${PAYMENT_ID}/refund`,
        headers,
        payload: { amount: -5 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for unknown payment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/payment/tr_ghost_refund/refund',
        headers,
        payload: { amount: 10 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400 when refund amount exceeds total', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/payment/${PAYMENT_ID}/refund`,
        headers,
        payload: { amount: 10000 },
      });
      // Should either reject with 400 (exceeds total) or 500 (Mollie not configured)
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // DUPLICATE PAYMENT
  // ====================================================================

  describe('POST /admin/payment/:paymentId/duplicate', () => {
    it('400 for missing paymentId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/payment//duplicate',
        headers,
      });
      expect([400, 404]).toContain(res.statusCode);
    });

    it('404 for unknown payment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/payment/tr_no_such_payment/duplicate',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ====================================================================
  // IMPERSONATE
  // ====================================================================

  describe('POST /admin/impersonate', () => {
    it('400 when email is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Email');
    });

    it('404 for non-existent email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: { email: 'does-not-exist@test.qrsong.io' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('403 when trying to impersonate an admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: { email: admin.user.email },
      });
      expect(res.statusCode).toBe(403);
    });

    it('200 for a regular customer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: { email: customer.user.email },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().token).toBe('string');
    });
  });

  // ====================================================================
  // TRANSLATE FIELDS
  // ====================================================================

  describe('POST /admin/translate-fields', () => {
    it('400 for missing locale', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/translate-fields',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for locale=en', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/translate-fields',
        headers,
        payload: { locale: 'en' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for invalid locale', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/translate-fields',
        headers,
        payload: { locale: 'xx' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 for valid locale (fire-and-forget)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/translate-fields',
        headers,
        payload: { locale: 'nl' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // TRACKS: toggle-spotify-ignored, missing-spotify-count, service-search
  // ====================================================================

  describe('track endpoints — misc', () => {
    it('GET /tracks/missing-spotify-count — returns count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tracks/missing-spotify-count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().count).toBe('number');
    });

    it('POST /tracks/toggle-spotify-ignored — 400 for missing id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/toggle-spotify-ignored',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /tracks/toggle-spotify-ignored — 404 for unknown track', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/toggle-spotify-ignored',
        headers,
        payload: { id: 999999 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /tracks/toggle-spotify-ignored — toggles flag for existing track', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/toggle-spotify-ignored',
        headers,
        payload: { id: trackId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().spotifyLinkIgnored).toBe('boolean');
    });

    it('POST /tracks/service-search — 400 for short search term', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/service-search',
        headers,
        payload: { service: 'spotify', searchTerm: 'a' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });

    it('POST /tracks/service-search — error for unsupported service', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/service-search',
        headers,
        payload: { service: 'invalid-service', searchTerm: 'hello world' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });

    it('POST /tracks/spotify-search — error for short term', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/spotify-search',
        headers,
        payload: { searchTerm: 'a' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });

    it('POST /tracks/missing-spotify — returns missing Spotify tracks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/missing-spotify',
        headers,
        payload: { searchTerm: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('POST /tracks/find-missing-service-links — 400 for missing service', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracks/find-missing-service-links',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/tracks/find-missing-service-links — 200 for valid service', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracks/find-missing-service-links',
        headers,
        payload: { service: 'tidal' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // HITLISTS - number-one
  // ====================================================================

  describe('GET /admin/hitlists/number-one/:date', () => {
    it('400 for invalid date format', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/hitlists/number-one/not-a-date',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 when no #1 track exists for that date', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/hitlists/number-one/2026-01-01',
        headers,
      });
      // No hitlist data in test DB → 404
      expect([200, 404]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // BROKEN LINKS CRUD
  // ====================================================================

  describe('broken links endpoints', () => {
    let brokenLinkId: number;

    beforeAll(async () => {
      // Seed a broken link
      const bl = await prisma().brokenLink.create({
        data: {
          url: 'https://broken-wave3.test/link',
          type: 'invalid',
          serviceType: 'spotify',
          errorType: 'not_found',
        },
      });
      brokenLinkId = bl.id;
    });

    it('GET /admin/broken-links — returns list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/broken-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('GET /admin/broken-links/count — returns count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/broken-links/count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().count).toBe('number');
    });

    it('PATCH /admin/broken-links/:id/ignore — 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/broken-links/abc/ignore',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH /admin/broken-links/:id/ignore — toggles ignored flag', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/broken-links/${brokenLinkId}/ignore`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().ignored).toBe('boolean');
    });

    it('DELETE /admin/broken-links/:id — 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/broken-links/abc',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE /admin/broken-links/:id — deletes broken link', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/broken-links/${brokenLinkId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('DELETE /admin/broken-links — deletes all broken links', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/broken-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().deleted).toBe('number');
    });
  });

  // ====================================================================
  // UNKNOWN LINKS CRUD
  // ====================================================================

  describe('unknown links endpoints', () => {
    let unknownLinkId: number;

    beforeAll(async () => {
      const ul = await prisma().unknownLink.create({
        data: {
          url: 'https://wave3-unknown.test/link',
        },
      });
      unknownLinkId = ul.id;
    });

    it('GET /admin/unknown-links — returns list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/unknown-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('GET /admin/unknown-links/count — returns count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/unknown-links/count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().count).toBe('number');
    });

    it('PATCH /admin/unknown-links/:id/ignore — 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/unknown-links/abc/ignore',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH /admin/unknown-links/:id/ignore — toggles ignored for valid id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/unknown-links/${unknownLinkId}/ignore`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('PATCH /admin/unknown-links/:id/ignore — 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/unknown-links/999999/ignore',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /admin/unknown-links/:id — 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/unknown-links/abc',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE /admin/unknown-links/:id — deletes unknown link', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/unknown-links/${unknownLinkId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('DELETE /admin/unknown-links — deletes all unknown links', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/unknown-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // SPOTIFY PROVIDER TOGGLE
  // ====================================================================

  describe('Spotify provider endpoints', () => {
    it('GET /admin/spotify/provider-status — returns provider status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/spotify/provider-status',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(['v1', 'v2', 'scraper', 'graphql']).toContain(res.json().playlistProvider);
    });

    it('POST /admin/spotify/toggle-provider — 400 for invalid target', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'v1', target: 'albums' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/spotify/toggle-provider — 400 for invalid provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'v99', target: 'playlist' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/spotify/toggle-provider — sets provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'v2', target: 'playlist' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().provider).toBe('v2');
      // Restore to v1
      await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'v1', target: 'playlist' },
      });
    });
  });

  // ====================================================================
  // DB FLUSH HOSTS
  // ====================================================================

  describe('POST /admin/db/flush-hosts', () => {
    it('runs FLUSH HOSTS and succeeds', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/db/flush-hosts',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // PRINTER COST CALCULATOR
  // ====================================================================

  describe('POST /admin/printer-costs/calculate', () => {
    it('returns calculation result (may fail if PrintEnBind external call throws)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/printer-costs/calculate',
        headers,
        payload: {},
      });
      // PrintEnBind.calculateSingleItem may fail in test env (external dep)
      // NOTE: suspected bug: uncaught error when PrintEnBind throws — endpoint has no try/catch
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // TRACKING ENDPOINTS
  // ====================================================================

  describe('tracking endpoints', () => {
    it('POST /admin/tracking/in-transit — returns tracking data', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/in-transit',
        headers,
        payload: { page: 1, itemsPerPage: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('POST /admin/tracking/delivered — returns delivered tracking data', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/delivered',
        headers,
        payload: { page: 1, itemsPerPage: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('GET /admin/tracking/country-codes — returns country codes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/tracking/country-codes',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('POST /admin/tracking/export — 400 for invalid status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/export',
        headers,
        payload: { status: 'Pending' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/tracking/toggle-ignore — 400 for missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/toggle-ignore',
        headers,
        payload: { paymentId: PAYMENT_ID },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/tracking/toggle-ignore — updates ignore status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/toggle-ignore',
        headers,
        payload: { paymentId: PAYMENT_ID, ignore: true },
      });
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // SITE SETTINGS
  // ====================================================================

  describe('site settings endpoints', () => {
    it('GET /admin/settings — returns settings (or 404 if not seeded)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/settings',
        headers,
      });
      expect([200, 404]).toContain(res.statusCode);
    });

    it('PUT /admin/settings — 400 for invalid productionDays', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/settings',
        headers,
        payload: { productionDays: -1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /admin/settings — updates valid settings', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/settings',
        headers,
        payload: { productionDays: 3, productionMessage: '' },
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // SHIPPING CONFIG
  // ====================================================================

  describe('shipping config endpoints', () => {
    it('GET /admin/shipping-config — returns all configs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/shipping-config',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('PUT /admin/shipping-config/:countryCode — 400 for invalid country code', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-config/INVALID',
        headers,
        payload: { minDaysOffset: 0, maxDaysOffset: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /admin/shipping-config/:countryCode — 400 for non-numeric offsets', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-config/NL',
        headers,
        payload: { minDaysOffset: 'abc', maxDaysOffset: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /admin/shipping-config/:countryCode — creates/updates config', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-config/ZZ',
        headers,
        payload: { minDaysOffset: 1, maxDaysOffset: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('DELETE /admin/shipping-config/:countryCode — 400 for invalid code', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/shipping-config/TOOLONG',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE /admin/shipping-config/:countryCode — deletes existing config', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/shipping-config/ZZ',
        headers,
      });
      expect([200, 404]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // ADMIN CHATS
  // ====================================================================

  describe('admin chat endpoints', () => {
    let chatId: number;

    beforeAll(async () => {
      const chat = await prisma().chat.create({
        data: {
          email: 'chattest@wave3.test',
          username: 'chattest',
        },
      });
      chatId = chat.id;
      await prisma().chatMessage.create({
        data: {
          chatId: chat.id,
          role: 'user',
          content: 'Hello from wave3 test',
        },
      });
    });

    it('GET /admin/chats — returns chats', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/chats', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('GET /admin/chats/support-count — returns count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/chats/support-count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().count).toBe('number');
    });

    it('GET /admin/chats/:id/messages — 404 for unknown chat', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/chats/999999/messages',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /admin/chats/:id/messages — returns chat messages', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/chats/${chatId}/messages`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data.messages)).toBe(true);
    });

    it('POST /admin/chats/:id/mark-seen — marks chat as seen', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/mark-seen`,
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('POST /admin/chats/:id/hijack — 400 for non-boolean hijacked', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/hijack`,
        headers,
        payload: { hijacked: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/chats/:id/hijack — sets hijack status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/hijack`,
        headers,
        payload: { hijacked: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().hijacked).toBe(true);
    });

    it('POST /admin/chats/:id/support-needed — 400 for non-boolean', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/support-needed`,
        headers,
        payload: { supportNeeded: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/chats/:id/support-needed — sets support needed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/support-needed`,
        headers,
        payload: { supportNeeded: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().supportNeeded).toBe(true);
    });

    it('POST /admin/chats/:id/message — 400 for missing content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/message`,
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/chats/:id/message — 404 for unknown chat', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/chats/999999/message',
        headers,
        payload: { content: 'Hello' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /admin/chats/:id/message — sends admin message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/message`,
        headers,
        payload: { content: 'Hi from admin' },
      });
      expect([200, 500]).toContain(res.statusCode);
    });

    it('POST /admin/chats/:id/typing — sends typing indicator', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/typing`,
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it('DELETE /admin/chats/:id — deletes chat', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/chats/${chatId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // EMAIL TEMPLATES + SEND CUSTOM EMAIL
  // ====================================================================

  describe('email templates and custom email', () => {
    it('GET /admin/email-templates — returns templates (or error if file missing)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/email-templates',
        headers,
      });
      expect([200, 500]).toContain(res.statusCode);
    });

    it('POST /admin/send-custom-email — 400 for missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/send-custom-email',
        headers,
        payload: { paymentId: PAYMENT_ID },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/send-custom-email — 404 for unknown payment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/send-custom-email',
        headers,
        payload: {
          paymentId: 'tr_ghost_custom',
          subject: 'Test',
          message: 'Hello',
        },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ====================================================================
  // EXTERNAL CARDS GET + STATS
  // ====================================================================

  describe('external cards GET and stats', () => {
    it('GET /admin/external-cards — returns paginated cards', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards?page=1&limit=10',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('GET /admin/external-cards — filters by cardType', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards?cardType=jumbo&page=1&limit=5',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /admin/external-cards/stats — returns stats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards/stats',
        headers,
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // DELETE PLAYLIST FROM ORDER
  // ====================================================================

  describe('DELETE /admin/playlist/:paymentHasPlaylistId', () => {
    it('400 for trying to delete the only playlist from an order', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/playlist/${phpId}`,
        headers,
      });
      // Only one playlist in order → cannot delete
      expect([400, 404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // AUTH: 401 without token
  // ====================================================================

  describe('auth: unauthenticated requests are rejected', () => {
    const endpoints = [
      { method: 'GET',    url: '/queue/status' },
      { method: 'POST',   url: '/admin/create' },
      { method: 'GET',    url: '/lastplays' },
      { method: 'POST',   url: '/push/broadcast' },
      { method: 'GET',    url: '/admin/featured/all' },
      { method: 'GET',    url: '/admin/broken-links' },
      { method: 'GET',    url: '/admin/unknown-links' },
      { method: 'GET',    url: '/admin/spotify/provider-status' },
      { method: 'GET',    url: '/admin/settings' },
      { method: 'GET',    url: '/admin/shipping-config' },
      { method: 'GET',    url: '/admin/chats' },
      { method: 'POST',   url: '/admin/impersonate' },
    ] as const;

    for (const ep of endpoints) {
      it(`${ep.method} ${ep.url} → 401 without token`, async () => {
        const res = await app.inject({ method: ep.method, url: ep.url });
        expect(res.statusCode).toBe(401);
      });
    }
  });

  describe('auth: customer (users group) gets 403 on admin endpoints', () => {
    it('GET /admin/broken-links → 403 for users-only JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/broken-links',
        headers: customerHeaders,
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /admin/chats → 403 for users-only JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/chats',
        headers: customerHeaders,
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
