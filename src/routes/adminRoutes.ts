import { FastifyInstance } from 'fastify';
import { createOrUpdateAdminUser, deleteUserById } from '../auth';
import Generator from '../generator';
import GeneratorQueue from '../generatorQueue';
import ExcelQueue from '../excelQueue';
import AnalyticsClient from '../analytics';
import Data from '../data';
import Charts from '../charts';
import { OpenPerplex } from '../openperplex';
import Push from '../push';
import Discount from '../discount';
import PrinterInvoiceService from '../printerinvoice';
import Utils from '../utils';
import Mollie from '../mollie';
import Order from '../order';
import Suggestion from '../suggestion';
import Copy from '../copy';
import Excel from '../excel';
import Review from '../review';
import Shipping from '../shipping';
import SiteSettings from '../sitesettings';
import ShippingConfig from '../shippingconfig';
import Spotify from '../spotify';
import PrismaInstance from '../prisma';
import { ChatService } from '../chat';
import ChatWebSocketServer from '../chat-websocket';
import { ChatGPT } from '../chatgpt';
import Mail from '../mail';
import Promotional from '../promotional';
import BrokenLink from '../brokenLink';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import sharp from 'sharp';

export default async function adminRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const generator = Generator.getInstance();
  const analytics = AnalyticsClient.getInstance();
  const data = Data.getInstance();
  const openperplex = new OpenPerplex();
  const push = Push.getInstance();
  const discount = new Discount();
  const printerInvoice = PrinterInvoiceService.getInstance();
  const utils = new Utils();
  const mollie = new Mollie();
  const order = Order.getInstance();
  const suggestion = Suggestion.getInstance();
  const copy = Copy.getInstance();
  const review = Review.getInstance();
  const shipping = Shipping.getInstance();
  const spotify = Spotify.getInstance();
  const chatgpt = new ChatGPT();
  const mail = Mail.getInstance();
  const prisma = PrismaInstance.getInstance();
  const promotional = Promotional.getInstance();
  const brokenLink = BrokenLink.getInstance();

  // Create order (admin only)
  fastify.post(
    '/create_order',
    getAuthHandler(['admin']),
    async (request: any, reply) => {
      // Setup the payment for printer submission (reset status and clear tracking)
      await generator.setupForPrinter(request.body.paymentId);

      const result = await generator.sendToPrinter(
        request.body.paymentId,
        request.clientIp,
        true
      );

      if (!result.success) {
        return reply.status(409).send({
          success: false,
          error: result.reason || 'Order could not be sent',
        });
      }

      return result;
    }
  );

  // Create/update admin user
  fastify.post(
    '/admin/create',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const { email, password, displayName, companyId, userGroup, id } =
        request.body;

      if (!email || !displayName) {
        reply.status(400).send({ error: 'Missing required fields' });
        return;
      }

      try {
        const user = await createOrUpdateAdminUser(
          email,
          password,
          displayName,
          companyId,
          userGroup,
          id,
          request.user?.userGroups
        );
        reply.send({
          success: true,
          message: 'User created/updated successfully',
          userId: user.userId,
        });
      } catch (error) {
        console.error('Error creating admin user:', error);
        reply.status(500).send({ error: 'Failed to create admin user' });
      }
    }
  );

  // Delete user by ID
  fastify.delete(
    '/admin/user/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid user id' });
        return;
      }
      const result = await deleteUserById(id);
      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  // Verify payment
  fastify.get(
    '/verify/:paymentId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      data.verifyPayment(request.params.paymentId);
      reply.send({ success: true });
    }
  );

  // OpenPerplex AI query
  fastify.post(
    '/openperplex',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      const year = await openperplex.ask(
        request.body.artist,
        request.body.title
      );
      return { success: true, year };
    }
  );

  // Get last plays
  fastify.get(
    '/lastplays',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const lastPlays = await data.getLastPlays();
      reply.send({ success: true, data: lastPlays });
    }
  );

  // Broadcast push notification
  fastify.post(
    '/push/broadcast',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { title, message, test, dry } = request.body;
      await push.broadcastNotification(
        title,
        message,
        utils.parseBoolean(test),
        utils.parseBoolean(dry)
      );
      reply.send({ success: true });
    }
  );

  // Get push messages
  fastify.get(
    '/push/messages',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      return await push.getMessages();
    }
  );

  // Regenerate order
  fastify.get(
    '/regenerate/:paymentId/:email',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      // Old PDFs are automatically cleared by generator.generate()
      const userAgent = request.headers['user-agent'] || '';
      const jobId = await generator.queueGenerate(
        request.params.paymentId,
        request.clientIp,
        '',
        true, // Force finalize
        !utils.parseBoolean(request.params.email), // Skip main mail
        false,
        userAgent
      );
      return { success: true, jobId };
    }
  );

  // Regenerate order (Only product email)
  fastify.get(
    '/regenerate-product-only/:paymentId',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      // Old PDFs are automatically cleared by generator.generate()
      const userAgent = request.headers['user-agent'] || '';
      // This will skip the main "order received" email but still send product emails
      const jobId = await generator.queueGenerate(
        request.params.paymentId,
        request.clientIp,
        '',
        true, // Force finalize
        false, // Don't skip main mail (but onlyProductMail will handle it)
        true, // Only product mail
        userAgent
      );
      return { success: true, jobId };
    }
  );

  // Queue status endpoints
  fastify.get('/queue/status', getAuthHandler(['admin']), async () => {
    if (!process.env['REDIS_URL']) {
      return { error: 'Queue not configured' };
    }

    const generatorQueue = GeneratorQueue.getInstance();
    const status = await generatorQueue.getQueueStatus();
    return { success: true, status };
  });

  // Get detailed queue status with jobs
  fastify.get(
    '/queue/detailed',
    getAuthHandler(['admin']),
    async (request: any) => {
      if (!process.env['REDIS_URL']) {
        return { error: 'Queue not configured' };
      }

      try {
        const generatorQueue = GeneratorQueue.getInstance();
        const detailedStatus = await generatorQueue.getDetailedQueueStatus();
        return { success: true, ...detailedStatus };
      } catch (error: any) {
        console.error('Error getting detailed queue status:', error);
        return {
          error: 'Failed to get queue details',
          message: error.message || 'Unknown error',
        };
      }
    }
  );

  // Get jobs by status with pagination
  fastify.get(
    '/queue/jobs/:status',
    getAuthHandler(['admin']),
    async (request: any) => {
      if (!process.env['REDIS_URL']) {
        return { error: 'Queue not configured' };
      }

      const { status } = request.params;
      const { start = 0, end = 50 } = request.query;

      const validStatuses = [
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      ];
      if (!validStatuses.includes(status)) {
        return {
          error: 'Invalid status. Must be one of: ' + validStatuses.join(', '),
        };
      }

      try {
        const generatorQueue = GeneratorQueue.getInstance();
        const jobs = await generatorQueue.getJobsByStatus(
          status as any,
          parseInt(start),
          parseInt(end)
        );
        return { success: true, jobs, status };
      } catch (error: any) {
        console.error('Error getting jobs by status:', error);
        return {
          error: 'Failed to get jobs',
          message: error.message || 'Unknown error',
        };
      }
    }
  );

  fastify.get(
    '/queue/job/:jobId',
    getAuthHandler(['admin']),
    async (request: any) => {
      if (!process.env['REDIS_URL']) {
        return { error: 'Queue not configured' };
      }

      const generatorQueue = GeneratorQueue.getInstance();
      const job = await generatorQueue.getJobStatus(request.params.jobId);

      if (!job) {
        return { error: 'Job not found' };
      }

      return { success: true, job };
    }
  );

  // Retry a specific job
  fastify.post(
    '/queue/job/:jobId/retry',
    getAuthHandler(['admin']),
    async (request: any) => {
      if (!process.env['REDIS_URL']) {
        return { error: 'Queue not configured' };
      }

      try {
        const generatorQueue = GeneratorQueue.getInstance();
        await generatorQueue.retryJob(request.params.jobId);
        return { success: true, message: 'Job requeued for retry' };
      } catch (error: any) {
        console.error('Error retrying job:', error);
        return {
          error: 'Failed to retry job',
          message: error.message || 'Unknown error',
        };
      }
    }
  );

  // Remove a specific job
  fastify.delete(
    '/queue/job/:jobId',
    getAuthHandler(['admin']),
    async (request: any) => {
      if (!process.env['REDIS_URL']) {
        return { error: 'Queue not configured' };
      }

      try {
        const generatorQueue = GeneratorQueue.getInstance();
        await generatorQueue.removeJob(request.params.jobId);
        return { success: true, message: 'Job removed' };
      } catch (error: any) {
        console.error('Error removing job:', error);
        return {
          error: 'Failed to remove job',
          message: error.message || 'Unknown error',
        };
      }
    }
  );

  // Pause the queue
  fastify.post('/queue/pause', getAuthHandler(['admin']), async () => {
    if (!process.env['REDIS_URL']) {
      return { error: 'Queue not configured' };
    }

    try {
      const generatorQueue = GeneratorQueue.getInstance();
      await generatorQueue.pauseQueue();
      return { success: true, message: 'Queue paused' };
    } catch (error: any) {
      console.error('Error pausing queue:', error);
      return {
        error: 'Failed to pause queue',
        message: error.message || 'Unknown error',
      };
    }
  });

  // Resume the queue
  fastify.post('/queue/resume', getAuthHandler(['admin']), async () => {
    if (!process.env['REDIS_URL']) {
      return { error: 'Queue not configured' };
    }

    try {
      const generatorQueue = GeneratorQueue.getInstance();
      await generatorQueue.resumeQueue();
      return { success: true, message: 'Queue resumed' };
    } catch (error: any) {
      console.error('Error resuming queue:', error);
      return {
        error: 'Failed to resume queue',
        message: error.message || 'Unknown error',
      };
    }
  });

  fastify.post('/queue/retry-failed', getAuthHandler(['admin']), async () => {
    if (!process.env['REDIS_URL']) {
      return { error: 'Queue not configured' };
    }

    const generatorQueue = GeneratorQueue.getInstance();
    await generatorQueue.retryFailedJobs();
    return { success: true, message: 'Failed jobs requeued for retry' };
  });

  fastify.post('/queue/clear', getAuthHandler(['admin']), async () => {
    if (!process.env['REDIS_URL']) {
      return { error: 'Queue not configured' };
    }

    const generatorQueue = GeneratorQueue.getInstance();
    await generatorQueue.clearQueue();
    return { success: true, message: 'Queue cleared' };
  });

  // Get orders with search
  fastify.post(
    '/orders',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const search = {
        ...request.body,
        page: request.body.page || 1,
        itemsPerPage: request.body.itemsPerPage || 10,
      };

      const { payments, totalItems } = await mollie.getPaymentList(search);

      reply.send({
        data: payments,
        totalItems,
        currentPage: search.page,
        itemsPerPage: search.itemsPerPage,
      });
    }
  );

  // Delete payment permanently
  fastify.delete(
    '/payment/:paymentId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentId } = request.params;

      if (!paymentId) {
        reply
          .status(400)
          .send({ success: false, error: 'Payment ID is required' });
        return;
      }

      try {
        const result = await mollie.deletePayment(paymentId);

        if (result.success) {
          reply.send({
            success: true,
            message: 'Payment deleted successfully',
          });
        } else {
          reply.status(404).send({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('Error deleting payment:', error);
        reply
          .status(500)
          .send({ success: false, error: 'Failed to delete payment' });
      }
    }
  );

  // Duplicate payment and regenerate
  fastify.post(
    '/admin/payment/:paymentId/duplicate',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentId } = request.params;

      if (!paymentId) {
        reply.status(400).send({
          success: false,
          error: 'Payment ID is required',
        });
        return;
      }

      try {
        // Duplicate the payment
        const result = await copy.duplicatePayment(paymentId);

        if (!result.success) {
          reply.status(404).send({ success: false, error: result.error });
          return;
        }

        // Queue regeneration for the new payment
        const userAgent = request.headers['user-agent'] || '';
        const jobId = await generator.queueGenerate(
          result.newPaymentId!,
          request.clientIp,
          '',
          true, // Force finalize
          false, // Don't skip main mail
          false, // Not only product mail
          userAgent
        );

        reply.send({
          success: true,
          message: 'Payment duplicated and queued for regeneration',
          newPaymentId: result.newPaymentId,
          jobId: jobId,
        });
      } catch (error) {
        console.error('Error duplicating payment:', error);
        reply.status(500).send({
          success: false,
          error: 'Failed to duplicate payment',
        });
      }
    }
  );

  // Update printer hold status for payment
  fastify.post(
    '/payment/:paymentId/printer-hold',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentId } = request.params;
      const { printerHold } = request.body;

      if (!paymentId) {
        reply.status(400).send({
          success: false,
          error: 'Payment ID is required',
        });
        return;
      }

      if (typeof printerHold !== 'boolean') {
        reply.status(400).send({
          success: false,
          error: 'printerHold must be a boolean',
        });
        return;
      }

      const result = await data.updatePaymentPrinterHold(
        paymentId,
        printerHold
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Payment not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Update express status for payment
  fastify.post(
    '/payment/:paymentId/express',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentId } = request.params;
      const { fast } = request.body;

      if (!paymentId) {
        reply.status(400).send({
          success: false,
          error: 'Payment ID is required',
        });
        return;
      }

      if (typeof fast !== 'boolean') {
        reply.status(400).send({
          success: false,
          error: 'fast must be a boolean',
        });
        return;
      }

      const result = await data.updatePaymentExpress(paymentId, fast);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Payment not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Update blocked status for playlist
  fastify.post(
    '/admin/playlist/:playlistId/blocked',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;
      const { blocked } = request.body;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      if (typeof blocked !== 'boolean') {
        reply.status(400).send({
          success: false,
          error: 'blocked must be a boolean',
        });
        return;
      }

      const result = await data.updatePlaylistBlocked(
        parseInt(playlistId, 10),
        blocked
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Playlist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Update featured status for playlist
  fastify.post(
    '/admin/playlist/:playlistId/featured',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;
      const { featured } = request.body;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      if (typeof featured !== 'boolean') {
        reply.status(400).send({
          success: false,
          error: 'featured must be a boolean',
        });
        return;
      }

      const result = await data.updatePlaylistFeatured(playlistId, featured);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Playlist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Get pending promotional playlists count (for menu badge)
  fastify.get(
    '/admin/promotional/pending-count',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const playlists = await data.getPendingPromotionalPlaylists();
      reply.send({ success: true, count: playlists.length });
    }
  );

  // Get pending promotional playlists
  fastify.get(
    '/admin/promotional/pending',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const playlists = await data.getPendingPromotionalPlaylists();
      reply.send({ success: true, data: playlists });
    }
  );

  // Get accepted promotional playlists
  fastify.get(
    '/admin/promotional/accepted',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const playlists = await data.getAcceptedPromotionalPlaylists();
      reply.send({ success: true, data: playlists });
    }
  );

  // Accept promotional playlist (translates description to all locales and sends approval email)
  fastify.post(
    '/admin/promotional/:playlistId/accept',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await promotional.acceptPromotionalPlaylist(playlistId);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Playlist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Decline promotional playlist
  fastify.post(
    '/admin/promotional/:playlistId/decline',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await data.declinePromotionalPlaylist(playlistId);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Playlist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Reload promotional playlist cache (clears cache for already approved playlists)
  fastify.post(
    '/admin/promotional/:playlistId/reload',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await data.clearPlaylistCache(playlistId);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Resend approval email for an approved promotional playlist
  fastify.post(
    '/admin/promotional/:playlistId/resend-email',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await promotional.resendApprovalEmail(playlistId);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Playlist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Retranslate description for a playlist (used after editing description)
  fastify.post(
    '/admin/promotional/:playlistId/translate',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await promotional.translateDescription(playlistId);

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'Playlist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Update featured locale for a playlist
  fastify.post(
    '/admin/promotional/:playlistId/locale',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;
      const { featuredLocale } = request.body;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      // featuredLocale can be null (for "All") or a valid locale string
      const result = await data.updateFeaturedLocale(
        playlistId,
        featuredLocale || null
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Edit promotional playlist (name, description, locale, slug)
  fastify.post(
    '/admin/promotional/:playlistId/edit',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;
      const { name, description, featuredLocale, slug } = request.body;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await data.updatePromotionalPlaylist(playlistId, {
        name,
        description,
        featuredLocale: featuredLocale || null,
        slug,
      });

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(400).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Get all featured playlists (featured = 1)
  fastify.get(
    '/admin/featured/all',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const playlists = await data.getAllFeaturedPlaylists();
      reply.send({ success: true, data: playlists });
    }
  );

  // Update featured hidden status for a playlist
  fastify.post(
    '/admin/playlist/:playlistId/featured-hidden',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;
      const { featuredHidden } = request.body;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      const result = await data.updateFeaturedHidden(
        playlistId,
        featuredHidden === true
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Upload custom image for a featured playlist
  fastify.post(
    '/admin/featured/:playlistId/upload-image',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      try {
        // Check if the playlist exists
        const playlist = await prisma.playlist.findUnique({
          where: { playlistId },
          select: { id: true, customImage: true },
        });

        if (!playlist) {
          reply.status(404).send({
            success: false,
            error: 'Playlist not found',
          });
          return;
        }

        // Process multipart data
        const parts = request.parts();
        let imageBuffer: Buffer | null = null;

        for await (const part of parts) {
          if (part.type === 'file' && part.fieldname === 'image') {
            imageBuffer = await part.toBuffer();
          }
        }

        if (!imageBuffer) {
          reply.status(400).send({
            success: false,
            error: 'No image file provided',
          });
          return;
        }

        // Create playlist_images directory if it doesn't exist
        const imagesDir = path.join(
          process.env['PUBLIC_DIR'] as string,
          'playlist_images'
        );
        await fsPromises.mkdir(imagesDir, { recursive: true });

        // Generate unique filename
        const uniqueId = utils.generateRandomString(32);
        const filename = `${uniqueId}.png`;
        const filePath = path.join(imagesDir, filename);

        // Process image with Sharp: resize if larger than 1600px, maintain aspect ratio
        const processedBuffer = await sharp(imageBuffer)
          .resize(1600, 1600, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9, quality: 90 })
          .toBuffer();

        // Write the processed file
        await fsPromises.writeFile(filePath, processedBuffer);

        // Delete old custom image if exists
        if (playlist.customImage) {
          const oldImagePath = path.join(
            process.env['PUBLIC_DIR'] as string,
            playlist.customImage.replace('/public/', '')
          );
          try {
            await fsPromises.unlink(oldImagePath);
          } catch {
            // Ignore if old file doesn't exist
          }
        }

        // Update database with new custom image path
        const customImagePath = `/public/playlist_images/${filename}`;
        await prisma.playlist.update({
          where: { playlistId },
          data: { customImage: customImagePath },
        });

        reply.send({
          success: true,
          customImage: customImagePath,
        });
      } catch (error: any) {
        console.error('Error uploading playlist image:', error);
        reply.status(500).send({
          success: false,
          error: 'Failed to upload image',
        });
      }
    }
  );

  // Remove custom image from a featured playlist
  fastify.post(
    '/admin/featured/:playlistId/remove-image',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { playlistId } = request.params;

      if (!playlistId) {
        reply.status(400).send({
          success: false,
          error: 'Playlist ID is required',
        });
        return;
      }

      try {
        // Get the playlist to find the current custom image
        const playlist = await prisma.playlist.findUnique({
          where: { playlistId },
          select: { customImage: true },
        });

        if (!playlist) {
          reply.status(404).send({
            success: false,
            error: 'Playlist not found',
          });
          return;
        }

        // Delete the file if it exists
        if (playlist.customImage) {
          const imagePath = path.join(
            process.env['PUBLIC_DIR'] as string,
            playlist.customImage.replace('/public/', '')
          );
          try {
            await fsPromises.unlink(imagePath);
          } catch {
            // Ignore if file doesn't exist
          }
        }

        // Update database to remove custom image
        await prisma.playlist.update({
          where: { playlistId },
          data: { customImage: null },
        });

        reply.send({ success: true });
      } catch (error: any) {
        console.error('Error removing playlist image:', error);
        reply.status(500).send({
          success: false,
          error: 'Failed to remove image',
        });
      }
    }
  );

  // Reset judged status for payment_has_playlist
  fastify.post(
    '/admin/playlist/:paymentHasPlaylistId/judged',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentHasPlaylistId } = request.params;

      if (!paymentHasPlaylistId) {
        reply.status(400).send({
          success: false,
          error: 'PaymentHasPlaylist ID is required',
        });
        return;
      }

      const result = await data.resetJudgedStatus(
        parseInt(paymentHasPlaylistId, 10)
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'PaymentHasPlaylist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Update track count for payment_has_playlist and playlist
  fastify.post(
    '/admin/playlist/:paymentHasPlaylistId/track-count',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentHasPlaylistId } = request.params;
      const { numberOfTracks } = request.body;

      if (!paymentHasPlaylistId) {
        reply.status(400).send({
          success: false,
          error: 'PaymentHasPlaylist ID is required',
        });
        return;
      }

      if (typeof numberOfTracks !== 'number' || numberOfTracks < 0) {
        reply.status(400).send({
          success: false,
          error: 'Valid numberOfTracks is required',
        });
        return;
      }

      const result = await data.updatePlaylistTrackCount(
        parseInt(paymentHasPlaylistId, 10),
        numberOfTracks
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'PaymentHasPlaylist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Update amount for payment_has_playlist
  fastify.post(
    '/admin/playlist/:paymentHasPlaylistId/amount',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentHasPlaylistId } = request.params;
      const { amount } = request.body;

      if (!paymentHasPlaylistId) {
        reply.status(400).send({
          success: false,
          error: 'PaymentHasPlaylist ID is required',
        });
        return;
      }

      if (typeof amount !== 'number' || amount < 1) {
        reply.status(400).send({
          success: false,
          error: 'Valid amount (minimum 1) is required',
        });
        return;
      }

      const result = await data.updatePlaylistAmount(
        parseInt(paymentHasPlaylistId, 10),
        amount
      );

      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(result.error === 'PaymentHasPlaylist not found' ? 404 : 500).send({
          success: false,
          error: result.error,
        });
      }
    }
  );

  // Analytics
  fastify.get(
    '/analytics',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const analytics = await AnalyticsClient.getInstance().getAllCounters();
      reply.send({ success: true, data: analytics });
    }
  );

  // Chart data - 30-day moving average
  const charts = Charts.getInstance();

  fastify.get(
    '/admin/charts/moving-average',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { days, startDate, endDate } = request.query;
        const daysNum = days ? parseInt(days as string) : undefined;

        const chartData = await charts.getMovingAverage(
          daysNum,
          startDate as string | undefined,
          endDate as string | undefined
        );

        reply.send({
          success: true,
          data: chartData
        });
      } catch (error: any) {
        console.error('Error fetching chart data:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch chart data'
        });
      }
    }
  );

  // Chart data - Hourly sales average
  fastify.get(
    '/admin/charts/hourly-sales',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { days, startDate, endDate } = request.query;
        const daysNum = days ? parseInt(days as string) : undefined;

        const chartData = await charts.getHourlySales(
          daysNum,
          startDate as string | undefined,
          endDate as string | undefined
        );

        reply.send({
          success: true,
          data: chartData
        });
      } catch (error: any) {
        console.error('Error fetching hourly chart data:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch hourly chart data'
        });
      }
    }
  );

  // Chart data - Daily sales average (by day of week)
  fastify.get(
    '/admin/charts/daily-sales',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { days, startDate, endDate } = request.query;
        const daysNum = days ? parseInt(days as string) : undefined;

        const chartData = await charts.getDailySales(
          daysNum,
          startDate as string | undefined,
          endDate as string | undefined
        );

        reply.send({
          success: true,
          data: chartData
        });
      } catch (error: any) {
        console.error('Error fetching daily chart data:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch daily chart data'
        });
      }
    }
  );

  // Search tracks
  fastify.post(
    '/tracks/search',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      const { searchTerm = '', missingYouTubeLink } = request.body;
      const tracks = await data.searchTracks(
        searchTerm,
        utils.parseBoolean(missingYouTubeLink)
      );
      return { success: true, data: tracks };
    }
  );

  // Update track
  fastify.post(
    '/tracks/update',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      const {
        id,
        artist,
        name,
        year,
        spotifyLink,
        youtubeMusicLink,
        appleMusicLink,
        tidalLink,
        deezerLink,
      } = request.body;

      if (!id || !artist || !name || year === undefined || year === null) {
        return { success: false, error: 'Missing required fields' };
      }
      const result = await data.updateTrack(
        id,
        artist,
        name,
        year,
        spotifyLink || '',
        youtubeMusicLink || '',
        appleMusicLink || '',
        tidalLink || '',
        deezerLink || '',
        request.clientIp
      );
      return result;
    }
  );

  // Get tracks missing Spotify link
  fastify.post(
    '/tracks/missing-spotify',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      const { searchTerm = '' } = request.body;
      const tracks = await data.getTracksMissingSpotifyLink(searchTerm);
      return { success: true, data: tracks };
    }
  );

  // Get count of tracks missing Spotify link
  fastify.get(
    '/tracks/missing-spotify-count',
    getAuthHandler(['admin']),
    async (_request: any, _reply) => {
      const count = await data.getTracksMissingSpotifyLinkCount();
      return { success: true, count };
    }
  );

  // Force fetch MusicFetch links for a single track (bypasses attempt limit)
  fastify.post(
    '/tracks/musicfetch',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      const { trackId } = request.body;
      if (!trackId) {
        return { success: false, error: 'Missing trackId' };
      }

      try {
        const MusicFetch = (await import('../musicfetch')).default;
        const musicFetch = MusicFetch.getInstance();
        const success = await musicFetch.updateTrackWithLinks(trackId, true);

        if (success) {
          // Fetch the updated track data to return
          const track = await data.getTrackById(trackId);
          return { success: true, track };
        } else {
          return { success: false, error: 'Failed to fetch links - track may not have any existing links to use as source' };
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  );

  // Search Spotify tracks (for admin track management)
  fastify.post(
    '/tracks/spotify-search',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      const { searchTerm, limit = 10 } = request.body;
      if (!searchTerm || searchTerm.length < 2) {
        return { success: false, error: 'Search term too short' };
      }

      try {
        const result = await spotify.searchTracks(searchTerm, limit, 0);
        return result;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  );

  // Year check queue
  fastify.get(
    '/yearcheck/queue',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const queue = await data.getYearCheckQueue();
      reply.send({
        success: true,
        queue,
      });
    }
  );

  // Year check
  fastify.get(
    '/yearcheck',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const result = await data.getFirstUncheckedTrack();
      reply.send({
        success: true,
        track: result.track,
        totalUnchecked: result.totalUnchecked,
        currentPlaylistId: result.currentPlaylistId,
        serviceType: result.serviceType,
      });
    }
  );

  // Update year check
  fastify.post(
    '/yearcheck',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const result = await data.updateTrackCheck(
        request.body.trackId,
        request.body.year
      );
      if (result.success && result.checkedPaymentIds!.length > 0) {
        for (const paymentId of result.checkedPaymentIds!) {
          generator.finalizeOrder(paymentId, mollie);
        }
      }
      reply.send({ success: true });
    }
  );

  // Check unfinalized
  fastify.get(
    '/check_unfinalized',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      data.checkUnfinalizedPayments();
      reply.send({ success: true });
    }
  );

  // Process playback counts for review eligibility
  fastify.post(
    '/admin/process_playback_counts',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const result = await review.processPlaybackCounts();
      reply.send(result);
    }
  );

  // Month report
  fastify.get(
    '/month_report/:yearMonth',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { yearMonth } = request.params;
      const year = parseInt(yearMonth.substring(0, 4));
      const month = parseInt(yearMonth.substring(4, 6));

      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      const report = await mollie.getPaymentsByMonth(startDate, endDate);

      reply.send({
        success: true,
        data: report,
      });
    }
  );

  // Add Spotify links
  fastify.get(
    '/add_spotify',
    getAuthHandler(['admin']),
    async (_request: any, reply) => {
      const result = data.addSpotifyLinks();
      return { success: true, processed: result };
    }
  );

  // Tax report
  fastify.get(
    '/tax_report/:yearMonth',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { yearMonth } = request.params;
      const year = parseInt(yearMonth.substring(0, 4));
      const month = parseInt(yearMonth.substring(4, 6));

      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);

      const report = await mollie.getPaymentsByTaxRate(startDate, endDate);

      reply.send({
        success: true,
        data: report,
      });
    }
  );

  // Day report
  fastify.get(
    '/day_report',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const report = await mollie.getPaymentsByDay();
      reply.send({
        success: true,
        data: report,
      });
    }
  );

  // Get corrections
  fastify.get(
    '/corrections',
    getAuthHandler(['admin']),
    async (_request: any, reply) => {
      const corrections = await suggestion.getCorrections();
      return { success: true, data: corrections };
    }
  );

  // Process corrections
  fastify.post(
    '/correction/:paymentId/:userHash/:playlistId/:andSend',
    getAuthHandler(['admin']),
    async (request: any, reply) => {
      const { artistOnlyForMe, titleOnlyForMe, yearOnlyForMe } = request.body;
      await suggestion.processCorrections(
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        artistOnlyForMe,
        titleOnlyForMe,
        yearOnlyForMe,
        utils.parseBoolean(request.params.andSend),
        request.clientIp
      );
      return { success: true };
    }
  );

  // Finalize order
  fastify.post(
    '/finalize',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      generator.finalizeOrder(request.body.paymentId, mollie);
      reply.send({ success: true });
    }
  );

  // Download invoice
  fastify.get(
    '/download_invoice/:invoiceId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { invoiceId } = request.params;
      const orderInstance = order;

      try {
        const invoicePath = await orderInstance.getInvoice(invoiceId);
        // Ensure the file exists and is readable
        try {
          await fsPromises.access(invoicePath, fs.constants.R_OK);
        } catch (error) {
          reply.code(404).send('File not found.');
          return;
        }

        // Serve the file for download
        reply.header(
          'Content-Disposition',
          'attachment; filename=' + path.basename(invoicePath)
        );
        reply.type('application/pdf');

        // Read the file into memory and send it as a buffer
        try {
          const fileContent = await fsPromises.readFile(invoicePath);
          reply.send(fileContent);
        } catch (error) {
          reply.code(500).send('Error reading file.');
        }
      } catch (error) {
        console.log(error);
        reply.status(500).send({ error: 'Failed to download invoice' });
      }
    }
  );

  // Get payment info
  fastify.get(
    '/payment/:paymentId/info',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentId } = request.params;

      try {
        const payment = await mollie.getPayment(paymentId);

        if (!payment) {
          reply.code(404).send({ error: 'Payment not found' });
          return;
        }

        reply.send({
          fullname: payment.fullname || '',
          email: payment.email || '',
          isBusinessOrder: payment.isBusinessOrder || false,
          companyName: payment.companyName || '',
          vatId: payment.vatId || '',
          address: payment.address || '',
          housenumber: payment.housenumber || '',
          city: payment.city || '',
          zipcode: payment.zipcode || '',
          countrycode: payment.countrycode || '',
          differentInvoiceAddress: payment.differentInvoiceAddress || false,
          invoiceAddress: payment.invoiceAddress || '',
          invoiceHousenumber: payment.invoiceHousenumber || '',
          invoiceCity: payment.invoiceCity || '',
          invoiceZipcode: payment.invoiceZipcode || '',
          invoiceCountrycode: payment.invoiceCountrycode || '',
        });
      } catch (error) {
        console.error(error);
        reply.status(500).send({ error: 'Failed to get payment info' });
      }
    }
  );

  // Update payment info
  fastify.put(
    '/payment/:paymentId/info',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const { paymentId } = request.params;
      const {
        fullname,
        email,
        isBusinessOrder,
        companyName,
        vatId,
        address,
        housenumber,
        city,
        zipcode,
        countrycode,
        differentInvoiceAddress,
        invoiceAddress,
        invoiceHousenumber,
        invoiceCity,
        invoiceZipcode,
        invoiceCountrycode,
      } = request.body;

      try {
        await order.updatePaymentInfo(paymentId, {
          fullname,
          email,
          isBusinessOrder,
          companyName,
          vatId,
          address,
          housenumber,
          city,
          zipcode,
          countrycode,
          differentInvoiceAddress,
          invoiceAddress,
          invoiceHousenumber,
          invoiceCity,
          invoiceZipcode,
          invoiceCountrycode,
        });

        reply.send({ success: true });
      } catch (error) {
        console.error(error);
        reply.status(500).send({ error: 'Failed to update payment info' });
      }
    }
  );

  // Update PaymentHasPlaylist
  fastify.post(
    '/php/:paymentHasPlaylistId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const paymentHasPlaylistId = parseInt(
          request.params.paymentHasPlaylistId
        );
        const { eco, doubleSided, printerType, template } = request.body;

        if (isNaN(paymentHasPlaylistId)) {
          reply
            .status(400)
            .send({ success: false, error: 'Invalid paymentHasPlaylistId' });
          return;
        }

        // Validate required boolean fields
        if (typeof eco !== 'boolean' || typeof doubleSided !== 'boolean') {
          reply.status(400).send({
            success: false,
            error: 'Invalid eco or doubleSided value. Must be boolean.',
          });
          return;
        }

        // Validate printerType if provided
        if (printerType !== undefined && typeof printerType !== 'string') {
          reply.status(400).send({
            success: false,
            error: 'Invalid printerType value. Must be string.',
          });
          return;
        }

        if (printerType && !['printnbind', 'tromp'].includes(printerType)) {
          reply.status(400).send({
            success: false,
            error: 'Invalid printerType value. Must be "printnbind" or "tromp".',
          });
          return;
        }

        // Validate template if provided
        if (template !== undefined && template !== null && typeof template !== 'string') {
          reply.status(400).send({
            success: false,
            error: 'Invalid template value. Must be string or null.',
          });
          return;
        }

        const result = await data.updatePaymentHasPlaylist(
          paymentHasPlaylistId,
          eco,
          doubleSided,
          printerType,
          template
        );

        if (!result.success) {
          reply.status(500).send(result);
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error(
          `Error in /php/:paymentHasPlaylistId route: ${
            (error as Error).message
          }`
        );
        reply
          .status(500)
          .send({ success: false, error: 'Internal server error' });
      }
    }
  );

  // Export playlist to Excel
  fastify.get(
    '/admin/playlist-excel/:paymentId/:paymentHasPlaylistId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { paymentId, paymentHasPlaylistId } = request.params;
        const paymentHasPlaylistIdInt = parseInt(paymentHasPlaylistId);

        if (isNaN(paymentHasPlaylistIdInt)) {
          reply.status(400).send({
            success: false,
            error: 'Invalid paymentHasPlaylistId',
          });
          return;
        }

        // Generate Excel file
        const excelBuffer = await data.generatePlaylistExcel(
          paymentId,
          paymentHasPlaylistIdInt
        );

        if (!excelBuffer) {
          reply.status(404).send({
            success: false,
            error: 'Playlist not found',
          });
          return;
        }

        // Set response headers for Excel file download
        reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header(
            'Content-Disposition',
            `attachment; filename="playlist-${paymentId}-${paymentHasPlaylistId}.xlsx"`
          )
          .send(excelBuffer);
      } catch (error) {
        console.error('Error generating Excel file:', error);
        reply.status(500).send({
          success: false,
          error: 'Failed to generate Excel file',
        });
      }
    }
  );

  // Discount code management
  fastify.post(
    '/admin/discount/create',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const result = await discount.createAdminDiscountCode(request.body);
      if (result.success) {
        reply.send({ success: true, code: result.code });
      } else {
        reply.status(400).send({ success: false, error: result.error });
      }
    }
  );

  fastify.get(
    '/admin/discount/all',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const result = await discount.getAllDiscounts();
      if (result.success) {
        reply.send({ success: true, discounts: result.discounts });
      } else {
        reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  fastify.delete(
    '/admin/discount/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const result = await discount.deleteDiscountCode(id);
      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  fastify.put(
    '/admin/discount/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const result = await discount.updateDiscountCode(id, request.body);
      if (result.success) {
        reply.send({ success: true, code: result.code });
      } else {
        reply.status(400).send({ success: false, error: result.error });
      }
    }
  );

  // Printer invoice management
  fastify.get(
    '/admin/printerinvoices',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      try {
        const invoices = await printerInvoice.getAllPrinterInvoices();
        reply.send({ success: true, invoices });
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'Failed to fetch printer invoices',
        });
      }
    }
  );

  fastify.post(
    '/admin/printerinvoices',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const {
        invoiceNumber,
        description,
        totalPriceExclVat,
        totalPriceInclVat,
      } = request.body;
      if (
        !invoiceNumber ||
        typeof invoiceNumber !== 'string' ||
        typeof description !== 'string' ||
        typeof totalPriceExclVat !== 'number' ||
        typeof totalPriceInclVat !== 'number'
      ) {
        reply
          .status(400)
          .send({ success: false, error: 'Invalid or missing fields' });
        return;
      }
      try {
        const result = await printerInvoice.createPrinterInvoice({
          invoiceNumber,
          description,
          totalPriceExclVat,
          totalPriceInclVat,
        });
        if (result.success) {
          reply.send({ success: true, invoice: result.invoice });
        } else {
          reply.status(400).send({ success: false, error: result.error });
        }
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'Failed to create printer invoice',
        });
      }
    }
  );

  fastify.put(
    '/admin/printerinvoices/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const {
        invoiceNumber,
        description,
        totalPriceExclVat,
        totalPriceInclVat,
      } = request.body;
      const result = await printerInvoice.updatePrinterInvoice(id, {
        invoiceNumber,
        description,
        totalPriceExclVat,
        totalPriceInclVat,
      });
      if (result.success) {
        reply.send({ success: true, invoice: result.invoice });
      } else {
        reply.status(400).send({ success: false, error: result.error });
      }
    }
  );

  fastify.post(
    '/admin/printerinvoices/:id/process',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const result = await printerInvoice.processInvoiceData(id, request.body);
      reply.send(result);
    }
  );

  fastify.delete(
    '/admin/printerinvoices/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const result = await printerInvoice.deletePrinterInvoice(id);
      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(400).send({ success: false, error: result.error });
      }
    }
  );

  // Print & Bind API
  fastify.post(
    '/admin/printenbind/update-payments',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const PrintEnBind = (await import('../printers/printenbind')).default;
      const printEnBind = PrintEnBind.getInstance();
      printEnBind.updateAllPaymentsWithPrintApiOrderId();
      reply.send({
        success: true,
        message: 'Updated all payments with printApiOrderId',
      });
    }
  );

  // Google Merchant Center routes
  fastify.post(
    '/admin/merchant-center/upload-featured',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { merchantCenter } = await import('../merchantcenter');
        merchantCenter.uploadFeaturedPlaylists();
        reply.send({
          success: true,
          message: 'Merchant Center upload initiated',
        });
      } catch (error: any) {
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to upload to Merchant Center',
        });
      }
    }
  );

  // Create gameset ZIP with QR codes
  fastify.post(
    '/admin/gameset/create',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { paymentId, paymentHasPlaylistId } = request.body;

        if (!paymentId || !paymentHasPlaylistId) {
          reply.status(400).send({
            success: false,
            error:
              'Missing required parameters: paymentId and paymentHasPlaylistId',
          });
          return;
        }

        const downloadUrl = await generator.createGameset(
          paymentId,
          paymentHasPlaylistId
        );
        reply.send({
          success: true,
          downloadUrl: downloadUrl,
          message: 'Gameset ZIP created successfully',
        });
      } catch (error: any) {
        console.error('Error creating gameset:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to create gameset',
        });
      }
    }
  );

  // MusicFetch bulk action endpoints
  fastify.get(
    '/admin/tracks/missing-music-links',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { limit = 100 } = request.query;
        const tracks = await data.getTracksWithoutMusicLinks(
          parseInt(limit) || 100
        );
        reply.send({
          success: true,
          count: tracks.length,
          tracks,
        });
      } catch (error: any) {
        console.error('Error fetching tracks missing music links:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch tracks',
        });
      }
    }
  );

  fastify.post(
    '/admin/tracks/fetch-music-links',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { trackIds } = request.body;

        // Dynamically import MusicFetch
        const MusicFetch = (await import('../musicfetch')).default;
        const musicFetch = MusicFetch.getInstance();

        // Start processing in background (don't wait for result)
        musicFetch.processBulkTracks(trackIds).catch((error) => {
          console.error('Error in background MusicFetch processing:', error);
        });

        // Send immediate response
        reply.send({
          success: true,
          message: 'MusicFetch bulk processing started in background',
        });
      } catch (error: any) {
        console.error('Error starting MusicFetch bulk action:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to start MusicFetch bulk action',
        });
      }
    }
  );

  // ============ EXTERNAL CARDS ROUTES ============

  // Import external cards from sources (Jumbo API, country JSON files, MusicMatch JSON)
  fastify.post(
    '/admin/external-cards/import',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const ExternalCardService = (await import('../externalCardService')).default;
        const externalCardService = ExternalCardService.getInstance();

        // Start import in background
        externalCardService.importAllExternalCards().catch((error) => {
          console.error('Error in background external card import:', error);
        });

        reply.send({
          success: true,
          message: 'External card import started in background',
        });
      } catch (error: any) {
        console.error('Error starting external card import:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to start external card import',
        });
      }
    }
  );

  // Fetch music links for external cards via MusicFetch
  fastify.post(
    '/admin/external-cards/fetch-music-links',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { cardIds } = request.body;

        const MusicFetch = (await import('../musicfetch')).default;
        const musicFetch = MusicFetch.getInstance();

        // Start processing in background
        musicFetch.processExternalCards(cardIds).catch((error) => {
          console.error('Error in background external card MusicFetch processing:', error);
        });

        reply.send({
          success: true,
          message: 'External card music link fetching started in background',
        });
      } catch (error: any) {
        console.error('Error starting external card music link fetch:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to start external card music link fetch',
        });
      }
    }
  );

  // Get external cards with search and filters
  fastify.get(
    '/admin/external-cards',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { search, missingLink, cardType, page = 1, limit = 50 } = request.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause
        const where: any = {};

        // Search filter
        if (search) {
          where.OR = [
            { sku: { contains: search } },
            { countryCode: { contains: search } },
            { playlistId: { contains: search } },
            { cardNumber: { contains: search } },
            { spotifyId: { contains: search } },
          ];
        }

        // Card type filter
        if (cardType) {
          where.cardType = cardType;
        }

        // Missing link filter
        if (missingLink) {
          switch (missingLink) {
            case 'appleMusic':
              where.appleMusicLink = null;
              break;
            case 'tidal':
              where.tidalLink = null;
              break;
            case 'youtubeMusic':
              where.youtubeMusicLink = null;
              break;
            case 'deezer':
              where.deezerLink = null;
              break;
            case 'amazonMusic':
              where.amazonMusicLink = null;
              break;
          }
        }

        const [cards, total] = await Promise.all([
          prisma.externalCard.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: { id: 'desc' },
          }),
          prisma.externalCard.count({ where }),
        ]);

        // Get track info for cards that have spotifyId
        const spotifyIds = cards
          .map((c) => c.spotifyId)
          .filter((id): id is string => id !== null);

        const tracks =
          spotifyIds.length > 0
            ? await prisma.track.findMany({
                where: { trackId: { in: spotifyIds } },
                select: { trackId: true, artist: true, name: true },
              })
            : [];

        const trackMap = new Map(tracks.map((t) => [t.trackId, t]));

        // Merge track info into cards
        const cardsWithTrackInfo = cards.map((card) => ({
          ...card,
          trackArtist: card.spotifyId ? trackMap.get(card.spotifyId)?.artist || null : null,
          trackName: card.spotifyId ? trackMap.get(card.spotifyId)?.name || null : null,
        }));

        reply.send({
          data: cardsWithTrackInfo,
          total,
          page: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
        });
      } catch (error: any) {
        console.error('Error fetching external cards:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch external cards',
        });
      }
    }
  );

  // Update a single external card
  fastify.put(
    '/admin/external-cards/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { id } = request.params;
        const {
          spotifyLink,
          appleMusicLink,
          tidalLink,
          youtubeMusicLink,
          deezerLink,
          amazonMusicLink,
        } = request.body;

        const updated = await prisma.externalCard.update({
          where: { id: parseInt(id) },
          data: {
            ...(spotifyLink !== undefined && { spotifyLink }),
            ...(appleMusicLink !== undefined && { appleMusicLink }),
            ...(tidalLink !== undefined && { tidalLink }),
            ...(youtubeMusicLink !== undefined && { youtubeMusicLink }),
            ...(deezerLink !== undefined && { deezerLink }),
            ...(amazonMusicLink !== undefined && { amazonMusicLink }),
          },
        });

        reply.send({
          success: true,
          card: updated,
        });
      } catch (error: any) {
        console.error('Error updating external card:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to update external card',
        });
      }
    }
  );

  // Fetch music links for a single external card via MusicFetch
  fastify.post(
    '/admin/external-cards/:id/musicfetch',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { id } = request.params;
        const cardId = parseInt(id);

        // Get the card
        const card = await prisma.externalCard.findUnique({
          where: { id: cardId },
        });

        if (!card) {
          return reply.status(404).send({
            success: false,
            error: 'External card not found',
          });
        }

        if (!card.spotifyId) {
          return reply.status(400).send({
            success: false,
            error: 'Card has no Spotify ID to search with',
          });
        }

        const MusicFetch = (await import('../musicfetch')).default;
        const musicFetch = MusicFetch.getInstance();

        // Use the processSingleExternalCard method
        const result = await musicFetch.processSingleExternalCard(card);

        if (result.success) {
          // Fetch the updated card
          const updatedCard = await prisma.externalCard.findUnique({
            where: { id: cardId },
          });

          reply.send({
            success: true,
            card: updatedCard,
            linksAdded: result.linksAdded,
          });
        } else {
          reply.send({
            success: false,
            error: result.error || 'No new links found',
          });
        }
      } catch (error: any) {
        console.error('Error fetching music links for external card:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch music links',
        });
      }
    }
  );

  // Get external card statistics
  fastify.get(
    '/admin/external-cards/stats',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const ExternalCardService = (await import('../externalCardService')).default;
        const externalCardService = ExternalCardService.getInstance();
        const stats = await externalCardService.getStats();

        reply.send({
          success: true,
          stats,
        });
      } catch (error: any) {
        console.error('Error fetching external card stats:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch external card stats',
        });
      }
    }
  );

  // Supplement Excel with QRSong links (async via queue)
  fastify.post(
    '/admin/supplement-excel',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const excel = Excel.getInstance();
        const { jobId, filename } = await excel.queueExcelProcessing(
          request.parts(),
          request.clientIp
        );

        reply.send({
          success: true,
          jobId,
          filename,
          message: 'Excel processing job queued successfully',
        });
      } catch (error: any) {
        console.error('Error queueing Excel job:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to queue Excel processing',
        });
      }
    }
  );

  // Get Excel job status
  fastify.get(
    '/admin/supplement-excel/status/:jobId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { jobId } = request.params;
        const excelQueue = ExcelQueue.getInstance();
        const jobStatus = await excelQueue.getJobStatus(jobId);

        if (!jobStatus) {
          reply.status(404).send({
            success: false,
            error: 'Job not found',
          });
          return;
        }

        reply.send({
          success: true,
          jobId: jobStatus.id,
          state: jobStatus.state,
          progress: jobStatus.progress,
          filename: jobStatus.returnvalue?.filename,
          error: jobStatus.failedReason,
        });
      } catch (error: any) {
        console.error('Error getting Excel job status:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to get job status',
        });
      }
    }
  );

  // Download completed Excel file
  fastify.get(
    '/admin/supplement-excel/download/:filename',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { filename } = request.params;

        // Validate filename to prevent directory traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
          reply.status(400).send({
            success: false,
            error: 'Invalid filename',
          });
          return;
        }

        const publicDir = process.env['PUBLIC_DIR'];
        if (!publicDir) {
          reply.status(500).send({
            success: false,
            error: 'PUBLIC_DIR not configured',
          });
          return;
        }

        const filePath = path.join(publicDir, 'excel', filename);

        // Check if file exists
        try {
          await fsPromises.access(filePath, fs.constants.R_OK);
        } catch (error) {
          reply.status(404).send({
            success: false,
            error: 'File not found',
          });
          return;
        }

        // Read and send the file
        const fileBuffer = await fsPromises.readFile(filePath);

        reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header(
            'Content-Disposition',
            `attachment; filename="${filename}"`
          )
          .send(fileBuffer);
      } catch (error: any) {
        console.error('Error downloading Excel file:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to download file',
        });
      }
    }
  );

  // Bulk create shipments in TrackingMore
  fastify.post(
    '/admin/shipping/create-all',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await shipping.createAllShipments();
        reply.send({
          success: true,
          ...result,
          message: `Processed ${result.processed} payment(s): ${result.successful} successful, ${result.failed} failed`,
        });
      } catch (error: any) {
        console.error('Error creating bulk shipments:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to create shipments',
        });
      }
    }
  );

  // Get tracking data for 'In Transit' tab (admin dashboard)
  fastify.post(
    '/admin/tracking/in-transit',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { page = 1, itemsPerPage = 100, textSearch, countryCode } = request.body;
        const result = await shipping.getTracking('Shipped', page, itemsPerPage, textSearch, countryCode);
        reply.send({
          success: true,
          ...result,
        });
      } catch (error: any) {
        console.error('Error fetching in-transit tracking:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch tracking data',
        });
      }
    }
  );

  // Get tracking data for 'Delivered' tab (admin dashboard)
  fastify.post(
    '/admin/tracking/delivered',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { page = 1, itemsPerPage = 100, textSearch, countryCode } = request.body;
        const result = await shipping.getTracking('Delivered', page, itemsPerPage, textSearch, countryCode);
        reply.send({
          success: true,
          ...result,
        });
      } catch (error: any) {
        console.error('Error fetching delivered tracking:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch tracking data',
        });
      }
    }
  );

  // Get available country codes for filter
  fastify.get(
    '/admin/tracking/country-codes',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const countryCodes = await shipping.getAvailableCountryCodes();
        reply.send({
          success: true,
          data: countryCodes,
        });
      } catch (error: any) {
        console.error('Error fetching country codes:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to fetch country codes',
        });
      }
    }
  );

  // Export tracking data to Excel
  fastify.post(
    '/admin/tracking/export',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { status, textSearch, countryCode } = request.body;

        if (!status || (status !== 'Shipped' && status !== 'Delivered')) {
          reply.status(400).send({
            success: false,
            error: 'Invalid status. Must be "Shipped" or "Delivered"',
          });
          return;
        }

        const excelBuffer = await shipping.exportTrackingToExcel(
          status,
          textSearch,
          countryCode
        );

        const filename = `tracking-${status.toLowerCase()}-${new Date().toISOString().split('T')[0]}.xlsx`;

        reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(excelBuffer);
      } catch (error: any) {
        console.error('Error exporting tracking data:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to export tracking data',
        });
      }
    }
  );

  // Toggle shippingIgnore status for a payment
  fastify.post(
    '/admin/tracking/toggle-ignore',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { paymentId, ignore } = request.body;

        if (!paymentId || typeof ignore !== 'boolean') {
          reply.status(400).send({
            success: false,
            error: 'paymentId and ignore (boolean) are required',
          });
          return;
        }

        const updatedPayment = await shipping.toggleIgnoreStatus(
          paymentId,
          ignore
        );

        reply.send({
          success: true,
          data: updatedPayment,
          message: `Shipment ${ignore ? 'ignored' : 'unignored'} successfully`,
        });
      } catch (error: any) {
        console.error('Error toggling shipping ignore:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to update shipping ignore status',
        });
      }
    }
  );

  // Get site settings
  fastify.get(
    '/admin/settings',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const siteSettings = SiteSettings.getInstance();
        const settings = await siteSettings.getSettings();

        if (!settings) {
          return reply.status(404).send({
            success: false,
            error: 'Settings not found',
          });
        }

        return { success: true, data: settings };
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Update site settings
  fastify.put(
    '/admin/settings',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { productionDays, productionMessage } = request.body;

        // Validation
        if (
          productionDays !== undefined &&
          (typeof productionDays !== 'number' || productionDays < 0)
        ) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid productionDays value',
          });
        }

        const siteSettings = SiteSettings.getInstance();
        const updatedSettings = await siteSettings.updateSettings({
          productionDays,
          productionMessage,
        });

        if (!updatedSettings) {
          return reply.status(500).send({
            success: false,
            error: 'Failed to update settings',
          });
        }

        return { success: true, data: updatedSettings };
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Get all shipping config offsets
  fastify.get(
    '/admin/shipping-config',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const shippingConfig = ShippingConfig.getInstance();
        const configs = await shippingConfig.getAllConfigs();
        return { success: true, data: configs };
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Create or update shipping config offset for a country
  fastify.put(
    '/admin/shipping-config/:countryCode',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { countryCode } = request.params;
        const { minDaysOffset, maxDaysOffset } = request.body;

        // Validation
        if (!countryCode || countryCode.length !== 2) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid country code. Must be a 2-letter ISO code.',
          });
        }

        if (typeof minDaysOffset !== 'number' || typeof maxDaysOffset !== 'number') {
          return reply.status(400).send({
            success: false,
            error: 'minDaysOffset and maxDaysOffset must be numbers',
          });
        }

        const shippingConfig = ShippingConfig.getInstance();
        const config = await shippingConfig.upsertConfig(
          countryCode,
          minDaysOffset,
          maxDaysOffset
        );

        if (!config) {
          return reply.status(500).send({
            success: false,
            error: 'Failed to update shipping config',
          });
        }

        return { success: true, data: config };
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Delete shipping config offset for a country
  fastify.delete(
    '/admin/shipping-config/:countryCode',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { countryCode } = request.params;

        if (!countryCode || countryCode.length !== 2) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid country code. Must be a 2-letter ISO code.',
          });
        }

        const shippingConfig = ShippingConfig.getInstance();
        const success = await shippingConfig.deleteConfig(countryCode);

        if (!success) {
          return reply.status(404).send({
            success: false,
            error: 'Config not found or failed to delete',
          });
        }

        return { success: true };
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Generate playlist JSON
  fastify.post(
    '/admin/generate-playlist-json',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { filename, playlistUrl } = request.body;

        if (!filename || !playlistUrl) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required fields: filename and playlistUrl',
          });
        }

        // Extract name from filename (e.g., "en.json" -> "en")
        const name = filename.replace(/\.json$/i, '');

        // Extract playlist ID from Spotify URL
        const playlistIdMatch = playlistUrl.match(
          /spotify\.com\/playlist\/([a-zA-Z0-9]+)/
        );
        if (!playlistIdMatch) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid Spotify playlist URL',
          });
        }
        const playlistId = playlistIdMatch[1];

        // Fetch tracks from Spotify
        const tracksResult = await spotify.getTracks(
          playlistId,
          false, // Don't use cache
          '', // No captcha token
          false, // Don't check captcha
          false // Not a slug
        );

        if (!tracksResult.success || !tracksResult.data) {
          return reply.status(500).send({
            success: false,
            error: tracksResult.error || 'Failed to fetch playlist tracks',
          });
        }

        // Generate the JSON mapping
        const cards: { [key: string]: string } = {};
        const tracks = tracksResult.data.tracks || [];

        tracks.forEach((track: any, index: number) => {
          // Zero-pad the index to 5 digits (00001, 00002, etc.)
          const paddedIndex = String(index + 1).padStart(5, '0');
          cards[paddedIndex] = track.id;
        });

        const result = {
          name,
          cards,
        };

        return { success: true, data: result };
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message || 'Internal server error',
        });
      }
    }
  );

  // Get all chats for admin dashboard
  fastify.get('/admin/chats', getAuthHandler(['admin']), async (_request: any, reply) => {
    try {
      const chats = await prisma.chat.findMany({
        where: {
          messages: {
            some: {}, // Only include chats with at least one message
          },
        },
        orderBy: [
          { lastActivityAt: 'desc' },
          { createdAt: 'desc' },
        ],
        include: {
          _count: {
            select: { messages: true },
          },
        },
      });

      const formattedChats = chats.map((chat) => ({
        id: chat.id,
        email: chat.email,
        username: chat.username,
        locale: chat.locale,
        supportNeeded: chat.supportNeeded,
        hijacked: chat.hijacked,
        unseenMessages: chat.unseenMessages,
        messageCount: chat._count.messages,
        lastActivityAt: chat.lastActivityAt,
        createdAt: chat.createdAt,
      }));

      return { success: true, data: formattedChats };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to fetch chats',
      });
    }
  });

  // Get support needed count for badge
  fastify.get('/admin/chats/support-count', getAuthHandler(['admin']), async (_request: any, reply) => {
    try {
      const count = await prisma.chat.count({
        where: {
          unseenMessages: true,
          messages: {
            some: {}, // Only count chats that have at least one message
          },
        },
      });

      return { success: true, count };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to fetch count',
      });
    }
  });

  // Get messages for a specific chat
  fastify.get('/admin/chats/:id/messages', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const chatId = parseInt(request.params.id, 10);

      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!chat) {
        return reply.status(404).send({
          success: false,
          error: 'Chat not found',
        });
      }

      return {
        success: true,
        data: {
          id: chat.id,
          email: chat.email,
          username: chat.username,
          locale: chat.locale,
          supportNeeded: chat.supportNeeded,
          hijacked: chat.hijacked,
          createdAt: chat.createdAt,
          messages: chat.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            translatedContent: m.translatedContent,
            createdAt: m.createdAt,
          })),
        },
      };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to fetch chat messages',
      });
    }
  });

  // Mark chat as seen by admin
  fastify.post('/admin/chats/:id/mark-seen', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const chatId = parseInt(request.params.id, 10);

      const chatService = new ChatService();
      await chatService.markChatAsSeen(chatId);

      return { success: true };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to mark chat as seen',
      });
    }
  });

  // Toggle hijack status for a chat
  fastify.post('/admin/chats/:id/hijack', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const chatId = parseInt(request.params.id, 10);
      const { hijacked } = request.body;

      if (typeof hijacked !== 'boolean') {
        return reply.status(400).send({
          success: false,
          error: 'hijacked must be a boolean',
        });
      }

      const chatService = new ChatService();
      await chatService.toggleHijack(chatId, hijacked);

      // Notify connected user about hijack status change via WebSocket
      const wsServer = ChatWebSocketServer.getInstance();
      console.log('[hijack] WebSocket server instance:', wsServer ? 'found' : 'NOT FOUND');
      if (wsServer) {
        wsServer.broadcastToChat(chatId, { type: 'hijack', hijacked });
      }

      return { success: true, hijacked };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to toggle hijack status',
      });
    }
  });

  // Toggle support needed status for a chat
  fastify.post('/admin/chats/:id/support-needed', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const chatId = parseInt(request.params.id, 10);
      const { supportNeeded } = request.body;

      if (typeof supportNeeded !== 'boolean') {
        return reply.status(400).send({
          success: false,
          error: 'supportNeeded must be a boolean',
        });
      }

      const chatService = new ChatService();
      await chatService.toggleSupportNeeded(chatId, supportNeeded);

      return { success: true, supportNeeded };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to toggle support needed status',
      });
    }
  });

  // Send admin message to a chat
  fastify.post('/admin/chats/:id/message', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const chatId = parseInt(request.params.id, 10);
      const { content } = request.body;

      if (!content || typeof content !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'content is required',
        });
      }

      // Get chat to find user's locale
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { locale: true },
      });

      if (!chat) {
        return reply.status(404).send({
          success: false,
          error: 'Chat not found',
        });
      }

      const chatService = new ChatService();
      const { id: messageId, translatedContent } = await chatService.saveAdminMessage(
        chatId,
        content,
        chat.locale || 'en'
      );

      // Broadcast to user via WebSocket
      const wsServer = ChatWebSocketServer.getInstance();
      if (wsServer) {
        wsServer.broadcastToChat(chatId, {
          type: 'admin_message',
          content: translatedContent, // User sees translated content
          role: 'admin',
        });
      }

      return {
        success: true,
        message: {
          id: messageId,
          content,
          translatedContent,
        },
      };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to send message',
      });
    }
  });

  // Admin typing indicator
  fastify.post('/admin/chats/:id/typing', getAuthHandler(['admin']), async (request: any, reply) => {
    const chatId = parseInt(request.params.id, 10);
    const wsServer = ChatWebSocketServer.getInstance();
    if (wsServer) {
      wsServer.broadcastToChat(chatId, { type: 'admin_typing' });
    }
    return { success: true };
  });

  // Delete a chat
  fastify.delete('/admin/chats/:id', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const chatId = parseInt(request.params.id, 10);

      // Delete messages first (due to foreign key constraint)
      await prisma.chatMessage.deleteMany({
        where: { chatId },
      });

      // Delete the chat
      await prisma.chat.delete({
        where: { id: chatId },
      });

      // Invalidate cache
      const chatService = new ChatService();
      await chatService.invalidateChatCache(chatId);

      return { success: true };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to delete chat',
      });
    }
  });

  // ============================================
  // Contact Email Management Endpoints
  // ============================================

  // Get all contact emails
  fastify.get('/admin/emails', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const emails = await prisma.contactEmail.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      return { success: true, emails };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to fetch emails',
      });
    }
  });

  // Get unread email count
  fastify.get('/admin/emails/unread-count', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const count = await prisma.contactEmail.count({
        where: { isRead: false },
      });
      return { success: true, count };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to count unread emails',
      });
    }
  });

  // Get single contact email with replies
  fastify.get('/admin/emails/:id', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const emailId = parseInt(request.params.id, 10);
      const email = await prisma.contactEmail.findUnique({
        where: { id: emailId },
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!email) {
        return reply.status(404).send({
          success: false,
          error: 'Email not found',
        });
      }

      return { success: true, email };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to fetch email',
      });
    }
  });

  // Mark email as read
  fastify.post('/admin/emails/:id/mark-read', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const emailId = parseInt(request.params.id, 10);
      await prisma.contactEmail.update({
        where: { id: emailId },
        data: { isRead: true },
      });
      return { success: true };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to mark email as read',
      });
    }
  });

  // Update email locale
  fastify.post('/admin/emails/:id/update-locale', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const emailId = parseInt(request.params.id, 10);
      const { locale } = request.body;

      if (!locale || typeof locale !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'Locale is required',
        });
      }

      await prisma.contactEmail.update({
        where: { id: emailId },
        data: { locale },
      });
      return { success: true };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to update locale',
      });
    }
  });

  // Reply to contact email
  fastify.post('/admin/emails/:id/reply', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const emailId = parseInt(request.params.id, 10);
      const { content } = request.body;

      if (!content || typeof content !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'Content is required',
        });
      }

      // Get the original email to find recipient and locale
      const contactEmail = await prisma.contactEmail.findUnique({
        where: { id: emailId },
      });

      if (!contactEmail) {
        return reply.status(404).send({
          success: false,
          error: 'Email not found',
        });
      }

      // Translate Dutch content to user's locale
      const mailService = Mail.getInstance();
      const targetLocale = contactEmail.locale || 'en';
      let translatedContent = content;

      // Only translate if locale is not Dutch
      if (targetLocale !== 'nl') {
        translatedContent = await mailService.translateToLocale(content, targetLocale);
      }

      // Store the reply
      const replyRecord = await prisma.contactEmailReply.create({
        data: {
          contactEmailId: emailId,
          content: content, // Original Dutch
          translatedContent: translatedContent, // Translated
        },
      });

      // Send the reply email using sendCustomMail
      const subject = contactEmail.subject
        ? `Re: ${contactEmail.subject}`
        : 'Re: Your message to QRSong!';

      await mailService.sendCustomMail(
        contactEmail.email,
        contactEmail.name,
        subject,
        translatedContent,
        targetLocale
      );

      return {
        success: true,
        reply: replyRecord,
      };
    } catch (error: any) {
      console.error('Error sending reply:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to send reply',
      });
    }
  });

  // Delete contact email
  fastify.delete('/admin/emails/:id', getAuthHandler(['admin']), async (request: any, reply) => {
    try {
      const emailId = parseInt(request.params.id, 10);

      // Delete will cascade to replies due to onDelete: Cascade
      await prisma.contactEmail.delete({
        where: { id: emailId },
      });

      return { success: true };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message || 'Failed to delete email',
      });
    }
  });

  // Get email templates from mail.json
  fastify.get(
    '/admin/email-templates',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const appRoot = process.env['APP_ROOT'] || path.join(__dirname, '..');
        const mailJsonPath = path.join(appRoot, '_data', 'mail.json');
        const data = JSON.parse(fs.readFileSync(mailJsonPath, 'utf-8'));

        return reply.send({
          success: true,
          templates: data.templates || []
        });
      } catch (error: any) {
        console.error('Error loading email templates:', error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to load email templates'
        });
      }
    }
  );

  // Send custom email to customer
  fastify.post(
    '/admin/send-custom-email',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { paymentId, subject, message, targetLocale } = request.body;

        // Validate required fields
        if (!paymentId || !subject || !message) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required fields: paymentId, subject, message'
          });
        }

        // Fetch payment with user details
        const payment = await prisma.payment.findUnique({
          where: { paymentId },
          select: {
            email: true,
            fullname: true,
            locale: true
          }
        });

        if (!payment) {
          return reply.status(404).send({
            success: false,
            error: 'Payment not found'
          });
        }

        // Determine target locale (use provided or fallback to payment locale)
        const locale = targetLocale || payment.locale || 'en';

        // Translate message if not Dutch
        let translatedSubject = subject;
        let translatedMessage = message;

        if (locale !== 'nl') {
          const translated = await chatgpt.translateMessage(message, subject, locale);
          translatedSubject = translated.subject;
          translatedMessage = translated.message;
        }

        // Send email
        await mail.sendCustomMail(
          payment.email,
          payment.fullname,
          translatedSubject,
          translatedMessage,
          locale
        );

        return reply.send({
          success: true,
          message: 'Email sent successfully'
        });
      } catch (error: any) {
        console.error('Error sending custom email:', error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Failed to send email'
        });
      }
    }
  );

  // Get all promotional playlists (admin dashboard)
  fastify.get(
    '/admin/promotional-playlists',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await promotional.getAllPromotionalPlaylists();
        return reply.send(result);
      } catch (error: any) {
        console.error('Error getting promotional playlists:', error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Failed to get promotional playlists'
        });
      }
    }
  );

  // Calculate shipping costs for specified countries
  fastify.post(
    '/admin/calculate-shipping-costs',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { countryCodes } = request.body;

        if (!countryCodes || !Array.isArray(countryCodes) || countryCodes.length === 0) {
          return reply.status(400).send({
            success: false,
            error: 'Country codes array required'
          });
        }

        // Validate country codes format (2-letter uppercase)
        const validCodes = countryCodes.filter(
          (code: string) => typeof code === 'string' && /^[A-Z]{2}$/.test(code)
        );

        if (validCodes.length === 0) {
          return reply.status(400).send({
            success: false,
            error: 'No valid country codes provided (must be 2-letter uppercase codes like DE, NL, BE)'
          });
        }

        // Start calculation in background
        order.calculateShippingCosts(validCodes);

        return reply.send({
          success: true,
          message: `Processing ${validCodes.length} countries: ${validCodes.join(', ')}`
        });
      } catch (error: any) {
        console.error('Error calculating shipping costs:', error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Failed to calculate shipping costs'
        });
      }
    }
  );

  // Update featured playlist stats (Wilson scores + decade percentages)
  fastify.post(
    '/admin/calculate-playlist-scores',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await data.updateFeaturedPlaylistStats();

        if (!result.success) {
          return reply.status(500).send({
            success: false,
            error: result.error || 'Failed to update playlist stats'
          });
        }

        return reply.send({
          success: true,
          message: `Updated ${result.scoresProcessed} playlists (scores) and ${result.decadesProcessed} playlists (decades)`,
          scoresProcessed: result.scoresProcessed,
          decadesProcessed: result.decadesProcessed
        });
      } catch (error: any) {
        console.error('Error updating playlist stats:', error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Failed to update playlist stats'
        });
      }
    }
  );

  // Create Mollie payment link
  fastify.post(
    '/admin/create-payment-link',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { amount, description } = request.body;

        if (!amount || typeof amount !== 'number' || amount <= 0) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid amount. Must be a positive number.',
          });
        }

        const result = await mollie.createPaymentLink(amount, description);

        if (!result.success) {
          return reply.status(500).send({
            success: false,
            error: result.error || 'Failed to create payment link',
          });
        }

        return reply.send({
          success: true,
          paymentLink: result.data.paymentLink,
          paymentLinkId: result.data.paymentLinkId,
          amount: result.data.amount,
          description: result.data.description,
        });
      } catch (error: any) {
        console.error('Error creating payment link:', error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Failed to create payment link',
        });
      }
    }
  );

  // Create Mollie refund for a payment
  fastify.post(
    '/admin/payment/:paymentId/refund',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { paymentId } = request.params;
        const { amount, reason } = request.body;

        if (!paymentId) {
          return reply.status(400).send({
            success: false,
            error: 'Payment ID is required.',
          });
        }

        if (!amount || typeof amount !== 'number' || amount <= 0) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid amount. Must be a positive number.',
          });
        }

        // Get the payment from database to verify it exists and get Mollie payment ID
        const payment = await prisma.payment.findUnique({
          where: { paymentId },
          select: {
            id: true,
            paymentId: true,
            totalPrice: true,
            refundAmount: true,
            status: true,
          },
        });

        if (!payment) {
          return reply.status(404).send({
            success: false,
            error: 'Payment not found.',
          });
        }

        // Check if payment status allows refund
        if (payment.status !== 'paid') {
          return reply.status(400).send({
            success: false,
            error: `Cannot refund a payment with status "${payment.status}". Only paid payments can be refunded.`,
          });
        }

        // Check if amount exceeds total price
        if (amount > payment.totalPrice) {
          return reply.status(400).send({
            success: false,
            error: `Refund amount (€${amount.toFixed(2)}) exceeds total payment amount (€${payment.totalPrice.toFixed(2)}).`,
          });
        }

        // Check if there's already a refund and the combined amount would exceed the total
        const existingRefund = payment.refundAmount || 0;
        if (existingRefund + amount > payment.totalPrice) {
          return reply.status(400).send({
            success: false,
            error: `Combined refund amount would exceed total payment. Already refunded: €${existingRefund.toFixed(2)}, requested: €${amount.toFixed(2)}, total: €${payment.totalPrice.toFixed(2)}.`,
          });
        }

        // Create refund via Mollie
        const result = await mollie.createRefund(payment.paymentId, amount);

        if (!result.success) {
          return reply.status(500).send({
            success: false,
            error: result.error || 'Failed to create refund with Mollie.',
          });
        }

        // Update payment in database with refund amount and reason
        const newRefundAmount = existingRefund + amount;
        await prisma.payment.update({
          where: { paymentId },
          data: {
            refundAmount: newRefundAmount,
            refundedAt: new Date(),
            refundReason: reason || null,
          },
        });

        return reply.send({
          success: true,
          refundId: result.data.refundId,
          amount: result.data.amount,
          status: result.data.status,
          totalRefunded: newRefundAmount.toFixed(2),
          isFullRefund: newRefundAmount >= payment.totalPrice,
        });
      } catch (error: any) {
        console.error('Error creating refund:', error);
        return reply.status(500).send({
          success: false,
          error: error.message || 'Failed to create refund.',
        });
      }
    }
  );

  // ============ HITLIST ROUTES ============

  // Import hitlist data (e.g., Dutch Top 40)
  fastify.post(
    '/admin/hitlists/import',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { hitlistType } = request.body;

        if (hitlistType !== 'nl-top40') {
          return reply.status(400).send({
            success: false,
            error: 'Invalid hitlist type. Supported: nl-top40',
          });
        }

        const Top40 = (await import('../top40')).default;
        const top40 = Top40.getInstance();
        const result = await top40.importTop40Data();

        reply.send({
          success: result.success,
          totalRows: result.totalRows,
          imported: result.imported,
          errors: result.errors,
          error: result.error,
        });
      } catch (error: any) {
        console.error('Error importing hitlist:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to import hitlist',
        });
      }
    }
  );

  // Get #1 track for a specific date
  fastify.get(
    '/admin/hitlists/number-one/:date',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { date } = request.params;
        const parsedDate = new Date(date);

        if (isNaN(parsedDate.getTime())) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid date format. Use YYYY-MM-DD',
          });
        }

        const Top40 = (await import('../top40')).default;
        const top40 = Top40.getInstance();
        const result = await top40.getNumberOneOnDate(parsedDate);

        if (!result) {
          return reply.status(404).send({
            success: false,
            error: 'No #1 track found for this date',
          });
        }

        reply.send({
          success: true,
          artist: result.artist,
          title: result.title,
          year: result.year,
          weekNumber: result.weekNumber,
        });
      } catch (error: any) {
        console.error('Error getting #1 track:', error);
        reply.status(500).send({
          success: false,
          error: error.message || 'Failed to get #1 track',
        });
      }
    }
  );

  // ============================================
  // BROKEN LINKS ROUTES (Admin only - public logging is in publicRoutes.ts)
  // ============================================

  // Get all broken links (admin only)
  fastify.get(
    '/admin/broken-links',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { type, serviceType, limit, offset } = request.query;

        const result = await brokenLink.getBrokenLinks({
          type,
          serviceType,
          limit: limit ? parseInt(limit) : undefined,
          offset: offset ? parseInt(offset) : undefined,
        });

        if (result.success) {
          return reply.send({
            success: true,
            data: result.data,
            total: result.total,
          });
        } else {
          return reply.status(500).send({ success: false, error: result.error });
        }
      } catch (error: any) {
        console.error('Error fetching broken links:', error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch broken links',
        });
      }
    }
  );

  // Get broken links count (admin only)
  fastify.get(
    '/admin/broken-links/count',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      try {
        const result = await brokenLink.getBrokenLinksCount();

        if (result.success) {
          return reply.send({ success: true, count: result.count });
        } else {
          return reply.status(500).send({ success: false, error: result.error });
        }
      } catch (error: any) {
        console.error('Error counting broken links:', error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to count broken links',
        });
      }
    }
  );

  // Delete a broken link (admin only)
  fastify.delete(
    '/admin/broken-links/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        return reply.status(400).send({ success: false, error: 'Invalid id' });
      }

      const result = await brokenLink.deleteBrokenLink(id);
      if (result.success) {
        return reply.send({ success: true });
      } else {
        return reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  // Delete all broken links (admin only)
  fastify.delete(
    '/admin/broken-links',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const result = await brokenLink.deleteAllBrokenLinks();
      if (result.success) {
        return reply.send({ success: true, deleted: result.deleted });
      } else {
        return reply.status(500).send({ success: false, error: result.error });
      }
    }
  );
}
