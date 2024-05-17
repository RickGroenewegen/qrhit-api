import { FastifyInstance } from 'fastify/types/instance';
import Fastify from 'fastify';
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
import Progress from './progress';
import fs from 'fs';
import Order from './order';

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
  private port = 3003;
  private workerId: number = 0;
  private isMainServer: boolean = false;
  private utils = new Utils();
  private spotify = new Spotify();
  private mollie = new Mollie();
  private qr = new Qr();
  private data = new Data();
  private progress = Progress.getInstance();
  private order = Order.getInstance();

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

  public async init() {
    this.isMainServer = this.utils.parseBoolean(process.env['MAIN_SERVER']!);
    await this.createDirs();
    await this.registerPlugins();
    await this.addRoutes();
    await this.startCluster();
  }

  private async createDirs() {
    const publicDir = process.env['PUBLIC_DIR']!;
    await this.utils.createDir(`${publicDir}/qr`);
    await this.utils.createDir(`${publicDir}/pdf`);
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

    await this.fastify.setErrorHandler((error, request, reply) => {
      if (process.env['ENVIRONMENT'] == 'development') {
        console.error(error);
      }
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
      '/spotify/playlists/:playlistId/tracks',
      async (request: any, _reply) => {
        return await this.spotify.getTracks(
          request.headers,
          request.params.playlistId
        );
      }
    );

    this.fastify.get(
      '/spotify/playlists/:playlistId',
      async (request: any, _reply) => {
        return await this.spotify.getPlaylist(
          request.headers,
          request.params.playlistId
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
      return await this.mollie.getPaymentUri(request.body);
    });

    this.fastify.post('/mollie/webhook', async (request: any, _reply) => {
      return await this.mollie.processWebhook(request.body);
    });

    this.fastify.post('/qr/generate', async (request: any, _reply) => {
      return await this.qr.generate(request.body);
    });

    this.fastify.get(
      '/progress/:paymentId/start',
      async (request: any, _reply) => {
        return await this.progress.startProgress(request.params.paymentId);
      }
    );

    this.fastify.get('/progress/:paymentId', async (request: any, _reply) => {
      return await this.progress.getProgress(request.params.paymentId);
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
          filename: data.filename,
        };
      }
    );

    this.fastify.get(
      '/link/:userHash/:trackId',
      async (request: any, _reply) => {
        return await this.data.getLink(
          request.params.userHash,
          request.params.trackId
        );
      }
    );

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

    this.fastify.get('/test', async (request: any, _reply) => {
      return { success: true };
    });

    this.fastify.post('/order/calculate', async (request: any, _reply) => {
      return await this.order.calculateOrder(request.body);
    });
  }
}

export default Server;
