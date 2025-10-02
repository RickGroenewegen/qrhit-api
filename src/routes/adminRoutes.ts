import { FastifyInstance } from 'fastify';
import { createOrUpdateAdminUser, deleteUserById } from '../auth';
import Generator from '../generator';
import GeneratorQueue from '../generatorQueue';
import AnalyticsClient from '../analytics';
import Data from '../data';
import { OpenPerplex } from '../openperplex';
import Push from '../push';
import Discount from '../discount';
import PrinterInvoiceService from '../printerinvoice';
import Utils from '../utils';
import Mollie from '../mollie';
import Order from '../order';
import Suggestion from '../suggestion';
import Copy from '../copy';
import path from 'path';
import fs from 'fs/promises';

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

  // Create order (admin only)
  fastify.post(
    '/create_order',
    getAuthHandler(['admin']),
    async (request: any, _reply) => {
      return await generator.sendToPrinter(
        request.body.paymentId,
        request.clientIp,
        true
      );
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
      await mollie.clearPDFs(request.params.paymentId);
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
      await mollie.clearPDFs(request.params.paymentId);
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

  // Analytics
  fastify.get(
    '/analytics',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const analytics = await AnalyticsClient.getInstance().getAllCounters();
      reply.send({ success: true, data: analytics });
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
      const { id, artist, name, year, spotifyLink, youtubeLink } = request.body;

      if (!id || !artist || !name || !year || !spotifyLink || !youtubeLink) {
        return { success: false, error: 'Missing required fields' };
      }
      const success = await data.updateTrack(
        id,
        artist,
        name,
        year,
        spotifyLink,
        youtubeLink,
        request.clientIp
      );
      return { success };
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
          await fs.access(invoicePath, fs.constants.R_OK);
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
          const fileContent = await fs.readFile(invoicePath);
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

  // Update PaymentHasPlaylist
  fastify.post(
    '/php/:paymentHasPlaylistId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const paymentHasPlaylistId = parseInt(
          request.params.paymentHasPlaylistId
        );
        const { eco, doubleSided, hideDomain } = request.body;

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

        // hideDomain is optional, default to false if not provided
        const hideDomainValue =
          typeof hideDomain === 'boolean' ? hideDomain : false;

        const result = await data.updatePaymentHasPlaylist(
          paymentHasPlaylistId,
          eco,
          doubleSided,
          hideDomainValue
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
        const { limit = 2 } = request.body;
        const { merchantCenter } = await import('../merchantcenter');
        merchantCenter.uploadFeaturedPlaylists(limit);
        reply.send({
          success: true,
          message: `Uploaded ${limit} featured playlists to Merchant Center`,
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
}
