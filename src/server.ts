import { FastifyInstance } from 'fastify/types/instance';
import { generateToken, verifyToken } from './auth';
import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import { OrderSearch } from './interfaces/OrderSearch';
import Logger from './logger';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import os from 'os';
import Utils from './utils';
import Spotify from './spotify';
import Mollie from './mollie';
import Qr from './qr';
import path from 'path';
import view from '@fastify/view';
import ejs from 'ejs';
import Data from './data';
import fs from 'fs/promises';
import Order from './order';
import Mail from './mail';
import ipPlugin from './plugins/ipPlugin';
import Formatters from './formatters';
import Translation from './translation';
import Cache from './cache';
import Generator from './generator';
import AnalyticsClient from './analytics';
import { ChatGPT } from './chatgpt';
import Discount from './discount';
import GitChecker from './git';
import { OpenPerplex } from './openperplex';
import Push from './push';
import Review from './review';
import Trustpilot from './trustpilot';
import { Music } from './music';
import Suggestion from './suggestion';
import Designer from './designer';
import Hitlist from './hitlist';

interface QueryParameters {
  [key: string]: string | string[];
}

declare module 'fastify' {
  export interface FastifyInstance {
    authenticate: any;
  }
}

class Server {
  private static instance: Server;
  private fastify: FastifyInstance;
  private logger = new Logger();
  private port = 3004;
  private workerId: number = 0;
  private isMainServer: boolean = false;
  private utils = new Utils();
  private spotify = new Spotify();
  private mollie = new Mollie();
  private qr = new Qr();
  private data = Data.getInstance();
  private order = Order.getInstance();
  private mail = Mail.getInstance();
  private formatters = new Formatters().getFormatters();
  private translation: Translation = new Translation();
  private cache = Cache.getInstance();
  private generator = Generator.getInstance();
  private analytics = AnalyticsClient.getInstance();
  private openai = new ChatGPT();
  private discount = new Discount();
  private openperplex = new OpenPerplex();
  private push = Push.getInstance();
  private review = Review.getInstance();
  private trustpilot = Trustpilot.getInstance();
  private music = new Music();
  private suggestion = Suggestion.getInstance();
  private designer = Designer.getInstance();
  private hitlist = Hitlist.getInstance();
  private whiteLabels = [
    {
      domain: 'k7.com',
      template: 'k7',
    },
  ];

  private version: string = '1.0.0';

