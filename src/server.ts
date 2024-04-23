import { FastifyInstance } from 'fastify/types/instance';
import Fastify from 'fastify';
import Logger from './logger';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import os from 'os';
import Utils from './utils';
import Spotify from './spotify';
import Mollie from './mollie';

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
    await this.registerPlugins();
    await this.addRoutes();
    await this.startCluster();
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

    this.fastify.setErrorHandler((error, request, reply) => {
      if (process.env['ENVIRONMENT'] == 'development') {
        console.error(error);
      }
      reply.status(500).send({ error: 'Internal Server Error' });
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

    this.fastify.post('/mollie/payment', async (request: any, _reply) => {
      return await this.mollie.getPaymentUri(request.body);
    });

    this.fastify.post('/mollie/webhook', async (request: any, _reply) => {
      return await this.mollie.processWebhook(request.body);
    });

    this.fastify.get('/test', async (request: any, _reply) => {
      return { success: true };
    });
  }
}

export default Server;
