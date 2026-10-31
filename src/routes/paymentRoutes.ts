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
import CardTemplates, { CardTemplateError, isFileTemplate, sendStoredPage, TEMPLATE_NAME } from '../cardTemplates';
import {
  CardDesign,
  deckDesigns,
  designIndexForCard,
  getExtraDesigns,
} from '../cardDesigns';
import { maxCardsFor } from '../config/constants';

import fs from 'fs/promises';
import { color } from 'console-log-colors';
import Formatters from '../formatters';
import Logger from '../logger';
import Fx from '../services/fx';
import { buildInvoiceLines, makeTranslator } from '../services/invoice-lines';
import PrismaInstance from '../prisma';
import UpgradeInvoices from '../upgradeInvoice';
import { isSignedRenderRequest } from '../renderSignature';
import CardPreviews from '../cardPreview';
import { showcaseView } from '../productPhoto/cards';
import {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
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
  // `store`: the scan app's proof of an App Store / Google Play purchase,
  // which settles a store_… order (see mollie.ts settleStorePurchase).
  fastify.post('/mollie/check', async (request: any, _reply) => {
    return await mollie.checkPaymentStatus(request.body.paymentId, request.body.store);
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

  // The help mail's "Complete my order" link (src/abandonedPayments.ts): a
  // new Mollie payment for the same order. A link that expired or was
  // altered goes to the contact page, which is what the mail is about.
  fastify.get('/order/resume/:orderId', async (request: any, reply) => {
    const requested = String(request.query?.l || '');
    const locale = translation.isValidLocale(requested) ? requested : 'en';
    // Fastify answers HEAD with this handler; a mail scanner checking the
    // link must not make a payment
    if (request.method === 'HEAD' || !isSignedRenderRequest('payment-resume', request)) {
      return reply.redirect(`${process.env['FRONTEND_URI']}/${locale}/contact`);
    }
    return reply.redirect(
      await mollie.resumeAbandonedPayment(String(request.params.orderId), locale)
    );
  });

  // Get order progress
  fastify.get(
    '/progress/:playlistId/:paymentId',
    async (request: any, _reply) => {
      // The checkout's progress page, right after paying. It carries the
      // order's totals, address and the buyer's hash, so it closes once a
      // set of the order was given away (src/gift.ts): the Mollie id is in
      // the recipient's links.
      const given = await prisma.paymentHasPlaylist.count({
        where: {
          payment: { paymentId: String(request.params.paymentId) },
          ownerUserId: { not: null },
        },
      });
      if (given > 0) {
        return { success: false, error: 'Payment not found' };
      }
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
      // "null", "undefined" or "NaN" would be priced as a NaN deck.
      const numberOfTracks = parseInt(request.params.numberOfTracks);
      if (!Number.isFinite(numberOfTracks) || numberOfTracks < 0) {
        return { success: false, error: 'Invalid number of tracks' };
      }
      const orderType = await order.getOrderType(
        numberOfTracks,
        utils.parseBoolean(request.params.digital),
        'cards',
        request.params.playlistId,
        request.params.subType
      );
      return {
        success: true,
        data: {
          amount: orderType.amount,
          maxCards: maxCardsFor(orderType.digital),
          alternatives: orderType.alternatives,
          available: true,
        },
      };
    }
  );

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
          // `inline=1`: the scan app's done screen opens the PDF in the
          // in-app browser, whose viewer shares and saves it
          reply.header(
            'Content-Disposition',
            (request.query.inline === '1' ? 'inline' : 'attachment') +
              '; filename=' +
              pdfFile.fileName
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

  // Invoice, the page the PDF Lambda prints (order.ts createInvoice). Signed:
  // it shows the buyer's address and what they paid, and the Mollie id is
  // in the links of a set given as a gift (src/gift.ts)
  fastify.get('/invoice/:paymentId', async (request: any, reply) => {
    if (!isSignedRenderRequest('invoice', request)) {
      reply.status(404).send({ error: 'Payment not found' });
      return;
    }
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
      const itemIndex = request.params.itemIndex ? parseInt(request.params.itemIndex) : undefined;
      tracks = tracks.slice(startIndex, endIndex + 1);

      if (payment.email) {
        await sendCardPages(reply, {
          payment,
          user,
          playlist,
          php: php[0],
          tracks,
          requestedTemplate: request.params.template,
          subdir: request.params.subdir,
          eco: utils.parseBoolean(request.params.eco),
          emptyPages: parseInt(request.params.emptyPages),
          startIndex,
          itemIndex,
        });
      }
    }
  );

  // One card of an order line that has no cards yet, drawn with a sample
  // track and a QR code made for it (CardPreviews.draftForLine): the help mail
  // after an abandoned payment shows the customer's card before anything was
  // generated. Opened by the PDF Lambda only, so the link is signed.
  fastify.get(
    '/qr/pdf-draft/:paymentHasPlaylistId',
    async (request: any, reply) => {
      if (!isSignedRenderRequest('card-draft', request)) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      const draft = await CardPreviews.getInstance().draftView(
        Number(request.params.paymentHasPlaylistId)
      );
      if (!draft) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      await sendCardPages(reply, {
        ...draft,
        eco: false,
        emptyPages: 0,
        startIndex: 0,
      });
    }
  );

  // The cards of a product photo (src/productPhoto/cards.ts), drawn from a
  // spec the render left in Redis: no order line behind them. Opened by the
  // PDF Lambda only, so the link is signed.
  fastify.get('/qr/pdf-showcase/:token', async (request: any, reply) => {
    if (!isSignedRenderRequest('card-showcase', request)) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }
    const view = await showcaseView(String(request.params.token));
    if (!view) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }
    await sendCardPages(reply, {
      ...view,
      emptyPages: 0,
      startIndex: 0,
    });
  });

  /**
   * The card pages of an order line as the printer and the downloads get
   * them, through the line's template: a stored one (src/cardTemplates.ts)
   * or a views/pdf_<name>.ejs file.
   */
  async function sendCardPages(
    reply: any,
    page: {
      payment: any;
      user: any;
      playlist: any;
      php: any;
      tracks: any[];
      requestedTemplate: string;
      subdir: string;
      eco: boolean;
      emptyPages: number;
      startIndex: number;
      itemIndex?: number;
      // '' prints none (a product photo's cards)
      batchNumber?: string;
      // designs 2..N and each card's design, for cards without an order
      // line (a product photo's); otherwise the line's own
      extraDesigns?: CardDesign[];
      cardDesignIndexes?: number[];
    }
  ): Promise<void> {
    const { payment, user, playlist, php, tracks, subdir, eco, emptyPages, startIndex, itemIndex } = page;

    // Construct batch number with item index if provided
    let batchNumber = php.paymentHasPlaylistId.toString();
    if (itemIndex && itemIndex > 0) {
      batchNumber = `${php.paymentHasPlaylistId}-${itemIndex}`;
    }
    if (page.batchNumber !== undefined) batchNumber = page.batchNumber;

    // An admin-chosen order template (see forcedPrinterTemplate) replaces
    // the single-card printer layout only: digital downloads and sheets
    // keep their multi-card layout instead of coming out one card per page.
    // php.template is the playlist's (legacy) column in this query;
    // the order line's own template is orderTemplate.
    const requestedTemplate = page.requestedTemplate;
    const forcedTemplate = forcedPrinterTemplate(php.orderTemplate);
    const template =
      forcedTemplate && !isMultiCardTemplate(requestedTemplate)
        ? forcedTemplate
        : requestedTemplate;

    // Load how-to card translations if enabled
    let howtoTranslations: Record<string, string> | null = null;
    if (php.addHowToCard) {
      howtoTranslations = await translation.getTranslationsByPrefix(
        php.addHowToCardLocale || 'en',
        'howto'
      );
    }

    // Alternating card designs (src/cardDesigns.ts). Card numbers run over
    // the whole deck, so a chunk that starts at startIndex continues the
    // cycle instead of restarting it. One design is php itself.
    const designs = deckDesigns(
      php,
      page.extraDesigns ?? (await getExtraDesigns(php.paymentHasPlaylistId))
    );
    const cardDesignIndexes =
      page.cardDesignIndexes ??
      tracks.map((_: any, index: number) =>
        designIndexForCard(designs.length, startIndex + index)
      );
    const cardDesigns = cardDesignIndexes.map((k: number) => designs[k]);

    const view = {
      subdir,
      payment,
      playlist,
      php,
      tracks,
      designs,
      cardDesigns,
      cardDesignIndexes,
      user,
      eco,
      emptyPages,
      batchNumber,
      startIndex,
      howtoTranslations,
      getYearFontSize,
      // Admin-chosen fonts outside fonts.ts get their weights from the
      // Google catalogue; the fixed list resolves as before.
      getGoogleFontWeights: await GoogleFonts.getInstance().weightsHelperForFonts(
        designs.map((design: any) => design.selectedFont)
      ),
      getGoogleFontName,
      getFontWeight,
      getQrTotalModules,
    };

    // A stored template (src/cardTemplates.ts) at the version the order
    // line pinned; any other name must be a views/pdf_<name>.ejs file.
    const stored = await CardTemplates.getInstance().forRender(
      template,
      template === php.orderTemplate ? php.orderTemplateVersion : null
    );
    if (stored) {
      try {
        await sendStoredPage(
          reply,
          stored,
          {
            php,
            designs,
            cardDesignIndexes,
            tracks,
            subdir,
            eco,
            startIndex,
            batchNumber,
            apiUri: process.env['API_URI'] as string,
          },
          view
        );
      } catch (error) {
        if (!(error instanceof CardTemplateError)) throw error;
        logger.log(color.red.bold(`Card template ${template} v${stored.version}: ${error.message}`));
        reply.status(500).send({ error: `card template ${template}: ${error.message}` });
      }
      return;
    }
    if (!TEMPLATE_NAME.test(template) || !isFileTemplate(template)) {
      reply.status(404).send({ error: 'Unknown template' });
      return;
    }
    await reply.view(`pdf_${template}.ejs`, view);
  }

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
}
