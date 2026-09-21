import { FastifyInstance } from 'fastify';
import { color, white } from 'console-log-colors';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import Utils from '../utils';
import Cache from '../cache';
import Mollie from '../mollie';
import Data from '../data';
import Designer from '../designer';
import AppDesign, {
  APP_DESIGN_OVERRIDE_MODES,
  AppDesignOverrideMode,
  sanitizeAssetFilename,
} from '../appDesign';
import { APP_DESIGN_PRICE } from '../config/constants';

const prisma = PrismaInstance.getInstance();
const logger = new Logger();
const utils = new Utils();

// Palette suggestions call OpenAI with an image, so they are capped per IP
// per day. Development and trusted IPs are exempt, like the AI playlist
// generator.
const PALETTE_DAILY_LIMIT_PER_IP = 20;

function isDev(): boolean {
  return process.env['ENVIRONMENT'] === 'development';
}

function paletteKeyForIp(ip: string): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
  return `appDesign:palette:${ip}:${ymd}`;
}

/**
 * App Designer: customer-made themes for the scan app, an upgrade on the
 * account (APP_DESIGN_PRICE, once). The account has a default design that
 * every paid playlist gets; each playlist can use its own design or the
 * plain QRSong! look instead. Designs can be made and saved before paying;
 * src/apptheme.ts only serves them once the account owns the upgrade.
 */
