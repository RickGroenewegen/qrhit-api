import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { outbound } from '../helpers/recording-mock';
import Generator from '../../src/generator';

// Mollie talks to the real Mollie API — fully mocked (same pattern as
// payment.test.ts). The upgrade endpoints use createUpgradePayment.
const mollieMock = vi.hoisted(() => ({
  createUpgradePayment: vi.fn(),
}));

vi.mock('../../src/mollie', () => ({
  default: class MollieMock {
    createUpgradePayment = mollieMock.createUpgradePayment;
  },
}));

// 1x1 transparent PNG data URI — sharp processes it for real.
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Public designer + upgrade routes on publicRoutes.ts: designer uploads,
 * card design get/update, apply-design, regenerate, reload rate limiting,
 * box/tracks upgrade endpoints, and assorted small public endpoints.
 */
describe('public designer and upgrade routes', () => {
  let app: FastifyInstance;

  const HASH = 'designer-user-hash';
  const PHYS_PAYMENT = 'tr_designer_phys';
  const PHYS_PLAYLIST = 'designer-playlist-phys';
  const DIG_PAYMENT = 'tr_designer_dig';
  const DIG_PLAYLIST = 'designer-playlist-dig';

  let userId: number;
  let physPhpId: number;
  let digPhpId: number;

  async function seedOrder(opts: {
    paymentId: string;
    playlistId: string;
    type: 'physical' | 'digital';
    orderTypeId: number;
    trackIds: number[];
  }) {
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: opts.playlistId,
        name: `Playlist ${opts.playlistId}`,
        image: 'img.png',
        numberOfTracks: opts.trackIds.length,
      },
    });
    await prisma().playlistHasTrack.createMany({
      data: opts.trackIds.map((trackId, i) => ({
        playlistId: playlist.id,
        trackId,
        order: i + 1,
      })),
    });
    const payment = await prisma().payment.create({
      data: {
        userId,
        paymentId: opts.paymentId,
        status: 'paid',
        finalized: true,
        fullname: 'Designer User',
        email: 'designer@test.qrsong.io',
        totalPrice: 50,
        productPriceWithoutTax: 40,
        shippingPriceWithoutTax: 0,
        productVATPrice: 10,
        shippingVATPrice: 0,
        totalVATPrice: 10,
        countrycode: 'NL',
        locale: 'nl',
        currency: 'EUR',
      },
    });
    const php = await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: payment.id,
        playlistId: playlist.id,
        amount: 1,
        numberOfTracks: opts.trackIds.length,
        orderTypeId: opts.orderTypeId,
        type: opts.type,
        subType: 'none',
        price: 50,
        priceWithoutVAT: 40,
        priceVAT: 10,
      },
    });
    return { playlist, payment, php };
  }

  beforeAll(async () => {
    // Generator queues PDF jobs / finalizes orders — never run for real.
    vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue(
      'job-test'
    );
    vi.spyOn(Generator.prototype as any, 'finalizeOrder').mockResolvedValue(
      undefined
    );

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();

    const user = await prisma().user.create({
      data: {
        userId: 'designer-user',
        email: 'designer@test.qrsong.io',
        displayName: 'Designer User',
        hash: HASH,
        verified: true,
      },
    });
    userId = user.id;

    await prisma().taxRate.create({ data: { rate: 21, countryCode: 'NL' } });

    const physOrderType = await prisma().orderType.create({
      data: {
        name: 'physical',
        description: 'Physical cards',
        amount: 25,
        digital: false,
      },
    });
    const digOrderType = await prisma().orderType.create({
      data: {
        name: 'digital',
        description: 'Digital cards',
        amount: 5,
        digital: true,
      },
    });

    const trackRows = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        prisma().track.create({
          data: {
            trackId: `designer-track-${i}`,
            name: `Design Song ${i}`,
            artist: `Design Artist ${i}`,
            year: 1980 + i,
            manuallyChecked: true,
          },
        })
      )
    );
    const trackIds = trackRows.map((t) => t.id);

    const phys = await seedOrder({
      paymentId: PHYS_PAYMENT,
      playlistId: PHYS_PLAYLIST,
      type: 'physical',
      orderTypeId: physOrderType.id,
      trackIds: trackIds.slice(0, 2),
    });
    physPhpId = phys.php.id;

    const dig = await seedOrder({
      paymentId: DIG_PAYMENT,
      playlistId: DIG_PLAYLIST,
      type: 'digital',
      orderTypeId: digOrderType.id,
      trackIds: trackIds.slice(2, 4),
    });
    digPhpId = dig.php.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('designer uploads', () => {
    it('rejects an upload without an image', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/background',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    });

    it('uploads a background image and writes the processed PNG', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/background',
        payload: { image: PNG_1X1, qrBackgroundType: 'square' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.filename).toMatch(/\.png$/);
      expect(
        fs.existsSync(
          path.join(process.env['PUBLIC_DIR']!, 'background', body.filename)
        )
      ).toBe(true);
    });

    it('uploads a back-side background image', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/backgroundBack',
        payload: { image: PNG_1X1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().filename).toMatch(/\.png$/);
    });

    it('uploads a logo image (box designer kind)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/logo',
        payload: { image: PNG_1X1, kind: 'box' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(
        fs.existsSync(
          path.join(process.env['PUBLIC_DIR']!, 'logo', body.filename)
        )
      ).toBe(true);
    });

    it('fails gracefully on a malformed data URI', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/background',
        payload: { image: 'data:image/png;base64,' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });

    it('returns success false for an unknown upload type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/watermark',
        payload: { image: PNG_1X1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });
  });

  describe('card design', () => {
    it('returns 404 for an unknown payment/hash combination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/usersuggestions/${PHYS_PAYMENT}/wrong-hash/${PHYS_PLAYLIST}/design`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().success).toBe(false);
    });

    it('returns the card design with the first track id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/design`,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.playlistName).toBe(`Playlist ${PHYS_PLAYLIST}`);
      expect(data.type).toBe('physical');
      // Tracks are ordered by name; "Design Song 0" comes first.
      expect(data.firstTrackId).toBe('designer-track-0');
    });

    it('updates the card design for the owner', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/design`,
        payload: {
          type: 'physical',
          subType: 'none',
          qrColor: '#112233',
          qrBackgroundColor: '#ffffff',
          selectedFont: 'Roboto',
          doubleSided: true,
          emoji: '🎵',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: physPhpId },
      });
      expect(php!.qrColor).toBe('#112233');
      expect(php!.selectedFont).toBe('Roboto');
      expect(php!.doubleSided).toBe(true);
      expect(php!.emoji).toBe('🎵');
    });

    it('refuses a design update with a wrong hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/wrong-hash/${PHYS_PLAYLIST}/design`,
        payload: { qrColor: '#000000' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('apply-design / regenerate / reload', () => {
    it('applies design changes on a physical order (queues regeneration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${DIG_PAYMENT}/${HASH}/${DIG_PLAYLIST}/apply-design`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(
        (Generator.prototype as any).queueGenerate
      ).toHaveBeenCalled();
    });

    it('applies design changes on a physical order and locks printing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/apply-design`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: physPhpId },
      });
      expect(php!.userConfirmedPrinting).toBe(true);
      expect(php!.eligableForPrinter).toBe(false);
      const payment = await prisma().payment.findUnique({
        where: { paymentId: PHYS_PAYMENT },
      });
      expect(payment!.userAgreedToPrinting).toBe(true);
      expect(payment!.userAgreedToPrintingAt).toBeTruthy();

      // Reset the printing lock — later upgrade tests need it off.
      await prisma().paymentHasPlaylist.update({
        where: { id: physPhpId },
        data: { userConfirmedPrinting: false },
      });
    });

    it('refuses apply-design with a wrong hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/wrong-hash/${PHYS_PLAYLIST}/apply-design`,
      });
      expect(res.json().success).toBe(false);
    });

    it('regenerates and mails a digital order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${DIG_PAYMENT}/${HASH}/regenerate`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(
        (Generator.prototype as any).finalizeOrder
      ).toHaveBeenCalledWith(DIG_PAYMENT, expect.anything(), true);
    });

    it('refuses regenerate with a wrong hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${DIG_PAYMENT}/wrong-hash/regenerate`,
      });
      expect(res.json()).toMatchObject({
        success: false,
        error: 'Unauthorized',
      });
    });

    it('refuses a reload with a wrong hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/wrong-hash/${PHYS_PLAYLIST}/reload`,
      });
      expect(res.json()).toMatchObject({
        success: false,
        error: 'Unauthorized',
      });
    });

    it('rate-limits playlist reloads to one per minute', async () => {
      await prisma().paymentHasPlaylist.update({
        where: { id: physPhpId },
        data: { lastReloadAt: new Date() },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/reload`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('rate_limit_exceeded');
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(body.lastReloadAt).toBeTruthy();
      await prisma().paymentHasPlaylist.update({
        where: { id: physPhpId },
        data: { lastReloadAt: null },
      });
    });
  });

  describe('box upgrade', () => {
    it('refuses box design access with a wrong hash', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/usersuggestions/${PHYS_PAYMENT}/wrong-hash/${PHYS_PLAYLIST}/box/design`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns the (empty) saved box design', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/box/design`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.design).toBeTypeOf('object');
    });

    it('refuses to save a box design before the box is enabled', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/box/design`,
        payload: { boxDesign: { boxBackFontColor: '#fff' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Box is not yet enabled for this order');
    });

    it('refuses box pricing for digital orders', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${DIG_PAYMENT}/${HASH}/${DIG_PLAYLIST}/box/calculate-price`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Gift box is only available for physical orders'
      );
    });

    it('calculates the box price for a physical order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/box/calculate-price`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      // 2 tracks → 1 box per set, amount 1 → 1 box at the base price.
      expect(body.boxQuantity).toBe(1);
      expect(body.totalBoxes).toBe(1);
      expect(body.boxUnitPriceEur).toBe(6.99);
      expect(body.totalEur).toBe(6.99);
      expect(body.taxRate).toBe(21);
      // VAT-inclusive price: net + VAT must reconstruct the total.
      expect(body.boxSubtotalEur + body.vatEur).toBeCloseTo(body.totalEur, 2);
    });

    it('creates a Mollie box upgrade payment and persists the quantity', async () => {
      mollieMock.createUpgradePayment.mockResolvedValueOnce({
        checkoutUrl: 'https://mollie.test/checkout/box',
      });
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/box/upgrade-payment`,
        payload: { locale: 'nl', currency: 'EUR' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        paymentUrl: 'https://mollie.test/checkout/box',
      });

      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: physPhpId },
      });
      expect(php!.boxQuantity).toBe(1);

      const args = mollieMock.createUpgradePayment.mock.calls.at(-1)![0];
      expect(args.amountEur).toBe(6.99);
      expect(args.metadata).toMatchObject({
        type: 'box_upgrade',
        paymentHasPlaylistId: String(physPhpId),
        originalPaymentId: PHYS_PAYMENT,
        quantity: '1',
        source: 'usersuggestions',
      });
      expect(args.redirectUrl).toContain('upgrade=box_success');
    });

    it('saves the box design once the box is enabled', async () => {
      await prisma().paymentHasPlaylist.update({
        where: { id: physPhpId },
        data: { boxEnabled: true },
      });

      const missing = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/box/design`,
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toBe('Missing boxDesign');

      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/box/design`,
        payload: { boxDesign: { boxBackFontColor: '#123456', boxBackText: 'Enjoy!' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const php = await prisma().paymentHasPlaylist.findUnique({
        where: { id: physPhpId },
      });
      expect(php!.boxBackFontColor).toBe('#123456');
      expect(php!.boxBackText).toBe('Enjoy!');
    });
  });

  describe('tracks upgrade', () => {
    beforeAll(() => {
      // PrintEnBind is globally mocked; the price calculation needs its raw
      // per-card cost. 0.4 EUR raw → 0.5 EUR marked up (× 1.25).
      outbound.respondWith('PrintEnBind', 'getRawCardCostEur', () => 0.4);
    });

    it('rejects an invalid extraTracks tier', async () => {
      for (const url of [
        `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/tracks/calculate-price`,
        `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/tracks/upgrade-payment`,
      ]) {
        const res = await app.inject({
          method: 'POST',
          url,
          payload: { extraTracks: 7 },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('Invalid extraTracks tier');
      }
    });

    it('refuses track pricing for digital orders', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${DIG_PAYMENT}/${HASH}/${DIG_PLAYLIST}/tracks/calculate-price`,
        payload: { extraTracks: 10 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Track upgrade is only available for physical orders'
      );
    });

    it('calculates the extra-tracks price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/tracks/calculate-price`,
        payload: { extraTracks: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.extraTracks).toBe(10);
      expect(body.perCardEur).toBe(0.5);
      expect(body.extraTracksCostEur).toBe(5);
      expect(body.currentNumberOfTracks).toBe(2);
      expect(body.taxRate).toBe(21);
      // total = (tracks cost + handling fee) * 1.21 — never zero or NaN.
      expect(body.totalEur).toBeGreaterThan(5);
      expect(Number.isFinite(body.totalEur)).toBe(true);
    });

    it('creates a Mollie tracks upgrade payment with upgrade metadata', async () => {
      mollieMock.createUpgradePayment.mockResolvedValueOnce({
        checkoutUrl: 'https://mollie.test/checkout/tracks',
      });
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/tracks/upgrade-payment`,
        payload: { extraTracks: 10, locale: 'nl' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        paymentUrl: 'https://mollie.test/checkout/tracks',
      });
      const args = mollieMock.createUpgradePayment.mock.calls.at(-1)![0];
      expect(args.metadata).toMatchObject({
        type: 'tracks_upgrade',
        extraTracks: '10',
        previousNumberOfTracks: '2',
        originalPaymentId: PHYS_PAYMENT,
        source: 'usersuggestions',
      });
      expect(args.redirectUrl).toContain('upgrade=tracks_success');
    });

    it('refuses adding tracks after the order is confirmed for printing', async () => {
      await prisma().paymentHasPlaylist.update({
        where: { id: physPhpId },
        data: { userConfirmedPrinting: true },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/usersuggestions/${PHYS_PAYMENT}/${HASH}/${PHYS_PLAYLIST}/tracks/upgrade-payment`,
        payload: { extraTracks: 10 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Cannot add tracks after order has been confirmed for printing'
      );
      await prisma().paymentHasPlaylist.update({
        where: { id: physPhpId },
        data: { userConfirmedPrinting: false },
      });
    });
  });

  describe('small public endpoints', () => {
    it('serves fonts and backgrounds with cache headers', async () => {
      const fonts = await app.inject({ method: 'GET', url: '/fonts' });
      expect(fonts.statusCode).toBe(200);
      expect(fonts.headers['cache-control']).toBe('public, max-age=86400');
      expect(Array.isArray(fonts.json().data)).toBe(true);

      const backgrounds = await app.inject({
        method: 'GET',
        url: '/backgrounds',
      });
      expect(backgrounds.statusCode).toBe(200);
      expect(Array.isArray(backgrounds.json().data)).toBe(true);
    });

    it('serves the apple-app-site-association file', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/apple-app-site-association',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body)).toHaveProperty('applinks');
    });

    it('answers the /test diagnostics endpoint', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, version: '1.0.0' });
    });

    it('registers a push token (mocked Push) and validates input', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/push/register',
        payload: { token: 'tok-only' },
      });
      expect(bad.statusCode).toBe(400);

      const before = outbound.calls('Push', 'addToken').length;
      const res = await app.inject({
        method: 'POST',
        url: '/push/register',
        payload: { token: 'tok-abc', type: 'ios' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const calls = outbound.calls('Push', 'addToken');
      expect(calls.length).toBe(before + 1);
      expect(calls.at(-1)!.args).toEqual(['tok-abc', 'ios']);
    });

    it('unsubscribes a valid hash (mocked Mail)', async () => {
      outbound.respondWith('Mail', 'unsubscribe', (hash: string) =>
        Promise.resolve(hash === 'valid-hash')
      );
      const ok = await app.inject({
        method: 'GET',
        url: '/unsubscribe/valid-hash',
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().success).toBe(true);
    });

    it('triggers contact upload (mocked Mail)', async () => {
      const res = await app.inject({ method: 'GET', url: '/upload_contacts' });
      expect(res.statusCode).toBe(200);
      expect(outbound.calls('Mail', 'uploadContacts').length).toBeGreaterThan(0);
    });

    it('processes unsent review emails (none pending)', async () => {
      const res = await app.inject({ method: 'GET', url: '/unsent_reviews' });
      expect(res.statusCode).toBe(200);
    });

    it('accepts chunk-error beacons and ignores bot user agents', async () => {
      const pushoverBefore = outbound.calls(
        'PushoverClient',
        'sendMessage'
      ).length;

      // Bot reports are dropped before the alert counter.
      const bot = await app.inject({
        method: 'POST',
        url: '/chunk-error',
        payload: { message: 'chunk failed', url: 'https://qrsong.io/x' },
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      });
      expect(bot.statusCode).toBe(200);
      expect(
        outbound.calls('PushoverClient', 'sendMessage').length
      ).toBe(pushoverBefore);

      // A real browser report is accepted (alerting is throttled via Redis,
      // so we only assert the response contract here).
      const real = await app.inject({
        method: 'POST',
        url: '/chunk-error',
        payload: { message: 'chunk failed', url: 'https://qrsong.io/x' },
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
        },
      });
      expect(real.statusCode).toBe(200);
      expect(real.json().success).toBe(true);
    });
  });
});
