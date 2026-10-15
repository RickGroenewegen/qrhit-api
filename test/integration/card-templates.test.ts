import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Generator from '../../src/generator';
import Order from '../../src/order';
import PDF from '../../src/pdf';
import MusicServiceRegistry from '../../src/services/MusicServiceRegistry';

/**
 * Card templates stored as data (src/cardTemplates.ts, routes in
 * src/routes/cardTemplateRoutes.ts): pushing versions, pinning one on an
 * order line, and the PDF page and proof that render it.
 */
describe('card template routes', () => {
  const NAME = 'cardtest';
  const PLAYLIST = '1xxLqfdEzvQ1yPMwKrxVAl';
  const BOUNDARY = '----cardtemplatetest';
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let user: Record<string, string>;
  let png: Buffer;

  const template = (marker: string, over: Record<string, unknown> = {}) => ({
    cardSizeMm: 56,
    note: `test ${marker}`,
    css: ".card-front { width: 56mm; background: url('{{ 'bg.png' | asset }}'); }",
    front: `<div class="card-front">${marker} v{{ template.version }} <img src="{{ qrUrl }}"></div>`,
    back: '<div class="card-back">{{ track.artist }} {{ track.year }}</div>',
    ...over,
  });

  function multipart(manifest: unknown, files: { name: string; bytes: Buffer }[] = [{ name: 'bg.png', bytes: png }]) {
    const parts: Buffer[] = [
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n`),
    ];
    for (const f of files) {
      parts.push(
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="asset"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        f.bytes,
        Buffer.from('\r\n')
      );
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
  }

  const push = (name: string, manifest: unknown, files?: { name: string; bytes: Buffer }[], query = '') => {
    const body = multipart(manifest, files);
    return app.inject({ method: 'POST', url: `/admin/card-templates/${name}${query}`, headers: { ...admin, ...body.headers }, payload: body.payload });
  };

  beforeAll(async () => {
    vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue('job-card-template');
    vi.spyOn(MusicServiceRegistry.prototype as any, 'getPlaylistFromUrl').mockResolvedValue({
      success: true,
      serviceType: 'spotify',
      data: { name: 'Card template test', trackCount: 2, imageUrl: 'https://i.scdn.co/image/x' },
    });
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3366ff' } }).png().toBuffer();
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const orderType = await prisma().orderType.create({
      data: { name: 'cards-48', type: 'cards', digital: false, description: 'Cards', amount: 20, maxCards: 500 },
    });
    vi.spyOn(Order.prototype as any, 'getOrderType').mockResolvedValue({ id: orderType.id });
    admin = authHeader((await createTestUser({ groups: ['admin'], email: 'owner@test.qrsong.io' })).token);
    user = authHeader((await createTestUser({ groups: ['users'] })).token);
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
    fs.rmSync(path.join(process.env['PUBLIC_DIR'] as string, 'card-templates', NAME), { recursive: true, force: true });
  });

  it('is admin only, except the signed proof page', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/card-templates' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/card-templates', headers: user })).statusCode).toBe(403);
    const body = multipart(template('x'));
    const res = await app.inject({ method: 'POST', url: `/admin/card-templates/${NAME}`, headers: { ...user, ...body.headers }, payload: body.payload });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/card-templates/proof/${NAME}/1?php=0&n=6&exp=9999999999&sig=x` })).statusCode).toBe(403);
  });

  it('checks without storing, then stores every push as a new version', async () => {
    const check = await push(NAME, template('ONE'), undefined, '?check=1');
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toMatchObject({ success: true, checked: true });
    expect(await prisma().cardTemplate.count()).toBe(0);

    const one = await push(NAME, template('ONE'));
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({ success: true, name: NAME, version: 1, warnings: [] });
    const url: string = one.json().assets['bg.png'];
    expect(url).toMatch(new RegExp(`/public/card-templates/${NAME}/[0-9a-f]{32}\\.png$`));
    expect(fs.existsSync(path.join(process.env['PUBLIC_DIR'] as string, 'card-templates', NAME, path.basename(url)))).toBe(true);

    const two = await push(NAME, template('TWO'));
    expect(two.json().version).toBe(2);

    const list = await app.inject({ method: 'GET', url: '/admin/card-templates', headers: admin });
    expect(list.json().stored).toEqual([expect.objectContaining({ name: NAME, version: 2, cardSizeMm: 56, orderLines: 0 })]);
    expect(list.json().files).toContain('sportstuif');

    const history = await app.inject({ method: 'GET', url: `/admin/card-templates/${NAME}`, headers: admin });
    expect(history.json().versions.map((v: any) => v.version)).toEqual([2, 1]);

    const v1 = await app.inject({ method: 'GET', url: `/admin/card-templates/${NAME}/1`, headers: admin });
    expect(v1.json().template.front).toContain('ONE');
    const latest = await app.inject({ method: 'GET', url: `/admin/card-templates/${NAME}/latest`, headers: admin });
    expect(latest.json().template.front).toContain('TWO');
  });

  it('refuses a file template name, unsafe source, missing and false assets', async () => {
    expect((await push('facta', template('x'))).statusCode).toBe(409);

    const script = await push(NAME, template('x', { back: '<div><script>alert(1)</script></div>' }));
    expect(script.statusCode).toBe(400);
    expect(script.json().error).toMatch(/back line 1: the <script> element is not allowed/);

    const missing = await push(NAME, template('x'), []);
    expect(missing.json().error).toMatch(/not in this push: bg.png/);

    const svg = await push(NAME, template('x'), [{ name: 'bg.png', bytes: Buffer.from('<svg onload="alert(1)"/>') }]);
    expect(svg.json().error).toMatch(/not a PNG/);

    const typo = await push(NAME, template('x', { back: '{{ track.artst }}' }));
    expect(typo.json().error).toMatch(/undefined variable: track.artst/);

    expect(await prisma().cardTemplate.count()).toBe(2);
  });

  let paymentId = '';
  let phpId = 0;

  it('pins the newest version on an order line and keeps it until asked', async () => {
    const order = await app.inject({
      method: 'POST',
      url: '/admin/toolkit/order',
      headers: admin,
      payload: { email: 'owner@test.qrsong.io', playlistId: PLAYLIST, template: NAME },
    });
    expect(order.statusCode, order.body).toBe(200);
    paymentId = order.json().paymentId;
    phpId = order.json().paymentHasPlaylistId;
    const line = () => prisma().paymentHasPlaylist.findUnique({ where: { id: phpId }, select: { template: true, templateVersion: true, printerType: true } });
    expect(await line()).toMatchObject({ template: NAME, templateVersion: 2 });

    await push(NAME, template('THREE'));
    const settings = (extra: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/php/${phpId}`, headers: admin, payload: { eco: false, doubleSided: true, ...extra } });

    // Saving the production settings sends the template again: the pin stays.
    expect((await settings({ template: NAME })).statusCode).toBe(200);
    expect(await line()).toMatchObject({ templateVersion: 2 });
    expect((await settings({ template: NAME, templateVersion: 'latest' })).statusCode).toBe(200);
    expect(await line()).toMatchObject({ templateVersion: 3 });
    expect((await settings({ template: NAME, templateVersion: 1 })).statusCode).toBe(200);
    expect(await line()).toMatchObject({ templateVersion: 1 });

    const unknown = await settings({ template: 'nope' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/no card template "nope"/);

    // A 56 mm template cannot go to a printer that cuts 60 mm.
    const tromp = await settings({ template: NAME, printerType: 'tromp' });
    expect(tromp.statusCode).toBe(400);
    expect(tromp.json().error).toMatch(/drawn for 56 mm cards; printer tromp cuts 60 mm/);
    expect(await line()).toMatchObject({ printerType: 'schneiders', templateVersion: 1 });

    // A file template has no version.
    expect((await settings({ template: 'sportstuif' })).statusCode).toBe(200);
    expect(await line()).toMatchObject({ template: 'sportstuif', templateVersion: null });
    expect((await settings({ template: NAME, templateVersion: 2 })).statusCode).toBe(200);
  });

  it('renders the order PDF page with the pinned version under the CSP', async () => {
    const php = await prisma().paymentHasPlaylist.findUnique({ where: { id: phpId }, include: { playlist: true } });
    const tracks = [
      { trackId: 'ctTrack000000000000001', name: 'Dancing Queen', artist: 'ABBA <live>', year: 1976 },
      { trackId: 'ctTrack000000000000002', name: 'Waterloo', artist: 'ABBA', year: 1974 },
    ];
    for (const [i, t] of tracks.entries()) {
      const track = await prisma().track.create({ data: t });
      await prisma().playlistHasTrack.create({ data: { playlistId: php!.playlistId, trackId: track.id, order: i } });
    }
    const pdfPage = (tpl: string) =>
      app.inject({ method: 'GET', url: `/qr/pdf/${php!.playlist.playlistId}/${paymentId}/${tpl}/0/1/sub/0/0` });

    const res = await pdfPage(NAME);
    expect(res.statusCode, res.body).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toContain("default-src 'none'");
    expect(res.body).toContain('TWO v2');
    expect(res.body).toContain('ABBA &lt;live&gt; 1976');
    expect(res.body).toContain(`<script nonce="${nonce}">`);
    expect(res.body).toMatch(/background: url\('http:\/\/localhost:3004\/public\/card-templates\/cardtest\/[0-9a-f]{32}\.png'\)/);

    // finalCheck asks for the regular printer layout; the line's own
    // template (payment_has_playlist.template) replaces it.
    const forced = await pdfPage('printer');
    expect(forced.body).toContain('TWO v2');

    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { template: null, templateVersion: null } });
    expect((await pdfPage('nope')).statusCode).toBe(404);
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { template: NAME, templateVersion: 2 } });
  });

  it('makes a proof from a signed page, with sample cards or the order', async () => {
    const link = await app.inject({
      method: 'POST',
      url: `/admin/card-templates/${NAME}/latest/proof`,
      headers: admin,
      payload: { url: true, qrColor: '#002b53' },
    });
    expect(link.statusCode, link.body).toBe(200);
    const proofUrl = new URL(link.json().url);
    const page = await app.inject({ method: 'GET', url: proofUrl.pathname + proofUrl.search });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain('THREE v3');
    expect(page.body).toContain('Earth, Wind &amp; Fire');
    // Sample cards get real QR pictures in the asked colour, made like an order's.
    expect(page.body).toContain('/public/qr/card-template-proof/002b53/sample1.png');
    expect(fs.existsSync(path.join(process.env['PUBLIC_DIR'] as string, 'qr/card-template-proof/002b53/sample1.png'))).toBe(true);
    const tampered = proofUrl.search.replace('qc=%23002b53', 'qc=%23000000');
    expect((await app.inject({ method: 'GET', url: proofUrl.pathname + tampered })).statusCode).toBe(403);

    const ofOrder = await app.inject({ method: 'POST', url: `/admin/card-templates/${NAME}/2/proof`, headers: admin, payload: { url: true, paymentId } });
    const orderUrl = new URL(ofOrder.json().url);
    const orderPage = await app.inject({ method: 'GET', url: orderUrl.pathname + orderUrl.search });
    expect(orderPage.body).toContain('ABBA &lt;live&gt; 1976');

    const render = vi.spyOn(PDF.prototype, 'renderUrlToPdfBuffer').mockResolvedValue(Buffer.from('%PDF-proof'));
    const pdf = await app.inject({ method: 'POST', url: `/admin/card-templates/${NAME}/2/proof`, headers: admin, payload: { paymentId } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body).toBe('%PDF-proof');
    expect(render).toHaveBeenCalledWith(expect.stringContaining(`/card-templates/proof/${NAME}/2?php=${phpId}&n=6`), expect.objectContaining({ width: 56, height: 56 }));
  });
});
