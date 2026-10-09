import { FastifyInstance } from 'fastify/types/instance';
import blogRoutes from '../routes/blogRoutes';
import accountRoutes from './routes/accountRoutes';
import adminRoutes from './routes/adminRoutes';
import companyRoutes from './routes/companyRoutes';
import musicRoutes from './routes/musicRoutes';
import themeRoutes from './routes/themeRoutes';
import paymentRoutes from './routes/paymentRoutes';
import discountRoutes from './routes/discountRoutes';
import publicRoutes from './routes/publicRoutes';
import resellerRoutes from './routes/resellerRoutes';
import gameRoutes from './routes/gameRoutes';
import boxRoutes from './routes/boxRoutes';
import appDesignRoutes from './routes/appDesignRoutes';
import bingoRoutes from './routes/bingoRoutes';
import quizRoutes from './routes/quizRoutes';
import { verifyToken } from './auth';
import { getTokenFromRequest } from './cookieAuth';
import { isCredentialedOrigin } from './corsOrigins';
import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import Logger from './logger';
import ErrorTracking from './errorTracking';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import { ensureLegacyDefaultBackgroundFile } from './legacyBackground';
import { startClusterWorkers } from './clusterPrimary';
import Utils from './utils';
import path from 'path';
import view from '@fastify/view';
import ejs from 'ejs';
import ipPlugin from './plugins/ipPlugin';
import playlistGuardPlugin from './plugins/playlistGuardPlugin';
import NativeWebSocketServer from './websocket-native';
import ChatWebSocketServer from './chat-websocket';
import ProgressWebSocketServer from './progress-websocket';
import GeneratorQueue from './generatorQueue';
import ExcelQueue from './excelQueue';
import aiPlaylistRoutes from './routes/aiPlaylistRoutes';
import businessRoutes from './routes/businessRoutes';
import toolkitRoutes from './routes/toolkitRoutes';
import aiAdminRoutes from './routes/aiAdminRoutes';
import aiCostRoutes from './routes/aiCostRoutes';
import ExternalCardService from './externalCardService';
import CalendarService from './calendarService';
import AppTheme from './apptheme';
import TrackEnrichment from './trackEnrichment';

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
  private utils = new Utils();
  private wsServer: NativeWebSocketServer | null = null;
  private chatWsServer: ChatWebSocketServer | null = null;
  private progressWsServer: ProgressWebSocketServer | null = null;

  private constructor() {
    this.fastify = Fastify({
      logger: false,
      // 20 MB for a JSON body; the routes that take a base64 image raise it
      // (BASE64_IMAGE_BODY_LIMIT). Multipart uploads have their own limit.
      // It was 100 MB everywhere: a cheap way to tie up a worker's memory.
      bodyLimit: 1024 * 1024 * 20,
    });
  }

  // Static method to get the instance of the class
  public static getInstance(): Server {
    if (!Server.instance) {
      Server.instance = new Server();
    }
    return Server.instance;
  }

  // Test-only: a fresh, non-singleton instance so each test suite can build
  // an isolated Fastify app without leaking state between suites.
  public static createFresh(): Server {
    return new Server();
  }

  // Test-only: configure the Fastify app (plugins, auth, routes) without
  // listening, clustering, websockets, queue workers or cron jobs, and hand
  // it back so tests can use fastify.inject().
  public async buildForTesting(): Promise<FastifyInstance> {
    await this.configure();
    return this.fastify;
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

    // Decorate fastify.authenticate so routes that use the
    // `{ preHandler: fastify.authenticate(['admin']) }` pattern (e.g.
    // blogRoutes) actually get a real auth preHandler. Without this the
    // decorator is undefined and those routes were silently public.
    this.fastify.decorate(
      'authenticate',
      (allowedGroups: string[] = []) =>
        (request: any, reply: any) =>
          verifyTokenMiddleware(request, reply, allowedGroups)
    );

    // Register route modules
    await accountRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await adminRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await companyRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await bingoRoutes(this.fastify, getAuthHandler);
    await quizRoutes(this.fastify, getAuthHandler);
    await gameRoutes(this.fastify, getAuthHandler);
    await boxRoutes(this.fastify, getAuthHandler);
    await appDesignRoutes(this.fastify, getAuthHandler);
    await themeRoutes(this.fastify, getAuthHandler);
    await aiAdminRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await aiCostRoutes(this.fastify, verifyTokenMiddleware, getAuthHandler);
    await discountRoutes(this.fastify, getAuthHandler);
    await businessRoutes(this.fastify, getAuthHandler);
    await toolkitRoutes(this.fastify, getAuthHandler);
  };

  public async addRoutes() {
    // Register blog routes
    await blogRoutes(this.fastify);

    // Register music/spotify routes
    await musicRoutes(this.fastify);

    // Register payment routes
    await paymentRoutes(this.fastify);

    // Register public routes
    await publicRoutes(this.fastify);

    // Register reseller API routes
    await resellerRoutes(this.fastify);

    // Register AI playlist routes
    await aiPlaylistRoutes(this.fastify);

    // WebSocket endpoints - return 426 Upgrade Required for non-WebSocket requests
    this.fastify.get('/chat-ws', async (request, reply) => {
      reply.status(426).send({ error: 'Upgrade Required', message: 'This endpoint requires a WebSocket connection' });
    });
    this.fastify.get('/ws', async (request, reply) => {
      reply.status(426).send({ error: 'Upgrade Required', message: 'This endpoint requires a WebSocket connection' });
    });
  }

  private configure = async () => {
    await this.createDirs();
    await this.registerPlugins();
    await this.addAuthRoutes();
    await this.addRoutes();
  };

  public init = async () => {
    await this.configure();
    await this.startCluster();
  };

  private async createDirs() {
    const publicDir = process.env['PUBLIC_DIR']!;
    const privateDir = process.env['PRIVATE_DIR']!;
    await this.utils.createDir(`${publicDir}/qr`);
    await this.utils.createDir(`${publicDir}/pdf`);
    await this.utils.createDir(`${publicDir}/excel`);
    await this.utils.createDir(`${publicDir}/avatars`);
    await this.utils.createDir(`${publicDir}/quiz_images`);
    await this.utils.createDir(`${publicDir}/companydata/assets`);
    await this.utils.createDir(`${publicDir}/background`);
    await this.utils.createDir(`${publicDir}/channable`);
    await this.utils.createDir(`${privateDir}/invoice`);

    // Orders from before the brand artwork are pinned to the blue artwork in
    // the uploads folder, which is not in git: make sure the file is there.
    const copied = await ensureLegacyDefaultBackgroundFile(
      process.env['ASSETS_DIR']!,
      publicDir
    );
    if (copied) {
      this.logger.log(
        color.blue.bold('Copied the legacy default card background into public/background')
      );
    }
  }

  private async startCluster() {
    if (cluster.isPrimary) {
      // app.ts forks the workers before this file is even loaded, so they
      // boot while the primary sets up what follows. The call here only does
      // something for an entry point that skipped that step.
      await startClusterWorkers();

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

          const excelQueue = ExcelQueue.getInstance();
          excelQueue.startWorkers(2);

          this.logger.log(
            color.blue.bold(
              `Queue workers initialized successfully: ${color.white.bold(
                workerCount.toString()
              )} Generator workers, ${color.white.bold('2')} Excel workers`
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

      // Initialize CalendarService (starts monthly event-calendar prefill cron;
      // production main server only — see startPrefillCron)
      CalendarService.getInstance();
    } else {
      this.workerId = parseInt(process.env['WORKER_ID'] as string);
      this.startServer();
    }
  }

  public async startServer(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Themes feed getLink responses, so start their load before traffic
        // arrives; it no longer contends with the blocked-playlists query
        // at boot (that now comes from Redis) and does not block listen.
        AppTheme.getInstance().warmup(0);

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

        // Warm the track-enrichment maps only now that the server is
        // listening, staggered per worker so four full-table scans do not
        // hit the database at once.
        const warmupStagger =
          (Number.isFinite(this.workerId) ? this.workerId : 0) * 3000;
        TrackEnrichment.getInstance().warmup(warmupStagger);

        resolve();
      } catch (err) {
        this.fastify.log.error(err);
        reject(err);
      }
    });
  }

  public async registerPlugins() {
    await this.fastify.register(require('@fastify/multipart'), {
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit for file uploads
      },
    });
    await this.fastify.register(require('@fastify/formbody'));
    await this.fastify.register(ipPlugin);
    // After ipPlugin: it reads the request.clientIp that ipPlugin resolves.
    await this.fastify.register(playlistGuardPlugin);
    await this.fastify.register(replyFrom);
    // Every origin may call the API (the scan app, partner pages), but only
    // the site's own origins get credentials (src/corsOrigins.ts). Before,
    // any origin got them, so a page on another site could read and change
    // everything behind an admin's session cookie.
    await this.fastify.register(require('@fastify/cors'), {
      delegator: (
        request: any,
        callback: (err: Error | null, options: Record<string, unknown>) => void
      ) => {
        callback(null, {
          origin: true,
          credentials: isCredentialedOrigin(request.headers.origin),
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
        });
      },
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
      // A 4xx (validation, bad body, @fastify/static refusing a `..` or `//`
      // path) is the caller's mistake, not ours: answer with its own status
      // and log one line, not a stack trace.
      const { statusCode: status, message } = error as {
        statusCode?: number;
        message?: string;
      };
      if (status && status >= 400 && status < 500) {
        ErrorTracking.getInstance().ignore(error);
        console.warn(`${status} ${request.method} ${request.url}: ${message}`);
        return reply.status(status).send({ error: message });
      }
      // The route pattern, not the URL: paths carry ids and download hashes.
      ErrorTracking.getInstance().capture(error, {
        method: request.method,
        route: request.routeOptions?.url ?? null,
      });
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
