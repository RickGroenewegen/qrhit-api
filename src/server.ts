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
import MusicBrainz from './musicbrainz';
import ipPlugin from './plugins/ipPlugin';
import Formatters from './formatters';
import Translation from './translation';
import Cache from './cache';
import Generator from './generator';
import AnalyticsClient from './analytics';
import { ChatGPT } from './chatgpt';
import { PDFImage } from 'pdf-lib';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

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
  private data = new Data();
  private order = Order.getInstance();
  private mail = new Mail();
  private musicBrainz = new MusicBrainz();
  private formatters = new Formatters().getFormatters();
  private translation: Translation = new Translation();
  private cache = Cache.getInstance();
  private generator = new Generator();
  private analytics = AnalyticsClient.getInstance();
  private openai = new ChatGPT();

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
    // Middleware for token verification
    const verifyTokenMiddleware = async (request: any, reply: any) => {
      const token = request.headers.authorization?.split(' ')[1];
      const decoded = verifyToken(token || '');
      if (!decoded) {
        reply.status(401).send({ error: 'Unauthorized' });
        return false;
      }
      return true;
    };

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

    this.fastify.get(
      '/analytics',
      { preHandler: verifyTokenMiddleware },
      async (request: any, reply: any) => {
        const analytics = await this.analytics.getAllCounters();
        reply.send({ success: true, data: analytics });
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
    await this.deploy();
    await this.setVersion();
    await this.createDirs();
    await this.registerPlugins();
    await this.addRoutes();
    await this.addAuthRoutes();
    await this.startCluster();
  };

  private async deploy() {
    if (this.isMainServer && cluster.isPrimary) {
      const hostName = os.hostname();
      if (hostName == process.env['MAIN_SERVER_HOSTNAME']) {
        const client = new ElasticLoadBalancingV2Client({
          region: process.env['AWS_ELB_REGION'],
          credentials: {
            accessKeyId: process.env['AWS_ELB_ACCESS_KEY']!,
            secretAccessKey: process.env['AWS_ELB_SECRET_KEY']!,
          },
        });

        const loadBalancerName = process.env['AWS_LOAD_BALANCER_NAME'];

        if (!loadBalancerName) {
          throw new Error('Load balancer name is not defined');
        }

        try {
          const loadBalancersCommand = new DescribeLoadBalancersCommand({
            Names: [loadBalancerName],
          });
          const loadBalancersResponse = await client.send(loadBalancersCommand);
          const loadBalancerArn =
            loadBalancersResponse.LoadBalancers?.[0].LoadBalancerArn;

          if (loadBalancerArn) {
            const targetGroupsCommand = new DescribeTargetGroupsCommand({
              LoadBalancerArn: loadBalancerArn,
            });
            const targetGroupsResponse = await client.send(targetGroupsCommand);
            const targetGroupArns = targetGroupsResponse.TargetGroups?.map(
              (tg) => tg.TargetGroupArn
            );

            if (targetGroupArns) {
              for (const targetGroupArn of targetGroupArns) {
                const targetHealthCommand = new DescribeTargetHealthCommand({
                  TargetGroupArn: targetGroupArn,
                });
                const targetHealthResponse = await client.send(
                  targetHealthCommand
                );
                const instanceIds =
                  targetHealthResponse.TargetHealthDescriptions?.map(
                    (desc) => desc.Target?.Id
                  );

                if (targetGroupArn == process.env['AWS_ELB_TARGET_GROUP_ARN']) {
                  console.log(
                    `Instances in target group ${targetGroupArn}:`,
                    instanceIds
                  );

                  if (instanceIds && instanceIds.length > 0) {
                    const ec2Client = new EC2Client({
                      region: process.env['AWS_ELB_REGION'],
                      credentials: {
                        accessKeyId: process.env['AWS_ELB_ACCESS_KEY']!,
                        secretAccessKey: process.env['AWS_ELB_SECRET_KEY']!,
                      },
                    });

                    const describeInstancesCommand = new DescribeInstancesCommand({
                      InstanceIds: instanceIds,
                    });

                    try {
                      const describeInstancesResponse = await ec2Client.send(describeInstancesCommand);
                      const internalIps = describeInstancesResponse.Reservations?.flatMap(reservation =>
                        reservation.Instances?.map(instance => instance.PrivateIpAddress)
                      );

                      console.log(`Internal IPs for instances in target group ${targetGroupArn}:`, internalIps);
                    } catch (error) {
                      console.error('Error retrieving instance IPs:', error);
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error('Error retrieving instances:', error);
        }
      }
    }
  }

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
      '/qr/pdf/:playlistId/:paymentId/:template/:startIndex/:endIndex/:subdir',
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
        let tracks = await this.data.getTracks(playlist.id);
        const payment = await this.mollie.getPayment(request.params.paymentId);
        const user = await this.data.getUser(payment.userId);

        // Slice the tracks based on the start and end index which is 0-based
        const startIndex = parseInt(request.params.startIndex);
        const endIndex = parseInt(request.params.endIndex);
        tracks = tracks.slice(startIndex, endIndex + 1);

        await reply.view(`pdf_${request.params.template}.ejs`, {
          subdir: request.params.subdir,
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
              available:
                orderType.digital ||
                (await this.utils.isTrustedIp(request.clientIp)),
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

      this.fastify.get('/release/:query', async (request: any, _reply) => {
        const year = await this.openai.ask(request.params.query);
        return { success: true, year };
      });

      this.fastify.get(
        '/year/:isrc/:artist/:title',
        async (request: any, _reply) => {
          const result = await this.musicBrainz.getReleaseDate(
            request.params.isrc,
            request.params.artist,
            request.params.title,
            true
          );
          return { success: true, data: result };
        }
      );

      this.fastify.get('/mb/:isrc', async (request: any, _reply) => {
        const result = await this.musicBrainz.getReleaseDateFromAPI(
          request.params.isrc
        );
        return { success: true, data: result };
      });
    }
    this.fastify.get('/mball', async (request: any, _reply) => {
      const result = await this.data.updateAllTrackYears();
      return { success: true, data: result };
    });
  }
}

export default Server;
