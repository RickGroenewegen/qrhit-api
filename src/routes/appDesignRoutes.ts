import { FastifyInstance } from 'fastify';
import { color, white } from 'console-log-colors';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import Utils from '../utils';
import Cache from '../cache';
import Mollie from '../mollie';
import Data from '../data';
import AppDesign, { sanitizeAssetFilename } from '../appDesign';
import { APP_DESIGN_PRICE } from '../config/constants';

const prisma = PrismaInstance.getInstance();
const logger = new Logger();
const utils = new Utils();

// Palette suggestions call OpenAI with an image, so the public endpoint is
// capped per IP per day. Development and trusted IPs are exempt, like the
// AI playlist generator.
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
 * App Designer: a customer-made theme for the scan app, sold as an add-on.
 *
 * - Checkout creates the design through mollie.ts (cart item flag).
 * - Here: the account page reads, unlocks (Mollie upgrade) and edits it, and
 *   both flows ask for an AI palette from an uploaded background.
 */
const appDesignRoutes = async (fastify: FastifyInstance, getAuthHandler?: any) => {
  if (!getAuthHandler) return;

  const appDesign = AppDesign.getInstance();
  const cache = Cache.getInstance();
  const data = Data.getInstance();

  /**
   * Resolve the caller's order line and make sure it is theirs. Returns the
   * row or sends the matching error and returns null.
   */
  async function ownedLine(request: any, reply: any, rawId: any) {
    const phpId = parseInt(rawId);
    if (isNaN(phpId)) {
      reply.status(400).send({ success: false, error: 'Invalid paymentHasPlaylistId' });
      return null;
    }
    const user = await prisma.user.findUnique({
      where: { userId: request.user?.userId },
    });
    if (!user) {
      reply.status(401).send({ success: false, error: 'User not found' });
      return null;
    }
    const php = await prisma.paymentHasPlaylist.findUnique({
      where: { id: phpId },
      include: { payment: true, playlist: true, appDesign: true },
    });
    if (!php) {
      reply.status(404).send({ success: false, error: 'PaymentHasPlaylist not found' });
      return null;
    }
    if (php.payment.userId !== user.id) {
      reply.status(403).send({ success: false, error: 'Unauthorized' });
      return null;
    }
    return { php, user };
  }

  /**
   * GET /api/app-design/:paymentHasPlaylistId
   * Current design (if any) plus whether the add-on is unlocked.
   */
  fastify.get(
    '/api/app-design/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const owned = await ownedLine(request, reply, request.params.paymentHasPlaylistId);
        if (!owned) return;
        const { php } = owned;
        const row = php.appDesign;
        return reply.send({
          success: true,
          enabled: php.appDesignEnabled === true,
          price: APP_DESIGN_PRICE,
          playlistName: php.playlist.name,
          design: row ? row.design : null,
          theme: row ? appDesign.buildThemeResponse(row) : null,
          version: row ? row.version : 0,
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in GET /api/app-design: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to load app design' });
      }
    }
  );

  /**
   * PUT /api/app-design/:paymentHasPlaylistId
   * Save a design for an unlocked line. Bumps the version so the app refreshes.
   */
  fastify.put(
    '/api/app-design/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const owned = await ownedLine(request, reply, request.params.paymentHasPlaylistId);
        if (!owned) return;
        const { php } = owned;
        if (!php.appDesignEnabled) {
          return reply.status(400).send({
            success: false,
            error: 'App design is not enabled for this order',
          });
        }
        let normalized;
        try {
          normalized = appDesign.normalizeInput(request.body);
        } catch (e: any) {
          return reply.status(400).send({ success: false, error: e.message });
        }
        const row = await appDesign.saveDesign(php.id, normalized.input);
        return reply.send({
          success: true,
          version: row.version,
          rejected: normalized.rejected,
          theme: appDesign.buildThemeResponse(row),
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in PUT /api/app-design: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to save app design' });
      }
    }
  );

  /**
   * POST /api/app-design/upgrade-payment
   * Unlock the add-on for an existing order. The design is stored right away
   * (the line stays disabled), so the webhook only has to flip the flag.
   */
  fastify.post(
    '/api/app-design/upgrade-payment',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentHasPlaylistId, locale, currency } = request.body || {};
        if (!paymentHasPlaylistId) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required parameter: paymentHasPlaylistId',
          });
        }
        const owned = await ownedLine(request, reply, paymentHasPlaylistId);
        if (!owned) return;
        const { php, user } = owned;

        if (php.appDesignEnabled) {
          return reply.status(400).send({
            success: false,
            error: 'App design is already enabled for this order',
          });
        }
        if (!php.payment.finalized) {
          return reply.status(400).send({
            success: false,
            error: 'Order has not been finalized yet',
          });
        }
        if (php.playlist.type === 'giftcard') {
          return reply.status(400).send({
            success: false,
            error: 'App design is only available for card orders',
          });
        }

        // Store the design now so the customer does not lose it if the
        // payment page is abandoned; the slug is only published on success.
        if (request.body?.design) {
          let normalized;
          try {
            normalized = appDesign.normalizeInput(request.body);
          } catch (e: any) {
            return reply.status(400).send({ success: false, error: e.message });
          }
          await appDesign.saveDesign(php.id, normalized.input, { reload: false });
          // Not unlocked yet: keep the slug off the line until the webhook
          // confirms payment, otherwise a scan would show an unpaid theme.
          await prisma.paymentHasPlaylist.update({
            where: { id: php.id },
            data: { theme: null, themeName: null },
          });
        }

        const countryCode = php.payment.countrycode || 'NL';
        const taxRate = (await data.getTaxRate(countryCode)) || 0;
        const userLocale = locale || 'en';
        const mollie = new Mollie();
        const result = await mollie.createUpgradePayment({
          amountEur: APP_DESIGN_PRICE,
          requestedCurrency: currency,
          description: `App design - ${php.playlist.name}`,
          locale: userLocale,
          redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/my-account?app_design_enabled=1`,
          metadata: {
            type: 'app_design_upgrade',
            paymentHasPlaylistId: php.id.toString(),
            userId: user.id.toString(),
            originalPaymentId: php.payment.paymentId,
            price: APP_DESIGN_PRICE.toString(),
            taxRate: taxRate.toString(),
          },
          clientIp: request.clientIp,
          billingCountry: countryCode,
          viewerCountry: request.body?.viewerCountry,
        });

        logger.log(
          color.blue.bold(
            `Created app design upgrade payment: ${white.bold(result.id)} for PHP ${white.bold(
              php.id.toString()
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
          color.red.bold(`Error in POST /api/app-design/upgrade-payment: ${error.message}`)
        );
        return reply.status(500).send({
          success: false,
          error: 'Failed to create app design upgrade payment',
        });
      }
    }
  );

  /**
   * POST /api/app-design/ai-theme
   * Palette suggestion for an uploaded background. Public because the order
   * flow runs before login; rate limited per IP.
   */
  fastify.post('/api/app-design/ai-theme', async (request: any, reply: any) => {
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
      logger.log(color.red.bold(`Error in POST /api/app-design/ai-theme: ${error.message}`));
      return reply.status(500).send({ success: false, error: 'Failed to suggest a palette' });
    }
  });
};

export default appDesignRoutes;
