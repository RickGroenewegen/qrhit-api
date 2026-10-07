import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Generator from '../../src/generator';
import Order from '../../src/order';
import MusicServiceRegistry from '../../src/services/MusicServiceRegistry';

/**
 * The qrsong toolkit's order routes (src/routes/toolkitRoutes.ts): admin only,
 * an order without Mollie or mails, and nothing for Print&Bind.
 */
describe('toolkit order routes', () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let user: Record<string, string>;
  let queueGenerate: any;
  const PLAYLIST = '1xxLqfdEzvQ1yPMwKrxVAl';

  beforeAll(async () => {
    queueGenerate = vi.spyOn(Generator.prototype as any, 'queueGenerate').mockResolvedValue('job-toolkit');
    vi.spyOn(MusicServiceRegistry.prototype as any, 'getPlaylistFromUrl').mockResolvedValue({
      success: true,
      serviceType: 'spotify',
      data: { name: 'Revant personeelsfeest 2026', trackCount: 48, imageUrl: 'https://i.scdn.co/image/x' },
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
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  it('is admin only', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/toolkit/order', headers: user, payload: {} });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/admin/toolkit/order/toolkit_x' });
    expect(anon.statusCode).toBe(401);
  });

  it('refuses Print&Bind and a track count that differs', async () => {
    const pb = await app.inject({
      method: 'POST',
      url: '/admin/toolkit/order',
      headers: admin,
      payload: { email: 'owner@test.qrsong.io', playlistId: PLAYLIST, printerType: 'printnbind' },
    });
    expect(pb.statusCode).toBe(400);
    const count = await app.inject({
      method: 'POST',
      url: '/admin/toolkit/order',
      headers: admin,
      payload: { email: 'owner@test.qrsong.io', playlistId: PLAYLIST, expectedTracks: 50 },
    });
    expect(count.statusCode).toBe(409);
    expect(await prisma().payment.count()).toBe(0);
  });

  it('creates the order, reads it back, changes the design and regenerates without mail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/toolkit/order',
      headers: admin,
      payload: {
        email: 'owner@test.qrsong.io',
        playlistId: PLAYLIST,
        expectedTracks: 48,
        fullname: 'Revant (DNP Giftmanagers)',
        companyName: 'DNP Giftmanagers',
        design: { background: 'front.png', backgroundBack: 'back.png', qrColor: '#ffffff', fontColor: '#ffffff' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.paymentId).toMatch(/^toolkit_/);
    expect(body.orderId).toBe(String(100000000 + body.paymentDbId));

    const payment = await prisma().payment.findUnique({ where: { paymentId: body.paymentId }, include: { PaymentHasPlaylist: true } });
    expect(payment!.status).toBe('paid');
    expect(payment!.printerHold).toBe(false);
    expect(payment!.marketingEmails).toBe(false);
    expect(payment!.PaymentHasPlaylist[0].printerType).toBe('schneiders');
    expect(payment!.PaymentHasPlaylist[0].backOpacity).toBe(100);
    expect(queueGenerate).toHaveBeenLastCalledWith(body.paymentId, '127.0.0.1', PLAYLIST, false, true, false);

    const status = await app.inject({ method: 'GET', url: `/admin/toolkit/order/${body.paymentId}`, headers: admin });
    expect(status.statusCode).toBe(200);
    const order = status.json().order;
    expect(order.printerHold).toBe(false);
    expect(order.line.printerType).toBe('schneiders');
    expect(order.line.design.qrColor).toBe('#ffffff');
    expect(order.line.printerPdf).toBeNull();

    const design = await app.inject({
      method: 'PUT',
      url: `/admin/toolkit/order/${body.paymentId}/design`,
      headers: admin,
      payload: { design: { fontColor: '#000000' } },
    });
    expect(design.statusCode).toBe(200);
    const line = await prisma().paymentHasPlaylist.findFirst({ where: { paymentId: payment!.id } });
    expect(line!.fontColor).toBe('#000000');
    expect(line!.qrColor).toBe('#ffffff');

    const regen = await app.inject({ method: 'POST', url: `/admin/toolkit/order/${body.paymentId}/regenerate`, headers: admin });
    expect(regen.statusCode).toBe(200);
    // forceFinalize, skipMainMail
    expect(queueGenerate).toHaveBeenLastCalledWith(body.paymentId, expect.anything(), '', true, true, false);

    // At the printer: the toolkit will not regenerate it any more.
    await prisma().payment.update({ where: { id: payment!.id }, data: { sentToPrinter: true } });
    const refused = await app.inject({ method: 'POST', url: `/admin/toolkit/order/${body.paymentId}/regenerate`, headers: admin });
    expect(refused.statusCode).toBe(409);
  });

  it('regenerates a Print&Bind order only while it is on printer hold', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/toolkit/order',
      headers: admin,
      payload: { email: 'owner@test.qrsong.io', playlistId: PLAYLIST, expectedTracks: 48 },
    });
    const { paymentId, paymentDbId } = res.json();
    await prisma().paymentHasPlaylist.updateMany({ where: { paymentId: paymentDbId }, data: { printerType: 'printnbind' } });

    const refused = await app.inject({ method: 'POST', url: `/admin/toolkit/order/${paymentId}/regenerate`, headers: admin });
    expect(refused.statusCode).toBe(409);

    await prisma().payment.update({ where: { id: paymentDbId }, data: { printerHold: true } });
    const regen = await app.inject({ method: 'POST', url: `/admin/toolkit/order/${paymentId}/regenerate`, headers: admin });
    expect(regen.statusCode).toBe(200);
  });
});
