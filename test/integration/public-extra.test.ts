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
import Generator from '../../src/generator';

/**
 * Public order-servicing routes: user suggestions (corrections) flow,
 * shipping info, reviews, promotional playlist setup and broken-link logging.
 */
describe('public order-servicing routes', () => {
  let app: FastifyInstance;

  const PAYMENT_ID = 'tr_public_1';
  const USER_HASH = 'public-user-hash';
  const PLAYLIST_ID = 'public-playlist-1';
  let userId: number;
  let playlistDbId: number;
  let phpId: number;
  let trackAId: number;
  let trackBId: number;
  let strangerTrackId: number;

  beforeAll(async () => {
    // PDF regeneration is queued in some approval paths — never run it here.
    vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue(
      'job-test'
    );

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    const user = await prisma().user.create({
      data: {
        userId: 'public-user',
        email: 'public@test.qrsong.io',
        displayName: 'Public User',
        hash: USER_HASH,
        verified: true,
      },
    });
    userId = user.id;

    const orderType = await prisma().orderType.create({
      data: { name: 'digital', description: 'Digital', amount: 5, digital: true },
    });

    const playlist = await prisma().playlist.create({
      data: {
        playlistId: PLAYLIST_ID,
        name: 'Public Mix',
        slug: 'public-mix',
        image: 'img.png',
      },
    });
    playlistDbId = playlist.id;

    const trackA = await prisma().track.create({
      data: {
        trackId: 'public-track-a',
        name: 'Alpha',
        artist: 'The Alphas',
        year: 1991,
        manuallyChecked: true,
      },
    });
    trackAId = trackA.id;
    const trackB = await prisma().track.create({
      data: {
        trackId: 'public-track-b',
        name: 'Beta',
        artist: 'The Betas',
        year: 1992,
        manuallyChecked: true,
      },
    });
    trackBId = trackB.id;
    const stranger = await prisma().track.create({
      data: {
        trackId: 'stranger-track',
        name: 'Stranger',
        artist: 'Nobody',
        manuallyChecked: true,
      },
    });
    strangerTrackId = stranger.id;

    await prisma().playlistHasTrack.createMany({
      data: [
        { playlistId: playlistDbId, trackId: trackAId },
        { playlistId: playlistDbId, trackId: trackBId },
      ],
    });

    const payment = await prisma().payment.create({
      data: {
        userId,
        paymentId: PAYMENT_ID,
        status: 'paid',
        fullname: 'Public User',
        email: 'public@test.qrsong.io',
        totalPrice: 30,
        productPriceWithoutTax: 24,
        shippingPriceWithoutTax: 0,
        productVATPrice: 6,
        shippingVATPrice: 0,
        totalVATPrice: 6,
        countrycode: 'NL',
        locale: 'nl',
      },
    });
    const php = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: payment.id,
        playlistId: playlistDbId,
        amount: 1,
        numberOfTracks: 2,
        orderTypeId: orderType.id,
        type: 'digital',
        price: 30,
        priceWithoutVAT: 24,
        priceVAT: 6,
      },
    });
    phpId = php.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('user suggestions (corrections)', () => {
    it('lists the playlist tracks with metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.suggestions).toHaveLength(2);
      const alpha = data.suggestions.find((t: any) => t.name === 'Alpha');
      expect(alpha.artist).toBe('The Alphas');
      expect(alpha.hasSuggestion).toBe('false');
      expect(data.metadata.paymentHasPlaylistId).toBe(phpId);
      expect(data.metadata.playlistType).toBe('digital');
    });

    it('rejects a suggestion with missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
        payload: { trackId: trackAId, name: 'Alpha II' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('saves a suggestion for an owned track', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
        payload: {
          trackId: trackAId,
          name: 'Alpha (Remastered)',
          artist: 'The Alphas',
          year: 1990,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const row = await prisma().userSuggestion.findFirst({
        where: { trackId: trackAId, userId },
      });
      expect(row!.name).toBe('Alpha (Remastered)');
      expect(row!.year).toBe(1990);
    });

    it('updates the existing suggestion on resubmit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
        payload: {
          trackId: trackAId,
          name: 'Alpha (Final)',
          artist: 'The Alphas',
          year: 1989,
        },
      });
      expect(res.json().success).toBe(true);
      const rows = await prisma().userSuggestion.findMany({
        where: { trackId: trackAId, userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Alpha (Final)');
    });

    it('marks the track as having a suggestion in the list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
      });
      const alpha = res
        .json()
        .data.suggestions.find((t: any) => t.suggestedName === 'Alpha (Final)');
      expect(alpha).toBeTruthy();
      expect(alpha.hasSuggestion).toBe('true');
    });

    it('refuses a suggestion with a wrong user hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/wrong-hash/${PLAYLIST_ID}`,
        payload: {
          trackId: trackAId,
          name: 'Hacked',
          artist: 'Hacker',
          year: 2000,
        },
      });
      expect(res.json().success).toBe(false);
    });

    it('refuses a suggestion for a track outside the playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
        payload: {
          trackId: strangerTrackId,
          name: 'Stranger',
          artist: 'Nobody',
          year: 2000,
        },
      });
      expect(res.json().success).toBe(false);
    });

    it('submits pending suggestions and flags the order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}/submit`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect(php!.suggestionsPending).toBe(true);
      expect(php!.userConfirmedPrinting).toBe(true);
    });

    it('refuses a submit with a wrong hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/wrong-hash/${PLAYLIST_ID}/submit`,
      });
      expect(res.json().success).toBe(false);
    });

    it('extends the printer deadline by 24 hours', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}/extend`,
      });
      expect(res.json().success).toBe(true);
      const payment = await prisma().payment.findUnique({
        where: { paymentId: PAYMENT_ID },
      });
      expect(payment!.canBeSentToPrinterAt!.getTime()).toBeGreaterThan(
        Date.now() + 23 * 60 * 60 * 1000
      );
    });

    it('deletes a suggestion', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/usersuggestions/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}/${trackAId}`,
      });
      expect(res.json().success).toBe(true);
      const row = await prisma().userSuggestion.findFirst({
        where: { trackId: trackAId, userId },
      });
      expect(row).toBeNull();
    });

    it('refuses deleting with a wrong hash', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/usersuggestions/${PAYMENT_ID}/wrong-hash/${PLAYLIST_ID}/${trackAId}`,
      });
      expect(res.json().success).toBe(false);
    });
  });

  describe('shipping info', () => {
    beforeAll(async () => {
      await prisma().shippingCostNew.createMany({
        data: [
          { country: 'NL', size: 1, cost: 3.99 },
          { country: 'NL', size: 2, cost: 4.99 },
          { country: 'DE', size: 1, cost: 5.5 },
          { country: 'ES', size: 1, cost: 6.5 },
        ],
      });
      // One delivered order so NL has real delivery stats.
      await prisma().payment.create({
        data: {
          userId,
          paymentId: 'tr_shipped_1',
          status: 'paid',
          fullname: 'Shipped Order',
          email: 'public@test.qrsong.io',
          totalPrice: 30,
          productPriceWithoutTax: 24,
          shippingPriceWithoutTax: 0,
          productVATPrice: 6,
          shippingVATPrice: 0,
          totalVATPrice: 6,
          countrycode: 'NL',
          printApiStatus: 'Delivered',
          shippingStartDateTime: new Date(Date.now() - 3 * 86400000),
          shippingDeliveryDateTime: new Date(Date.now() - 1 * 86400000),
        },
      });
    });

    it('returns per-country shipping info with adjusted costs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/shipping/info-by-country',
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      // No settings row seeded -> default production days.
      expect(data.productionDays).toBe(3);

      const nl = data.countries.find((c: any) => c.countryCode === 'NL');
      expect(nl).toBeTruthy();
      // NL costs are pinned to 2.99 regardless of the stored cost.
      expect(nl.shippingCosts.every((c: any) => c.cost === 2.99)).toBe(true);

      const de = data.countries.find((c: any) => c.countryCode === 'DE');
      // Other countries get 1 deducted from the stored cost.
      expect(de.shippingCosts[0].cost).toBe(4.5);

      const es = data.countries.find((c: any) => c.countryCode === 'ES');
      // ES is pinned to 3.90.
      expect(es.shippingCosts[0].cost).toBe(3.9);

      // NL is sorted first (priority country).
      expect(data.countries[0].countryCode).toBe('NL');
    });

    it('returns average delivery times', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tracking/average-delivery-times',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const list = body.data ?? body;
      const nl = (Array.isArray(list) ? list : []).find(
        (c: any) => c.countryCode === 'NL'
      );
      expect(nl).toBeTruthy();
      expect(nl.orderCount).toBeGreaterThanOrEqual(1);
      expect(nl.minDays).toBeLessThanOrEqual(nl.maxDays);
    });
  });

  describe('reviews', () => {
    beforeAll(async () => {
      const localeFields = (text: string) =>
        Object.fromEntries(
          ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'jp', 'cn'].flatMap(
            (l) => [
              [`title_${l}`, `Great (${l})`],
              [`message_${l}`, `${text} (${l})`],
            ]
          )
        );
      await prisma().trustPilot.create({
        data: {
          name: 'Happy Customer',
          country: 'NL',
          rating: 5,
          image: 'avatar.png',
          landingPage: true,
          ...localeFields('Loved the cards'),
        } as any,
      });
      await prisma().trustPilot.create({
        data: {
          name: 'Hidden Review',
          country: 'NL',
          rating: 1,
          image: 'avatar.png',
          hide: true,
          ...localeFields('Should not appear'),
        } as any,
      });
    });

    it('returns visible reviews in the requested locale', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reviews/nl/10/false',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].author).toBe('Happy Customer');
      expect(body.reviews[0].title).toBe('Great (nl)');
      expect(body.reviews[0].stars).toBe(5);
    });

    it('filters on landing-page reviews', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reviews/en/5/true',
      });
      expect(res.json().reviews).toHaveLength(1);
    });
  });

  describe('promotional playlist setup', () => {
    it('rejects an unknown payment/hash combination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/promotional/${PAYMENT_ID}/wrong-hash/${PLAYLIST_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns the promotional setup for the owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/promotional/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.playlistName).toBe('Public Mix');
      // Before the first submission the checkbox defaults to active=true.
      expect(data.active).toBe(true);
      expect(data.hasSubmitted).toBe(false);
    });

    it('checks slug availability', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/promotional/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}/check-slug`,
        payload: { title: 'My Party Mix' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.available).toBe(true);
      expect(body.slug).toBe('my-party-mix');
    });

    it('requires a title when saving', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/promotional/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
        payload: { description: 'No title' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('saves the promotional setup', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/promotional/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}`,
        payload: {
          title: 'My Party Mix',
          description: 'The best party songs',
          active: true,
          locale: 'nl',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const playlist = await prisma().playlist.findUnique({
        where: { playlistId: PLAYLIST_ID },
      });
      expect(playlist!.promotionalTitle).toBe('My Party Mix');
      expect(playlist!.promotionalActive).toBe(true);
      expect(playlist!.promotionalUserId).toBe(userId);
      expect(playlist!.slug).toBe('my-party-mix');
    });
  });

  describe('misc public endpoints', () => {
    it('rejects an invalid unsubscribe hash', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/unsubscribe/not-a-real-hash',
      });
      expect(res.statusCode).toBe(400);
    });

    it('validates the broken-link payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/broken-links',
        payload: { url: 'https://x.test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid broken-link type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/broken-links',
        payload: { url: 'https://x.test', type: 'weird', errorType: 'nope' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('logs a broken link', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/broken-links',
        payload: {
          url: 'https://open.spotify.com/playlist/gone',
          type: 'invalid',
          errorType: 'not_found',
          serviceType: 'spotify',
        },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().brokenLink.findFirst({
        where: { url: 'https://open.spotify.com/playlist/gone' },
      });
      expect(row).toBeTruthy();
      expect(row!.errorType).toBe('not_found');
    });
  });
});
