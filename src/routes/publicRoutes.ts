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
import Shipping from '../shipping';
import { ChatService } from '../chat';
import PushoverClient from '../pushover';
import Promotional from '../promotional';
import BrokenLink from '../brokenLink';
import { FONTS } from '../fonts';
import { BACKGROUNDS } from '../backgrounds';
import { BOX_PRICE, BOX_MAX_CARDS, BOX_TIER_PRICES, EXTRA_TRACK_TIERS } from '../config/constants';
import Upgrade, { pickBoxDesignFields } from '../upgrade';
import PrismaInstance from '../prisma';
import { QRGAMES_UPGRADE_PRICE } from '../game';
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
  const shipping = Shipping.getInstance();
  const chatService = new ChatService();
  const promotional = Promotional.getInstance();
  const brokenLink = BrokenLink.getInstance();

  // Pricing constants endpoint
  fastify.get('/api/pricing', async (_request: any, reply: any) => {
    reply.send({
      boxUnitPrice: BOX_PRICE,
      boxMaxCards: BOX_MAX_CARDS,
      boxTierPrices: BOX_TIER_PRICES,
      gamesUnitPrice: QRGAMES_UPGRADE_PRICE,
    });
  });

  // Chat init endpoint - creates or resumes chat session
  fastify.post('/chat/init', async (request: any, reply: any) => {
    try {
      const { email, recaptchaToken, existingChatId } = request.body;

      // Verify reCAPTCHA
      const { isHuman } = await utils.verifyRecaptcha(recaptchaToken);
      if (!isHuman) {
        return reply.status(400).send({ success: false, error: 'reCAPTCHA verification failed' });
      }

      // Validate email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !emailRegex.test(email)) {
        return reply.status(400).send({ success: false, error: 'Valid email required' });
      }

      // If existingChatId provided, try to resume
      if (existingChatId) {
        const existingChat = await chatService.getChat(existingChatId);
        if (existingChat) {
          const hasMessages = await chatService.chatHasMessages(existingChatId);
          return reply.send({
            success: true,
            chatId: existingChat.id,
            username: existingChat.username,
            hasMessages,
            supportNeeded: existingChat.supportNeeded,
            hijacked: existingChat.hijacked
          });
        } else {
          // Chat was deleted, inform client to reset
          return reply.send({
            success: true,
            chatDeleted: true,
            message: 'Previous chat was deleted'
          });
        }
      }

      // Create new chat
      const chatId = await chatService.createChat(email);
      const username = email.split('@')[0];

      return reply.send({ success: true, chatId, username, hasMessages: false, supportNeeded: false });
    } catch (error) {
      logger.log(`Error in /chat/init: ${(error as Error).message}`);
      return reply.status(500).send({ success: false, error: 'Failed to initialize chat' });
    }
  });

  // Clear chat messages for user (soft delete)
  fastify.post('/chat/clear', async (request: any, reply: any) => {
    try {
      const { chatId } = request.body;
      if (!chatId) {
        return reply.status(400).send({ success: false, error: 'Chat ID required' });
      }
      await chatService.clearChatForUser(chatId);
      return reply.send({ success: true });
    } catch (error) {
      logger.log(`Error in /chat/clear: ${(error as Error).message}`);
      return reply.status(500).send({ success: false, error: 'Failed to clear chat' });
    }
  });

  // Mark chat as needing support
  fastify.post('/chat/support-needed', async (request: any, reply: any) => {
    try {
      const { chatId } = request.body;
      if (!chatId) {
        return reply.status(400).send({ success: false, error: 'Chat ID required' });
      }
      await chatService.markSupportNeeded(chatId);

      // Send Pushover notification
      const pushover = new PushoverClient();
      pushover.sendMessage({
        title: 'QRSong Chat Support',
        message: `Chat #${chatId} needs support`,
      }, request.clientIp);

      return reply.send({ success: true });
    } catch (error) {
      logger.log(`Error in /chat/support-needed: ${(error as Error).message}`);
      return reply.status(500).send({ success: false, error: 'Failed to mark support needed' });
    }
  });

  // Cache for robots.txt content
  let robotsTxtCache: string | null = null;

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
    try {
      const robotsContent =
        'User-agent: Googlebot\nDisallow:\nUser-agent: Googlebot-image\nDisallow:';

      reply.header('Content-Type', 'text/plain').send(robotsContent);
    } catch (error) {
      reply.status(500).send('Error serving robots.txt');
    }
  });

  // Conta  ct form
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
    '/usersuggestions/:paymentId/:userHash/:playlistId/apply-design',
    async (request: any, reply) => {
      const success = await suggestion.applyDesignChanges(
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

  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/reload',
    async (request: any, reply) => {
      const result = await suggestion.reloadPlaylist(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId
      );
      return result;
    }
  );

  fastify.post(
    '/usersuggestions/:paymentId/:userHash/regenerate',
    async (request: any, reply) => {
      const result = await suggestion.regenerateAndMail(
        request.params.paymentId,
        request.params.userHash
      );
      return result;
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
    const { image, filename, hideCircle, qrBackgroundType, kind } = request.body;
    const { type } = request.params;

    if (!image) {
      reply.status(400).send({ success: false, error: 'No image provided' });
      return;
    }

    // Tag uploads so the log makes clear whether they come from the card or
    // box designer. Defaults to 'card' for safety / backwards compatibility.
    const uploadKind: 'card' | 'box' = kind === 'box' ? 'box' : 'card';

    let result = { success: false };

    if (type == 'background') {
      // Convert hideCircle to qrBackgroundType for backward compatibility
      const backgroundType =
        qrBackgroundType || (hideCircle ? 'none' : 'square');
      result = await designer.uploadBackgroundImage(
        image,
        filename,
        backgroundType,
        uploadKind
      );
    } else if (type == 'backgroundBack') {
      // Upload background for the back side of cards
      const backgroundType = qrBackgroundType || 'square';
      result = await designer.uploadBackgroundBackImage(
        image,
        filename,
        backgroundType,
        uploadKind
      );
    } else if (type == 'logo') {
      result = await designer.uploadLogoImage(image, filename, uploadKind);
    }
    return result;
  });

  // Get card design for user suggestions
  fastify.get(
    '/usersuggestions/:paymentId/:userHash/:playlistId/design',
    async (request: any, reply) => {
      const { paymentId, userHash, playlistId } = request.params;

      const result = await designer.getCardDesign(
        paymentId,
        userHash,
        playlistId
      );

      if (!result.success) {
        reply.status(404).send(result);
        return;
      }

      return result;
    }
  );

  // Update card design for user suggestions
  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/design',
    async (request: any, reply) => {
      const { paymentId, userHash, playlistId } = request.params;
      const {
        type = 'physical',
        subType = 'none',
        background,
        logo,
        emoji,
        hideCircle,
        qrBackgroundType,
        qrColor,
        qrBackgroundColor,
        selectedFont,
        selectedFontSize,
        doubleSided,
        eco,
        backgroundFrontType,
        backgroundFrontColor,
        useFrontGradient,
        gradientFrontColor,
        gradientFrontDegrees,
        gradientFrontPosition,
        backgroundBack,
        backgroundBackType,
        backgroundBackColor,
        fontColor,
        useGradient,
        gradientBackgroundColor,
        gradientDegrees,
        gradientPosition,
        frontOpacity,
        backOpacity,
      } = request.body;

      const success = await designer.updateCardDesign(
        paymentId,
        userHash,
        playlistId,
        type,
        subType,
        {
          background,
          logo,
          emoji,
          hideCircle,
          qrBackgroundType,
          qrColor,
          qrBackgroundColor,
          selectedFont,
          selectedFontSize,
          doubleSided,
          eco,
          backgroundFrontType,
          backgroundFrontColor,
          useFrontGradient,
          gradientFrontColor,
          gradientFrontDegrees,
          gradientFrontPosition,
          backgroundBack,
          backgroundBackType,
          backgroundBackColor,
          fontColor,
          useGradient,
          gradientBackgroundColor,
          gradientDegrees,
          gradientPosition,
          frontOpacity,
          backOpacity,
        }
      );

      if (!success) {
        reply
          .status(403)
          .send({ success: false, error: 'Unauthorized or invalid request' });
        return;
      }

      return { success };
    }
  );

  // ===== User-suggestions upgrade endpoints =====
  // These are authenticated by paymentId + userHash (no JWT required) so the
  // email link "just works." They mirror /api/box/* but live on this page
  // rather than /my-account.

  const upgrade = Upgrade.getInstance();

  // Box: get saved design (no JWT — userHash-authenticated)
  fastify.get(
    '/usersuggestions/:paymentId/:userHash/:playlistId/box/design',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const ctx = await upgrade.verifyUserHash(paymentId, userHash, playlistId);
        if (!ctx) {
          return reply.status(403).send({ success: false, error: 'Unauthorized' });
        }
        return reply.send({
          success: true,
          design: pickBoxDesignFields(ctx.php),
        });
      } catch (error: any) {
        logger.log(`Error in GET /usersuggestions/.../box/design: ${error.message}`);
        return reply.status(500).send({ success: false, error: 'Failed to load box design' });
      }
    }
  );

  // Box: save design (without payment) — only allowed when box is already enabled
  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/box/design',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const { boxDesign } = request.body || {};
        const ctx = await upgrade.verifyUserHash(paymentId, userHash, playlistId);
        if (!ctx) {
          return reply.status(403).send({ success: false, error: 'Unauthorized' });
        }
        if (!ctx.php.boxEnabled) {
          return reply.status(400).send({
            success: false,
            error: 'Box is not yet enabled for this order',
          });
        }
        if (!boxDesign) {
          return reply.status(400).send({ success: false, error: 'Missing boxDesign' });
        }
        await PrismaInstance.getInstance().paymentHasPlaylist.update({
          where: { id: ctx.php.id },
          data: pickBoxDesignFields(boxDesign),
        });
        return reply.send({ success: true });
      } catch (error: any) {
        logger.log(`Error in POST /usersuggestions/.../box/design: ${error.message}`);
        return reply.status(500).send({ success: false, error: 'Failed to save box design' });
      }
    }
  );

  // Box: calculate price (EUR). Quantity is derived server-side from the
  // playlist's track count — clients do not supply it.
  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/box/calculate-price',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const ctx = await upgrade.verifyUserHash(paymentId, userHash, playlistId);
        if (!ctx) {
          return reply.status(403).send({ success: false, error: 'Unauthorized' });
        }
        if (ctx.php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Gift box is only available for physical orders',
          });
        }
        const price = await upgrade.calculateBoxUpgradePrice(ctx.php, ctx.payment);
        return reply.send({ success: true, ...price });
      } catch (error: any) {
        logger.log(`Error in POST /usersuggestions/.../box/calculate-price: ${error.message}`);
        return reply.status(500).send({ success: false, error: 'Failed to calculate price' });
      }
    }
  );

  // Box: create Mollie upgrade payment. No design is collected at this
  // step — the user designs the box AFTER unlocking it (post-payment).
  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/box/upgrade-payment',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const { locale, currency, digital } = request.body || {};
        const ctx = await upgrade.verifyUserHash(paymentId, userHash, playlistId);
        if (!ctx) {
          return reply.status(403).send({ success: false, error: 'Unauthorized' });
        }
        if (ctx.php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Gift box is only available for physical orders',
          });
        }

        const price = await upgrade.calculateBoxUpgradePrice(ctx.php, ctx.payment);

        // Persist the derived quantity now. Design will be added post-payment
        // via POST /usersuggestions/.../box/design once boxEnabled is true.
        await PrismaInstance.getInstance().paymentHasPlaylist.update({
          where: { id: ctx.php.id },
          data: { boxQuantity: price.boxQuantity },
        });

        const userLocale = locale || ctx.payment.locale || 'en';
        const digitalSegment = digital === undefined || digital === null
          ? '0'
          : String(parseInt(digital) || 0);
        const result = await mollie.createUpgradePayment({
          amountEur: price.totalEur,
          requestedCurrency: currency || ctx.payment.currency || 'EUR',
          description:
            price.boxQuantity > 1
              ? `Gift Box (${price.boxQuantity}x) - ${ctx.playlist.name}`
              : `Gift Box - ${ctx.playlist.name}`,
          locale: userLocale,
          redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/usersuggestions/${paymentId}/${userHash}/${playlistId}/${digitalSegment}?upgrade=box_success`,
          metadata: {
            type: 'box_upgrade',
            paymentHasPlaylistId: ctx.php.id.toString(),
            userId: ctx.user.id.toString(),
            originalPaymentId: ctx.payment.paymentId,
            shippingCost: '0',
            boxPrice: BOX_PRICE.toString(),
            quantity: price.boxQuantity.toString(),
            source: 'usersuggestions',
          },
          clientIp: request.clientIp,
        });

        return reply.send({ success: true, paymentUrl: result.checkoutUrl });
      } catch (error: any) {
        logger.log(`Error in POST /usersuggestions/.../box/upgrade-payment: ${error.message}`);
        console.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to create box upgrade payment',
        });
      }
    }
  );

  // Tracks: calculate price (EUR)
  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/tracks/calculate-price',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const { extraTracks } = request.body || {};
        const ctx = await upgrade.verifyUserHash(paymentId, userHash, playlistId);
        if (!ctx) {
          return reply.status(403).send({ success: false, error: 'Unauthorized' });
        }
        if (ctx.php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Track upgrade is only available for physical orders',
          });
        }
        const tier = parseInt(extraTracks);
        if (!(EXTRA_TRACK_TIERS as readonly number[]).includes(tier)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid extraTracks tier',
          });
        }
        const price = await upgrade.calculateExtraTracksPrice(ctx.php, ctx.payment, tier);
        return reply.send({
          success: true,
          ...price,
          currentNumberOfTracks: ctx.php.numberOfTracks,
        });
      } catch (error: any) {
        logger.log(`Error in POST /usersuggestions/.../tracks/calculate-price: ${error.message}`);
        return reply.status(500).send({ success: false, error: 'Failed to calculate price' });
      }
    }
  );

  // Tracks: create Mollie upgrade payment
  fastify.post(
    '/usersuggestions/:paymentId/:userHash/:playlistId/tracks/upgrade-payment',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const { extraTracks, locale, currency, digital } = request.body || {};
        const ctx = await upgrade.verifyUserHash(paymentId, userHash, playlistId);
        if (!ctx) {
          return reply.status(403).send({ success: false, error: 'Unauthorized' });
        }
        if (ctx.php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Track upgrade is only available for physical orders',
          });
        }
        const tier = parseInt(extraTracks);
        if (!(EXTRA_TRACK_TIERS as readonly number[]).includes(tier)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid extraTracks tier',
          });
        }
        if (ctx.php.userConfirmedPrinting) {
          return reply.status(400).send({
            success: false,
            error: 'Cannot add tracks after order has been confirmed for printing',
          });
        }
        const price = await upgrade.calculateExtraTracksPrice(ctx.php, ctx.payment, tier);
        const userLocale = locale || ctx.payment.locale || 'en';
        const digitalSegment = digital === undefined || digital === null
          ? '0'
          : String(parseInt(digital) || 0);
        const result = await mollie.createUpgradePayment({
          amountEur: price.totalEur,
          requestedCurrency: currency || ctx.payment.currency || 'EUR',
          description: `+${tier} tracks - ${ctx.playlist.name}`,
          locale: userLocale,
          redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/usersuggestions/${paymentId}/${userHash}/${playlistId}/${digitalSegment}?upgrade=tracks_success`,
          metadata: {
            type: 'tracks_upgrade',
            paymentHasPlaylistId: ctx.php.id.toString(),
            userId: ctx.user.id.toString(),
            originalPaymentId: ctx.payment.paymentId,
            extraTracks: tier.toString(),
            previousNumberOfTracks: (ctx.php.numberOfTracks || 0).toString(),
            source: 'usersuggestions',
          },
          clientIp: request.clientIp,
        });

        return reply.send({ success: true, paymentUrl: result.checkoutUrl });
      } catch (error: any) {
        logger.log(`Error in POST /usersuggestions/.../tracks/upgrade-payment: ${error.message}`);
        console.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to create tracks upgrade payment',
        });
      }
    }
  );

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

    // Generate order
    fastify.get('/generate/:paymentId', async (request: any, _reply) => {
      const userAgent = request.headers['user-agent'] || '';
      const jobId = await generator.queueGenerate(
        request.params.paymentId,
        request.clientIp,
        '',
        false,
        false,
        false,
        userAgent
      );
      return { success: true, jobId };
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

    // Test shipping
    fastify.get('/test_shipping/:paymentId', async (request: any, reply: any) => {
      try {
        const result = await shipping.createShipment(request.params.paymentId);
        reply.send({ success: true, data: result });
      } catch (error) {
        logger.log(
          `Error in /test_shipping route: ${(error as Error).message}`
        );
        reply.status(500).send({
          success: false,
          error: (error as Error).message,
        });
      }
    });

    // Test get tracking info
    fastify.get('/test_tracking/:paymentId', async (request: any, reply: any) => {
      try {
        const { result, updatedPayment } = await shipping.getTrackingInfo(request.params.paymentId);
        reply.send({ success: true, trackingData: result, payment: updatedPayment });
      } catch (error) {
        logger.log(
          `Error in /test_tracking route: ${(error as Error).message}`
        );
        reply.status(500).send({
          success: false,
          error: (error as Error).message,
        });
      }
    });

    // Development route to manually trigger shipping status updates (cron job)
    fastify.get('/dev_update_shipping_statuses', async (request: any, reply: any) => {
      try {
        logger.log('Manually triggering shipping status updates...');
        const summary = await shipping.updateAllShippingStatuses();
        reply.send({
          success: true,
          message: 'Shipping status update completed',
          summary,
        });
      } catch (error) {
        logger.log(
          `Error in /dev_update_shipping_statuses route: ${(error as Error).message}`
        );
        reply.status(500).send({
          success: false,
          error: (error as Error).message,
        });
      }
    });
  }

  // Public route to get average delivery times per country (past 2 weeks)
  fastify.get('/api/tracking/average-delivery-times', async (request: any, reply: any) => {
    try {
      const result = await shipping.getAverageDeliveryTimes();
      reply.send({ success: true, data: result });
    } catch (error) {
      logger.log(
        `Error in /api/tracking/average-delivery-times route: ${(error as Error).message}`
      );
      reply.status(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // Public route to get shipping information by country (delivery times + costs)
  fastify.get('/api/shipping/info-by-country', async (request: any, reply: any) => {
    try {
      const result = await shipping.getShippingInfoByCountry();
      reply.send({ success: true, data: result });
    } catch (error) {
      logger.log(
        `Error in /api/shipping/info-by-country route: ${(error as Error).message}`
      );
      reply.status(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // =============================================
  // Promotional playlist routes
  // =============================================

  // Get promotional setup data for a playlist
  fastify.get(
    '/promotional/:paymentId/:userHash/:playlistId',
    async (request: any, reply) => {
      const result = await promotional.getPromotionalSetup(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId
      );

      if (!result.success) {
        reply.status(result.error === 'Unauthorized' ? 401 : 400).send(result);
        return;
      }

      return result;
    }
  );

  // Save promotional setup data
  fastify.post(
    '/promotional/:paymentId/:userHash/:playlistId',
    async (request: any, reply) => {
      const { title, description, image, active, locale } = request.body;

      if (!title) {
        reply.status(400).send({ success: false, error: 'Title is required' });
        return;
      }

      if (!description) {
        reply.status(400).send({ success: false, error: 'Description is required' });
        return;
      }

      const result = await promotional.savePromotionalSetup(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        {
          title,
          description: description || '',
          image,
          active: active !== false,
          locale: locale || 'en',
        }
      );

      if (!result.success) {
        reply.status(result.error === 'Unauthorized' ? 401 : 400).send(result);
        return;
      }

      return result;
    }
  );

  // Check if promotional title/slug already exists
  fastify.post(
    '/promotional/:paymentId/:userHash/:playlistId/check-slug',
    async (request: any, reply) => {
      const { title } = request.body;

      if (!title) {
        reply.status(400).send({ success: false, error: 'Title is required' });
        return;
      }

      const result = await promotional.checkSlugAvailability(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        title
      );

      if (!result.success) {
        reply.status(result.error === 'Unauthorized' ? 401 : 400).send(result);
        return;
      }

      return result;
    }
  );

  // =============================================
  // Broken links logging (public endpoint for tracking)
  // =============================================

  // Log a broken link (public endpoint - no auth required)
  fastify.post('/broken-links', async (request: any, reply: any) => {
    try {
      const { url, type, errorType, serviceType } = request.body;
      const userAgent = request.headers['user-agent'] || '';

      if (!url || !type || !errorType) {
        return reply.status(400).send({
          success: false,
          error: 'Missing required fields: url, type, errorType',
        });
      }

      // Validate type
      if (type !== 'invalid' && type !== 'non-retrievable') {
        return reply.status(400).send({
          success: false,
          error: 'Invalid type. Must be "invalid" or "non-retrievable"',
        });
      }

      const result = await brokenLink.logBrokenLink({
        url,
        type,
        errorType,
        serviceType,
        userAgent,
      });

      if (result.success) {
        return reply.send({ success: true, id: result.id });
      } else {
        return reply.status(500).send({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error('Error logging broken link:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to log broken link',
      });
    }
  });

  // -- GET /fonts (public, no auth) --
  fastify.get('/fonts', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=86400');
    return { success: true, data: FONTS };
  });

  // -- GET /backgrounds (public, no auth) --
  fastify.get('/backgrounds', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=86400');
    return { success: true, data: BACKGROUNDS };
  });

}
