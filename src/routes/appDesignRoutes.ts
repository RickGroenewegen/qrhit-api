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
  appDesignLineError,
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
   * A paid card line the requester may design, or null after sending the
   * error. `userId` is the customer, who must own the line; null is an admin,
   * who works on it for its owner (`php.payment.userId`).
   */
  async function ownedLine(reply: any, userId: number | null, rawId: any) {
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
    const problem = appDesignLineError(php, userId);
    if (problem) {
      reply.status(problem.status).send({ success: false, error: problem.error });
      return null;
    }
    return php!;
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
   * Set what a line shows, for its owner; sends the response. `requesterUserId`
   * as in ownedLine: the customer, or null for an admin.
   */
  async function changeMode(request: any, reply: any, requesterUserId: number | null) {
    const mode = request.body?.mode;
    if (!APP_DESIGN_OVERRIDE_MODES.includes(mode)) {
      return reply.status(400).send({ success: false, error: 'Invalid mode' });
    }
    const php = await ownedLine(reply, requesterUserId, request.params.paymentHasPlaylistId);
    if (!php) return;
    try {
      await appDesign.setOverrideMode(php.payment.userId, php.id, mode);
    } catch (e: any) {
      return reply.status(400).send({ success: false, error: e.message });
    }
    return reply.send({ success: true, mode });
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
        return await changeMode(request, reply, user.id);
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in PUT /api/app-design/playlist/mode: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to change the app design' });
      }
    }
  );

  // ─── Admin: any customer's design, from an order line ───────────────────
  // The dashboard opens a customer's app design from an order line, like the
  // card and box designers. The owner always comes from the line, never from
  // the admin's token. An admin save unlocks nothing: src/apptheme.ts still
  // only serves the design once the customer owns the upgrade.

  /**
   * GET /admin/playlist/:paymentHasPlaylistId/app-design
   * The line's mode and own design, its owner's default design and whether
   * the owner has the upgrade.
   */
  fastify.get(
    '/admin/playlist/:paymentHasPlaylistId/app-design',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const php = await ownedLine(reply, null, request.params.paymentHasPlaylistId);
        if (!php) return;
        const ownerId = php.payment.userId;
        const [entitled, designs] = await Promise.all([
          appDesign.isEntitled(ownerId),
          appDesign.getDesigns(ownerId),
        ]);
        const override = designs.overrides.find((row) => row.paymentHasPlaylistId === php.id);
        return reply.send({
          success: true,
          paymentHasPlaylistId: php.id,
          playlistName: php.playlist.name,
          entitled,
          mode: (override?.mode as AppDesignOverrideMode) || 'default',
          design: designPayload(override),
          defaultDesign: designPayload(designs.defaultDesign),
        });
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in GET /admin/playlist/app-design: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to load app design' });
      }
    }
  );

  /**
   * PUT /admin/playlist/:paymentHasPlaylistId/app-design
   * Save the line's own design; the line switches to it.
   */
  fastify.put(
    '/admin/playlist/:paymentHasPlaylistId/app-design',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const php = await ownedLine(reply, null, request.params.paymentHasPlaylistId);
        if (!php) return;
        return await save(request, reply, {
          userId: php.payment.userId,
          paymentHasPlaylistId: php.id,
        });
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in PUT /admin/playlist/app-design: ${white.bold(error.message)}`)
        );
        return reply.status(500).send({ success: false, error: 'Failed to save app design' });
      }
    }
  );

  /**
   * PUT /admin/playlist/:paymentHasPlaylistId/app-design/default
   * Save the default design of the account that owns the line.
   */
  fastify.put(
    '/admin/playlist/:paymentHasPlaylistId/app-design/default',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const php = await ownedLine(reply, null, request.params.paymentHasPlaylistId);
        if (!php) return;
        return await save(request, reply, { userId: php.payment.userId });
      } catch (error: any) {
        logger.log(
          color.red.bold(
            `Error in PUT /admin/playlist/app-design/default: ${white.bold(error.message)}`
          )
        );
        return reply.status(500).send({ success: false, error: 'Failed to save app design' });
      }
    }
  );

  /**
   * PUT /admin/playlist/:paymentHasPlaylistId/app-design/mode
   * What the line shows: the default design, its own, or the plain app.
   */
  fastify.put(
    '/admin/playlist/:paymentHasPlaylistId/app-design/mode',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        return await changeMode(request, reply, null);
      } catch (error: any) {
        logger.log(
          color.red.bold(`Error in PUT /admin/playlist/app-design/mode: ${white.bold(error.message)}`)
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
   * a theme directory. Admins too: the dashboard opens the same editor.
   */
  fastify.post(
    '/api/app-design/upload/:type',
    getAuthHandler(['users', 'admin']),
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
   * GET /app-design/card-palette/:filename
   * The dominant and an accent colour of a card's background upload, for the
   * app design the checkout makes from a card. Public, like the checkout:
   * guests order too. Only names of card uploads, answered from Redis after
   * the first time.
   */
  fastify.get('/app-design/card-palette/:filename', async (request: any, reply: any) => {
    const filename = sanitizeAssetFilename(request.params.filename);
    if (!filename) {
      return reply.status(400).send({ success: false, error: 'Invalid filename' });
    }
    try {
      const palette = await appDesign.cardPalette(filename);
      if (!palette) {
        return reply.status(400).send({ success: false, error: 'Invalid filename' });
      }
      return reply.send({ success: true, palette });
    } catch (error: any) {
      if (error?.code === 'ENOENT' || /missing|no such file|unsupported image/i.test(error?.message || '')) {
        return reply.status(404).send({ success: false, error: 'Background not found' });
      }
      logger.log(
        color.red.bold(`Error in GET /app-design/card-palette: ${white.bold(error.message)}`)
      );
      return reply.status(500).send({ success: false, error: 'Failed to read the background' });
    }
  });

  /**
   * POST /api/app-design/ai-theme
   * Palette suggestion for an uploaded background, rate limited per IP.
   * Admins too, for the dashboard's editor.
   */
  fastify.post(
    '/api/app-design/ai-theme',
    getAuthHandler(['users', 'admin']),
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