  private constructor() {
    this.fastify = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024 * 100, // 100 MB, adjust as needed
    });
  }

  // Static method to get the instance of the class
  public static getInstance(): Server {
    if (!Server.instance) {
      Server.instance = new Server();
    }
    return Server.instance;
  }

  private addAuthRoutes = async () => {
    // Middleware for token verification
    const verifyTokenMiddleware = async (request: any, reply: any) => {
      const token = request.headers.authorization?.split(' ')[1];
      const decoded = verifyToken(token || '');

      if (!decoded) {
        reply.status(401).send({ error: 'Unauthorized' });
        return false;
      } else {
        if (
          decoded.username == 'Sidra' &&
          request.url != '/tracks/search' &&
          request.url != '/tracks/update'
        ) {
          reply.status(401).send({ error: 'Unauthorized' });
          console.log('Nee!');

          return false;
        }
      }
      return true;
    };

    this.fastify.post(
      '/create_order',
      { preHandler: verifyTokenMiddleware },
      async (request: any, _reply) => {
        return await this.generator.sendToPrinter(
          request.body.paymentId,
          request.clientIp
        );
      }
    );

    this.fastify.post('/validate', async (request: any, reply: any) => {
      const { username, password } = request.body as {
        username: string;
        password: string;
      };
      const validUsername = process.env.ENV_ADMIN_USERNAME;
      const validPassword = process.env.ENV_ADMIN_PASSWORD;
      const validUsername2 = process.env.ENV_ADMIN_USERNAME2;
      const validPassword2 = process.env.ENV_ADMIN_PASSWORD2;

      if (
        (username === validUsername && password === validPassword) ||
        (username === validUsername2 && password === validPassword2)
      ) {
        const token = generateToken(username);
        reply.send({ token });
      } else {
        reply.status(401).send({ error: 'Invalid credentials' });
      }
    });

    this.fastify.get(
      '/verify/:paymentId',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        this.data.verifyPayment(request.params.paymentId);
        reply.send({ success: true });
      }
    );

    this.fastify.post(
      '/openperplex',
      { preHandler: verifyTokenMiddleware },
      async (request: any, _reply) => {
        const year = await this.openperplex.ask(
          request.body.artist,
          request.body.title
        );
        return { success: true, year };
      }
    );

    this.fastify.get(
      '/reviews/:locale/:amount',
      async (request: any, _reply) => {
        const amount = parseInt(request.params.amount) || 0;
        return await this.trustpilot.getReviews(
          true,
          amount,
          request.params.locale
        );
      }
    );

    this.fastify.get('/reviews_details', async (_request: any, _reply) => {
      return await this.trustpilot.getCompanyDetails();
    });

    this.fastify.get('/review/:paymentId', async (request: any, _reply) => {
      return await this.review.checkReview(request.params.paymentId);
    });

    this.fastify.post('/review/:paymentId', async (request: any, _reply) => {
      const { rating, review } = request.body;
      return await this.review.createReview(
        request.params.paymentId,
        rating,
        review
      );
    });

    this.fastify.get(
      '/lastplays',
      { preHandler: verifyTokenMiddleware },
      async (_request: any, reply: any) => {
        const lastPlays = await this.data.getLastPlays();
        reply.send({ success: true, data: lastPlays });
      }
    );

    this.fastify.post(
      '/push/broadcast',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const { title, message, test, dry } = request.body;
        await this.push.broadcastNotification(
          title,
          message,
          this.utils.parseBoolean(test),
          this.utils.parseBoolean(dry)
        );
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/push/messages',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        return await this.push.getMessages();
      }
    );

    this.fastify.get(
      '/regenerate/:paymentId/:email',
      { preHandler: verifyTokenMiddleware },
      async (request: any, _reply) => {
        await this.mollie.clearPDFs(request.params.paymentId);
        this.generator.generate(
          request.params.paymentId,
          request.clientIp,
          '',
          this.mollie,
          true, // Force finalize
          !this.utils.parseBoolean(request.params.email) // Skip main mail
        );
        return { success: true };
      }
    );

    this.fastify.post(
      '/orders',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const search = {
          ...request.body,
          page: request.body.page || 1,
          itemsPerPage: request.body.itemsPerPage || 10,
        };

        const { payments, totalItems } = await this.mollie.getPaymentList(
          search
        );

        reply.send({
          data: payments,
          totalItems,
          currentPage: search.page,
          itemsPerPage: search.itemsPerPage,
        });
      }
    );

    this.fastify.post(
      '/discount/:code/:digital',
      async (request: any, reply: any) => {
        const result = await this.discount.checkDiscount(
          request.params.code,
          request.body.token,
          this.utils.parseBoolean(request.params.digital)
        );
        reply.send(result);
      }
    );

    this.fastify.post('/push/register', async (request: any, reply: any) => {
      const { token, type } = request.body;
      if (!token || !type) {
        reply.status(400).send({ error: 'Invalid request' });
        return;
      }

      await this.push.addToken(token, type);
      reply.send({ success: true });
    });

    this.fastify.get(
      '/analytics',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const analytics = await this.analytics.getAllCounters();
        reply.send({ success: true, data: analytics });
      }
    );

    this.fastify.post(
      '/tracks/search',
      { preHandler: verifyTokenMiddleware },
      async (request: any, _reply) => {
        const { searchTerm = '', missingYouTubeLink } = request.body;
        const tracks = await this.data.searchTracks(
          searchTerm,
          this.utils.parseBoolean(missingYouTubeLink)
        );
        return { success: true, data: tracks };
      }
    );

    this.fastify.post(
      '/tracks/update',
      { preHandler: verifyTokenMiddleware },
      async (request: any, _reply) => {
        const { id, artist, name, year, spotifyLink, youtubeLink } =
          request.body;

        if (!id || !artist || !name || !year || !spotifyLink || !youtubeLink) {
          return { success: false, error: 'Missing required fields' };
        }
        const success = await this.data.updateTrack(
          id,
          artist,
          name,
          year,
          spotifyLink,
          youtubeLink
        );
        return { success };
      }
    );

    this.fastify.get(
      '/yearcheck',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const result = await this.data.getFirstUncheckedTrack();
        reply.send({
          success: true,
          track: result.track,
          totalUnchecked: result.totalUnchecked,
        });
      }
    );

    this.fastify.post(
      '/yearcheck',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const result = await this.data.updateTrackCheck(
          request.body.trackId,
          request.body.year
        );
        if (result.success && result.checkedPaymentIds!.length > 0) {
          for (const paymentId of result.checkedPaymentIds!) {
            this.generator.finalizeOrder(paymentId, this.mollie);
          }
        }
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/check_unfinalized',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        this.data.checkUnfinalizedPayments();
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/month_report/:yearMonth',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const { yearMonth } = request.params;
        const year = parseInt(yearMonth.substring(0, 4));
        const month = parseInt(yearMonth.substring(4, 6));

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const report = await this.mollie.getPaymentsByMonth(startDate, endDate);

        reply.send({
          success: true,
          data: report,
        });
      }
    );

    this.fastify.get(
      '/add_spotify',
      { preHandler: verifyTokenMiddleware },
      async (_request: any, reply) => {
        const result = this.data.addSpotifyLinks();
        return { success: true, processed: result };
      }
    );

    this.fastify.get(
      '/fix_preview_links',
      { preHandler: verifyTokenMiddleware },
      async (_request: any, _reply) => {
        const result = await this.data.fixPreviewLinks();
        return {
          success: true,
          processed: result.processed,
          updated: result.updated,
          errors: result.errors,
        };
      }
    );

    this.fastify.get(
      '/tax_report/:yearMonth',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const { yearMonth } = request.params;
        const year = parseInt(yearMonth.substring(0, 4));
        const month = parseInt(yearMonth.substring(4, 6));

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const report = await this.mollie.getPaymentsByTaxRate(
          startDate,
          endDate
        );

        reply.send({
          success: true,
          data: report,
        });
      }
    );

    this.fastify.get(
      '/day_report',
      { preHandler: verifyTokenMiddleware },
      async (_request: any, reply: any) => {
        const report = await this.mollie.getPaymentsByDay();
        reply.send({
          success: true,
          data: report,
        });
      }
    );

    this.fastify.get(
      '/corrections',
      { preHandler: verifyTokenMiddleware },
      async (_request: any, reply) => {
        const corrections = await this.suggestion.getCorrections();
        return { success: true, data: corrections };
      }
    );

    this.fastify.post(
      '/correction/:paymentId/:userHash/:playlistId/:andSend',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply) => {
        this.suggestion.processCorrections(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          this.utils.parseBoolean(request.params.andSend),
          request.clientIp
        );
        return { success: true };
      }
    );

    this.fastify.post(
      '/finalize',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        this.generator.finalizeOrder(request.body.paymentId, this.mollie);
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/download_invoice/:invoiceId',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const { invoiceId } = request.params;
        const orderInstance = this.order;

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
  };

  public init = async () => {
    this.isMainServer = this.utils.parseBoolean(process.env['MAIN_SERVER']!);
    await this.setVersion();
    await this.createDirs();
    await this.registerPlugins();
    await this.addRoutes();
    await this.addAuthRoutes();
    await this.startCluster();
  };

  private async setVersion() {
    this.version = JSON.parse(
      await fs.readFile('package.json', 'utf-8')
    ).version;
  }

  private async createDirs() {
    const publicDir = process.env['PUBLIC_DIR']!;
    const privateDir = process.env['PRIVATE_DIR']!;
    await this.utils.createDir(`${publicDir}/qr`);
    await this.utils.createDir(`${publicDir}/pdf`);
    await this.utils.createDir(`${privateDir}/invoice`);
  }

  public getWorkerId() {
    return this.workerId;
  }

  private async startCluster() {
    if (cluster.isPrimary) {
      this.logger.log(
        color.blue.bold(
          `Master ${color.bold.white(process.pid)} is starting...`
        )
      );

      const numCPUs = os.cpus().length;
      for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
          WORKER_ID: `${i}`,
        });
      }
      cluster.on('exit', (worker, code, signal) => {
        this.logger.log(
          color.red.bold(
            `Worker ${color.white.bold(worker.process.pid)} died. Restarting...`
          )
        );
        cluster.fork({
          WORKER_ID: `${parseInt(process.env['WORKER_ID'] as string)}`,
        });
      });
    } else {
      this.workerId = parseInt(process.env['WORKER_ID'] as string);
      this.startServer();
    }
  }

  public async startServer(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.fastify.listen({ port: this.port, host: '0.0.0.0' });
        this.logger.log(
          color.green.bold('Fastify running on port: ') +
            color.white.bold(this.port) +
            color.green.bold(' on worker ') +
            color.white.bold(this.workerId)
        );
        resolve();
      } catch (err) {
        this.fastify.log.error(err);
        reject(err);
      }
    });
  }

  public getPort(): number {
    return this.port;
  }

  public async registerPlugins() {
    await this.fastify.register(require('@fastify/multipart'), {
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit for file uploads
      },
    });
    await this.fastify.register(require('@fastify/formbody'));
    await this.fastify.register(ipPlugin);
    await this.fastify.register(replyFrom);
    await this.fastify.register(require('@fastify/cors'), {
      origin: '*',
      methods: 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
      allowedHeaders:
        'Origin, X-Requested-With, Content-Type, Accept, sentry-trace, baggage, Authorization',
      credentials: true,
    });

    // Add security headers
    this.fastify.addHook('onSend', (_request, reply, _payload, done) => {
      reply.header('X-Frame-Options', 'DENY');
      done();
    });

    await this.fastify.register((instance, opts, done) => {
      instance.register(require('@fastify/static'), {
        root: process.env['PUBLIC_DIR'] as string,
        prefix: '/public/',
      });
      done();
    });

    await this.fastify.register((instance, opts, done) => {
      instance.register(require('@fastify/static'), {
        root: process.env['ASSETS_DIR'] as string,
        prefix: '/assets/',
      });
      done();
    });

    await this.fastify.register((instance, opts, done) => {
      instance.register(require('@fastify/static'), {
        root: path.join(process.cwd(), 'app'),
        prefix: '/',
      });
      done();
    });

    await this.fastify.setErrorHandler((error, request, reply) => {
      console.error(error);
      reply.status(500).send({ error: 'Internal Server Error' });
    });

    // Register the view plugin with EJS
    await this.fastify.register(view, {
      engine: { ejs: ejs },
      root: `${process.env['APP_ROOT']}/views`, // Ensure this is the correct path to your EJS templates
      includeViewExtension: true,
    });
  }

  public async addRoutes() {
    this.fastify.get(
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

    this.fastify.get('/robots.txt', async (_request, reply) => {
      reply
        .header('Content-Type', 'text/plain')
        .send('User-agent: *\nDisallow: /');
    });

    this.fastify.post(
      '/spotify/playlists/tracks',
      async (request: any, _reply) => {
        return await this.spotify.getTracks(
          request.body.playlistId,
          this.utils.parseBoolean(request.body.cache),
          request.body.captchaToken,
          true,
          this.utils.parseBoolean(request.body.slug)
        );
      }
    );

    this.fastify.post(
      '/spotify/playlists',

      async (request: any, _reply) => {
        return await this.spotify.getPlaylist(
          request.body.playlistId,
          this.utils.parseBoolean(request.body.cache),
          request.body.captchaToken,
          true,
          this.utils.parseBoolean(request.body.featured),
          this.utils.parseBoolean(request.body.slug),
          request.body.locale
        );
      }
    );

    this.fastify.get('/spotify/playlists', async (request: any, _reply) => {
      return await this.spotify.getPlaylists(request.headers);
    });

    this.fastify.post('/spotify/callback', async (request: any, _reply) => {
      return await this.spotify.getTokens(request.body.code);
    });

    this.fastify.post('/mollie/check', async (request: any, _reply) => {
      return await this.mollie.checkPaymentStatus(request.body.paymentId);
    });

    this.fastify.post('/mollie/payment', async (request: any, _reply) => {
      return await this.mollie.getPaymentUri(request.body, request.clientIp);
    });

    this.fastify.post('/mollie/webhook', async (request: any, _reply) => {
      return await this.mollie.processWebhook(request.body);
    });

    this.fastify.post('/contact', async (request: any, _reply) => {
      return await this.mail.sendContactForm(request.body, request.clientIp);
    });

    this.fastify.get('/ip', async (request, reply) => {
      return { ip: request.ip, clientIp: request.clientIp };
    });

    this.fastify.get(
      '/progress/:playlistId/:paymentId',
      async (request: any, _reply) => {
        const data = await this.data.getPayment(
          request.params.paymentId,
          request.params.playlistId
        );
        return {
          success: true,
          data,
        };
      }
    );

    this.fastify.get('/qr/:trackId', async (request: any, reply) => {
      // Get the 'Accept-Language' header from the request
      const locale = this.utils.parseAcceptLanguage(
        request.headers['accept-language']
      );
      const translations = await this.translation.getTranslationsByPrefix(
        locale,
        'countdown'
      );
      let useVersion = this.version;
      if (process.env['ENVIRONMENT'] === 'development') {
        useVersion = new Date().getTime().toString();
      }
      await reply.view(`countdown.ejs`, {
        translations,
        version: useVersion,
        domain: process.env['FRONTEND_URI'],
      });
    });

    this.fastify.get('/qrlink/:trackId', async (request: any, reply) => {
      // Get the reqeust headers
      const headers = request.headers;

      const result = await this.data.getLink(
        request.params.trackId,
        request.clientIp
      );
      let link = '';
      let yt = '';
      if (result.success) {
        link = result.data.link;
        yt = result.data.youtubeLink;
      }
      return { link, yt };
    });

    this.fastify.get(
      '/qr/pdf/:playlistId/:paymentId/:template/:startIndex/:endIndex/:subdir/:eco/:emptyPages',
      async (request: any, reply) => {
        const valid = await this.mollie.canDownloadPDF(
          request.params.playlistId,
          request.params.paymentId
        );
        if (!valid) {
          reply.status(403).send({ error: 'Forbidden' });
          return;
        }

        const payment = await this.mollie.getPayment(request.params.paymentId);
        const user = await this.data.getUser(payment.userId);
        const playlist = await this.data.getPlaylist(request.params.playlistId);
        const php = await this.data.getPlaylistsByPaymentId(
          request.params.paymentId,
          request.params.playlistId
        );
        let tracks = await this.data.getTracks(playlist.id, user.id);

        // Slice the tracks based on the start and end index which is 0-based
        const startIndex = parseInt(request.params.startIndex);
        const endIndex = parseInt(request.params.endIndex);
        const eco = this.utils.parseBoolean(request.params.eco);
        const emptyPages = parseInt(request.params.emptyPages);
        const subdir = request.params.subdir;
        tracks = tracks.slice(startIndex, endIndex + 1);

        // Extract domain from email and check if it's in the whitelist
        const emailDomain = payment.email ? payment.email.split('@')[1] : '';
        const whitelabel = this.whiteLabels.find(
          (wl) => wl.domain === emailDomain
        );

        if (payment.email) {
          const template =
            whitelabel && request.params.template.indexOf('digital_double') > -1
              ? `${request.params.template}_${whitelabel.template}`
              : request.params.template;

          await reply.view(`pdf_${template}.ejs`, {
            subdir,
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

    this.fastify.get('/invoice/:paymentId', async (request: any, reply) => {
      const payment = await this.mollie.getPayment(request.params.paymentId);
      if (!payment) {
        reply.status(404).send({ error: 'Payment not found' });
        return;
      }
      const playlists = await this.data.getPlaylistsByPaymentId(
        payment.paymentId
      );

      let orderType = 'digital';
      for (const playlist of playlists) {
        if (playlist.orderType !== 'digital') {
          orderType = 'physical';
          break;
        }
      }

      await reply.view(`invoice.ejs`, {
        payment,
        playlists,
        orderType,
        ...this.formatters,
        translations: await this.translation.getTranslationsByPrefix(
          payment.locale,
          'invoice'
        ),
        countries: await this.translation.getTranslationsByPrefix(
          payment.locale,
          'countries'
        ),
      });
    });

    this.fastify.get('/test', async (request: any, _reply) => {
      this.analytics.increaseCounter('testCategory', 'testAction');

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

      return { success: true, localIp, version: this.version };
    });

    this.fastify.get('/featured/:locale', async (request: any, _reply) => {
      const playlists = await this.data.getFeaturedPlaylists(
        request.params.locale
      );
      return { success: true, data: playlists };
    });

    this.fastify.get(
      '/ordertype/:numberOfTracks/:digital/:subType/:playlistId',
      async (request: any, _reply) => {
        const orderType = await this.order.getOrderType(
          parseInt(request.params.numberOfTracks),
          this.utils.parseBoolean(request.params.digital),
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

    this.fastify.get('/ordertypes', async (request: any, _reply) => {
      const orderTypes = await this.order.getOrderTypes();
      if (orderTypes && orderTypes.length > 0) {
        return orderTypes;
      } else {
        return { success: false, error: 'Order type not found' };
      }
    });

    this.fastify.get(
      '/download/:paymentId/:userHash/:playlistId/:type',
      async (request: any, reply) => {
        const pdfFile = await this.data.getPDFFilepath(
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

            this.logger.log(
              color.blue.bold(
                `User downloaded file: ${color.white.bold(pdfFile.filePath)}`
              )
            );

            reply.send(fileContent);
          } catch (error) {
            reply.code(404).send('PDF not found');
          }
        } else {
          reply.code(404).send('PDF not found');
        }
      }
    );

    this.fastify.post('/order/calculate', async (request: any, _reply) => {
      try {
        const result = await this.order.calculateOrder(request.body);
        return result;
      } catch (e) {
        return { success: false };
      }
    });

    this.fastify.get('/cache', async (request: any, _reply) => {
      await this.cache.flush();
      this.order.updateFeaturedPlaylists();
      await this.cache.flush();
      return { success: true };
    });

    this.fastify.post('/printapi/webhook', async (request: any, _reply) => {
      await this.order.processPrintApiWebhook(request.body.orderId);
      return { success: true };
    });

    this.fastify.get('/upload_contacts', async (request: any, _reply) => {
      const result = await this.mail.uploadContacts();
      return { success: true };
    });

    this.fastify.post('/newsletter_subscribe', async (request: any, reply) => {
      const { email, captchaToken } = request.body;
      if (!email || !this.utils.isValidEmail(email)) {
        reply
          .status(400)
          .send({ success: false, error: 'Invalid email address' });
        return;
      }

      const result = await this.mail.subscribeToNewsletter(email, captchaToken);
      return { success: result };
    });

    this.fastify.get('/unsubscribe/:hash', async (request: any, reply) => {
      const result = await this.mail.unsubscribe(request.params.hash);
      if (result) {
        reply.send({ success: true, message: 'Successfully unsubscribed' });
      } else {
        reply
          .status(400)
          .send({ success: false, message: 'Invalid unsubscribe link' });
      }
    });

    this.fastify.get('/unsent_reviews', async (request: any, _reply) => {
      return await this.review.processReviewEmails();
    });

    this.fastify.get(
      '/usersuggestions/:paymentId/:userHash/:playlistId',
      async (request: any, reply) => {
        const suggestions = await this.suggestion.getUserSuggestions(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId
        );
        return { success: true, data: suggestions };
      }
    );

    this.fastify.post(
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

        const success = await this.suggestion.saveUserSuggestion(
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

    this.fastify.post(
      '/usersuggestions/:paymentId/:userHash/:playlistId/submit',
      async (request: any, reply) => {
        const success = await this.suggestion.submitUserSuggestions(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          request.clientIp
        );
        return { success };
      }
    );

    this.fastify.post(
      '/usersuggestions/:paymentId/:userHash/:playlistId/extend',
      async (request: any, reply) => {
        const success = await this.suggestion.extendPrinterDeadline(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId
        );
        return { success };
      }
    );

    this.fastify.post('/designer/upload/:type', async (request: any, reply) => {
      const { image, filename } = request.body;
      const { type } = request.params;

      if (!image) {
        reply.status(400).send({ success: false, error: 'No image provided' });
        return;
      }

      let result = { success: false };

      if (type == 'background') {
        result = await this.designer.uploadBackgroundImage(image, filename);
      } else if (type == 'logo') {
        result = await this.designer.uploadLogoImage(image, filename);
      }
      return result;
    });

    this.fastify.delete(
      '/usersuggestions/:paymentId/:userHash/:playlistId/:trackId',
      async (request: any, reply) => {
        const success = await this.suggestion.deleteUserSuggestion(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          parseInt(request.params.trackId)
        );
        return { success };
      }
    );

    if (process.env['ENVIRONMENT'] == 'development') {
      this.fastify.get(
        '/generate_invoice/:paymentId',
        async (request: any, _reply) => {
          const payment = await this.mollie.getPayment(
            request.params.paymentId
          );
          if (payment) {
            const pdfPath = await this.order.createInvoice(payment);
            this.mail.sendTrackingEmail(
              payment,
              payment.printApiTrackingLink!,
              pdfPath
            );
            return { success: true };
          } else {
            return { success: false };
          }
        }
      );

      this.fastify.get(
        '/youtube/:artist/:title',
        async (request: any, reply: any) => {
          const result = await this.data.getYouTubeLink(
            request.params.artist,
            request.params.title
          );
          reply.send({
            success: true,
            youtubeLink: result,
          });
        }
      );

      this.fastify.post('/push', async (request: any, reply: any) => {
        const { token, title, message } = request.body;
        await this.push.sendPushNotification(token, title, message);
        reply.send({ success: true });
      });

      this.fastify.post('/qrtest', async (request: any, _reply) => {
        const result = await this.qr.generateQR(
          `${request.body.url}`,
          `/mnt/efs/qrsong/${request.body.filename}`
        );
        return { success: true };
      });

      this.fastify.get('/testorder', async (request: any, _reply) => {
        await this.order.testOrder();
        return { success: true };
      });

      this.fastify.get('/calculate_shipping', async (request: any, _reply) => {
        this.order.calculateShippingCosts();
        return { success: true };
      });

      this.fastify.get('/fix_years', async (request: any, _reply) => {
        await this.data.fixYears();
        return { success: true };
      });

      this.fastify.get('/generate/:paymentId', async (request: any, _reply) => {
        await this.generator.generate(
          request.params.paymentId,
          request.clientIp,
          '',
          this.mollie
        );
        return { success: true };
      });

      this.fastify.get('/mail/:paymentId', async (request: any, _reply) => {
        const payment = await this.mollie.getPayment(request.params.paymentId);
        const playlist = await this.data.getPlaylist(
          payment.playlist.playlistId
        );
        await this.mail.sendEmail(
          'digital',
          payment,
          playlist,
          payment.filename,
          payment.filenameDigital
        );
        return { success: true };
      });

      this.fastify.get('/release/:query', async (request: any, _reply) => {
        const year = await this.openai.ask(request.params.query);
        return { success: true, year };
      });

      this.fastify.get(
        '/yearv2/:id/:isrc/:artist/:title/:spotifyReleaseYear',
        async (request: any, _reply) => {
          const result = await this.music.getReleaseDate(
            parseInt(request.params.id),
            request.params.isrc,
            request.params.artist,
            request.params.title,
            parseInt(request.params.spotifyReleaseYear)
          );
          return { success: true, data: result };
        }
      );
    }

    this.fastify.get(
      '/discount/voucher/:type/:code/:paymentId',
      async (request: any, reply: any) => {
        const { type, code, paymentId } = request.params;
        const discount = await this.discount.getDiscountDetails(code);
        const payment = await this.mollie.getPayment(paymentId);
        if (discount) {
          try {
            const translations = await this.translation.getTranslationsByPrefix(
              payment.locale,
              'voucher'
            );
            await reply.view(`voucher_${type}.ejs`, {
              discount,
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

    // Hitlist routes
    this.fastify.post('/hitlist', async (request: any, _reply) => {
      return await this.hitlist.getCompanyListByDomain(
        request.body.domain,
        request.body.hash,
        request.body.slug
      );
    });

    this.fastify.post('/hitlist/search', async (request: any, _reply) => {
      const { searchString, limit = 10, offset = 0 } = request.body;

      // Use the hitlist search method instead of directly calling spotify
      return await this.spotify.searchTracks(searchString);
    });

    this.fastify.post('/hitlist/tracks', async (request: any, _reply) => {
      const { trackIds } = request.body;

      if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
        return { success: false, error: 'Invalid track IDs' };
      }

      return await this.spotify.getTracksByIds(trackIds);
    });

    this.fastify.post('/hitlist/submit', async (request: any, reply) => {
      const { hitlist, companyListId, submissionHash, fullname, email } =
        request.body;

      // Add companyListId, submissionHash, fullname and email to each track
      const enrichedHitlist = hitlist.map((track: any) => ({
        ...track,
        companyListId,
        submissionHash,
        fullname,
        email,
      }));

      const result = await this.hitlist.submit(enrichedHitlist);
      if (!result.success) {
        return result; // Return error if submission failed
      }

      return {
        success: true,
        message: email
          ? 'Please check your email to verify your submission'
          : 'Submission received',
      };
    });

    // API endpoint for verifying submissions via POST request
    this.fastify.post('/hitlist/verify', async (request: any, reply) => {
      const { hash } = request.body;

      if (!hash) {
        return { success: false, error: 'Missing verification hash' };
      }

      const success = await this.hitlist.verifySubmission(hash);

      return {
        success: success,
        message: success
          ? 'Submission verified successfully'
          : 'Verification failed',
      };
    });

    // API endpoint for finalizing a company list (creating a top 10)
    this.fastify.post('/hitlist/finalize', async (request: any, reply) => {
      const { companyListId } = request.body;

      if (!companyListId) {
        return { success: false, error: 'Missing company list ID' };
      }

      return await this.hitlist.finalizeList(parseInt(companyListId));
    });

    // API endpoint for completing Spotify authorization with the code
    this.fastify.post(
      '/hitlist/spotify-auth-complete',
      async (request: any, reply) => {
        const { code } = request.body;

        if (!code) {
          return { success: false, error: 'Missing authorization code' };
        }

        return await this.hitlist.completeSpotifyAuth(code);
      }
    );

    // API endpoint for handling Spotify authorization callback (this will be hit by the browser)
    this.fastify.get('/spotify_callback', async (request: any, reply) => {
      const { code, state } = request.query;

      if (!code) {
        reply.type('text/html').send(`
          <html>
            <head><title>Spotify Authorization Failed</title></head>
            <body>
              <h1>Authorization Failed</h1>
              <p>No authorization code was received from Spotify.</p>
            </body>
          </html>
        `);
        return;
      }

      // Automatically process the authorization
      const result = await this.hitlist.completeSpotifyAuth(code);

      if (result.success) {
        reply.type('text/html').send(`
          <html>
            <head><title>Spotify Authorization Complete</title></head>
            <body>
              <h1>Authorization Complete</h1>
              <p>The Spotify playlist has been created successfully!</p>
              <p><a href="${result.data.playlistUrl}" target="_blank">View your playlist</a></p>
            </body>
          </html>
        `);
      } else {
        reply.type('text/html').send(`
          <html>
            <head><title>Spotify Authorization Error</title></head>
            <body>
              <h1>Authorization Error</h1>
              <p>There was an error creating the Spotify playlist: ${result.error}</p>
            </body>
          </html>
        `);
      }
    });
  }
}

export default Server;
