import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import { APP_DESIGN_PRICE } from '../../src/config/constants';

// Mollie talks to the real Mollie API: the upgrade route only needs
// createUpgradePayment, so the class is replaced by a recording stub.
const mollieMock = vi.hoisted(() => ({
  createUpgradePayment: vi.fn(),
}));

vi.mock('../../src/mollie', () => ({
  default: class MollieMock {
    createUpgradePayment = mollieMock.createUpgradePayment;
  },
}));

// OpenAI must never be called from tests. The palette helper is stubbed per
// case; the fallback path runs sharp for real on the uploaded image.
const chatgptMock = vi.hoisted(() => ({
  suggestAppPalette: vi.fn(),
}));

vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class ChatGPTMock {
    suggestAppPalette = chatgptMock.suggestAppPalette;
  },
  thumbnailNameFor: (filename: string) =>
    filename.replace(/\.[a-z0-9]+$/i, '') + '_thumb.webp',
}));

// Solid red PNG, built with sharp so the dominant-colour fallback has
// something unambiguous to find.
async function redPngDataUri(): Promise<string> {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const THEME = {
  cssVariables: {
    '--app-background': 'linear-gradient(135deg, #18565e, #0b2c31)',
    '--app-text-color': '#feefe5',
    '--app-scan-button-background': '#f79677',
    '--app-scan-button-border': '#0b2c31',
  },
  showMusicalNotes: false,
  showRecord: true,
  showEqualizer: true,
};

const DESIGN = {
  backgroundType: 'gradient',
  backgroundColor: '#18565e',
  gradientColor: '#0b2c31',
  textColor: '#feefe5',
  accentColor: '#f79677',
  fontId: 'Bebas Neue',
  helpText: 'Scan a card\n\nHave <fun>',
  name: 'Party deck',
};

/**
 * App Designer: theme route fallback, account routes, upgrade payment and
 * the AI palette endpoint (appDesignRoutes.ts, themeRoutes.ts, appDesign.ts).
 */
describe('app design routes', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let stranger: Awaited<ReturnType<typeof createTestUser>>;
  let enabledPhpId: number;
  let lockedPhpId: number;
  let unfinalizedPhpId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    owner = await createTestUser({ groups: ['users'] });
    stranger = await createTestUser({ groups: ['users'] });

    await prisma().taxRate.create({ data: { rate: 21, countryCode: 'NL' } });

    const orderType = await prisma().orderType.create({
      data: {
        name: 'digital',
        type: 'cards',
        description: 'Digital cards',
        amount: 0,
        maxCards: 3000,
      },
    });
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: 'app-design-playlist',
        name: 'App Mix',
        slug: 'app-mix',
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
          fullname: 'App Buyer',
          email: owner.user.email,
          totalPrice: 20,
          productPriceWithoutTax: 16,
          shippingPriceWithoutTax: 0,
          productVATPrice: 4,
          shippingVATPrice: 0,
          totalVATPrice: 4,
          countrycode: 'NL',
          locale: 'nl',
          currency: 'EUR',
        },
      });
    const mkLine = (paymentId: number, appDesignEnabled: boolean) =>
      prisma().paymentHasPlaylist.create({
        data: {
          paymentId,
          playlistId: playlist.id,
          amount: 1,
          numberOfTracks: 10,
          orderTypeId: orderType.id,
          type: 'digital',
          subType: 'none',
          price: 20,
          priceWithoutVAT: 16,
          priceVAT: 4,
          appDesignEnabled,
          appDesignPrice: appDesignEnabled ? APP_DESIGN_PRICE : 0,
        },
      });

    const enabledPayment = await mkPayment('tr_app_enabled', true);
    enabledPhpId = (await mkLine(enabledPayment.id, true)).id;
    const lockedPayment = await mkPayment('tr_app_locked', true);
    lockedPhpId = (await mkLine(lockedPayment.id, false)).id;
    const unfinalized = await mkPayment('tr_app_unfinalized', false);
    unfinalizedPhpId = (await mkLine(unfinalized.id, false)).id;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /api/app-design/:id', () => {
    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/app-design/${enabledPhpId}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("403s another user's line", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/app-design/${enabledPhpId}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('reports an unlocked line without a design yet', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/app-design/${enabledPhpId}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        enabled: true,
        price: APP_DESIGN_PRICE,
        design: null,
        theme: null,
        version: 0,
      });
    });
  });

  describe('PUT /api/app-design/:id', () => {
    it('refuses to save on a locked line', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/app-design/${lockedPhpId}`,
        headers: authHeader(owner.token),
        payload: { design: DESIGN, theme: THEME },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a payload without CSS variables', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/app-design/${enabledPhpId}`,
        headers: authHeader(owner.token),
        payload: { design: DESIGN, theme: { cssVariables: { '--evil': 'url(x)' } } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('stores the design, points the line at the slug and bumps the version', async () => {
      const first = await app.inject({
        method: 'PUT',
        url: `/api/app-design/${enabledPhpId}`,
        headers: authHeader(owner.token),
        payload: {
          design: DESIGN,
          theme: { ...THEME, cssVariables: { ...THEME.cssVariables, '--nope': '#fff' } },
          fontId: 'Bebas Neue',
        },
      });
      expect(first.statusCode).toBe(200);
      const body = first.json();
      expect(body.version).toBe(1);
      expect(body.rejected).toEqual(['--nope']);
      expect(body.theme.id).toBe(`u${enabledPhpId}`);
      expect(body.theme.fonts.url).toContain('Bebas+Neue');
      // Plain text in, escaped paragraphs out.
      expect(body.theme.helpText).toBe('<p>Scan a card</p><p>Have &lt;fun&gt;</p>');

      const php = await prisma().paymentHasPlaylist.findUnique({ where: { id: enabledPhpId } });
      expect(php!.theme).toBe(`u${enabledPhpId}`);
      expect(php!.themeName).toBe('Party deck');

      const second = await app.inject({
        method: 'PUT',
        url: `/api/app-design/${enabledPhpId}`,
        headers: authHeader(owner.token),
        payload: { design: DESIGN, theme: THEME },
      });
      expect(second.json().version).toBe(2);
    });
  });

  describe('GET /theme/:slug', () => {
    it('serves the stored design in the shape the scan app expects', async () => {
      const res = await app.inject({ method: 'GET', url: `/theme/u${enabledPhpId}` });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toMatchObject({
        id: `u${enabledPhpId}`,
        name: 'Party deck',
        version: 2,
        cacheTTL: 86400,
        showMusicalNotes: false,
        showRecord: true,
        cssVariables: { '--app-text-color': '#feefe5' },
        assets: { logo: null, background: null },
      });
      expect(data.cssVariables['--nope']).toBeUndefined();
    });

    it('still serves file-based themes first', async () => {
      const res = await app.inject({ method: 'GET', url: '/theme/acme' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe('acme');
    });

    it('404s unknown and malformed slugs', async () => {
      expect((await app.inject({ method: 'GET', url: '/theme/u999999' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/theme/..%2Fetc' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/theme/u${enabledPhpId}/logo` })).statusCode).toBe(404);
    });
  });

  describe('uploads and assets', () => {
    let background: string;

    it('stores an app background under app-theme and serves it through the theme route', async () => {
      const upload = await app.inject({
        method: 'POST',
        url: '/designer/upload/background',
        payload: { image: await redPngDataUri(), kind: 'app' },
      });
      expect(upload.statusCode).toBe(200);
      const body = upload.json();
      expect(body.success).toBe(true);
      background = body.filename;
      expect(
        fs.existsSync(path.join(process.env['PUBLIC_DIR']!, 'app-theme', background))
      ).toBe(true);

      const save = await app.inject({
        method: 'PUT',
        url: `/api/app-design/${enabledPhpId}`,
        headers: authHeader(owner.token),
        payload: { design: { ...DESIGN, background }, theme: THEME },
      });
      expect(save.json().theme.assets.background).toContain(`/theme/u${enabledPhpId}/background?v=3`);

      const asset = await app.inject({
        method: 'GET',
        url: `/theme/u${enabledPhpId}/background`,
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('image/png');
    });

    it('rejects unknown upload types for the app kind', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/designer/upload/backgroundBack',
        payload: { image: await redPngDataUri(), kind: 'app' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('suggests a palette from OpenAI and validates it', async () => {
      chatgptMock.suggestAppPalette.mockResolvedValueOnce({
        backgroundColor: '#123456',
        textColor: '#ffffff',
        accentColor: 'not-a-color',
        accentTextColor: '#000',
        buttonStyle: 'glass',
        fontId: 'Bebas Neue',
        showMusicalNotes: true,
        mood: 'bold retro',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/ai-theme',
        payload: { background },
      });
      expect(res.statusCode).toBe(200);
      const { palette } = res.json();
      expect(palette.source).toBe('ai');
      expect(palette.backgroundColor).toBe('#123456');
      expect(palette.accentTextColor).toBe('#000000');
      expect(palette.buttonStyle).toBe('glass');
      expect(palette.fontId).toBe('Bebas Neue');
      // The invalid accent falls back to the computed one, still a hex colour.
      expect(palette.accentColor).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('falls back to the dominant colour when the model gives nothing', async () => {
      chatgptMock.suggestAppPalette.mockResolvedValueOnce(null);
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/ai-theme',
        payload: { background },
      });
      expect(res.statusCode).toBe(200);
      const { palette } = res.json();
      expect(palette.source).toBe('fallback');
      // The image is re-encoded as JPEG before sampling, so allow for a
      // little compression drift around pure red.
      const [r, g, b] = [1, 3, 5].map((i) =>
        parseInt(palette.backgroundColor.slice(i, i + 2), 16)
      );
      expect(r).toBeGreaterThan(240);
      expect(g).toBeLessThan(20);
      expect(b).toBeLessThan(20);
      expect(palette.textColor).toBe('#ffffff');
    });

    it('refuses filenames that are not bare upload names', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/ai-theme',
        payload: { background: '../../etc/passwd' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/app-design/upgrade-payment', () => {
    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        payload: { paymentHasPlaylistId: lockedPhpId },
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses an already unlocked line and an unfinalized order', async () => {
      const already = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: enabledPhpId },
      });
      expect(already.statusCode).toBe(400);
      const pending = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        headers: authHeader(owner.token),
        payload: { paymentHasPlaylistId: unfinalizedPhpId },
      });
      expect(pending.statusCode).toBe(400);
    });

    it('stores the design, keeps the slug unpublished and creates a Mollie payment', async () => {
      mollieMock.createUpgradePayment.mockResolvedValueOnce({
        id: 'tr_app_upgrade',
        checkoutUrl: 'https://mollie.test/checkout/app',
        currency: 'EUR',
        amount: APP_DESIGN_PRICE,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        headers: authHeader(owner.token),
        payload: {
          paymentHasPlaylistId: lockedPhpId,
          design: DESIGN,
          theme: THEME,
          locale: 'nl',
          currency: 'EUR',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        paymentUrl: 'https://mollie.test/checkout/app',
      });

      const args = mollieMock.createUpgradePayment.mock.calls.at(-1)![0];
      expect(args.amountEur).toBe(APP_DESIGN_PRICE);
      expect(args.metadata).toMatchObject({
        type: 'app_design_upgrade',
        paymentHasPlaylistId: String(lockedPhpId),
        originalPaymentId: 'tr_app_locked',
      });
      expect(args.redirectUrl).toContain('app_design_enabled=1');

      const row = await prisma().appDesign.findUnique({
        where: { paymentHasPlaylistId: lockedPhpId },
      });
      expect(row?.slug).toBe(`u${lockedPhpId}`);
      const php = await prisma().paymentHasPlaylist.findUnique({ where: { id: lockedPhpId } });
      expect(php!.appDesignEnabled).toBe(false);
      expect(php!.theme).toBeNull();
    });
  });
});
