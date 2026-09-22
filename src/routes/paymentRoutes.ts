import { FastifyInstance } from 'fastify';
import Mollie from '../mollie';
import Data from '../data';
import Order from '../order';
import Discount from '../discount';
import Review from '../review';
import Translation from '../translation';
import Utils from '../utils';
import {
  getYearFontSize,
  getGoogleFontName,
  getFontWeight,
} from '../fonts';
import { getQrTotalModules } from '../qr';
import GoogleFonts from '../googleFonts';
import { forcedPrinterTemplate, isMultiCardTemplate } from '../pdf';
import { maxCardsFor } from '../config/constants';

import fs from 'fs/promises';
import { color } from 'console-log-colors';
import Formatters from '../formatters';
import Logger from '../logger';
import Fx from '../services/fx';
import { buildInvoiceLines, makeTranslator } from '../services/invoice-lines';
import PrismaInstance from '../prisma';
import UpgradeInvoices from '../upgradeInvoice';
import {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  getCurrencyForCountry,
  SupportedCurrency,
} from '../data/currency-map';

export default async function paymentRoutes(fastify: FastifyInstance) {
  const mollie = new Mollie();
  const data = Data.getInstance();
  const order = Order.getInstance();
  const discount = new Discount();
  const reviewObj = Review.getInstance();
  const translation = new Translation();
  const logger = new Logger();
  const utils = new Utils();
  const formatters = new Formatters().getFormatters();
  const fx = Fx.getInstance();
  const prisma = PrismaInstance.getInstance();

  // Check payment status
  fastify.post('/mollie/check', async (request: any, _reply) => {
    return await mollie.checkPaymentStatus(request.body.paymentId);
  });

  // Create payment
  fastify.post('/mollie/payment', async (request: any, _reply) => {
    const headerCountry =
      (request.headers['cloudfront-viewer-country'] as string | undefined) ||
      (request.headers['x-country-code'] as string | undefined) ||
      '';
    return await mollie.getPaymentUri(
      request.body,
      request.clientIp,
      false,
      false,
      headerCountry.toUpperCase()
    );
  });

  // Payment webhook
  fastify.post('/mollie/webhook', async (request: any, _reply) => {
    return await mollie.processWebhook(request.body);
  });

  // Get order progress
  fastify.get(
    '/progress/:playlistId/:paymentId',
    async (request: any, _reply) => {
      const data = await Data.getInstance().getPayment(
        request.params.paymentId,
        request.params.playlistId
      );
      if (!data) {
        return { success: false, error: 'Payment not found' };
      }
      return {
        success: true,
        data,
      };
    }
  );

  // Get order type
  fastify.get(
    '/ordertype/:numberOfTracks/:digital/:subType/:playlistId',
    async (request: any, _reply) => {
      const orderType = await order.getOrderType(
        parseInt(request.params.numberOfTracks),
        utils.parseBoolean(request.params.digital),
        'cards',
        request.params.playlistId,
        request.params.subType
      );
      if (orderType) {
        return {
          success: true,
          data: {
            id: orderType.id,
            amount: orderType.amount,
            maxCards: maxCardsFor(orderType.digital),
            alternatives: orderType.alternatives || {},
            available: true,
          },
        };
      } else {
        return {
          success: true,
          data: {
            id: 0,
            amount: 0,
            alternatives: {},
            available: false,
          },
        };
      }
    }
  );

  // Get order types
  fastify.get('/ordertypes', async (request: any, _reply) => {
    const orderTypes = await order.getOrderTypes();
    if (orderTypes && orderTypes.length > 0) {
      return orderTypes;
    } else {
      return { success: false, error: 'Order type not found' };
    }
  });

  // Download files
  fastify.get(
    '/download/:paymentId/:userHash/:playlistId/:type',
    async (request: any, reply) => {
      if (!request.query.cb) {
        const url = request.url + (request.url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        return reply.redirect(url);
      }

      const pdfFile = await data.getPDFFilepath(
        request.clientIp,
        request.params.paymentId,
        request.params.userHash,
        request.params.playlistId,
        request.params.type
      );
      if (pdfFile && pdfFile.filePath) {
        try {
          await fs.access(pdfFile.filePath, fs.constants.R_OK);
          reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
          reply.header(
            'Content-Disposition',
            'attachment; filename=' + pdfFile.fileName
          );
          reply.type('application/pdf');
          const fileContent = await fs.readFile(pdfFile.filePath);

          logger.log(
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

  // Calculate order
  fastify.post('/order/calculate', async (request: any, _reply) => {
    try {
      const result = await order.calculateOrder(request.body);
      if (!result?.success || !result.data) {
        return result;
      }

      const requested: SupportedCurrency = isSupportedCurrency(
        request.body?.currency
      )
        ? (request.body.currency as SupportedCurrency)
        : 'EUR';

      if (requested === 'EUR') {
        result.data.presentment = {
          currency: 'EUR',
          rate: 1,
          total: result.data.total,
          price: result.data.price,
          shipping: result.data.shipping,
          payment: result.data.payment,
          volumeDiscount: result.data.volumeDiscount,
          gamesFee: result.data.gamesFee,
          qrgamesUnitPrice: result.data.qrgamesUnitPrice,
          appDesignFee: result.data.appDesignFee,
          appDesignUnitPrice: result.data.appDesignUnitPrice,
          appDesignOwned: result.data.appDesignOwned,
          reverseCharge: result.data.reverseCharge,
          vatIdStatus: result.data.vatIdStatus,
        };
        return result;
      }

      try {
        const convertField = async (v: number) =>
          (await fx.convert(v || 0, requested)).amount;
        const totalConv = await fx.convert(result.data.total || 0, requested);
        result.data.presentment = {
          currency: requested,
          rate: totalConv.rate,
          total: totalConv.amount,
          price: await convertField(result.data.price),
          shipping: await convertField(result.data.shipping),
          payment: await convertField(result.data.payment),
          volumeDiscount: await convertField(result.data.volumeDiscount),
          gamesFee: await convertField(result.data.gamesFee),
          qrgamesUnitPrice: await convertField(result.data.qrgamesUnitPrice),
          appDesignFee: await convertField(result.data.appDesignFee),
          appDesignUnitPrice: await convertField(result.data.appDesignUnitPrice),
          appDesignOwned: result.data.appDesignOwned,
          reverseCharge: result.data.reverseCharge,
          vatIdStatus: result.data.vatIdStatus,
        };
      } catch (e) {
        logger.log(
          color.yellow.bold(
            `FX conversion failed for ${requested}: ${(e as Error).message}`
          )
        );
      }
      return result;
    } catch (e) {
      return { success: false };
    }
  });

  // Get supported currencies + current rates. Returns EFFECTIVE rates (ECB ×
  // buffer) so the frontend multiplies EUR × rate directly — keeping the
  // buffer as a backend-only concern. Changing BUFFER_PCT only needs a server
  // restart; clients will pick up the new effective rate on their next fetch.
  fastify.get('/currency/rates', async (_request: any, _reply) => {
    const rates = await fx.getEffectiveRates();
    return {
      success: true,
      data: {
        currencies: SUPPORTED_CURRENCIES,
        rates: rates?.rates ?? { EUR: 1 },
        asOf: rates?.asOf ?? null,
      },
    };
  });

  // Get suggested currency for a country code
  fastify.get('/currency/for-country/:countryCode', async (request: any) => {
    const { countryCode } = request.params;
    return {
      success: true,
      data: {
        currency: getCurrencyForCountry(countryCode),
      },
    };
  });

  // Calculate volume discount
  fastify.post('/order/volume-discount', async (request: any, _reply) => {
    try {
      const volumeDiscount = await discount.calculateVolumeDiscount(
        request.body.cart
      );
      return {
        success: true,
        volumeDiscount: volumeDiscount,
      };
    } catch (e) {
      return { success: false, volumeDiscount: 0 };
    }
  });

  // Discount check / validate / voucher routes live in discountRoutes.ts.

  // Invoice
  fastify.get('/invoice/:paymentId', async (request: any, reply) => {
    const storedPayment = await mollie.getPayment(request.params.paymentId);
    if (!storedPayment) {
      reply.status(404).send({ error: 'Payment not found' });
      return;
    }
    // Extra cards and gift boxes bought later are added to the order's
    // totalPrice (the books) but invoiced on their own (U range), so the
    // order invoice leaves them out again.
    const bookedUpgrades = await UpgradeInvoices.getInstance().amountBookedOnOrder(
      storedPayment.id
    );
    const payment =
      bookedUpgrades > 0
        ? {
            ...storedPayment,
            totalPrice: parseFloat((storedPayment.totalPrice - bookedUpgrades).toFixed(2)),
          }
        : storedPayment;
    const playlists = await data.getPlaylistsByPaymentId(payment.paymentId);

    let orderType = 'digital';
    for (const playlist of playlists) {
      if (playlist.orderType !== 'digital') {
        orderType = 'physical';
        break;
      }
    }

    const invoiceCurrency = payment.currency || 'EUR';
    // `invoiceRate` is the raw buffered FX rate Mollie used; fine for the
    // footnote ("1 EUR = X NOK") but NOT safe to drive line items, because
    // the total was snap-rounded (e.g. nearest NOK 5) before Mollie charged
    // it. Using `invoiceRate * totalPrice` would print a smooth total that
    // differs from what the customer actually paid.
    //
    // `displayRate` is the effective rate implied by the charged total —
    // totalPricePresentment / totalPrice. Multiplying every EUR line by
    // `displayRate` keeps line items proportional AND makes them sum to the
    // presentment total, so the invoice matches Mollie exactly.
    const invoiceRate =
      invoiceCurrency === 'EUR' ? 1 : payment.exchangeRate || 1;
    const presentmentTotal =
      invoiceCurrency === 'EUR'
        ? payment.totalPrice
        : payment.totalPricePresentment ?? payment.totalPrice * invoiceRate;
    const displayRate =
      invoiceCurrency === 'EUR' || !payment.totalPrice
        ? 1
        : presentmentTotal / payment.totalPrice;
    const moneyFormatter = formatters.currencyFormatter(invoiceCurrency);
    const translations = await translation.getTranslationsByPrefix(
      payment.locale,
      'invoice'
    );

    // Payments written with the discount-aware math carry a snapshot the
    // line builder renders from; older rows keep the legacy template block.
    const invoice =
      (payment.pricingVersion || 1) >= 2
        ? buildInvoiceLines(
            payment,
            playlists,
            orderType,
            makeTranslator(translations as Record<string, string>)
          )
        : null;

    await reply.view(`invoice.ejs`, {
      payment,
      playlists,
      orderType,
      invoice,
      ...formatters,
      moneyFormatter,
      invoiceCurrency,
      invoiceRate,
      displayRate,
      presentmentTotal,
      translations,
      countries: await translation.getTranslationsByPrefix(
        payment.locale,
        'countries'
      ),
    });
  });

  // Invoice for a purchase made after an order (App Designer, extra cards),
  // rendered from its stored snapshot through the order invoice template so
  // both look the same. Keyed on the Mollie payment id like /invoice/:paymentId.
  fastify.get('/invoice/upgrade/:molliePaymentId', async (request: any, reply) => {
    const row = await prisma.upgradeInvoice.findUnique({
      where: { molliePaymentId: request.params.molliePaymentId },
    });
    if (!row) {
      reply.status(404).send({ error: 'Invoice not found' });
      return;
    }
    const customer = (row.customer || {}) as Record<string, any>;
    const invoiceCurrency = row.currency || 'EUR';
    const presentmentTotal = invoiceCurrency === 'EUR' ? row.totalPrice : row.amountCharged;
    // Effective rate implied by what was charged, so the lines sum to it.
    const displayRate =
      invoiceCurrency === 'EUR' || !row.totalPrice ? 1 : row.amountCharged / row.totalPrice;
    const payment = {
      ...customer,
      orderId: row.invoiceNumber,
      createdAt: row.createdAt,
      paymentMethod: row.paymentMethod,
      taxRate: row.taxRate,
      taxRateShipping: row.taxRate,
      reverseCharge: false,
      totalPrice: row.totalPrice,
      currency: invoiceCurrency,
    };
    const translations = await translation.getTranslationsByPrefix(row.locale, 'invoice');
    await reply.view(`invoice.ejs`, {
      payment,
      playlists: [],
      orderType: 'digital',
      invoice: {
        lines: row.lines,
        summary: {
          subtotalExcl: row.totalPriceWithoutTax,
          goodsVatBase: row.totalPriceWithoutTax,
          goodsVat: row.totalVAT,
          shippingVatBase: 0,
          shippingVat: 0,
          totalIncl: row.totalPrice,
        },
      },
      ...formatters,
      moneyFormatter: formatters.currencyFormatter(invoiceCurrency),
      invoiceCurrency,
      invoiceRate: displayRate,
      displayRate,
      presentmentTotal,
      translations,
      countries: await translation.getTranslationsByPrefix(row.locale, 'countries'),
    });
  });

  // PDF generation
  fastify.get(
    '/qr/pdf/:playlistId/:paymentId/:template/:startIndex/:endIndex/:subdir/:eco/:emptyPages/:itemIndex?',
    async (request: any, reply) => {
      const valid = await mollie.canDownloadPDF(
        request.params.playlistId,
        request.params.paymentId
      );
      if (!valid) {
        reply.status(403).send({ error: 'Forbidden' });
        return;
      }

      const payment = await mollie.getPayment(request.params.paymentId);
      const user = await data.getUser(payment.userId);
      const playlist = await data.getPlaylist(request.params.playlistId);
      const php = await data.getPlaylistsByPaymentId(
        request.params.paymentId,
        request.params.playlistId
      );
      let tracks = await data.getTracks(playlist.id, user.id);

      // Slice the tracks based on the start and end index
      const startIndex = parseInt(request.params.startIndex);
      const endIndex = parseInt(request.params.endIndex);
      const eco = utils.parseBoolean(request.params.eco);
      const emptyPages = parseInt(request.params.emptyPages);
      const subdir = request.params.subdir;
      const itemIndex = request.params.itemIndex ? parseInt(request.params.itemIndex) : undefined;
      tracks = tracks.slice(startIndex, endIndex + 1);

      // Construct batch number with item index if provided
      let batchNumber = php[0].paymentHasPlaylistId.toString();
      if (itemIndex && itemIndex > 0) {
        batchNumber = `${php[0].paymentHasPlaylistId}-${itemIndex}`;
      }

      if (payment.email) {
        // An admin-chosen order template, or the company list's forced
        // template for company orders (see forcedPrinterTemplate), replaces
        // the single-card printer layout only: digital downloads and sheets
        // keep their multi-card layout instead of coming out one card per page.
        const requestedTemplate: string = request.params.template;
        const forcedTemplate = forcedPrinterTemplate(
          php[0].template,
          playlist.template,
          payment.vibe
        );
        const template =
          forcedTemplate && !isMultiCardTemplate(requestedTemplate)
            ? forcedTemplate
            : requestedTemplate;

        // Load how-to card translations if enabled
        let howtoTranslations: Record<string, string> | null = null;
        if (php[0].addHowToCard) {
          howtoTranslations = await translation.getTranslationsByPrefix(
            php[0].addHowToCardLocale || 'en',
            'howto'
          );
        }

        await reply.view(`pdf_${template}.ejs`, {
          subdir,
          payment,
          playlist,
          php: php[0],
          tracks,
          user,
          eco,
          emptyPages,
          batchNumber,
          startIndex,
          howtoTranslations,
          getYearFontSize,
          // Admin-chosen fonts outside fonts.ts get their weights from the
          // Google catalogue; the fixed list resolves as before.
          getGoogleFontWeights: await GoogleFonts.getInstance().weightsHelper(php[0].selectedFont),
          getGoogleFontName,
          getFontWeight,
          getQrTotalModules,
        });
      }
    }
  );

  // Box insert PDF
  fastify.get(
    '/qr/pdf-box/:paymentHasPlaylistId/:paymentId',
    async (request: any, reply) => {
      const payment = await mollie.getPayment(request.params.paymentId);
      if (!payment) {
        reply.status(403).send({ error: 'Forbidden' });
        return;
      }

      const php = await data.getPaymentHasPlaylistById(
        parseInt(request.params.paymentHasPlaylistId)
      );

      if (!php || php.paymentId !== payment.id) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }

      // Optional explicit insert count (used by box upgrade flows where the
      // purchased box total is not boxQuantity × amount). 0 = derive from php.
      const count = Math.min(100, Math.max(0, parseInt(request.query.count) || 0));

      await reply.view('pdf_box_insert.ejs', {
        payment,
        php,
        count,
        getGoogleFontWeights: await GoogleFonts.getInstance().weightsHelper(php.selectedFont),
        getGoogleFontName,
        getFontWeight,
      });
    }
  );

  // Reviews
  fastify.get('/review/:paymentId', async (request: any, _reply) => {
    return await reviewObj.checkReview(request.params.paymentId);
  });

  fastify.post('/review/:paymentId', async (request: any, _reply) => {
    const { rating, review } = request.body;
    return await reviewObj.createReview(
      request.params.paymentId,
      rating,
      review
    );
  });

  // Print API webhook
  fastify.post('/printapi/webhook', async (request: any, _reply) => {
    await order.processPrintApiWebhook(request.body.orderId);
    return { success: true };
  });

  // Development routes
  if (process.env['ENVIRONMENT'] == 'development') {
    fastify.get(
      '/generate_invoice/:paymentId',
      async (request: any, _reply) => {
        const payment = await mollie.getPayment(request.params.paymentId);
        if (payment) {
          const pdfPath = await order.createInvoice(payment);
          // Send tracking email would go here
          return { success: true };
        } else {
          return { success: false };
        }
      }
    );
  }
}
