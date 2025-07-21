import { FastifyInstance } from 'fastify';
import Mollie from '../mollie';
import Data from '../data';
import Order from '../order';
import Discount from '../discount';
import Review from '../review';
import Translation from '../translation';
import Utils from '../utils';
import fs from 'fs/promises';
import path from 'path';

export default async function paymentRoutes(fastify: FastifyInstance) {
  const mollie = new Mollie();
  const data = Data.getInstance();
  const order = Order.getInstance();
  const discount = new Discount();
  const review = Review.getInstance();
  const translation = new Translation();
  const utils = new Utils();

  // Check payment status
  fastify.post('/mollie/check', async (request: any, _reply) => {
    return await mollie.checkPaymentStatus(request.body.paymentId);
  });

  // Create payment
  fastify.post('/mollie/payment', async (request: any, _reply) => {
    return await mollie.getPaymentUri(request.body, request.clientIp);
  });

  // Payment webhook
  fastify.post('/mollie/webhook', async (request: any, _reply) => {
    return await mollie.processWebhook(request.body);
  });

  // Get order progress
  fastify.get('/progress/:playlistId/:paymentId', async (request: any, _reply) => {
    const data = await Data.getInstance().getPayment(
      request.params.paymentId,
      request.params.playlistId
    );
    return {
      success: true,
      data,
    };
  });

  // Get order type
  fastify.get(
    '/ordertype/:numberOfTracks/:digital/:subType/:playlistId',
    async (request: any, _reply) => {
      const orderType = await order.getOrderType(
        parseInt(request.params.numberOfTracks),
        utils.parseBoolean(request.params.digital),
        'cards',
        request.params.playlistId,
        request.params.subType
      );
      if (orderType) {
        return {
          success: true,
          data: {
            id: orderType.id,
            amount: orderType.amount,
            maxCards: orderType.digital ? 3000 : 1000,
            alternatives: orderType.alternatives || {},
            available: true,
          },
        };
      } else {
        return {
          success: true,
          data: {
            id: 0,
            amount: 0,
            alternatives: {},
            available: false,
          },
        };
      }
    }
  );

  // Get order types
  fastify.get('/ordertypes', async (request: any, _reply) => {
    const orderTypes = await order.getOrderTypes();
    if (orderTypes && orderTypes.length > 0) {
      return orderTypes;
    } else {
      return { success: false, error: 'Order type not found' };
    }
  });

  // Download files
  fastify.get(
    '/download/:paymentId/:userHash/:playlistId/:type',
    async (request: any, reply) => {
      const pdfFile = await data.getPDFFilepath(
        request.clientIp,
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        request.params.type
      );
      if (pdfFile && pdfFile.filePath) {
        try {
          await fs.access(pdfFile.filePath, fs.constants.R_OK);
          reply.header(
            'Content-Disposition',
            'attachment; filename=' + pdfFile.fileName
          );
          reply.type('application/pdf');
          const fileContent = await fs.readFile(pdfFile.filePath);

          console.log(`User downloaded file: ${pdfFile.filePath}`);

          reply.send(fileContent);
        } catch (error) {
          reply.code(404).send('PDF not found');
        }
      } else {
        reply.code(404).send('PDF not found');
      }
    }
  );

  // Calculate order
  fastify.post('/order/calculate', async (request: any, _reply) => {
    try {
      const result = await order.calculateOrder(request.body);
      return result;
    } catch (e) {
      return { success: false };
    }
  });

  // Check discount
  fastify.post('/discount/:code/:digital', async (request: any, reply: any) => {
    const result = await discount.checkDiscount(
      request.params.code,
      request.body.token,
      utils.parseBoolean(request.params.digital)
    );
    reply.send(result);
  });

  // Get voucher
  fastify.get(
    '/discount/voucher/:type/:code/:paymentId',
    async (request: any, reply: any) => {
      const { type, code, paymentId } = request.params;
      const discountDetails = await discount.getDiscountDetails(code);
      const payment = await mollie.getPayment(paymentId);
      if (discountDetails) {
        try {
          const translations = await translation.getTranslationsByPrefix(
            payment.locale,
            'voucher'
          );
          await reply.view(`voucher_${type}.ejs`, {
            discount: discountDetails,
            translations,
          });
        } catch (error) {
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      } else {
        reply.status(404).send({ error: 'Code not found' });
      }
    }
  );

  // Invoice
  fastify.get('/invoice/:paymentId', async (request: any, reply) => {
    const payment = await mollie.getPayment(request.params.paymentId);
    if (!payment) {
      reply.status(404).send({ error: 'Payment not found' });
      return;
    }
    const playlists = await data.getPlaylistsByPaymentId(payment.paymentId);

    let orderType = 'digital';
    for (const playlist of playlists) {
      if (playlist.orderType !== 'digital') {
        orderType = 'physical';
        break;
      }
    }

    const formatters = {}; // Add formatters here if needed

    await reply.view(`invoice.ejs`, {
      payment,
      playlists,
      orderType,
      ...formatters,
      translations: await translation.getTranslationsByPrefix(
        payment.locale,
        'invoice'
      ),
      countries: await translation.getTranslationsByPrefix(
        payment.locale,
        'countries'
      ),
    });
  });

  // PDF generation
  fastify.get(
    '/qr/pdf/:playlistId/:paymentId/:template/:startIndex/:endIndex/:subdir/:eco/:emptyPages',
    async (request: any, reply) => {
      const valid = await mollie.canDownloadPDF(
        request.params.playlistId,
        request.params.paymentId
      );
      if (!valid) {
        reply.status(403).send({ error: 'Forbidden' });
        return;
      }

      const payment = await mollie.getPayment(request.params.paymentId);
      const user = await data.getUser(payment.userId);
      const playlist = await data.getPlaylist(request.params.playlistId);
      const php = await data.getPlaylistsByPaymentId(
        request.params.paymentId,
        request.params.playlistId
      );
      let tracks = await data.getTracks(playlist.id, user.id);

      // Slice the tracks based on the start and end index
      const startIndex = parseInt(request.params.startIndex);
      const endIndex = parseInt(request.params.endIndex);
      const eco = utils.parseBoolean(request.params.eco);
      const emptyPages = parseInt(request.params.emptyPages);
      const subdir = request.params.subdir;
      tracks = tracks.slice(startIndex, endIndex + 1);

      // Check for white label
      const emailDomain = payment.email ? payment.email.split('@')[1] : '';
      const whiteLabels = [
        {
          domain: 'k7.com',
          template: 'k7',
        },
      ];
      const whitelabel = whiteLabels.find((wl) => wl.domain === emailDomain);

      if (payment.email) {
        let template = request.params.template;
        
        // Check for specific Treffer email
        if (payment.email.toLowerCase() === 'west14+treffer@gmail.com' && request.params.template === 'printer') {
          template = 'treffer_printer';
        } else if (whitelabel && request.params.template.indexOf('digital_double') > -1) {
          template = `${request.params.template}_${whitelabel.template}`;
        }

        await reply.view(`pdf_${template}.ejs`, {
          subdir,
          payment,
          playlist,
          php: php[0],
          tracks,
          user,
          eco,
          emptyPages,
        });
      }
    }
  );

  // Reviews
  fastify.get('/review/:paymentId', async (request: any, _reply) => {
    return await review.checkReview(request.params.paymentId);
  });

  fastify.post('/review/:paymentId', async (request: any, _reply) => {
    const { rating, review } = request.body;
    return await review.createReview(
      request.params.paymentId,
      rating,
      review
    );
  });

  // Print API webhook
  fastify.post('/printapi/webhook', async (request: any, _reply) => {
    await order.processPrintApiWebhook(request.body.orderId);
    return { success: true };
  });

  // Development routes
  if (process.env['ENVIRONMENT'] == 'development') {
    fastify.get('/generate_invoice/:paymentId', async (request: any, _reply) => {
      const payment = await mollie.getPayment(request.params.paymentId);
      if (payment) {
        const pdfPath = await order.createInvoice(payment);
        // Send tracking email would go here
        return { success: true };
      } else {
        return { success: false };
      }
    });
  }
}