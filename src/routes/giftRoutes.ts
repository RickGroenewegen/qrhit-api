import { FastifyInstance } from 'fastify';
import { createReadStream } from 'fs';
import { color, white } from 'console-log-colors';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import Utils from '../utils';
import GiftVouchers, { GiftError, parseVoucherText } from '../gift';
import { isSignedRenderRequest } from '../renderSignature';

const prisma = PrismaInstance.getInstance();
const logger = new Logger();
const utils = new Utils();

/**
 * Giving a set as a gift (src/gift.ts):
 * - POST   /api/gift/vouchers                  make a voucher { paymentId, paymentHasPlaylistIds, recipientName, fromName, message, locale }
 * - PUT    /api/gift/vouchers/:id              change its texts (the PDF is made again)
 * - DELETE /api/gift/vouchers/:id              cancel it
 * - GET    /api/gift/vouchers/:id/pdf          the voucher PDF, for its giver
 * - GET    /api/gift/redeem/:code              PUBLIC, limited per IP: what the redeem page shows
 * - POST   /api/gift/redeem/:code/claim        redeem it into the signed-in account
 * - GET    /gift/voucher/view/:id              SIGNED: the voucher page the PDF Lambda prints
 * - POST   /admin/gift/vouchers/:id/cancel     cancel a voucher for a customer
 * - POST   /admin/playlist/:paymentHasPlaylistId/gift/return   give a redeemed set back to its buyer
 */
const giftRoutes = async (fastify: FastifyInstance, getAuthHandler?: any) => {
  if (!getAuthHandler) return;
  const gifts = GiftVouchers.getInstance();

  async function currentUserId(request: any, reply: any): Promise<number | null> {
    const user = await prisma.user.findUnique({
      where: { userId: request.user?.userId },
      select: { id: true },
    });
    if (!user) {
      reply.status(401).send({ success: false, error: 'userNotFound' });
      return null;
    }
    return user.id;
  }

  function fail(reply: any, error: any, what: string) {
    if (error instanceof GiftError) {
      return reply.status(error.status).send({ success: false, error: error.code });
    }
    logger.log(color.red.bold(`${what}: ${white.bold(error?.message || String(error))}`));
    return reply.status(500).send({ success: false, error: 'internalServerError' });
  }

  function voucherId(request: any): number {
    const id = parseInt(request.params.id, 10);
    if (!Number.isInteger(id)) throw new GiftError(400, 'invalidId');
    return id;
  }

  fastify.post('/api/gift/vouchers', getAuthHandler(['users']), async (request: any, reply: any) => {
    try {
      const userId = await currentUserId(request, reply);
      if (!userId) return;
      const body = request.body || {};
      const voucher = await gifts.createVoucher(
        userId,
        String(body.paymentId || ''),
        body.paymentHasPlaylistIds,
        parseVoucherText(body)
      );
      return reply.send({ success: true, voucher });
    } catch (error) {
      return fail(reply, error, 'Making a gift voucher');
    }
  });

  fastify.put('/api/gift/vouchers/:id', getAuthHandler(['users']), async (request: any, reply: any) => {
    try {
      const userId = await currentUserId(request, reply);
      if (!userId) return;
      const voucher = await gifts.updateVoucher(userId, voucherId(request), parseVoucherText(request.body));
      return reply.send({ success: true, voucher });
    } catch (error) {
      return fail(reply, error, 'Changing a gift voucher');
    }
  });

  fastify.delete('/api/gift/vouchers/:id', getAuthHandler(['users']), async (request: any, reply: any) => {
    try {
      const userId = await currentUserId(request, reply);
      if (!userId) return;
      await gifts.cancelVoucher(voucherId(request), userId);
      return reply.send({ success: true });
    } catch (error) {
      return fail(reply, error, 'Cancelling a gift voucher');
    }
  });

  fastify.get('/api/gift/vouchers/:id/pdf', getAuthHandler(['users']), async (request: any, reply: any) => {
    try {
      const userId = await currentUserId(request, reply);
      if (!userId) return;
      const { file, filename } = await gifts.voucherPdf(userId, voucherId(request));
      reply.header('Content-Type', 'application/pdf');
      reply.header(
        'Content-Disposition',
        `attachment; filename="gift-voucher.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(createReadStream(file));
    } catch (error) {
      return fail(reply, error, 'Downloading a gift voucher');
    }
  });

  fastify.get('/api/gift/redeem/:code', async (request: any, reply: any) => {
    try {
      const ip = request.clientIp || request.ip;
      const exempt = process.env['ENVIRONMENT'] === 'development' || utils.isTrustedIp(ip);
      if (!exempt && !(await gifts.allowLookup(ip))) {
        return reply.status(429).send({ success: false, error: 'tooManyAttempts' });
      }
      reply.header('Cache-Control', 'private, no-store');
      return reply.send({ success: true, gift: await gifts.redeemInfo(request.params.code) });
    } catch (error) {
      return fail(reply, error, 'Looking up a gift');
    }
  });

  fastify.post(
    '/api/gift/redeem/:code/claim',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const userId = await currentUserId(request, reply);
        if (!userId) return;
        const result = await gifts.claim(request.params.code, userId);
        return reply.send({ success: true, replay: result.replay });
      } catch (error) {
        return fail(reply, error, 'Redeeming a gift');
      }
    }
  );

  // The page the PDF Lambda prints; signed, because it has no login
  fastify.get('/gift/voucher/view/:id', async (request: any, reply: any) => {
    try {
      if (!isSignedRenderRequest('gift-voucher', request)) {
        return reply.status(404).send({ success: false, error: 'notFound' });
      }
      const view = await gifts.voucherView(voucherId(request));
      if (!view) return reply.status(404).send({ success: false, error: 'notFound' });
      await reply.view('gift_voucher.ejs', view);
      return reply;
    } catch (error) {
      return fail(reply, error, 'Rendering a gift voucher');
    }
  });

  // ─── Admin ───

  fastify.post('/admin/gift/vouchers/:id/cancel', getAuthHandler(['admin']), async (request: any, reply: any) => {
    try {
      await gifts.cancelVoucher(voucherId(request), null);
      return reply.send({ success: true });
    } catch (error) {
      return fail(reply, error, 'Cancelling a gift voucher (admin)');
    }
  });

  fastify.post(
    '/admin/playlist/:paymentHasPlaylistId/gift/return',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const id = parseInt(request.params.paymentHasPlaylistId, 10);
        if (!Number.isInteger(id)) throw new GiftError(400, 'invalidId');
        await gifts.returnToBuyer(id);
        return reply.send({ success: true });
      } catch (error) {
        return fail(reply, error, 'Returning a gifted set');
      }
    }
  );
};

export default giftRoutes;
