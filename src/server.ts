import { FastifyInstance } from 'fastify/types/instance';
import blogRoutes from '../routes/blogRoutes';
import accountRoutes from './routes/accountRoutes';
import adminRoutes from './routes/adminRoutes';
import vibeRoutes from './routes/vibeRoutes';
import musicRoutes from './routes/musicRoutes';
import themeRoutes from './routes/themeRoutes';
import paymentRoutes from './routes/paymentRoutes';
import publicRoutes from './routes/publicRoutes';
import gameRoutes from './routes/gameRoutes';
import bingoRoutes from './routes/bingoRoutes';
import quizRoutes from './routes/quizRoutes';
import { verifyToken } from './auth';
import { getTokenFromRequest } from './cookieAuth';
import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import Logger from './logger';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import os from 'os';
import Utils from './utils';
import path from 'path';
import view from '@fastify/view';
import ejs from 'ejs';
import fs from 'fs/promises';
import ipPlugin from './plugins/ipPlugin';
import { createServer } from 'http';
import NativeWebSocketServer from './websocket-native';
import ChatWebSocketServer from './chat-websocket';
import ProgressWebSocketServer from './progress-websocket';
import GeneratorQueue from './generatorQueue';
import MusicFetchQueue from './musicfetchQueue';
import ExcelQueue from './excelQueue';
import ExternalCardService from './externalCardService';

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
  private version: string = '1.0.0';
  private httpServer: any;
  private wsServer: NativeWebSocketServer | null = null;
  private chatWsServer: ChatWebSocketServer | null = null;
  private progressWsServer: ProgressWebSocketServer | null = null;

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
    const verifyTokenMiddleware = async (
      request: any,
      reply: any,
      allowedGroups: string[] = []
    ) => {
      // Get token from cookie or Authorization header
      const token = getTokenFromRequest(request);
      const decoded = verifyToken(token || '');

      if (!decoded) {
        reply.status(401).send({ error: 'Unauthorized' });
        return false;
      }

      // Attach decoded token to request for later use
      request.user = decoded;

      // Check if user has any of the allowed groups
      if (allowedGroups.length > 0) {
        const userGroups = decoded.userGroups || [];
        const hasAllowedGroup = userGroups.some((group: string) =>
          allowedGroups.includes(group)
        );

        if (!hasAllowedGroup) {
          reply
            .status(403)
            .send({ error: 'Forbidden: Insufficient permissions' });
          return false;
        }
      }

      return true;
    };

    const getAuthHandler = (allowedGroups: string[]) => {
      return {
        // Conditionally apply preHandler based on environment
        preHandler: (request: any, reply: any) =>
          verifyTokenMiddleware(request, reply, allowedGroups),
      };
    };

    // Register route modules
    await accountRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await adminRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await vibeRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await bingoRoutes(this.fastify, getAuthHandler);
    await quizRoutes(this.fastify, getAuthHandler);
    await gameRoutes(this.fastify, getAuthHandler);
  };

  public async addRoutes() {
    // Register blog routes
    await blogRoutes(this.fastify);

    // Register music/spotify routes
    await musicRoutes(this.fastify);

    // Register theme routes
    await themeRoutes(this.fastify);

    // Register payment routes
    await paymentRoutes(this.fastify);

    // Register public routes
    await publicRoutes(this.fastify);

    // WebSocket endpoints - return 426 Upgrade Required for non-WebSocket requests
    this.fastify.get('/chat-ws', async (request, reply) => {
      reply.status(426).send({ error: 'Upgrade Required', message: 'This endpoint requires a WebSocket connection' });
    });
    this.fastify.get('/ws', async (request, reply) => {
      reply.status(426).send({ error: 'Upgrade Required', message: 'This endpoint requires a WebSocket connection' });
    });
  }

  public init = async () => {
    this.isMainServer = this.utils.parseBoolean(process.env['MAIN_SERVER']!);
    await this.setVersion();
    await this.createDirs();
    await this.registerPlugins();
    await this.addAuthRoutes();
    await this.addRoutes();
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
    await this.utils.createDir(`${publicDir}/excel`);
    await this.utils.createDir(`${publicDir}/avatars`);
    await this.utils.createDir(`${publicDir}/quiz_images`);
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

      // Initialize queue workers only if explicitly enabled
      // In production, use the standalone worker process instead

      if (
        process.env['REDIS_URL'] &&
        process.env['RUN_QUEUE_WORKERS'] === 'true' &&
        ((await this.utils.isMainServer()) ||
          process.env['ENVIRONMENT'] === 'development')
      ) {
        try {
          const workerCount = parseInt(process.env['QUEUE_WORKERS'] || '2');
          const generatorQueue = GeneratorQueue.getInstance();
          await generatorQueue.initializeWorkers(workerCount);

          const musicFetchQueue = MusicFetchQueue.getInstance();
          musicFetchQueue.startWorkers(1);

          const excelQueue = ExcelQueue.getInstance();
          excelQueue.startWorkers(2);

          this.logger.log(
            color.green.bold(
              `Queue workers initialized successfully: ${color.white.bold(
                workerCount.toString()
              )} Generator workers, 1 MusicFetch worker, 2 Excel workers`
            )
          );
        } catch (error) {
          this.logger.log(
            color.red.bold(`Failed to initialize queue workers: ${error}`)
          );
        }
      } else if (process.env['REDIS_URL']) {
        this.logger.log(
          color.blue.bold(
            'Queue workers not initialized (use standalone worker process or set RUN_QUEUE_WORKERS=true)'
          )
        );
      }

      // Initialize ExternalCardService (starts nightly import cron job)
      ExternalCardService.getInstance();

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

        // Initialize WebSocket servers on all workers
        if (this.fastify.server) {
          this.wsServer = new NativeWebSocketServer(this.fastify.server);
          this.chatWsServer = new ChatWebSocketServer(this.fastify.server);
          this.progressWsServer = new ProgressWebSocketServer(this.fastify.server);
          ChatWebSocketServer.setInstance(this.chatWsServer);
          ProgressWebSocketServer.setInstance(this.progressWsServer);

          // Handle WebSocket upgrade routing
          this.fastify.server.on('upgrade', (request, socket, head) => {
            const url = request.url || '';
            const pathname = url.split('?')[0];
            if (pathname === '/ws' && this.wsServer) {
              this.wsServer.handleUpgrade(request, socket, head);
            } else if (pathname === '/chat-ws' && this.chatWsServer) {
              this.chatWsServer.handleUpgrade(request, socket, head);
            } else if (pathname === '/progress-ws' && this.progressWsServer) {
              this.progressWsServer.handleUpgrade(request, socket, head);
            } else {
              socket.destroy();
            }
          });
        }

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
    // Allowed origins for CORS (with credentials)
    const isProduction = process.env['ENVIRONMENT'] === 'production';
    const productionOrigins = [
      'https://www.qrsong.io',
      'https://qrsong.io',
      'https://onzevibe.nl',
      'https://www.onzevibe.nl',
      'https://stem.onzevibe.nl',
    ];
    const developmentOrigins = [
      'http://localhost:4200',
      'http://localhost:5000',
    ];
    const allowedOrigins = isProduction
      ? productionOrigins
      : [...productionOrigins, ...developmentOrigins];

    await this.fastify.register(require('@fastify/cors'), {
      origin: (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) {
          callback(null, true);
          return;
        }
        // Check if origin is in allowed list
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          // Allow all origins (mobile app, dev servers, etc.)
          callback(null, true);
        }
      },
      methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'x-user-agent',
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'sentry-trace',
        'baggage',
        'Authorization',
      ],
      credentials: true,
    });

    // Register cookie plugin for HttpOnly cookie authentication
    await this.fastify.register(require('@fastify/cookie'));

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
      root: `${process.env['APP_ROOT']}/views`,
      includeViewExtension: true,
    });
  }
}

export default Server;
