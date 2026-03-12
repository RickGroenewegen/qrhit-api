import { FastifyInstance } from 'fastify';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import { color, white } from 'console-log-colors';
import { createMollieClient, Locale } from '@mollie/api-client';

const prisma = PrismaInstance.getInstance();
const logger = new Logger();
const BOX_UPGRADE_PRICE = 6.99;

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
          totalPrice: BOX_UPGRADE_PRICE,
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
          boxPrice: BOX_UPGRADE_PRICE,
          total: BOX_UPGRADE_PRICE + shipping,
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
   * POST /api/box/upgrade-payment
   * Create a Mollie payment to add a gift box to an existing physical order
   * Requires authentication
   */
  fastify.post(
    '/api/box/upgrade-payment',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentHasPlaylistId, boxDesign, locale } = request.body;
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

        const totalAmount = parseFloat((BOX_UPGRADE_PRICE + shipping).toFixed(2));

        // Save box design data and set boxQuantity
        await prisma.paymentHasPlaylist.update({
          where: { id: phpId },
          data: {
            boxQuantity: 1,
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

        // Create Mollie payment for box upgrade
        const mollieClient = createMollieClient({
          apiKey: process.env['MOLLIE_API_KEY']!,
        });

        // Get locale mapping
        const localeMap: { [key: string]: string } = {
          en: 'en_US',
          nl: 'nl_NL',
          de: 'de_DE',
          fr: 'fr_FR',
          es: 'es_ES',
          it: 'it_IT',
          pt: 'pt_PT',
          pl: 'pl_PL',
        };
        const mollieLocale = (localeMap[locale || 'en'] || 'en_US') as Locale;
        const userLocale = locale || 'en';

        const playlistName = php.playlist.name;

        const payment = await mollieClient.payments.create({
          amount: {
            currency: 'EUR',
            value: totalAmount.toFixed(2),
          },
          metadata: {
            type: 'box_upgrade',
            paymentHasPlaylistId: phpId.toString(),
            userId: user.id.toString(),
            originalPaymentId: php.payment.paymentId,
            shippingCost: shipping.toString(),
            boxPrice: BOX_UPGRADE_PRICE.toString(),
          },
          description: `Gift Box - ${playlistName}`,
          redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/my-account?box_enabled=1`,
          webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
          locale: mollieLocale,
        });

        const checkoutUrl = payment.getCheckoutUrl();

        logger.log(
          color.blue.bold(
            `Created box upgrade payment: ${white.bold(payment.id)} for playlist ${white.bold(playlistName)} (${white.bold('€' + totalAmount.toFixed(2))})`
          )
        );

        return reply.send({
          success: true,
          paymentUrl: checkoutUrl,
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
