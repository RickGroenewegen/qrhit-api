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
import { outbound } from '../helpers/recording-mock';
import Generator from '../../src/generator';

/**
 * Admin corrections processing (suggestion.ts processCorrections) and the
 * promotional playlist moderation flow (accept/decline/edit/locale/resend).
 */
describe('admin corrections and promotional moderation', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let queueSpy: any;

  const PAYMENT_ID = 'tr_corrections_1';
  const USER_HASH = 'corrections-hash';
  const PLAYLIST_ID = 'corrections-playlist';
  let userId: number;
  let playlistDbId: number;
  let phpId: number;
  let trackAId: number;
  let trackBId: number;

  beforeAll(async () => {
    queueSpy = vi
      .spyOn(Generator.prototype as any, 'queueGenerate')
      .mockResolvedValue('job-corrections');
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const admin = await createTestUser({ groups: ['admin'] });
    headers = authHeader(admin.token);

    const user = await prisma().user.create({
      data: {
        userId: 'corrections-user',
        email: 'corrections@test.qrsong.io',
        displayName: 'Corrections User',
        hash: USER_HASH,
      },
    });
    userId = user.id;
    const orderType = await prisma().orderType.create({
      data: { name: 'digital', description: 'Digital', amount: 5, digital: true },
    });
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: PLAYLIST_ID,
        name: 'Corrections Mix',
        slug: 'corrections-mix',
        image: 'img.png',
      },
    });
    playlistDbId = playlist.id;
    const trackA = await prisma().track.create({
      data: {
        trackId: 'corr-track-a',
        name: 'Old Title',
        artist: 'Original Artist',
        year: 1990,
        manuallyChecked: true,
      },
    });
    trackAId = trackA.id;
    const trackB = await prisma().track.create({
      data: {
        trackId: 'corr-track-b',
        name: 'Track B',
        artist: 'Artist B',
        year: 1995,
        manuallyChecked: true,
      },
    });
    trackBId = trackB.id;
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
        fullname: 'Corrections User',
        email: 'corrections@test.qrsong.io',
        totalPrice: 25,
        productPriceWithoutTax: 20,
        shippingPriceWithoutTax: 0,
        productVATPrice: 5,
        shippingVATPrice: 0,
        totalVATPrice: 5,
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
        suggestionsPending: true,
        price: 25,
        priceWithoutVAT: 20,
        priceVAT: 5,
      },
    });
    phpId = php.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('processing corrections', () => {
    it('applies global corrections, clears suggestions and queues regeneration', async () => {
      await prisma().userSuggestion.create({
        data: {
          trackId: trackAId,
          userId,
          playlistId: playlistDbId,
          name: 'New Title',
          artist: 'Original Artist',
          year: 1991,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/correction/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}/true`,
        headers,
        payload: {
          artistOnlyForMe: false,
          titleOnlyForMe: false,
          yearOnlyForMe: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const track = await prisma().track.findUnique({ where: { id: trackAId } });
      expect(track!.name).toBe('New Title');
      expect(track!.year).toBe(1991);
      expect(track!.manuallyCorrected).toBe(true);

      const suggestions = await prisma().userSuggestion.findMany({
        where: { userId },
      });
      expect(suggestions).toHaveLength(0);

      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect(php!.suggestionsPending).toBe(false);
      // digital order: judged state reset so the user can suggest again
      expect(php!.userConfirmedPrinting).toBe(false);

      expect(queueSpy).toHaveBeenCalledWith(
        PAYMENT_ID,
        '',
        '',
        true,
        true,
        false,
        '',
        expect.objectContaining({ type: 'sendDigitalEmail' })
      );
    });

    it('stores playlist-only corrections in TrackExtraInfo', async () => {
      await prisma().userSuggestion.create({
        data: {
          trackId: trackBId,
          userId,
          playlistId: playlistDbId,
          name: 'Track B',
          artist: 'Corrected Artist B',
          year: 1995,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/correction/${PAYMENT_ID}/${USER_HASH}/${PLAYLIST_ID}/false`,
        headers,
        payload: {
          artistOnlyForMe: true,
          titleOnlyForMe: false,
          yearOnlyForMe: false,
        },
      });
      expect(res.statusCode).toBe(200);

      // The global track record stays untouched...
      const track = await prisma().track.findUnique({ where: { id: trackBId } });
      expect(track!.artist).toBe('Artist B');

      // ...while the playlist-scoped override is stored.
      const extra = await prisma().trackExtraInfo.findFirst({
        where: { trackId: trackBId, playlistId: playlistDbId },
      });
      expect(extra).toBeTruthy();
      expect(extra!.artist).toBe('Corrected Artist B');

      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: phpId },
      });
      expect(php!.artistOnlyForMe).toBe(true);
    });
  });

  describe('promotional moderation', () => {
    const PROMO_ID = 'promo-moderation-1';
    let promoUser: any;

    beforeAll(async () => {
      promoUser = await prisma().user.create({
        data: {
          userId: 'promo-user',
          email: 'promo@test.qrsong.io',
          displayName: 'Promo User',
          hash: 'promo-user-hash',
          locale: 'nl',
        },
      });
      const playlist = await prisma().playlist.create({
        data: {
          playlistId: PROMO_ID,
          name: 'Promo Mix',
          slug: 'promo-mix',
          image: 'img.png',
          promotionalActive: true,
          promotionalTitle: 'Beste Feesthits',
          promotionalUserId: promoUser.id,
        },
      });
      const orderType = await prisma().orderType.findFirst({
        where: { name: 'digital' },
      });
      const payment = await prisma().payment.create({
        data: {
          userId: promoUser.id,
          paymentId: 'tr_promo_payment',
          status: 'paid',
          fullname: 'Promo User',
          email: 'promo@test.qrsong.io',
          totalPrice: 25,
          productPriceWithoutTax: 20,
          shippingPriceWithoutTax: 0,
          productVATPrice: 5,
          shippingVATPrice: 0,
          totalVATPrice: 5,
        },
      });
      await prisma().paymentHasPlaylist.create({
        data: {
          paymentId: payment.id,
          playlistId: playlist.id,
          amount: 1,
          numberOfTracks: 10,
          orderTypeId: orderType!.id,
          type: 'digital',
          price: 25,
          priceWithoutVAT: 20,
          priceVAT: 5,
        },
      });
    });

    it('accepts a promotional playlist, renames it and emails a discount code', async () => {
      const before = outbound.calls('Mail', 'sendPromotionalApprovedEmail').length;
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${PROMO_ID}/accept`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const playlist = await prisma().playlist.findUnique({
        where: { playlistId: PROMO_ID },
      });
      expect(playlist!.promotionalAccepted).toBe(true);
      expect(playlist!.name).toBe('Beste Feesthits');
      expect(playlist!.slug).toBe('beste-feesthits');

      const discount = await prisma().discountCode.findFirst({
        where: { promotionalUserId: promoUser.id },
      });
      expect(discount).toBeTruthy();
      expect((discount as any).promotional).toBe(true);

      const after = outbound.calls('Mail', 'sendPromotionalApprovedEmail');
      expect(after.length).toBe(before + 1);
      expect(after[after.length - 1].args[0]).toBe('promo@test.qrsong.io');
    });

    it('resends the approval email', async () => {
      const before = outbound.calls('Mail', 'sendPromotionalApprovedEmail').length;
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${PROMO_ID}/resend-email`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(
        outbound.calls('Mail', 'sendPromotionalApprovedEmail').length
      ).toBe(before + 1);
    });

    it('updates the featured locale', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${PROMO_ID}/locale`,
        headers,
        payload: { featuredLocale: 'nl' },
      });
      expect(res.statusCode).toBe(200);
      const playlist = await prisma().playlist.findUnique({
        where: { playlistId: PROMO_ID },
      });
      expect(playlist!.featuredLocale).toBe('nl');
    });

    it('edits the promotional playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${PROMO_ID}/edit`,
        headers,
        payload: {
          name: 'Feesthits 2026',
          description: 'De allerbeste feesthits',
          slug: 'feesthits-2026',
        },
      });
      expect(res.statusCode).toBe(200);
      const playlist = await prisma().playlist.findUnique({
        where: { playlistId: PROMO_ID },
      });
      expect(playlist!.name).toBe('Feesthits 2026');
      expect(playlist!.slug).toBe('feesthits-2026');
    });

    it('clears the playlist cache via reload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/promotional/${PROMO_ID}/reload`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('declines a pending promotional playlist', async () => {
      await prisma().playlist.create({
        data: {
          playlistId: 'promo-declined-1',
          name: 'Spam Mix',
          slug: 'spam-mix',
          image: 'img.png',
          promotionalActive: true,
          promotionalTitle: 'Spam',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/admin/promotional/promo-declined-1/decline',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const playlist = await prisma().playlist.findUnique({
        where: { playlistId: 'promo-declined-1' },
      });
      expect(playlist!.promotionalDeclined).toBe(true);
      expect(playlist!.promotionalAccepted).toBe(false);
    });

    it('404s accepting an unknown playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/promotional/does-not-exist/accept',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
