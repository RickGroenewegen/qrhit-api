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
import AppDesign from '../../src/appDesign';
import AppTheme from '../../src/apptheme';

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
 * App Designer as an account upgrade: designs saved before paying, theme
 * files under PUBLIC_DIR/customer-themes, the versioned slug a scan gets,
 * default vs override vs admin precedence, the purchase ledger, uploads and
 * the AI palette (appDesignRoutes.ts, themeRoutes.ts, appDesign.ts,
 * apptheme.ts).
 */
describe('app design (account upgrade)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let stranger: Awaited<ReturnType<typeof createTestUser>>;
  let firstPhpId: number;
  let secondPhpId: number;
  let defaultSlug: string;
  let background: string;
  const appTheme = () => AppTheme.getInstance();

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
    const mkPlaylist = (playlistId: string, name: string) =>
      prisma().playlist.create({
        data: { playlistId, name, slug: playlistId, image: 'img.png' },
      });
    const mkPayment = (paymentId: string) =>
      prisma().payment.create({
        data: {
          userId: owner.user.id,
          paymentId,
          status: 'paid',
          finalized: true,
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
    const mkLine = (paymentId: number, playlistId: number) =>
      prisma().paymentHasPlaylist.create({
        data: {
          paymentId,
          playlistId,
          amount: 1,
          numberOfTracks: 10,
          orderTypeId: orderType.id,
          type: 'digital',
          subType: 'none',
          price: 20,
          priceWithoutVAT: 16,
          priceVAT: 4,
        },
      });

    const party = await mkPlaylist('app-design-party', 'Party Mix');
    const wedding = await mkPlaylist('app-design-wedding', 'Wedding Mix');
    firstPhpId = (await mkLine((await mkPayment('tr_app_one')).id, party.id)).id;
    secondPhpId = (await mkLine((await mkPayment('tr_app_two')).id, wedding.id)).id;
    await appTheme().reload();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('before paying', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/app-design' });
      expect(res.statusCode).toBe(401);
    });

    it('lists the paid playlists, the price and no entitlement', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/app-design',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        success: true,
        entitled: false,
        price: APP_DESIGN_PRICE,
        defaultDesign: null,
      });
      expect(body.playlists.map((p: any) => p.paymentHasPlaylistId).sort()).toEqual(
        [firstPhpId, secondPhpId].sort()
      );
      expect(body.playlists.every((p: any) => p.mode === 'default')).toBe(true);
    });

    it('rejects a payload without CSS variables', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/app-design/default',
        headers: authHeader(owner.token),
        payload: { design: DESIGN, theme: { cssVariables: { '--evil': 'url(x)' } } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('saves the default design and publishes a theme file, but no scan gets it', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/app-design/default',
        headers: authHeader(owner.token),
        payload: {
          design: DESIGN,
          theme: { ...THEME, cssVariables: { ...THEME.cssVariables, '--nope': '#fff' } },
          fontId: 'Bebas Neue',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, version: 1, rejected: ['--nope'] });

      const row = await prisma().appDesign.findUnique({ where: { scopeKey: `u${owner.user.id}` } });
      expect(row?.slug).toMatch(/^c[a-z0-9]{10}$/);
      defaultSlug = row!.slug;
      const file = path.join(
        process.env['PUBLIC_DIR']!,
        'customer-themes',
        defaultSlug,
        `${defaultSlug}.json`
      );
      expect(fs.existsSync(file)).toBe(true);

      // Not bought yet: the scan map stays empty for both playlists.
      expect(appTheme().getTheme(firstPhpId)?.s).toBe('');
      expect(appTheme().getTheme(secondPhpId)?.s).toBe('');
    });
  });

  describe('GET /theme/:slug', () => {
    it('serves a customer theme under its versioned slug, marked as customer', async () => {
      const res = await app.inject({ method: 'GET', url: `/theme/${defaultSlug}-1` });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toMatchObject({
        id: `${defaultSlug}-1`,
        source: 'customer',
        name: 'Party deck',
        version: 1,
        cacheTTL: 86400,
        showMusicalNotes: false,
        showRecord: true,
        cssVariables: { '--app-text-color': '#feefe5' },
        assets: { logo: null, background: null },
      });
      expect(data.cssVariables['--nope']).toBeUndefined();
      expect(data.fonts.url).toContain('Bebas+Neue');
      // Plain text in, escaped paragraphs out.
      expect(data.helpText).toBe('<p>Scan a card</p><p>Have &lt;fun&gt;</p>');
    });

    it('answers an outdated version with the current file under the asked id', async () => {
      const res = await app.inject({ method: 'GET', url: `/theme/${defaultSlug}-99` });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: `${defaultSlug}-99`, version: 1 });
    });

    it('serves hand-made themes first, marked as business', async () => {
      const res = await app.inject({ method: 'GET', url: '/theme/acme' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: 'acme', source: 'business' });
    });

    it('404s unknown and malformed slugs', async () => {
      expect((await app.inject({ method: 'GET', url: '/theme/czzzzzzzzzz-1' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/theme/..%2Fetc' })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: `/theme/${defaultSlug}-1/logo` })).statusCode
      ).toBe(404);
    });

    it('keeps customer slugs out of the public debug list', async () => {
      const res = await app.inject({ method: 'GET', url: '/theme/debug/all' });
      const slugs = res.json().themes.map((t: any) => t.slug);
      expect(slugs.some((s: string) => s.startsWith(defaultSlug))).toBe(false);
    });
  });

  describe('uploads and assets', () => {
    it('requires a login to upload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/upload/background',
        payload: { image: await redPngDataUri() },
      });
      expect(res.statusCode).toBe(401);
    });

    it('stores an upload and copies it into the theme on save', async () => {
      const upload = await app.inject({
        method: 'POST',
        url: '/api/app-design/upload/background',
        headers: authHeader(owner.token),
        payload: { image: await redPngDataUri() },
      });
      expect(upload.statusCode).toBe(200);
      background = upload.json().filename;
      expect(
        fs.existsSync(path.join(process.env['PUBLIC_DIR']!, 'app-theme', background))
      ).toBe(true);

      const save = await app.inject({
        method: 'PUT',
        url: '/api/app-design/default',
        headers: authHeader(owner.token),
        payload: { design: { ...DESIGN, background }, theme: THEME },
      });
      expect(save.json().version).toBe(2);

      const theme = await app.inject({ method: 'GET', url: `/theme/${defaultSlug}-2` });
      expect(theme.json().data.assets.background).toContain(
        `/theme/${defaultSlug}-2/background?v=2`
      );
      const asset = await app.inject({ method: 'GET', url: `/theme/${defaultSlug}-2/background` });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('image/png');
    });

    it('rejects unknown upload types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/upload/backgroundBack',
        headers: authHeader(owner.token),
        payload: { image: await redPngDataUri() },
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
        headers: authHeader(owner.token),
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
        headers: authHeader(owner.token),
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

    it('requires a login for the AI palette and refuses non-upload filenames', async () => {
      const anonymous = await app.inject({
        method: 'POST',
        url: '/api/app-design/ai-theme',
        payload: { background },
      });
      expect(anonymous.statusCode).toBe(401);
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/ai-theme',
        headers: authHeader(owner.token),
        payload: { background: '../../etc/passwd' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('buying the upgrade', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/app-design/upgrade-payment' });
      expect(res.statusCode).toBe(401);
    });

    it('refuses an account without a paid card order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        headers: authHeader(stranger.token),
        payload: { locale: 'en', currency: 'EUR' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates a Mollie payment for the constant price, taxed by the last order', async () => {
      mollieMock.createUpgradePayment.mockResolvedValueOnce({
        id: 'tr_app_upgrade',
        checkoutUrl: 'https://mollie.test/checkout/app',
        currency: 'SEK',
        amount: 105,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        headers: authHeader(owner.token),
        payload: { locale: 'nl', currency: 'SEK' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        paymentUrl: 'https://mollie.test/checkout/app',
      });

      const args = mollieMock.createUpgradePayment.mock.calls[
        mollieMock.createUpgradePayment.mock.calls.length - 1
      ][0];
      expect(args.amountEur).toBe(APP_DESIGN_PRICE);
      expect(args.requestedCurrency).toBe('SEK');
      expect(args.metadata).toMatchObject({
        type: 'app_design_upgrade',
        userId: String(owner.user.id),
        countrycode: 'NL',
        taxRate: '21',
      });
      expect(args.redirectUrl).toContain('/nl/my-account/app-design?enabled=1');
    });

    it('records the paid purchase once and switches every playlist to the default', async () => {
      const appDesign = AppDesign.getInstance();
      const params = {
        userId: owner.user.id,
        molliePaymentId: 'tr_app_upgrade',
        price: APP_DESIGN_PRICE,
        taxRate: 21,
        countrycode: 'NL',
        currency: 'SEK',
        amountCharged: 105,
      };
      const first = await appDesign.processUpgradePayment(params);
      expect(first).toMatchObject({ success: true, created: true });
      const replay = await appDesign.processUpgradePayment(params);
      expect(replay).toMatchObject({ success: true, created: false });

      const purchases = await prisma().appDesignPurchase.findMany({
        where: { userId: owner.user.id },
      });
      expect(purchases).toHaveLength(1);
      expect(purchases[0]).toMatchObject({
        totalPrice: APP_DESIGN_PRICE,
        taxRate: 21,
        countrycode: 'NL',
        currency: 'SEK',
        amountCharged: 105,
      });
      expect(purchases[0].totalPriceWithoutTax + purchases[0].totalVAT).toBeCloseTo(
        APP_DESIGN_PRICE,
        2
      );

      expect(appTheme().getTheme(firstPhpId)?.s).toBe(`${defaultSlug}-2`);
      expect(appTheme().getTheme(secondPhpId)?.s).toBe(`${defaultSlug}-2`);

      const again = await app.inject({
        method: 'POST',
        url: '/api/app-design/upgrade-payment',
        headers: authHeader(owner.token),
        payload: { locale: 'nl', currency: 'EUR' },
      });
      expect(again.statusCode).toBe(400);
    });

    it('serves an edit on the next scan under a new slug', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/app-design/default',
        headers: authHeader(owner.token),
        payload: { design: { ...DESIGN, background }, theme: THEME },
      });
      expect(appTheme().getTheme(firstPhpId)?.s).toBe(`${defaultSlug}-3`);
    });
  });

  describe('per playlist', () => {
    it("403s another user's playlist", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/app-design/playlist/${firstPhpId}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('needs a design of its own before it can use one', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/app-design/playlist/${secondPhpId}/mode`,
        headers: authHeader(owner.token),
        payload: { mode: 'custom' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('overrides the default with its own design, then the plain app, then back', async () => {
      const own = await app.inject({
        method: 'PUT',
        url: `/api/app-design/playlist/${secondPhpId}`,
        headers: authHeader(owner.token),
        payload: { design: { ...DESIGN, name: 'Wedding' }, theme: THEME },
      });
      expect(own.statusCode).toBe(200);
      const override = await prisma().appDesign.findUnique({
        where: { paymentHasPlaylistId: secondPhpId },
      });
      expect(appTheme().getTheme(secondPhpId)).toMatchObject({
        s: `${override!.slug}-1`,
        n: 'Wedding',
      });
      // The other playlist keeps the default.
      expect(appTheme().getTheme(firstPhpId)?.s).toBe(`${defaultSlug}-3`);

      const setMode = (mode: string) =>
        app.inject({
          method: 'PUT',
          url: `/api/app-design/playlist/${secondPhpId}/mode`,
          headers: authHeader(owner.token),
          payload: { mode },
        });
      await setMode('standard');
      expect(appTheme().getTheme(secondPhpId)?.s).toBe('');
      await setMode('default');
      expect(appTheme().getTheme(secondPhpId)?.s).toBe(`${defaultSlug}-3`);
      // Its own design was kept and can be switched back on.
      expect((await setMode('custom')).statusCode).toBe(200);
      expect(appTheme().getTheme(secondPhpId)?.s).toBe(`${override!.slug}-1`);

      const listed = await app.inject({
        method: 'GET',
        url: '/api/app-design',
        headers: authHeader(owner.token),
      });
      const second = listed
        .json()
        .playlists.find((p: any) => p.paymentHasPlaylistId === secondPhpId);
      expect(second).toMatchObject({ mode: 'custom', hasOwnDesign: true });
    });

    it('lets an admin-assigned B2B theme win', async () => {
      await prisma().paymentHasPlaylist.update({
        where: { id: firstPhpId },
        data: { theme: 'acme', themeName: 'Acme' },
      });
      await appTheme().reload();
      expect(appTheme().getTheme(firstPhpId)).toMatchObject({ s: 'acme', n: 'Acme' });
    });
  });
});
