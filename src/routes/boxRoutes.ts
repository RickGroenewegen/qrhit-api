import { FastifyInstance } from 'fastify';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import Data from '../data';
import { color, white } from 'console-log-colors';
import Mollie from '../mollie';
import { BOX_PRICE } from '../config/constants';

const prisma = PrismaInstance.getInstance();
const logger = new Logger();
const data = Data.getInstance();

const boxRoutes = async (fastify: FastifyInstance, getAuthHandler?: any) => {
  if (!getAuthHandler) return;

  /**
   * POST /api/box/calculate-price
   * Calculate price for adding a gift box to an existing physical order
   * Requires authentication
   */
  fastify.post(
    '/api/box/calculate-price',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentHasPlaylistId } = request.body;
        const userIdString = request.user?.userId;

        if (!paymentHasPlaylistId) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required parameter: paymentHasPlaylistId',
          });
        }

        // Look up user to get database ID
        const user = await prisma.user.findUnique({
          where: { userId: userIdString },
        });

        if (!user) {
          return reply.status(401).send({
            success: false,
            error: 'User not found',
          });
        }

        const phpId = parseInt(paymentHasPlaylistId);
        if (isNaN(phpId)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid paymentHasPlaylistId',
          });
        }

        // Validate PaymentHasPlaylist
        const php = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
          include: {
            payment: true,
            playlist: true,
          },
        });

        if (!php) {
          return reply.status(404).send({
            success: false,
            error: 'PaymentHasPlaylist not found',
          });
        }

        if (php.payment.userId !== user.id) {
          return reply.status(403).send({
            success: false,
            error: 'Unauthorized',
          });
        }

        if (php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Gift box is only available for physical orders',
          });
        }

        if (!php.payment.finalized) {
          return reply.status(400).send({
            success: false,
            error: 'Order has not been finalized yet',
          });
        }


        return reply.send({
          success: true,
          totalPrice: BOX_PRICE,
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in POST /api/box/calculate-price: ${error.message}`));
        return reply.status(500).send({
          success: false,
          error: 'Failed to calculate price',
        });
      }
    }
  );

  /**
   * POST /api/box/calculate-shipping
   * Calculate shipping costs for box upgrade
   * Requires authentication
   */
  fastify.post(
    '/api/box/calculate-shipping',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentHasPlaylistId } = request.body;
        const userIdString = request.user?.userId;

        if (!paymentHasPlaylistId) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required parameter: paymentHasPlaylistId',
          });
        }

        // Look up user to get database ID
        const user = await prisma.user.findUnique({
          where: { userId: userIdString },
        });

        if (!user) {
          return reply.status(401).send({
            success: false,
            error: 'User not found',
          });
        }

        const phpId = parseInt(paymentHasPlaylistId);
        if (isNaN(phpId)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid paymentHasPlaylistId',
          });
        }

        // Validate PaymentHasPlaylist
        const php = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
          include: {
            payment: true,
            playlist: true,
          },
        });

        if (!php) {
          return reply.status(404).send({
            success: false,
            error: 'PaymentHasPlaylist not found',
          });
        }

        if (php.payment.userId !== user.id) {
          return reply.status(403).send({
            success: false,
            error: 'Unauthorized',
          });
        }

        if (php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Gift box is only available for physical orders',
          });
        }

        if (!php.payment.finalized) {
          return reply.status(400).send({
            success: false,
            error: 'Order has not been finalized yet',
          });
        }


        // Calculate shipping costs
        const countryCode = php.payment.countrycode || 'NL';
        let shipping = 0;

        if (countryCode === 'NL') {
          shipping = 2.99;
        } else {
          const PrintEnBind = (await import('../printers/printenbind')).default;
          const printEnBind = PrintEnBind.getInstance();
          const shippingResult = await printEnBind.getShippingCosts(countryCode, 80);
          shipping = shippingResult?.cost || 0;
        }

        return reply.send({
          success: true,
          shipping,
          boxPrice: BOX_PRICE,
          total: BOX_PRICE + shipping,
          address: {
            fullname: php.payment.fullname,
            address: php.payment.address,
            housenumber: php.payment.housenumber,
            city: php.payment.city,
            zipcode: php.payment.zipcode,
            countrycode: php.payment.countrycode,
          },
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in POST /api/box/calculate-shipping: ${error.message}`));
        return reply.status(500).send({
          success: false,
          error: 'Failed to calculate shipping',
        });
      }
    }
  );

  /**
   * GET /api/box/design/:paymentHasPlaylistId
   * Get saved box design for a playlist
   * Requires authentication
   */
  fastify.get(
    '/api/box/design/:paymentHasPlaylistId',
    getAuthHandler(['users', 'admin']),
    async (request: any, reply: any) => {
      try {
        const phpId = parseInt(request.params.paymentHasPlaylistId);
        const userIdString = request.user?.userId;
        const isAdmin = request.user?.role === 'admin';

        if (isNaN(phpId)) {
          return reply.status(400).send({ success: false, error: 'Invalid paymentHasPlaylistId' });
        }

        const php = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
          include: { payment: true },
        });

        if (!php) {
          return reply.status(404).send({ success: false, error: 'Not found' });
        }

        // Admins can access any playlist, users can only access their own
        if (!isAdmin) {
          const user = await prisma.user.findUnique({ where: { userId: userIdString } });
          if (!user || php.payment.userId !== user.id) {
            return reply.status(403).send({ success: false, error: 'Unauthorized' });
          }
        }

        return reply.send({
          success: true,
          design: {
            boxFrontBackgroundType: php.boxFrontBackgroundType,
            boxFrontBackground: php.boxFrontBackground,
            boxFrontBackgroundColor: php.boxFrontBackgroundColor,
            boxFrontLogo: php.boxFrontLogo,
            boxFrontLogoScale: php.boxFrontLogoScale,
            boxFrontLogoPositionX: php.boxFrontLogoPositionX,
            boxFrontLogoPositionY: php.boxFrontLogoPositionY,
            boxFrontEmoji: php.boxFrontEmoji,
            boxBackBackgroundType: php.boxBackBackgroundType,
            boxBackBackground: php.boxBackBackground,
            boxBackBackgroundColor: php.boxBackBackgroundColor,
            boxBackFontColor: php.boxBackFontColor,
            boxBackUseGradient: php.boxBackUseGradient,
            boxBackGradientColor: php.boxBackGradientColor,
            boxBackGradientDegrees: php.boxBackGradientDegrees,
            boxBackGradientPosition: php.boxBackGradientPosition,
            boxBackOpacity: php.boxBackOpacity,
            boxBackText: php.boxBackText,
            boxBackSelectedFont: php.boxBackSelectedFont,
            boxBackSelectedFontSize: php.boxBackSelectedFontSize,
          },
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in GET /api/box/design: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to load box design' });
      }
    }
  );

  /**
   * POST /api/box/upgrade-payment
   * Create a Mollie payment to add a gift box to an existing physical order
   * Requires authentication
   */
  fastify.post(
    '/api/box/upgrade-payment',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentHasPlaylistId, boxDesign, locale, quantity, currency } = request.body;
        const boxQuantity = Math.max(1, Math.min(10, parseInt(quantity) || 1));
        const userIdString = request.user?.userId;

        if (!paymentHasPlaylistId || !boxDesign) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required parameters: paymentHasPlaylistId, boxDesign',
          });
        }

        // Look up user to get database ID
        const user = await prisma.user.findUnique({
          where: { userId: userIdString },
        });

        if (!user) {
          return reply.status(401).send({
            success: false,
            error: 'User not found',
          });
        }

        const phpId = parseInt(paymentHasPlaylistId);
        if (isNaN(phpId)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid paymentHasPlaylistId',
          });
        }

        // Validate PaymentHasPlaylist
        const php = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
          include: {
            payment: true,
            playlist: true,
          },
        });

        if (!php) {
          return reply.status(404).send({
            success: false,
            error: 'PaymentHasPlaylist not found',
          });
        }

        if (php.payment.userId !== user.id) {
          return reply.status(403).send({
            success: false,
            error: 'Unauthorized',
          });
        }

        if (php.type !== 'physical') {
          return reply.status(400).send({
            success: false,
            error: 'Gift box is only available for physical orders',
          });
        }

        if (!php.payment.finalized) {
          return reply.status(400).send({
            success: false,
            error: 'Order has not been finalized yet',
          });
        }


        // Calculate shipping server-side
        const countryCode = php.payment.countrycode || 'NL';
        let shipping = 0;

        if (countryCode === 'NL') {
          shipping = 2.99;
        } else {
          const PrintEnBind = (await import('../printers/printenbind')).default;
          const printEnBind = PrintEnBind.getInstance();
          const shippingResult = await printEnBind.getShippingCosts(countryCode, 80);
          shipping = shippingResult?.cost || 0;
        }

        // Apply VAT based on customer's country
        const taxRate = (await data.getTaxRate(countryCode)) || 0;
        const boxSubtotal = BOX_PRICE * boxQuantity;
        const boxVAT = parseFloat((boxSubtotal * (taxRate / 100)).toFixed(2));
        const totalAmount = parseFloat((boxSubtotal + boxVAT + shipping).toFixed(2));

        // Save box design data and set boxQuantity
        await prisma.paymentHasPlaylist.update({
          where: { id: phpId },
          data: {
            boxQuantity,
            // Box front design
            boxFrontBackgroundType: boxDesign.boxFrontBackgroundType,
            boxFrontBackground: boxDesign.boxFrontBackground,
            boxFrontBackgroundColor: boxDesign.boxFrontBackgroundColor,
            boxFrontUseFrontGradient: boxDesign.boxFrontUseFrontGradient,
            boxFrontGradientColor: boxDesign.boxFrontGradientColor,
            boxFrontGradientDegrees: boxDesign.boxFrontGradientDegrees,
            boxFrontGradientPosition: boxDesign.boxFrontGradientPosition,
            boxFrontOpacity: boxDesign.boxFrontOpacity,
            boxFrontLogo: boxDesign.boxFrontLogo,
            boxFrontLogoScale: boxDesign.boxFrontLogoScale,
            boxFrontLogoPositionX: boxDesign.boxFrontLogoPositionX,
            boxFrontLogoPositionY: boxDesign.boxFrontLogoPositionY,
            boxFrontEmoji: boxDesign.boxFrontEmoji,
            // Box back design
            boxBackBackgroundType: boxDesign.boxBackBackgroundType,
            boxBackBackground: boxDesign.boxBackBackground,
            boxBackBackgroundColor: boxDesign.boxBackBackgroundColor,
            boxBackFontColor: boxDesign.boxBackFontColor,
            boxBackUseGradient: boxDesign.boxBackUseGradient,
            boxBackGradientColor: boxDesign.boxBackGradientColor,
            boxBackGradientDegrees: boxDesign.boxBackGradientDegrees,
            boxBackGradientPosition: boxDesign.boxBackGradientPosition,
            boxBackOpacity: boxDesign.boxBackOpacity,
            boxBackText: boxDesign.boxBackText,
            boxBackSelectedFont: boxDesign.boxBackSelectedFont,
            boxBackSelectedFontSize: boxDesign.boxBackSelectedFontSize,
          },
        });

        const userLocale = locale || 'en';
        const playlistName = php.playlist.name;

        // Delegate FX conversion + method filtering + Mollie create to the
        // shared Mollie.createUpgradePayment helper. `totalAmount` is in EUR
        // (books currency); the helper converts to the buyer's presentment
        // currency and charges Mollie in that currency.
        const mollie = new Mollie();
        const result = await mollie.createUpgradePayment({
          amountEur: totalAmount,
          requestedCurrency: currency,
          description:
            boxQuantity > 1
              ? `Gift Box (${boxQuantity}x) - ${playlistName}`
              : `Gift Box - ${playlistName}`,
          locale: userLocale,
          redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/my-account?box_enabled=1`,
          metadata: {
            type: 'box_upgrade',
            paymentHasPlaylistId: phpId.toString(),
            userId: user.id.toString(),
            originalPaymentId: php.payment.paymentId,
            shippingCost: shipping.toString(),
            boxPrice: BOX_PRICE.toString(),
            quantity: boxQuantity.toString(),
          },
          clientIp: request.clientIp,
        });

        logger.log(
          color.blue.bold(
            `Created box upgrade payment: ${white.bold(result.id)} for playlist ${white.bold(playlistName)} (${white.bold(result.currency + ' ' + result.amount.toFixed(2))})`
          )
        );

        return reply.send({
          success: true,
          paymentUrl: result.checkoutUrl,
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in POST /api/box/upgrade-payment: ${error.message}`));
        console.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Failed to create box upgrade payment',
        });
      }
    }
  );
};

export default boxRoutes;
