import { FastifyInstance } from 'fastify';
import Discount from '../discount';
import Mollie from '../mollie';
import Translation from '../translation';
import Utils from '../utils';

/**
 * Discount codes: the public checkout checks, the gift-card voucher view and
 * the admin CRUD. Payment creation itself (where codes are redeemed) stays
 * in paymentRoutes / src/mollie.ts.
 */
export default async function discountRoutes(
  fastify: FastifyInstance,
  getAuthHandler: any
) {
  const discount = new Discount();
  const mollie = new Mollie();
  const translation = new Translation();
  const utils = new Utils();

  // -------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------

  // Check a single code. With a `cart` in the body the code is evaluated
  // against the whole order with the same rules payment creation applies;
  // without one the legacy single-code check answers (gift-card page, older
  // clients).
  fastify.post('/discount/:code/:digital', async (request: any, reply: any) => {
    const body = request.body || {};
    const result = await discount.checkDiscount(
      request.params.code,
      body.token,
      utils.parseBoolean(request.params.digital),
      {
        cart: body.cart && Array.isArray(body.cart.items) ? body.cart : undefined,
        email: body.email || null,
        countrycode: body.countrycode || undefined,
        fast: !!body.fast,
      }
    );
    reply.send(result);
  });

  // The mobile app's standing offer, shown when someone scans a card that is
  // not ours. Public and read-only: it reads one evergreen percent code and
  // never mints anything, so unlike /discount/:code it needs no reCAPTCHA (the
  // app has no site key) and adds no abuse surface. A `success: false` answer
  // simply hides the offer in the app.
  fastify.get('/app/offer', async (request: any, reply: any) => {
    const result = await discount.getAppOffer();
    reply.send(result);
  });

  // Re-validate every code already in the cart (checkout load, back
  // navigation, before "Pay"). Read-only.
  fastify.post('/discount/validate', async (request: any, reply: any) => {
    const body = request.body || {};
    if (!body.cart || !Array.isArray(body.cart.items)) {
      reply.status(400).send({ success: false, message: 'invalidCart' });
      return;
    }
    const result = await discount.validateCart(body.cart, body.token, {
      email: body.email || null,
      countrycode: body.countrycode || undefined,
      fast: !!body.fast,
    });
    reply.send(result);
  });

  // Gift-card voucher (rendered to PDF by Lambda)
  fastify.get(
    '/discount/voucher/:type/:code/:paymentId',
    async (request: any, reply: any) => {
      const { type, code, paymentId } = request.params;
      const discountDetails = await discount.getDiscountDetails(code);
      const payment = await mollie.getPayment(paymentId);
      if (discountDetails) {
        try {
          const translations = await translation.getTranslationsByPrefix(
            payment.locale,
            'voucher'
          );
          await reply.view(`voucher_${type}.ejs`, {
            discount: discountDetails,
            translations,
          });
        } catch (error) {
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      } else {
        reply.status(404).send({ error: 'Code not found' });
      }
    }
  );

  // -------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------

  fastify.post(
    '/admin/discount/create',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const result = await discount.createAdminDiscountCode(request.body);
      if (result.success) {
        reply.send({ success: true, code: result.code });
      } else {
        reply.status(400).send({ success: false, error: result.error });
      }
    }
  );

  fastify.get(
    '/admin/discount/all',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const result = await discount.getAllDiscounts();
      if (result.success) {
        reply.send({ success: true, discounts: result.discounts });
      } else {
        reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  fastify.post(
    '/admin/discount/search',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const {
        searchTerm = '',
        filter = '',
        balanceFilter = '',
        page = 1,
        limit = 12,
      } = request.body;
      const result = await discount.searchDiscounts({
        searchTerm,
        filter,
        balanceFilter,
        page: Number(page),
        limit: Number(limit),
      });
      if (result.success) {
        reply.send({
          success: true,
          discounts: result.discounts,
          total: result.total,
          page: result.page,
          totalPages: result.totalPages,
        });
      } else {
        reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  fastify.delete(
    '/admin/discount/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const result = await discount.deleteDiscountCode(id);
      if (result.success) {
        reply.send({ success: true });
      } else {
        reply.status(500).send({ success: false, error: result.error });
      }
    }
  );

  fastify.put(
    '/admin/discount/:id',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid id' });
        return;
      }
      const result = await discount.updateDiscountCode(id, request.body);
      if (result.success) {
        reply.send({ success: true, code: result.code });
      } else {
        reply.status(400).send({ success: false, error: result.error });
      }
    }
  );
}