const appDesignRoutes = async (fastify: FastifyInstance, getAuthHandler?: any) => {
  if (!getAuthHandler) return;

  const appDesign = AppDesign.getInstance();
  const cache = Cache.getInstance();
  const data = Data.getInstance();

  async function currentUser(request: any, reply: any) {
    const user = await prisma.user.findUnique({
      where: { userId: request.user?.userId },
    });
    if (!user) {
      reply.status(401).send({ success: false, error: 'User not found' });
      return null;
    }
    return user;
  }

  /** The user's paid card order lines: the playlists a design can apply to. */
  async function paidCardLines(userId: number) {
    return prisma.paymentHasPlaylist.findMany({
      where: {
        payment: { userId, status: 'paid' },
        playlist: { type: { not: 'giftcard' } },
      },
      include: {
        playlist: { select: { name: true, image: true } },
        payment: { select: { createdAt: true } },
      },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * One of the caller's paid card lines, or null after sending the error.
   */
  async function ownedLine(reply: any, userId: number, rawId: any) {
    const phpId = parseInt(rawId);
    if (isNaN(phpId)) {
      reply.status(400).send({ success: false, error: 'Invalid paymentHasPlaylistId' });
      return null;
    }
    const php = await prisma.paymentHasPlaylist.findUnique({
      where: { id: phpId },
      include: {
        payment: { select: { userId: true, status: true } },
        playlist: { select: { name: true, type: true } },
      },
    });
    if (!php) {
      reply.status(404).send({ success: false, error: 'PaymentHasPlaylist not found' });
      return null;
    }
    if (php.payment.userId !== userId) {
      reply.status(403).send({ success: false, error: 'Unauthorized' });
      return null;
    }
    if (php.payment.status !== 'paid' || php.playlist.type === 'giftcard') {
      reply.status(400).send({
        success: false,
        error: 'App design is only available for paid card orders',
      });
      return null;
    }
    return php;
  }

  function designPayload(row: any) {
    if (!row || !row.design) return null;
    return { design: row.design, name: row.name, version: row.version };
  }

  /**
   * Validate and save one design; sends the error for a bad payload.
   */
  async function save(request: any, reply: any, scope: { userId: number; paymentHasPlaylistId?: number }) {
    let normalized;
    try {
      normalized = appDesign.normalizeInput(request.body);
    } catch (e: any) {
      reply.status(400).send({ success: false, error: e.message });
      return;
    }
    const row = await appDesign.saveDesign(scope, normalized.input);
    reply.send({
      success: true,
      version: row.version,
      rejected: normalized.rejected,
    });
  }

  /**
   * GET /api/app-design
   * Everything the App Designer page needs: whether the account owns the
   * upgrade, the price, the default design and every paid playlist with
   * what it shows.
   */
  fastify.get('/api/app-design', getAuthHandler(['users']), async (request: any, reply: any) => {
    try {
      const user = await currentUser(request, reply);
      if (!user) return;
      const [entitled, designs, lines] = await Promise.all([
        appDesign.isEntitled(user.id),
        appDesign.getDesigns(user.id),
        paidCardLines(user.id),
      ]);
      const overrideByLine = new Map(
        designs.overrides.map((row) => [row.paymentHasPlaylistId as number, row])
      );
      return reply.send({
        success: true,
        entitled,
        price: APP_DESIGN_PRICE,
        defaultDesign: designPayload(designs.defaultDesign),
        playlists: lines.map((line) => {
          const override = overrideByLine.get(line.id);
          return {
            paymentHasPlaylistId: line.id,
            name: line.playlist.name,
            image: line.playlist.image,
            type: line.type,
            orderedAt: line.payment.createdAt,
            mode: (override?.mode as AppDesignOverrideMode) || 'default',
            hasOwnDesign: !!override?.design,
          };
        }),
      });
    } catch (error: any) {
      logger.log(color.red.bold(`Error in GET /api/app-design: ${white.bold(error.message)}`));
      return reply.status(500).send({ success: false, error: 'Failed to load app design' });
    }
  });

  /**
   * GET /api/app-design/playlist/:paymentHasPlaylistId
   * One playlist: its mode and its own design, if it has one.
   */
  fastify.get(
    '/api/app-design/playlist/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const user = await currentUser(request, reply);
        if (!user) return;
        const php = await ownedLine(reply, user.id, request.params.paymentHasPlaylistId);
        if (!php) return;
        const override = await prisma.appDesign.findUnique({
          where: { paymentHasPlaylistId: php.id },
        });
        return reply.send({
          success: true,
          paymentHasPlaylistId: php.id,
          playlistName: php.playlist.name,
          mode: (override?.mode as AppDesignOverrideMode) || 'default',
          design: designPayload(override),
        });
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in GET /api/app-design/playlist: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to load app design' });
      }
    }
  );

  /**
   * PUT /api/app-design/default
   * Save the account's default design. Allowed before paying.
   */
  fastify.put('/api/app-design/default', getAuthHandler(['users']), async (request: any, reply: any) => {
    try {
      const user = await currentUser(request, reply);
      if (!user) return;
      return await save(request, reply, { userId: user.id });
    } catch (error: any) {
      logger.log(color.red.bold(`Error in PUT /api/app-design/default: ${white.bold(error.message)}`));
      return reply.status(500).send({ success: false, error: 'Failed to save app design' });
    }
  });

  /**
   * PUT /api/app-design/playlist/:paymentHasPlaylistId
   * Save a playlist's own design; the playlist switches to it.
   */
  fastify.put(
    '/api/app-design/playlist/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const user = await currentUser(request, reply);
        if (!user) return;
        const php = await ownedLine(reply, user.id, request.params.paymentHasPlaylistId);
        if (!php) return;
        return await save(request, reply, { userId: user.id, paymentHasPlaylistId: php.id });
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in PUT /api/app-design/playlist: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to save app design' });
      }
    }
  );

  /**
   * PUT /api/app-design/playlist/:paymentHasPlaylistId/mode
   * What a playlist shows: the default design, its own, or the plain app.
   */
  fastify.put(
    '/api/app-design/playlist/:paymentHasPlaylistId/mode',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const user = await currentUser(request, reply);
        if (!user) return;
        const mode = request.body?.mode;
        if (!APP_DESIGN_OVERRIDE_MODES.includes(mode)) {
          return reply.status(400).send({ success: false, error: 'Invalid mode' });
        }
        const php = await ownedLine(reply, user.id, request.params.paymentHasPlaylistId);
        if (!php) return;
        try {
          await appDesign.setOverrideMode(user.id, php.id, mode);
        } catch (e: any) {
          return reply.status(400).send({ success: false, error: e.message });
        }
        return reply.send({ success: true, mode });
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in PUT /api/app-design/playlist/mode: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to change the app design' });
      }
    }
  );

  /**
   * POST /api/app-design/upgrade-payment
   * Buy App Designer for the account. Charged in the customer's currency
   * (converted from APP_DESIGN_PRICE); the webhook records the purchase.
   */
  fastify.post(
    '/api/app-design/upgrade-payment',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const user = await currentUser(request, reply);
        if (!user) return;
        const { locale, currency, viewerCountry } = request.body || {};

        if (await appDesign.isEntitled(user.id)) {
          return reply.status(400).send({
            success: false,
            error: 'App Designer is already enabled for this account',
          });
        }
        // The upgrade themes the app for the customer's own cards, so there
        // has to be at least one paid card order it can apply to. Its
        // country also decides the VAT of the purchase.
        const lastOrder = await prisma.payment.findFirst({
          where: {
            userId: user.id,
            status: 'paid',
            PaymentHasPlaylist: { some: { playlist: { type: { not: 'giftcard' } } } },
          },
          orderBy: { createdAt: 'desc' },
          select: { countrycode: true },
        });
        if (!lastOrder) {
          return reply.status(400).send({
            success: false,
            error: 'App Designer needs a paid card order',
          });
        }

        const countryCode = lastOrder.countrycode || 'NL';
        const taxRate = (await data.getTaxRate(countryCode)) || 0;
        const userLocale = locale || 'en';
        const mollie = new Mollie();
        const result = await mollie.createUpgradePayment({
          amountEur: APP_DESIGN_PRICE,
          requestedCurrency: currency,
          description: 'QRSong! App Designer',
          locale: userLocale,
          redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/my-account/app-design?enabled=1`,
          metadata: {
            type: 'app_design_upgrade',
            userId: user.id.toString(),
            price: APP_DESIGN_PRICE.toString(),
            taxRate: taxRate.toString(),
            countrycode: countryCode,
            locale: userLocale,
          },
          clientIp: request.clientIp,
          billingCountry: countryCode,
          viewerCountry,
        });

        logger.log(
          color.blue.bold(
            `Created App Designer payment ${white.bold(result.id)} for user ${white.bold(
              user.id.toString()
            )} (${white.bold(result.currency + ' ' + result.amount.toFixed(2))})`
          )
        );

        return reply.send({
          success: true,
          paymentUrl: result.checkoutUrl,
          paymentId: result.id,
        });
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in POST /api/app-design/upgrade-payment: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({
          success: false,
          error: 'Failed to create App Designer payment',
        });
      }
    }
  );

  /**
   * POST /api/app-design/upload/:type (background | logo)
   * Editor uploads. Phone-sized, no square crop or QR clearance like the card
   * pipeline; stored under PUBLIC_DIR/app-theme until a save copies them into
   * a theme directory.
   */
  fastify.post(
    '/api/app-design/upload/:type',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      const { type } = request.params;
      if (type !== 'background' && type !== 'logo') {
        return reply.status(400).send({ success: false, error: 'Invalid upload type' });
      }
      if (!request.body?.image) {
        return reply.status(400).send({ success: false, error: 'No image provided' });
      }
      const result = await Designer.getInstance().uploadAppThemeImage(request.body.image, type);
      return reply.status(result.success ? 200 : 400).send(result);
    }
  );

  /**
   * POST /api/app-design/ai-theme
   * Palette suggestion for an uploaded background, rate limited per IP.
   */
  fastify.post(
    '/api/app-design/ai-theme',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      const background = sanitizeAssetFilename(request.body?.background);
      if (!background) {
        return reply.status(400).send({ success: false, error: 'Invalid background filename' });
      }

      const ip = utils.getClientIp(request);
      if (!isDev() && !utils.isTrustedIp(ip)) {
        const key = paletteKeyForIp(ip);
        try {
          const used = parseInt(await cache.executeCommand('incr', key), 10);
          if (used === 1) {
            await cache.executeCommand('expire', key, 24 * 3600);
          }
          if (used > PALETTE_DAILY_LIMIT_PER_IP) {
            await cache.executeCommand('decr', key);
            return reply.status(429).send({
              success: false,
              error: 'Daily AI theme limit reached',
            });
          }
        } catch (err) {
          logger.log(
            color.yellow.bold(`[AppDesign] Rate-limit check failed (allowing through): ${err}`)
          );
        }
      }

      try {
        const palette = await appDesign.suggestPalette(background);
        return reply.send({ success: true, palette });
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          return reply.status(404).send({ success: false, error: 'Background not found' });
        }
        logger.log(
          color.red.bold(`Error in POST /api/app-design/ai-theme: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to suggest a palette' });
      }
    }
  );
};

export default appDesignRoutes;
