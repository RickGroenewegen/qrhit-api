import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Generator from '../../src/generator';
import Order from '../../src/order';
import PDF from '../../src/pdf';
import Data from '../../src/data';
import CardPreviews from '../../src/cardPreview';
import MusicServiceRegistry from '../../src/services/MusicServiceRegistry';
import { getExtraDesigns } from '../../src/cardDesigns';
import { computePrintFingerprint } from '../../src/printFingerprint';

/**
 * The dashboard's printer card preview and the die-line pictures
 * (src/cardPreview.ts, routes in src/routes/adminRoutes.ts): where the first
 * card comes from, that a picture is made once and again after any change,
 * and the upload the qrsong toolkit's cut-check sends.
 */
describe('card preview routes', () => {
  const PLAYLIST = '1xxLqfdEzvQ1yPMwKrxVAl';
  const BOUNDARY = '----cardpreviewtest';
  const MM = 72 / 25.4;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let user: Record<string, string>;
  let paymentId = '';
  let phpId = 0;
  let render: ReturnType<typeof vi.spyOn>;
  const publicDir = () => process.env['PUBLIC_DIR'] as string;
  const previewDir = () => path.join(publicDir(), 'card-previews');

  /** Pages of `sizeMm`, each in two colours: left half, right half (rgb 0..1). */
  async function pdfOf(sizeMm: number, pages: [number[], number[]][]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const side = sizeMm * MM;
    for (const [left, right] of pages) {
      const page = doc.addPage([side, side]);
      page.drawRectangle({ x: 0, y: 0, width: side / 2, height: side, color: rgb(left[0], left[1], left[2]) });
      page.drawRectangle({ x: side / 2, y: 0, width: side / 2, height: side, color: rgb(right[0], right[1], right[2]) });
    }
    return Buffer.from(await doc.save());
  }
  const RED = [1, 0, 0];
  const BLUE = [0, 0, 1];
  const GREEN = [0, 1, 0];
  const YELLOW = [1, 1, 0];
  const GREY = [0.5, 0.5, 0.5];

  /** A stored printer PDF as the generator writes it: a 56 mm render with addBleed applied. */
  async function storePrinterPdf(pages: [number[], number[]][]): Promise<string> {
    const filename = `card_preview_test_${phpId}.pdf`;
    const file = path.join(publicDir(), 'pdf', filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await pdfOf(56, pages));
    await new PDF().addBleed(file, 3);
    return filename;
  }

  /** The fingerprint the generator would store for the line now. */
  async function currentFingerprint(): Promise<string> {
    const data = Data.getInstance();
    const rows = await data.getPlaylistsByPaymentId(paymentId, PLAYLIST);
    const row = rows.find((r: any) => Number(r.paymentHasPlaylistId) === phpId);
    const tracks = await data.getTracks(row.id, 0, phpId);
    return computePrintFingerprint(row, tracks, await getExtraDesigns(phpId));
  }

  async function colourAt(url: string, xShare: number): Promise<number[]> {
    const file = path.join(publicDir(), url.replace(/^\/public\//, ''));
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const x = Math.round(info.width * xShare);
    const y = Math.round(info.height / 2);
    return Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
  }

  const linePictures = () => (fs.existsSync(previewDir()) ? fs.readdirSync(previewDir()).filter((f) => f.startsWith(`${phpId}-`)) : []);
  const preview = (headers = admin) => app.inject({ method: 'GET', url: `/admin/playlist/${phpId}/card-preview`, headers });

  function multipart(fields: Record<string, string>, file?: Buffer) {
    const parts: Buffer[] = Object.entries(fields).map(([name, value]) =>
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
    if (file) {
      parts.push(
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="card.png"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        file,
        Buffer.from('\r\n')
      );
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
  }
  const dieLines = (fields: Record<string, string>, file?: Buffer, headers = admin) => {
    const body = multipart(fields, file);
    return app.inject({ method: 'POST', url: '/admin/card-preview/die-lines', headers: { ...headers, ...body.headers }, payload: body.payload });
  };

  beforeAll(async () => {
    vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue('job-card-preview');
    vi.spyOn(MusicServiceRegistry.prototype as any, 'getPlaylistFromUrl').mockResolvedValue({
      success: true,
      serviceType: 'spotify',
      data: { name: 'Card preview test', trackCount: 2, imageUrl: 'https://i.scdn.co/image/x' },
    });
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

    // A Schneiders order on the sportstuif card template (a views/pdf_*.ejs file)
    const order = await app.inject({
      method: 'POST',
      url: '/admin/toolkit/order',
      headers: admin,
      payload: { email: 'owner@test.qrsong.io', playlistId: PLAYLIST, template: 'sportstuif' },
    });
    expect(order.statusCode, order.body).toBe(200);
    paymentId = order.json().paymentId;
    phpId = order.json().paymentHasPlaylistId;
    const php = await prisma().paymentHasPlaylist.findUnique({ where: { id: phpId } });
    for (const [i, t] of [
      { trackId: 'cpTrack000000000000001', name: 'Dancing Queen', artist: 'ABBA', year: 1976 },
      { trackId: 'cpTrack000000000000002', name: 'Waterloo', artist: 'ABBA', year: 1974 },
    ].entries()) {
      const track = await prisma().track.create({ data: t });
      await prisma().playlistHasTrack.create({ data: { playlistId: php!.playlistId, trackId: track.id, order: i } });
    }

    // A fresh render: one 56 mm card, red | blue on both sides
    const rendered = await pdfOf(56, [
      [RED, BLUE],
      [RED, BLUE],
    ]);
    render = vi.spyOn(PDF.prototype, 'renderUrlToPdfBuffer').mockResolvedValue(rendered);
  });

  beforeEach(() => {
    render.mockClear();
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
    for (const file of linePictures()) fs.rmSync(path.join(previewDir(), file), { force: true });
    fs.rmSync(path.join(publicDir(), 'pdf', `card_preview_test_${phpId}.pdf`), { force: true });
  });

  it('is admin only', async () => {
    expect((await app.inject({ method: 'GET', url: `/admin/playlist/${phpId}/card-preview` })).statusCode).toBe(401);
    expect((await preview(user)).statusCode).toBe(403);
    expect((await dieLines({ cardMm: '56' }, undefined, user)).statusCode).toBe(403);
  });

  it('answers what it cannot show', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/playlist/abc/card-preview', headers: admin })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/admin/playlist/99999999/card-preview', headers: admin })).statusCode).toBe(404);
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { subType: 'sheets' } });
    const sheets = await preview();
    expect(sheets.statusCode).toBe(400);
    expect(sheets.json().error).toMatch(/single cards/);
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { subType: 'none' } });
    expect(render).not.toHaveBeenCalled();
  });

  it('renders the first card when there is no printer PDF, once', async () => {
    const res = await preview();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true, status: 'ready', source: 'render', cardSizeMm: 56 });
    expect(body.front).toMatch(new RegExp(`^/public/card-previews/${phpId}-[0-9a-f]{32}-front\\.png$`));
    expect(body.frontDie).toBe(body.front.replace('-front.png', '-front-die.png'));
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/qr/pdf/${PLAYLIST}/${paymentId}/sportstuif/0/0/[^/]*/0/0/1$`)),
      expect.objectContaining({ width: 56, height: 56, pageRanges: '1-2' })
    );
    expect(linePictures()).toHaveLength(4);
    expect((await sharp(path.join(publicDir(), body.front.slice(8))).metadata()).width).toBe(720);
    expect((await sharp(path.join(publicDir(), body.frontDie.slice(8))).metadata()).width).toBe(900);
    expect(await colourAt(body.front, 0.25)).toEqual([255, 0, 0]);
    expect(await colourAt(body.back, 0.75)).toEqual([0, 0, 255]);

    const again = await preview();
    expect(again.json().front).toBe(body.front);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('makes a new picture when the first card changes, once for requests at the same time', async () => {
    const before = (await preview()).json().front;
    const first = await prisma().track.findFirst({ where: { trackId: 'cpTrack000000000000001' } });
    await prisma().track.update({ where: { id: first!.id }, data: { year: 1977 } });
    const [a, b] = await Promise.all([preview(), preview()]);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().front).not.toBe(before);
    expect(b.json().front).toBe(a.json().front);
    expect(render).toHaveBeenCalledTimes(1);
    // the line keeps only its newest pictures
    expect(linePictures()).toHaveLength(4);
    expect(linePictures().some((f) => before.endsWith(f))).toBe(false);
  });

  it('reads the stored printer PDF while it is current, past the how-to card', async () => {
    const filename = await storePrinterPdf([
      [GREEN, YELLOW],
      [YELLOW, GREEN],
    ]);
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { filename, pdfFingerprint: await currentFingerprint() } });
    const res = await preview();
    expect(res.json()).toMatchObject({ source: 'pdf', cardSizeMm: 56 });
    expect(render).not.toHaveBeenCalled();
    expect(await colourAt(res.json().front, 0.25)).toEqual([0, 255, 0]);
    expect(await colourAt(res.json().back, 0.25)).toEqual([255, 255, 0]);

    // With the how-to card the first card is on pages 3 and 4
    await storePrinterPdf([
      [GREY, GREY],
      [GREY, GREY],
      [YELLOW, GREEN],
      [GREEN, YELLOW],
    ]);
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { addHowToCard: true } });
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { pdfFingerprint: await currentFingerprint() } });
    const howTo = await preview();
    expect(howTo.json().source).toBe('pdf');
    expect(await colourAt(howTo.json().front, 0.25)).toEqual([255, 255, 0]);
    expect(render).not.toHaveBeenCalled();
  });

  it('takes a new template on the line as a change the printer PDF does not have', async () => {
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { template: 'facta' } });
    const res = await preview();
    expect(res.json().source).toBe('render');
    expect(render).toHaveBeenCalledWith(expect.stringContaining('/facta/0/0/'), expect.objectContaining({ pageRanges: '3-4' }));
  });

  it('goes back to the printer PDF when the line matches it again', async () => {
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { template: 'sportstuif' } });
    expect((await preview()).json().source).toBe('pdf');
    expect(render).not.toHaveBeenCalled();
  });

  it('says so when the card cannot be rendered, and does not try again until asked', async () => {
    await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { qrColor: '#123456' } });
    render.mockRejectedValueOnce(new Error('Lambda down'));
    const res = await preview();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, status: 'failed', error: 'The card could not be rendered: Lambda down' });

    // The dashboard asks again: the failure is remembered, no new render
    expect((await preview()).statusCode).toBe(502);
    expect(render).toHaveBeenCalledTimes(1);

    const retry = await app.inject({ method: 'GET', url: `/admin/playlist/${phpId}/card-preview?retry=1`, headers: admin });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().status).toBe('ready');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('answers generating while the card renders in the background, then the pictures', async () => {
    const previews = CardPreviews.getInstance();
    const waitMs = previews.inlineWaitMs;
    previews.inlineWaitMs = 50;
    try {
      await prisma().paymentHasPlaylist.update({ where: { id: phpId }, data: { qrColor: '#654321' } });
      let finish!: (pdf: Buffer) => void;
      render.mockImplementationOnce(() => new Promise<Buffer>((resolve) => (finish = resolve)));

      const first = await preview();
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ success: true, status: 'generating', source: 'render', cardSizeMm: 56 });
      expect(first.json().front).toBeUndefined();
      // asked again while it runs: still one render
      expect((await preview()).json().status).toBe('generating');
      expect(render).toHaveBeenCalledTimes(1);

      finish(await pdfOf(56, [
        [GREEN, GREEN],
        [YELLOW, YELLOW],
      ]));
      let ready: any = null;
      for (let i = 0; i < 100 && !ready; i++) {
        const res = await preview();
        if (res.statusCode === 200) ready = res.json();
        else await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(ready).toMatchObject({ status: 'ready', source: 'render' });
      expect(await colourAt(ready.front, 0.5)).toEqual([0, 255, 0]);
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      previews.inlineWaitMs = waitMs;
    }
  });

  it('draws the die line on an upload and on the line, for the toolkit', async () => {
    const canvas = await sharp({ create: { width: 620, height: 620, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const upload = await dieLines({ views: JSON.stringify([{ px: 620 }, { px: 420, x: 0, y: 0, sizeMm: 9 }]) }, canvas);
    expect(upload.statusCode, upload.body).toBe(200);
    const body = upload.json();
    expect(body).toMatchObject({ success: true, cardMm: 56, source: 'upload' });
    expect(body.pages[0]).toMatchObject({ page: 1, pageMm: 62 });
    expect(body.pages[0].views.map((v: any) => [v.px, v.sizeMm, v.guides])).toEqual([
      [620, 62, true],
      [420, 9, true],
    ]);
    const png = Buffer.from(body.pages[0].views[0].png, 'base64');
    expect((await sharp(png).metadata()).width).toBe(620);

    // Chromium's page comes out a little larger than the card; the generator
    // scales it to the card exactly before the bleed, and so does this
    render.mockResolvedValueOnce(await pdfOf(56.2, [
      [RED, BLUE],
      [RED, BLUE],
    ]));
    const line = await dieLines({ paymentHasPlaylistId: String(phpId), views: '[{"px":300}]' });
    expect(line.statusCode, line.body).toBe(200);
    expect(line.json()).toMatchObject({ cardMm: 56 });
    expect(line.json().pages.map((p: any) => [p.page, p.pageMm])).toEqual([
      [1, 62],
      [2, 62],
    ]);

    expect((await dieLines({ views: '[{"px":300}]' })).statusCode).toBe(400);
    expect((await dieLines({ views: 'nope' }, canvas)).json().error).toMatch(/not valid JSON/);
    expect((await dieLines({ paymentHasPlaylistId: 'x' })).statusCode).toBe(400);
    const plain = await app.inject({ method: 'POST', url: '/admin/card-preview/die-lines', headers: admin, payload: {} });
    expect(plain.statusCode).toBe(400);
  });
});
