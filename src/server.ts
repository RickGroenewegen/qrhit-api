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
import fs from 'fs';
import Order from './order';
import Mail from './mail';
import MusicBrainz from './musicbrainz';
import ipPlugin from './plugins/ipPlugin';
import Formatters from './formatters';
import Translation from './translation';
import Cache from './cache';
import Generator from './generator';

interface QueryParameters {
  [key: string]: string | string[];
}

declare module 'fastify' {
  export interface FastifyInstance {
    authenticate: any;
  };
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
  private data = new Data();
  private order = Order.getInstance();
  private mail = new Mail();
  private musicBrainz = new MusicBrainz();
  private formatters = new Formatters().getFormatters();
  private translation: Translation = new Translation();
  private cache = Cache.getInstance();
  private generator = new Generator();

  private version: string = '1.0.0';

  private constructor() {
    this.fastify = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024 * 10, // 10 MB, adjust as needed
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
    this.fastify.post('/validate', async (request: any, reply: any) => {
      const { username, password } = request.body as {
        username: string;
        password: string;
      };
      const validUsername = process.env.ENV_ADMIN_USERNAME;
      const validPassword = process.env.ENV_ADMIN_PASSWORD;

      if (username === validUsername && password === validPassword) {
        const token = generateToken(username);
        reply.send({ token });
      } else {
        reply.status(401).send({ error: 'Invalid credentials' });
      }
    });

    this.fastify.post('/orders', async (request: any, reply: any) => {
      const token = request.headers.authorization?.split(' ')[1];
      const decoded = verifyToken(token || '');

      if (!decoded) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const search = {
        ...request.body,
        page: request.body.page || 1,
        itemsPerPage: request.body.itemsPerPage || 10,
      };

      const { payments, totalItems } = await this.mollie.getPaymentList(search);

      reply.send({
        data: payments,
        totalItems,
        currentPage: search.page,
        itemsPerPage: search.itemsPerPage,
      });
    });

    this.fastify.get(
      '/download_invoice/:invoiceId',
      async (request: any, reply: any) => {
        const token = request.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token || '');

        if (!decoded) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const { invoiceId } = request.params;
        const orderInstance = this.order;

        try {
          const invoicePath = await orderInstance.getInvoice(invoiceId);
          // Ensure the file exists and is readable
          try {
            await fs.promises.access(invoicePath, fs.constants.R_OK);
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
            const fileContent = await fs.promises.readFile(invoicePath);
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
      (await fs.readFileSync('package.json')).toString()
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
    await this.fastify.register(require('@fastify/multipart'));
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
    this.fastify.get('/robots.txt', async (_request, reply) => {
      reply
        .header('Content-Type', 'text/plain')
        .send('User-agent: *\nDisallow: /');
    });

    this.fastify.get(
      '/spotify/playlists/:playlistId/tracks/:cache',
      async (request: any, _reply) => {
        return await this.spotify.getTracks(
          request.params.playlistId,
          this.utils.parseBoolean(request.params.cache)
        );
      }
    );

    this.fastify.get(
      '/spotify/playlists/:playlistId/:cache',

      async (request: any, _reply) => {
        return await this.spotify.getPlaylist(
          request.params.playlistId,
          this.utils.parseBoolean(request.params.cache)
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

    // Setup a route to download a PDF
    this.fastify.get('/download/:filename', async (request: any, reply) => {
      const filename = path.basename(request.params.filename); // Use basename to avoid path traversal
      const filePath = path.join(process.env['PUBLIC_DIR']!, 'pdf', filename);

      // Ensure the file is a PDF for security reasons
      if (path.extname(filename) !== '.pdf') {
        reply.code(400).send('Only PDF files can be downloaded.');
        return;
      }

      // Check if the file exists and is readable
      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
      } catch (error) {
        reply.code(404).send('File not found.');
        return;
      }

      // Serve the PDF file using the filePath
      reply.header('Content-Disposition', 'attachment; filename=' + filename);
      reply.type('application/pdf');

      // Read the file into memory and send it as a buffer
      try {
        const fileContent = await fs.promises.readFile(filePath);
        reply.send(fileContent);
      } catch (error) {
        reply.code(500).send('Error reading file.');
      }
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
      const translations = this.translation.getTranslationsByPrefix(
        locale,
        'countdown'
      );
      let useVersion = this.version;
      if (process.env['ENVIRONMENT'] === 'development') {
        useVersion = new Date().getTime().toString();
      }
      await reply.view(`countdown.ejs`, { translations, version: useVersion });
    });

    this.fastify.get('/qrlink/:trackId', async (request: any, reply) => {
      const result = await this.data.getLink(request.params.trackId);
      let link = '';
      if (result.success) {
        link = result.data.link;
      }
      return { link };
    });

    this.fastify.get(
      '/qr/pdf/:playlistId/:paymentId/:template',
      async (request: any, reply) => {
        const valid = await this.mollie.canDownloadPDF(
          request.params.playlistId,
          request.params.paymentId
        );
        if (!valid) {
          reply.status(403).send({ error: 'Forbidden' });
          return;
        }
        const playlist = await this.data.getPlaylist(request.params.playlistId);
        const tracks = await this.data.getTracks(playlist.id);
        const payment = await this.mollie.getPayment(request.params.paymentId);
        const user = await this.data.getUser(payment.userId);

        await reply.view(`pdf_${request.params.template}.ejs`, {
          playlist,
          tracks,
          user,
        });
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
        translations: this.translation.getTranslationsByPrefix(
          payment.locale,
          'invoice'
        ),
      });
    });

    this.fastify.get('/test', async (request: any, _reply) => {
      return { success: true };
    });

    this.fastify.get('/featured/:locale', async (request: any, _reply) => {
      const playlists = await this.data.getFeaturedPlaylists(
        request.params.locale
      );
      return { success: true, data: playlists };
    });

    this.fastify.get(
      '/ordertype/:numberOfTracks',
      async (request: any, _reply) => {
        const orderType = await this.order.getOrderType(
          parseInt(request.params.numberOfTracks)
        );
        if (orderType) {
          return {
            success: true,
            data: {
              id: orderType.id,
              amount: orderType.amountWithMargin,
              description: orderType.description,
              maxCards: orderType.maxCards,
            },
          };
        } else {
          return { success: false, error: 'Order type not found' };
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

    this.fastify.post('/order/calculate', async (request: any, _reply) => {
      return await this.order.calculateOrder(request.body);
    });

    this.fastify.get('/cache', async (request: any, _reply) => {
      if (
        process.env['ENVIRONMENT'] == 'development' ||
        this.utils.isTrustedIp(request.clientIp)
      ) {
        await this.cache.flush();
        await this.order.updateFeaturedPlaylists();
        await this.cache.flush();
        return { success: true };
      } else {
        return { success: false };
      }
    });

    this.fastify.post('/printapi/webhook', async (request: any, _reply) => {
      console.log(123, request.body);
    });

    if (process.env['ENVIRONMENT'] == 'development') {
      this.fastify.get('/testorder', async (request: any, _reply) => {
        await this.order.testOrder();
        return { success: true };
      });

      this.fastify.get('/generate/:paymentId', async (request: any, _reply) => {
        await this.generator.generate(
          request.params.paymentId,
          request.clientId,
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

      this.fastify.get('/mb/:isrc', async (request: any, _reply) => {
        const result = await this.musicBrainz.getReleaseDateFromAPI(
          request.params.isrc
        );
        return { success: true, data: result };
      });
    }
  }
}

export default Server;
