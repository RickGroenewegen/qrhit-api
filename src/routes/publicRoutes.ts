import { FastifyInstance } from 'fastify';
import Mail from '../mail';
import Push from '../push';
import Suggestion from '../suggestion';
import Designer from '../designer';
import Trustpilot from '../trustpilot';
import AudioClient from '../audio';
import Generator from '../generator';
import Qr from '../qr';
import Order from '../order';
import { ChatGPT } from '../chatgpt';
import { Music } from '../music';
import Data from '../data';
import Utils from '../utils';
import Logger from '../logger';
import Review from '../review';
import Mollie from '../mollie';
import Cache from '../cache';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

export default async function publicRoutes(fastify: FastifyInstance) {
  const mail = Mail.getInstance();
  const push = Push.getInstance();
  const suggestion = Suggestion.getInstance();
  const designer = Designer.getInstance();
  const trustpilot = Trustpilot.getInstance();
  const audio = AudioClient.getInstance();
  const generator = Generator.getInstance();
  const qr = new Qr();
  const order = Order.getInstance();
  const openai = new ChatGPT();
  const music = new Music();
  const data = Data.getInstance();
  const utils = new Utils();
  const logger = new Logger();
  const review = Review.getInstance();
  const mollie = new Mollie();
  const cache = Cache.getInstance();

  // Apple App Site Association
  fastify.get(
    '/.well-known/apple-app-site-association',
    async (_request, reply) => {
      const filePath = path.join(
        process.env['APP_ROOT'] as string,
        '..',
        'apple-app-site-association'
      );
      try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        reply.header('Content-Type', 'application/json').send(fileContent);
      } catch (error) {
        reply.status(404).send({ error: 'File not found' });
      }
    }
  );

  // Robots.txt
  fastify.get('/robots.txt', async (_request, reply) => {
    reply
      .header('Content-Type', 'text/plain')
      .send('User-agent: *\nDisallow: /');
  });

  // Contact form
  fastify.post('/contact', async (request: any, _reply) => {
    return await mail.sendContactForm(request.body, request.clientIp);
  });

  // Get IP address
  fastify.get('/ip', async (request, reply) => {
    return { ip: request.ip, clientIp: request.clientIp };
  });

  // Test endpoint
  fastify.get('/test', async (request: any, _reply) => {
    const interfaces = os.networkInterfaces();
    let localIp = 'Not found';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]!) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
    }

    return { success: true, localIp, version: '1.0.0' };
  });

  // Cache update
  fastify.get('/cache', async (request: any, _reply) => {
    cache.flush();
    order.updateFeaturedPlaylists();
    return { success: true };
  });

  // Upload contacts
  fastify.get('/upload_contacts', async (request: any, _reply) => {
    mail.uploadContacts();
    return { success: true };
  });

  // Newsletter subscription
  fastify.post('/newsletter_subscribe', async (request: any, reply) => {
    const { email, captchaToken } = request.body;
    if (!email || !utils.isValidEmail(email)) {
      reply
        .status(400)
        .send({ success: false, error: 'Invalid email address' });
      return;
    }

    const result = await mail.subscribeToNewsletter(email, captchaToken);
    return { success: result };
  });

  // Newsletter unsubscribe
  fastify.get('/unsubscribe/:hash', async (request: any, reply) => {
    const result = await mail.unsubscribe(request.params.hash);
    if (result) {
      reply.send({ success: true, message: 'Successfully unsubscribed' });
    } else {
      reply
        .status(400)
        .send({ success: false, message: 'Invalid unsubscribe link' });
    }
  });

  // Push notification registration
  fastify.post('/push/register', async (request: any, reply: any) => {
    const { token, type } = request.body;
    if (!token || !type) {
      reply.status(400).send({ error: 'Invalid request' });
      return;
    }

    await push.addToken(token, type);
    reply.send({ success: true });
  });

  // Reviews
  fastify.get(
    '/reviews/:locale/:amount/:landingPage',
    async (request: any, _reply) => {
      const amount = parseInt(request.params.amount) || 0;
      return await trustpilot.getReviews(
        true,
        amount,
        request.params.locale,
        utils.parseBoolean(request.params.landingPage)
      );
    }
  );

  fastify.get('/reviews_details', async (_request: any, _reply) => {
    return await trustpilot.getCompanyDetails();
  });

  fastify.get('/unsent_reviews', async (request: any, _reply) => {
    return await review.processReviewEmails();
  });

  // User suggestions
  fastify.get(
    '/usersuggestions/:paymentId/:userHash/:playlistId',
    async (request: any, reply) => {
      const suggestions = await suggestion.getUserSuggestions(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId
      );
      return { success: true, data: suggestions };
    }
  );

  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId',
    async (request: any, reply) => {
      const {
        trackId,
        name,
        artist,
        year,
        extraNameAttribute,
        extraArtistAttribute,
      } = request.body;

      if (!trackId || !name || !artist || !year) {
        reply
          .status(400)
          .send({ success: false, error: 'Missing required fields' });
        return;
      }

      const success = await suggestion.saveUserSuggestion(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        trackId,
        {
          name,
          artist,
          year,
          extraNameAttribute,
          extraArtistAttribute,
        }
      );

      return { success };
    }
  );

  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/submit',
    async (request: any, reply) => {
      const success = await suggestion.submitUserSuggestions(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        request.clientIp
      );
      return { success };
    }
  );

  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/extend',
    async (request: any, reply) => {
      const success = await suggestion.extendPrinterDeadline(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId
      );
      return { success };
    }
  );

  fastify.delete(
    '/usersuggestions/:paymentId/:userHash/:playlistId/:trackId',
    async (request: any, reply) => {
      const success = await suggestion.deleteUserSuggestion(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        parseInt(request.params.trackId)
      );
      return { success };
    }
  );

  // Designer upload
  fastify.post('/designer/upload/:type', async (request: any, reply) => {
    const { image, filename } = request.body;
    const { type } = request.params;

    if (!image) {
      reply.status(400).send({ success: false, error: 'No image provided' });
      return;
    }

    let result = { success: false };

    if (type == 'background') {
      result = await designer.uploadBackgroundImage(image, filename);
    } else if (type == 'logo') {
      result = await designer.uploadLogoImage(image, filename);
    }
    return result;
  });

  // Development routes
  if (process.env['ENVIRONMENT'] == 'development') {
    // Test audio generation
    fastify.post('/test_audio', async (request: any, reply: any) => {
      try {
        const { prompt, instructions } = request.body as {
          prompt?: string;
          instructions?: string;
        };

        if (!prompt) {
          reply.status(400).send({
            success: false,
            error: 'Missing required field: prompt',
          });
          return;
        }

        const filePath = await audio.generateAudio(prompt, instructions);
        reply.send({
          success: true,
          message: `Audio generated successfully at ${filePath}`,
        });
      } catch (error) {
        logger.log(`Error in /test_audio route: ${(error as Error).message}`);
        reply
          .status(500)
          .send({ success: false, error: 'Failed to generate audio' });
      }
    });

    // Push notification test
    fastify.post('/push', async (request: any, reply: any) => {
      const { token, title, message } = request.body;
      await push.sendPushNotification(token, title, message);
      reply.send({ success: true });
    });

    // QR test
    fastify.post('/qrtest', async (request: any, _reply) => {
      const result = await qr.generateQR(
        `${request.body.url}`,
        `/mnt/efs/qrsong/${request.body.filename}`
      );
      return { success: true };
    });

    // Test order
    fastify.get('/testorder', async (request: any, _reply) => {
      await order.testOrder();
      return { success: true };
    });

    // Calculate shipping
    fastify.get('/calculate_shipping', async (request: any, _reply) => {
      order.calculateShippingCosts();
      return { success: true };
    });

    // Generate order
    fastify.get('/generate/:paymentId', async (request: any, _reply) => {
      await generator.generate(
        request.params.paymentId,
        request.clientIp,
        '',
        mollie,
        false,
        false,
        false
      );
      return { success: true };
    });

    // Send mail
    fastify.get('/mail/:paymentId', async (request: any, _reply) => {
      // This would need mollie and data instances
      return { success: true };
    });

    // OpenAI release query
    fastify.get('/release/:query', async (request: any, _reply) => {
      const year = await openai.ask(request.params.query);
      return { success: true, year };
    });

    // Music year detection
    fastify.get(
      '/yearv2/:id/:isrc/:artist/:title/:spotifyReleaseYear',
      async (request: any, _reply) => {
        const result = await music.getReleaseDate(
          parseInt(request.params.id),
          request.params.isrc,
          request.params.artist,
          request.params.title,
          parseInt(request.params.spotifyReleaseYear)
        );
        return { success: true, data: result };
      }
    );

    // Translate genres
    fastify.get('/dev/translate_genres', async (_request: any, reply: any) => {
      try {
        data.translateGenres();
        reply.send({
          success: true,
          message: 'Genre translation process started.',
        });
      } catch (error) {
        logger.log(
          `Error in /dev/translate_genres route: ${(error as Error).message}`
        );
        reply
          .status(500)
          .send({ success: false, error: 'Failed to translate genres' });
      }
    });
  }
}
