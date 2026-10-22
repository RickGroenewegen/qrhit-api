import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import AppTheme from '../../src/apptheme';

/**
 * Scan-app themes stored as data (src/storedThemes.ts, routes in
 * src/routes/appThemeRoutes.ts and themeRoutes.ts): pushing versions, what the
 * app gets for a stored theme and for the folder themes that were never
 * pushed, and the slug a scanned card carries.
 */
describe('stored app themes', () => {
  const SLUG = 'itest-theme';
  const BOUNDARY = '----appthemetest';
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let user: Record<string, string>;
  let logo: Buffer;
  let background: Buffer;
  let storedLine: number;
  let folderLine: number;
  const appTheme = () => AppTheme.getInstance();

  const theme = (over: Record<string, unknown> = {}) => ({
    id: SLUG,
    name: 'Integration theme',
    version: 1,
    showRecord: false,
    cssVariables: { '--app-background': '#492bf5', '--app-text-color': '#ffffff' },
    fonts: { family: 'Nunito, sans-serif', url: 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;700&display=swap' },
    helpText: '<h2>Welkom</h2><p>Scan een kaart.</p>',
    ...over,
  });

  function multipart(manifest: unknown, files: Record<string, Buffer> = {}, note?: string) {
    const parts: Buffer[] = [
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n`),
    ];
    if (note) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${note}\r\n`));
    for (const [field, bytes] of Object.entries(files)) {
      parts.push(
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${field}.png"\r\nContent-Type: image/png\r\n\r\n`),
        bytes,
        Buffer.from('\r\n')
      );
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
  }

  const push = (slug: string, manifest: unknown, files?: Record<string, Buffer>, query = '', headers = admin, note?: string) => {
    const body = multipart(manifest, files, note);
    return app.inject({ method: 'POST', url: `/admin/app-themes/${slug}${query}`, headers: { ...headers, ...body.headers }, payload: body.payload });
  };

  beforeAll(async () => {
    logo = await sharp({ create: { width: 4, height: 2, channels: 4, background: '#00000000' } }).png().toBuffer();
    background = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#492bf5' } }).png().toBuffer();
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const owner = await createTestUser({ groups: ['admin'], email: 'themes@test.qrsong.io' });
    admin = authHeader(owner.token);
    user = authHeader((await createTestUser({ groups: ['users'] })).token);

    const orderType = await prisma().orderType.create({
      data: { name: 'cards-48', type: 'cards', digital: false, description: 'Cards', amount: 20, maxCards: 500 },
    });
    const line = async (paymentId: string, theme: string) => {
      const playlist = await prisma().playlist.create({ data: { playlistId: paymentId, name: paymentId, slug: paymentId, image: 'img.png' } });
      const payment = await prisma().payment.create({
        data: {
          userId: owner.user.id,
          paymentId,
          status: 'paid',
          finalized: true,
          fullname: 'Theme Buyer',
          email: owner.user.email,
          totalPrice: 0,
          productPriceWithoutTax: 0,
          shippingPriceWithoutTax: 0,
          productVATPrice: 0,
          shippingVATPrice: 0,
          totalVATPrice: 0,
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
          numberOfTracks: 48,
          orderTypeId: orderType.id,
          type: 'physical',
          subType: 'none',
          price: 0,
          priceWithoutVAT: 0,
          priceVAT: 0,
          theme,
          themeName: theme,
        },
      });
      return php.id;
    };
    storedLine = await line('toolkit_theme_stored', SLUG);
    folderLine = await line('toolkit_theme_folder', 'vanharen');
    await appTheme().reload();
  });

  afterAll(async () => {
    await closeTestApp(app);
    fs.rmSync(path.join(process.env['PUBLIC_DIR'] as string, 'app-themes'), { recursive: true, force: true });
  });

  it('is admin only', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/app-themes' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/app-themes', headers: user })).statusCode).toBe(403);
    expect((await push(SLUG, theme(), {}, '', user)).statusCode).toBe(403);
  });

  it('checks without storing, and names every problem', async () => {
    const check = await push(SLUG, theme(), { logo, background }, '?check=1');
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ success: true, checked: true, slug: SLUG, name: 'Integration theme', warnings: [] });
    expect(await prisma().appThemeVersion.count()).toBe(0);

    const bad = await push(SLUG, theme({ name: '', cssVariables: { '--app-text-color': 'url(x)' } }), {}, '?check=1');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.split('\n')).toHaveLength(2);

    expect((await push('default', theme())).statusCode).toBe(409);
    expect((await push('arla--breaker', theme())).statusCode).toBe(409);
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    expect((await push(SLUG, theme(), { logo: jpeg })).json().error).toMatch(/logo must be a PNG/);
    expect(await prisma().appThemeVersion.count()).toBe(0);
  });

  it('a scanned card keeps the plain slug of a folder theme', () => {
    expect(appTheme().getTheme(folderLine)?.s).toBe('vanharen');
    expect(appTheme().getTheme(storedLine)?.s).toBe(SLUG);
  });

  it('stores a version and serves it at once, without a deploy', async () => {
    const res = await push(SLUG, theme(), { logo, background }, '', admin, 'first version');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, slug: SLUG, version: 1, servedSlug: `${SLUG}--v1`, name: 'Integration theme' });

    // The card now carries the version, so the app reloads the theme on its next scan.
    expect(appTheme().getTheme(storedLine)?.s).toBe(`${SLUG}--v1`);
    expect(appTheme().getTheme(folderLine)?.s).toBe('vanharen');

    const served = await app.inject({ method: 'GET', url: `/theme/${SLUG}--v1` });
    expect(served.statusCode).toBe(200);
    expect(served.json().data).toMatchObject({
      id: `${SLUG}--v1`,
      name: 'Integration theme',
      version: 1,
      source: 'business',
      showRecord: false,
      cssVariables: theme().cssVariables,
      helpText: '<h2>Welkom</h2><p>Scan een kaart.</p>',
      assets: {
        logo: `${process.env['API_URI']}/theme/${SLUG}--v1/logo?v=1`,
        background: `${process.env['API_URI']}/theme/${SLUG}--v1/background?v=1`,
      },
    });
    expect(served.json().data).not.toHaveProperty('note');

    const picture = await app.inject({ method: 'GET', url: `/theme/${SLUG}--v1/background?v=1` });
    expect(picture.statusCode).toBe(200);
    expect(picture.headers['content-type']).toBe('image/png');
    expect(picture.rawPayload.equals(background)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/theme/${SLUG}` })).json().data.id).toBe(SLUG);
  });

  it('a new push reaches every card: the slug moves on, an old one gets the newest version', async () => {
    const res = await push(SLUG, theme({ showRecord: true }), { background });
    expect(res.json()).toMatchObject({ version: 2, servedSlug: `${SLUG}--v2` });
    expect(res.json().warnings).toEqual([expect.stringMatching(/no logo/)]);
    expect(appTheme().getTheme(storedLine)?.s).toBe(`${SLUG}--v2`);

    const old = (await app.inject({ method: 'GET', url: `/theme/${SLUG}--v1` })).json().data;
    expect(old).toMatchObject({ id: `${SLUG}--v1`, version: 2, showRecord: true, assets: { logo: null } });
    expect((await app.inject({ method: 'GET', url: `/theme/${SLUG}--v2/logo` })).statusCode).toBe(404);
  });

  it('leaves the folder themes as they were', async () => {
    const folder = JSON.parse(fs.readFileSync(path.join(process.env['APP_ROOT'] as string, '_data/themes/acme/acme.json'), 'utf8'));
    const res = (await app.inject({ method: 'GET', url: '/theme/acme' })).json().data;
    expect(res).toMatchObject({ id: 'acme', name: folder.name, version: folder.version, source: 'business', cssVariables: folder.cssVariables });
    expect((await app.inject({ method: 'GET', url: '/theme/acme--v1' })).statusCode).toBe(404);
  });

  it('a pushed folder theme starts above the folder\'s own version and then wins', async () => {
    const folder = JSON.parse(fs.readFileSync(path.join(process.env['APP_ROOT'] as string, '_data/themes/gebo/gebo.json'), 'utf8'));
    const res = await push('gebo', folder, { background });
    expect(res.json().version).toBe(folder.version + 1);
    const served = (await app.inject({ method: 'GET', url: '/theme/gebo' })).json().data;
    expect(served).toMatchObject({ id: 'gebo', version: folder.version + 1, cssVariables: folder.cssVariables, assets: { logo: null } });
  });

  it('lists, shows and hands back what was pushed', async () => {
    const list = (await app.inject({ method: 'GET', url: '/admin/app-themes', headers: admin })).json();
    expect(list.stored.find((t: any) => t.slug === SLUG)).toMatchObject({ version: 2, name: 'Integration theme', orderLines: 1 });
    expect(list.folders).toEqual(expect.arrayContaining(['acme', 'vanharen']));

    const history = (await app.inject({ method: 'GET', url: `/admin/app-themes/${SLUG}`, headers: admin })).json();
    expect(history.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(history.versions[1].note).toBe('first version');
    expect(history.orderLines).toEqual([expect.objectContaining({ paymentHasPlaylistId: storedLine, paymentId: 'toolkit_theme_stored' })]);

    const v1 = (await app.inject({ method: 'GET', url: `/admin/app-themes/${SLUG}/1`, headers: admin })).json().theme;
    expect(v1).toMatchObject({ slug: SLUG, version: 1, name: 'Integration theme', config: { showRecord: false } });
    expect(v1.files.logo).toMatch(/^[0-9a-f]{32}\.png$/);
    const latest = (await app.inject({ method: 'GET', url: `/admin/app-themes/${SLUG}/latest`, headers: admin })).json().theme;
    expect(latest.version).toBe(2);

    const pulled = await app.inject({ method: 'GET', url: `/admin/app-themes/${SLUG}/1/logo`, headers: admin });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.rawPayload.equals(logo)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/admin/app-themes/${SLUG}/2/logo`, headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/admin/app-themes/${SLUG}/9`, headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/admin/app-themes/nothere', headers: admin })).statusCode).toBe(404);
  });
});
