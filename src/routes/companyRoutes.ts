import { DELIVERY_FIELDS, pickDeliveryFields } from '../deliveryAddress';
import { FastifyInstance } from 'fastify';
import Business from '../business';
import Bookkeeping from '../bookkeeping';
import PrismaInstance from '../prisma';
import Translation from '../translation';
import Data from '../data';
import {
  getSuggestionArtwork,
  parsePlaylistSuggestionOptions,
  playlistSuggestionQuery,
  suggestionArtPath,
} from '../playlistSuggestions';
import {
  quotationVatContext,
  normalizeCountryIso,
  resolveVatRegion,
} from '../services/vat';
import Cache from '../cache';
import { isSignedRenderRequest, signedRenderQuery } from '../renderSignature';
import {
  ListVariant,
  listPricingFromCalculation,
  listPricingTotals,
  listPrinterVariant,
} from '../listPricing';
import {
  ListInvoices,
  blockingInvoice,
  companyCustomerKey,
  findListInvoices,
  invoiceExclVat,
  recordListInvoice,
} from '../listInvoices';
import { markListSold } from '../businessSales';
import {
  PRICE_LIST_EDITIONS,
  PriceListEdition,
  PriceListError,
  assertProfitTable,
  buildPriceList,
  priceListQuery,
  resolveProfitMatrix,
  verifyPriceListSignature,
} from '../priceList';
import { BUSINESS_OPTION_PRICES, businessContactEmail } from '../businessOptions';
import { shippingLineText } from '../businessShipping';

export default async function companyRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const business = Business.getInstance();
  const bookkeeping = Bookkeeping.getInstance();
  const translation = new Translation();
  const data = Data.getInstance();


  // Pull the optional order metrics (sent along by the calculators) out of a
  // calculation save body. Only returns the fields that were provided.
  const extractCalculationMetrics = (
    body: any
  ): { numberOfBoxes?: number; buyPrice?: number | null; sellPrice?: number | null } => {
    const metrics: {
      numberOfBoxes?: number;
      buyPrice?: number | null;
      sellPrice?: number | null;
    } = {};
    if (body?.numberOfBoxes !== undefined) {
      const n = Number(body.numberOfBoxes);
      if (Number.isFinite(n) && n >= 0) metrics.numberOfBoxes = Math.round(n);
    }
    for (const field of ['buyPrice', 'sellPrice'] as const) {
      if (body?.[field] !== undefined) {
        if (body[field] === null) {
          metrics[field] = null;
        } else {
          const n = Number(body[field]);
          if (Number.isFinite(n)) metrics[field] = Math.round(n * 100) / 100;
        }
      }
    }
    return metrics;
  };

  // The Sell column has to show what the invoice will add up to, so when the
  // calculator sent a price snapshot the sell price is taken from it rather
  // than from the client's own sum.
  const calculationMetrics = (body: any, calculation: unknown) => {
    const metrics = extractCalculationMetrics(body);
    if (typeof calculation === 'string') {
      const pricing = listPricingFromCalculation(calculation);
      if (pricing) metrics.sellPrice = listPricingTotals(pricing).total;
    }
    return metrics;
  };

  const parseVariant = (value: unknown): ListVariant | null =>
    value === 'qrsong' || value === 'schneider' ? value : null;

  // ============================================
  // Bookkeeping (MoneyBird) — invoice creation
  // ============================================

  // The list's existing MoneyBird invoices per payment option ('full' |
  // 'down' | 'remaining', null when not created), plus what each option
  // would invoice (excl. VAT), so the admin sees the amounts before creating
  // anything. `?type=` picks the price variant, default the list's printer.
  fastify.get(
    '/business/companies/:companyId/lists/:listId/invoices',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const listId = parseInt(request.params.listId);
        if (isNaN(companyId) || isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid company or list ID' });
          return;
        }
        const prisma = PrismaInstance.getInstance();
        const list: any = await (prisma as any).companyList.findUnique({
          where: { id: listId },
          select: { id: true, name: true, companyId: true, printer: true },
        });
        if (!list || list.companyId !== companyId) {
          reply.status(404).send({ error: 'List not found' });
          return;
        }
        const company = await (prisma as any).company.findUnique({
          where: { id: companyId },
          select: { locale: true },
        });
        const variant: ListVariant =
          parseVariant(request.query?.type) || listPrinterVariant(list.printer);

        const status = await bookkeeping.getStatus();
        let invoices: ListInvoices = { full: null, down: null, remaining: null };
        if (status.connected) {
          const references = await business.buildInvoiceReferences(
            list.name,
            company?.locale
          );
          invoices = await findListInvoices({ listId, companyId, references });
        }

        const built = await business.buildInvoiceLineItems(
          companyId,
          listId,
          variant,
          'full',
          { downPaymentExclVat: invoiceExclVat(invoices.down) }
        );

        reply.send({
          connected: status.connected,
          ...invoices,
          pricing: built.success
            ? {
                subtotal: built.totals!.subtotal,
                // Part of the subtotal; the discount is never taken of it.
                shippingTotal: built.totals!.shippingTotal,
                discountPercent: built.pricing!.discountPercent,
                discountAmount: built.totals!.discountAmount,
                total: built.totals!.total,
                amounts: built.amounts,
              }
            : null,
          pricingError: built.success ? null : built.error,
        });
      } catch (error: any) {
        console.error('Error listing invoices:', error?.message || error);
        reply.status(500).send({ error: 'Failed to list invoices' });
      }
    }
  );

  // Stream a sales invoice PDF from the bookkeeping provider.
  fastify.get(
    '/business/sales-invoices/:invoiceId/pdf',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const invoiceId = request.params.invoiceId;
        if (!invoiceId) {
          reply.status(400).send({ error: 'Missing invoice ID' });
          return;
        }
        const status = await bookkeeping.getStatus();
        if (!status.connected) {
          reply.status(409).send({
            error: 'Bookkeeping provider not connected',
            reason: status.reason,
          });
          return;
        }
        const buf = await bookkeeping.downloadInvoicePdf(invoiceId);
        reply
          .header('Content-Type', 'application/pdf')
          .header(
            'Content-Disposition',
            `attachment; filename="invoice-${invoiceId}.pdf"`
          )
          .send(buf);
      } catch (error: any) {
        const status = error?.response?.status || 500;
        console.error('Error downloading invoice PDF:', error?.message || error);
        reply.status(status).send({ error: 'Failed to download PDF' });
      }
    }
  );

  // Create a sales invoice from a list's quotation values.
  // body: { type: 'qrsong' | 'schneider', paymentOption: 'full' | 'down' | 'remaining' }
  fastify.post(
    '/business/companies/:companyId/lists/:listId/invoice',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const listId = parseInt(request.params.listId);
        if (isNaN(companyId) || isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid company or list ID' });
          return;
        }
        const { type, paymentOption } = request.body || {};
        const t = parseVariant(type);
        if (!t) {
          reply.status(400).send({ error: 'Unknown price variant' });
          return;
        }
        const po =
          paymentOption === 'down' || paymentOption === 'remaining'
            ? paymentOption
            : 'full';

        const status = await bookkeeping.getStatus();
        if (!status.connected) {
          reply.status(409).send({
            error: 'Bookkeeping provider not connected',
            reason: status.reason,
          });
          return;
        }

        const prisma = PrismaInstance.getInstance();
        const listRow: any = await (prisma as any).companyList.findUnique({
          where: { id: listId },
          select: { id: true, name: true, companyId: true },
        });
        if (!listRow || listRow.companyId !== companyId) {
          reply.status(404).send({ error: 'List not found' });
          return;
        }
        const companyRow = await (prisma as any).company.findUnique({
          where: { id: companyId },
          select: { locale: true },
        });
        const refs = await business.buildInvoiceReferences(
          listRow.name,
          companyRow?.locale
        );

        // The dialog greys out options that are taken, but a second tab or
        // a double click must not bill the customer twice either.
        const existing = await findListInvoices({
          listId,
          companyId,
          references: refs,
        });
        const blocking = blockingInvoice(existing, po);
        if (blocking) {
          reply.status(409).send({
            error: `This list already has an invoice that covers this payment (${blocking.invoice_id || blocking.reference || blocking.id}).`,
            existing,
          });
          return;
        }

        // The final instalment is the total minus the down payment as it was
        // actually invoiced, so the two add up even if the price or the down
        // payment changed in between.
        const downPaymentExclVat = invoiceExclVat(existing.down);
        if (po === 'remaining' && existing.down && downPaymentExclVat == null) {
          reply.status(502).send({
            error: 'Could not read the amount of the down payment invoice from MoneyBird',
          });
          return;
        }

        const built = await business.buildInvoiceLineItems(
          companyId,
          listId,
          t,
          po,
          { downPaymentExclVat }
        );
        if (!built.success || !built.items || !built.company) {
          reply.status(400).send({
            error: built.error || 'Could not build invoice items',
            code: built.code,
          });
          return;
        }

        const company = built.company as any;

        // The quotation shows reverse charge (EU) or 0% export (world) for
        // non-domestic companies; without an explicit rate createInvoice
        // falls back to the standard 21% NL rate and the finalized invoice
        // would contradict the signed quotation. Fail loudly when MoneyBird
        // has no matching 0% rate rather than booking the wrong VAT.
        const invoiceVatRegion = resolveVatRegion(company.countrycode);
        if (invoiceVatRegion !== 'nl') {
          const zeroRateId = await bookkeeping.findTaxRateId({
            percentage: 0,
            countryCode:
              normalizeCountryIso(company.countrycode) || undefined,
          });
          if (!zeroRateId) {
            reply.status(409).send({
              error: `No 0% tax rate configured in MoneyBird for ${company.countrycode}`,
            });
            return;
          }
          built.items = built.items.map((it: any) => ({
            ...it,
            tax_rate_id: zeroRateId,
          }));
        }

        const fullName = (company.contact || '').trim();
        const [firstname, ...rest] = fullName.split(/\s+/);
        const lastname = rest.join(' ').trim();

        // The line items came back rendered in the company's business
        // language; MoneyBird's own labels follow the same one.
        const invoiceLocale = translation.resolveBusinessLocale(
          built.locale || company.locale
        );

        const contactPayload = {
          company_name: company.name,
          firstname: firstname || undefined,
          lastname: lastname || undefined,
          address1:
            [company.address, company.housenumber].filter(Boolean).join(' ') ||
            undefined,
          zipcode: company.zipcode || undefined,
          city: company.city || undefined,
          country: (company.countrycode || '').toUpperCase() || undefined,
          phone: company.contactphone || undefined,
          send_invoices_to_email: company.contactemail || undefined,
          send_estimates_to_email: company.contactemail || undefined,
          language: invoiceLocale,
        };

        const contact = await bookkeeping.findOrCreateContact(
          companyCustomerKey(company.id),
          contactPayload
        );
        if (!contact?.id) {
          reply
            .status(500)
            .send({ error: 'Failed to create or find bookkeeping contact' });
          return;
        }

        const reference =
          po === 'down' ? refs.down : po === 'remaining' ? refs.remaining : refs.full;

        const draft = await bookkeeping.createInvoice({
          contactId: contact.id,
          reference,
          invoiceDate: new Date().toISOString().slice(0, 10),
          items: built.items,
          language: invoiceLocale,
        });

        // Finalize so the invoice is no longer in "Concept" state.
        // If finalize fails, fall back to the draft so the admin still sees
        // the result (they can manually book it in MoneyBird).
        const finalized =
          draft?.id != null ? await bookkeeping.finalizeInvoice(draft.id) : null;
        const invoice = finalized || draft;

        // By id, so it is found again whatever happens to the list's name or
        // the company's language. A draft whose finalize failed counts too:
        // it exists in MoneyBird.
        await recordListInvoice(listId, po, invoice);

        reply.send({
          success: true,
          invoice,
          contact: { id: contact.id, company_name: contact.company_name },
        });
      } catch (error: any) {
        console.error(
          'Invoice creation error:',
          error?.response?.data || error
        );
        reply.status(500).send({
          error: 'Failed to create invoice',
          details: error?.response?.data || error?.message,
        });
      }
    }
  );

  // Get all companies
  fastify.get(
    '/business/companies',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        // Pass user groups to filter companies based on onlyForAdmin flag
        const result = await business.getAllCompanies(request.user?.userGroups);

        if (!result.success) {
          reply.status(500).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error retrieving all companies:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Update company list
  fastify.put(
    '/business/companies/:companyId/lists/:listId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const listId = parseInt(request.params.listId);

        if (isNaN(companyId) || isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid company or list ID' });
          return;
        }

        const result = await business.updateCompanyList(companyId, listId, request);

        if (!result || !result.success) {
          let statusCode = 500;
          if (result.error === 'Company list not found') {
            statusCode = 404;
          } else if (result.error === 'List does not belong to this company') {
            statusCode = 403;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error updating company list:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get users by company
  fastify.get(
    '/business/users/:companyId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await business.getUsersByCompany(companyId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company not found') {
            statusCode = 404;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true, users: result.users });
      } catch (error) {
        console.error('Error retrieving users for company:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Update company
  fastify.put(
    '/business/companies/:companyId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const {
        name,
        followUp,
        onlyForAdmin,
        excludeFromMailing,
        address,
        housenumber,
        city,
        zipcode,
        countrycode,
        contact,
        contactemail,
        contactphone,
        locale,
        message,
      } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }
      if (!name) {
        reply.status(400).send({ error: 'Missing required field: name' });
        return;
      }

      const result = await business.updateCompany(companyId, {
        name,
        followUp,
        onlyForAdmin,
        excludeFromMailing:
          typeof excludeFromMailing === 'boolean' ? excludeFromMailing : undefined,
        address,
        housenumber,
        city,
        zipcode,
        countrycode,
        contact,
        contactemail,
        contactphone,
        locale,
        message,
        // Only the delivery fields that are in the body; others stay as they are.
        ...pickDeliveryFields(request.body || {}),
      });

      if (!result.success) {
        let statusCode = 500;
        if (result.error === 'Company not found') {
          statusCode = 404;
        }
        reply.status(statusCode).send({ error: result.error });
        return;
      }

      reply.send({ success: true, company: result.data.company });
    }
  );

  // Get list-level calculation with fallback to company-level.
  // ?variant=tromp|schneider (lists are priced by Tromp or Schneider).
  fastify.get(
    '/business/companies/:companyId/lists/:listId/calculation',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const variant = request.query?.variant as string;

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      if (!['tromp', 'schneider'].includes(variant)) {
        reply.status(400).send({ error: 'Invalid variant' });
        return;
      }

      if (
        request.user.userGroups.includes('companyadmin') &&
        request.user.companyId !== companyId
      ) {
        reply.status(403).send({ error: 'Forbidden' });
        return;
      }

      const listColumn =
        variant === 'tromp' ? 'calculationTromp' : 'calculationSchneider';

      const prisma = PrismaInstance.getInstance();
      const list = await prisma.companyList.findUnique({
        where: { id: listId },
        select: {
          id: true,
          companyId: true,
          numberOfCards: true,
          numberOfBoxes: true,
          calculationTromp: true,
          calculationSchneider: true,
        },
      });

      if (!list || list.companyId !== companyId) {
        reply.status(404).send({ error: 'List not found' });
        return;
      }

      const numberOfCards = list.numberOfCards;
      const numberOfBoxes = list.numberOfBoxes;

      const listValue = (list as any)[listColumn] as string | null;
      if (listValue) {
        reply.send({
          success: true,
          source: 'list',
          calculation: listValue,
          numberOfCards,
          numberOfBoxes,
        });
        return;
      }

      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: {
          calculationTromp: true,
          calculationSchneider: true,
        },
      });

      const companyValue = company ? ((company as any)[listColumn] as string | null) : null;
      if (companyValue) {
        reply.send({
          success: true,
          source: 'company',
          calculation: companyValue,
          numberOfCards,
          numberOfBoxes,
        });
        return;
      }

      reply.send({
        success: true,
        source: 'empty',
        calculation: null,
        numberOfCards,
        numberOfBoxes,
      });
    }
  );

  // Update company list info (JSON). Accepts all non-design editable fields.
  fastify.put(
    '/business/companies/:companyId/lists/:listId/info',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const body = request.body || {};

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      const requiredStringFields = ['name', 'slug'] as const;
      const descriptionFields = Translation.ALL_LOCALES.map(
        (code) => `description_${code}`
      );
      const optionalStringFields = [
        'playlistSource',
        'playlistUrl',
        'languages',
        'musicWishes',
        'designResponsibility',
        'gameExplanation',
        'approverName',
        'specialNotes',
        'internalNotes',
        'printer',
        ...DELIVERY_FIELDS,
        ...descriptionFields,
      ];
      const numberFields = [
        'numberOfTracks',
        'minimumNumberOfTracks',
        'numberOfCards',
        'numberOfBoxes',
      ] as const;
      const dateFields = [
        'startAt',
        'endAt',
        'meetingDate',
        'desiredDeliveryDate',
      ] as const;
      const booleanFields = [
        'showNames',
        'qrvote',
        'addBirthdayNumber1',
        'hideBirthdayNumber1',
        'personalizedApp',
        'useCompanyDeliveryAddress',
        'deliveryAsap',
      ] as const;

      const allowedStatuses = [
        'new',
        'company',
        'questions',
        'box',
        'card',
        'playlist',
        'personalize',
        'generating_pdf',
        'pdf_complete',
        'spotify_list_generated',
        'submitted',
        'production',
        'open',
        'closed',
        'draft',
      ];

      const updateData: Record<string, any> = {};

      if (body.status !== undefined) {
        if (
          typeof body.status !== 'string' ||
          !allowedStatuses.includes(body.status)
        ) {
          reply.status(400).send({ error: 'Invalid status value' });
          return;
        }
        updateData['status'] = body.status;
      }

      for (const field of requiredStringFields) {
        if (body[field] !== undefined) {
          if (typeof body[field] !== 'string' || !body[field].trim()) {
            reply.status(400).send({ error: `${field} must be a non-empty string` });
            return;
          }
          updateData[field] = body[field].trim();
        }
      }

      // Lists are printed by Tromp ('qrsong') or Schneider.
      if (body.printer !== undefined && !parseVariant(body.printer)) {
        reply.status(400).send({ error: 'Invalid printer' });
        return;
      }

      for (const field of optionalStringFields) {
        if (body[field] !== undefined) {
          if (body[field] === null) {
            updateData[field] = null;
          } else if (typeof body[field] === 'string') {
            updateData[field] = body[field];
          } else {
            reply.status(400).send({ error: `${field} must be a string or null` });
            return;
          }
        }
      }

      for (const field of numberFields) {
        if (body[field] !== undefined) {
          if (body[field] === null) {
            updateData[field] = null;
          } else {
            const n = Number(body[field]);
            if (!Number.isFinite(n) || n < 0) {
              reply.status(400).send({ error: `${field} must be a non-negative number` });
              return;
            }
            updateData[field] = Math.round(n);
          }
        }
      }

      for (const field of dateFields) {
        if (body[field] !== undefined) {
          if (body[field] === null || body[field] === '') {
            updateData[field] = null;
          } else {
            const d = new Date(body[field]);
            if (isNaN(d.getTime())) {
              reply.status(400).send({ error: `${field} must be a valid date` });
              return;
            }
            updateData[field] = d;
          }
        }
      }

      for (const field of booleanFields) {
        if (body[field] !== undefined) {
          updateData[field] = Boolean(body[field]);
        }
      }

      // The voting page's button colours (#rrggbb).
      for (const field of ['buttonBackgroundColor', 'buttonTextColor'] as const) {
        if (body[field] !== undefined) {
          if (typeof body[field] !== 'string' || !/^#[0-9a-f]{6}$/i.test(body[field])) {
            reply.status(400).send({ error: `${field} must be a colour like #1a2b3c` });
            return;
          }
          updateData[field] = body[field].toLowerCase();
        }
      }

      if (Object.keys(updateData).length === 0) {
        reply.status(400).send({ error: 'No fields to update' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const list = await prisma.companyList.findUnique({ where: { id: listId } });
      if (!list || list.companyId !== companyId) {
        reply.status(404).send({ error: 'List not found' });
        return;
      }

      if (updateData.slug && updateData.slug !== list.slug) {
        const existing = await prisma.companyList.findFirst({
          where: { slug: updateData.slug, NOT: { id: listId } },
        });
        if (existing) {
          reply.status(409).send({ error: 'Slug already in use' });
          return;
        }
      }

      const updated = await prisma.companyList.update({
        where: { id: listId },
        data: updateData,
      });

      // The voting page caches the list; a renamed slug leaves the old copies too.
      await business.clearCompanyListCache(list.slug);
      if (updated.slug !== list.slug) await business.clearCompanyListCache(updated.slug);

      reply.send({ success: true, list: updated });
    }
  );

  // The Lists tab's "Sold" toggle: a sold list counts as a business sale in
  // the financial reports (src/businessSales.ts). Body: { sold, soldAt? },
  // soldAt as YYYY-MM-DD. Admin only, it moves the books.
  fastify.put(
    '/business/companies/:companyId/lists/:listId/sold',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const body = request.body || {};

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }
      if (typeof body.sold !== 'boolean') {
        reply.status(400).send({ error: 'sold must be true or false' });
        return;
      }
      if (body.soldAt != null && typeof body.soldAt !== 'string') {
        reply.status(400).send({ error: 'Invalid sold date' });
        return;
      }

      const result = await markListSold(companyId, listId, body.sold, body.soldAt);
      if (!result.success) {
        reply.status(result.status).send({ error: result.error });
        return;
      }
      reply.send(result);
    }
  );

  // Helper to verify a list belongs to a company; replies with 404 and
  // returns null when it doesn't.
  const findCompanyList = async (
    companyId: number,
    listId: number,
    reply: any
  ): Promise<any | null> => {
    if (isNaN(companyId) || isNaN(listId)) {
      reply.status(400).send({ error: 'Invalid company or list ID' });
      return null;
    }
    const prisma = PrismaInstance.getInstance();
    const list = await prisma.companyList.findUnique({ where: { id: listId } });
    if (!list || list.companyId !== companyId) {
      reply.status(404).send({ error: 'List not found' });
      return null;
    }
    return list;
  };

  // ---- Delivery addresses ----

  // Get delivery addresses for a list
  fastify.get(
    '/business/companies/:companyId/lists/:listId/delivery-addresses',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const prisma = PrismaInstance.getInstance();
      const addresses = await (prisma as any).companyListDeliveryAddress.findMany({
        where: { companyListId: listId },
        orderBy: { id: 'asc' },
      });
      reply.send({ success: true, addresses });
    }
  );

  // Create delivery address
  fastify.post(
    '/business/companies/:companyId/lists/:listId/delivery-addresses',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const { name, address, country } = request.body || {};
      if (!name?.trim() || !address?.trim() || !country?.trim()) {
        reply
          .status(400)
          .send({ error: 'name, address and country are required' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const created = await (prisma as any).companyListDeliveryAddress.create({
        data: {
          companyListId: listId,
          name: name.trim(),
          address: address.trim(),
          country: country.trim(),
        },
      });
      reply.status(201).send({ success: true, address: created });
    }
  );

  // Update delivery address
  fastify.put(
    '/business/companies/:companyId/lists/:listId/delivery-addresses/:addressId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const addressId = parseInt(request.params.addressId);
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const prisma = PrismaInstance.getInstance();
      const existing = await (prisma as any).companyListDeliveryAddress.findUnique({
        where: { id: addressId },
      });
      if (!existing || existing.companyListId !== listId) {
        reply.status(404).send({ error: 'Delivery address not found' });
        return;
      }

      const { name, address, country } = request.body || {};
      if (!name?.trim() || !address?.trim() || !country?.trim()) {
        reply
          .status(400)
          .send({ error: 'name, address and country are required' });
        return;
      }

      const updated = await (prisma as any).companyListDeliveryAddress.update({
        where: { id: addressId },
        data: {
          name: name.trim(),
          address: address.trim(),
          country: country.trim(),
        },
      });
      reply.send({ success: true, address: updated });
    }
  );

  // Delete delivery address
  fastify.delete(
    '/business/companies/:companyId/lists/:listId/delivery-addresses/:addressId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const addressId = parseInt(request.params.addressId);
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const prisma = PrismaInstance.getInstance();
      const existing = await (prisma as any).companyListDeliveryAddress.findUnique({
        where: { id: addressId },
      });
      if (!existing || existing.companyListId !== listId) {
        reply.status(404).send({ error: 'Delivery address not found' });
        return;
      }

      await (prisma as any).companyListDeliveryAddress.delete({
        where: { id: addressId },
      });
      reply.send({ success: true });
    }
  );

  // A list's design files are in the asset store now (CompanyFile with
  // companyListId, routes/businessRoutes.ts). The company_list_files table is
  // left in place and unread.

  // ---- Order e-mail ----

  // Build the printer order e-mail (Dutch) for a list
  fastify.get(
    '/business/companies/:companyId/lists/:listId/order-email',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      const result = await business.getOrderEmail(companyId, listId);
      if (!result.success) {
        reply
          .status(result.error === 'List not found' ? 404 : 500)
          .send({ error: result.error });
        return;
      }
      reply.send({ success: true, email: result.data });
    }
  );

  // Toggle the favorite flag on a company
  fastify.put(
    '/business/companies/:companyId/favorite',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const company = await prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!company) {
        reply.status(404).send({ error: 'Company not found' });
        return;
      }

      const favorite = Boolean(request.body?.favorite);
      const updated = await (prisma as any).company.update({
        where: { id: companyId },
        data: { favorite },
      });
      reply.send({ success: true, favorite: updated.favorite });
    }
  );

  // Re-download a previously persisted quotation as PDF
  fastify.get(
    '/business/companies/:companyId/quotations/:quotationId/pdf',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const quotationId = parseInt(request.params.quotationId);
      if (isNaN(companyId) || isNaN(quotationId)) {
        reply.status(400).send({ error: 'Invalid company or quotation ID' });
        return;
      }

      const result = await business.getQuotationPDF(
        companyId,
        quotationId,
        request.user.userGroups,
        request.user.companyId
      );

      if (!result.success) {
        const statusCode =
          result.error === 'Forbidden'
            ? 403
            : result.error === 'Quotation not found' ||
                result.error === 'Company not found' ||
                result.error === 'Archived PDF not found'
              ? 404
              : 500;
        reply.status(statusCode).send({ error: result.error });
        return;
      }

      reply.header('Content-Type', 'application/pdf');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`
      );
      reply.send(result.data);
    }
  );

  // Delete a persisted quotation (and its archived PDF)
  fastify.delete(
    '/business/companies/:companyId/quotations/:quotationId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const quotationId = parseInt(request.params.quotationId);
      if (isNaN(companyId) || isNaN(quotationId)) {
        reply.status(400).send({ error: 'Invalid company or quotation ID' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const quotation = await (prisma as any).quotation.findUnique({
        where: { id: quotationId },
      });
      if (!quotation || quotation.companyId !== companyId) {
        reply.status(404).send({ error: 'Quotation not found' });
        return;
      }

      const pdfPath = `${process.env['PRIVATE_DIR']}/quotation/${quotation.quotationNumber}.pdf`;
      try {
        const fsPromisesModule = await import('fs/promises');
        await fsPromisesModule.unlink(pdfPath);
      } catch {
        /* file may already be gone */
      }

      await (prisma as any).quotation.delete({ where: { id: quotationId } });

      reply.send({ success: true });
    }
  );

  // List quotations for a company
  fastify.get(
    '/business/companies/:companyId/quotations',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }
      if (
        request.user.userGroups.includes('companyadmin') &&
        request.user.companyId !== companyId
      ) {
        reply.status(403).send({ error: 'Forbidden' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const quotations = await (prisma as any).quotation.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      });

      reply.send({ success: true, quotations });
    }
  );

  // Aggregate counts for the company detail sidebar
  fastify.get(
    '/business/companies/:companyId/counts',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }
      if (
        request.user.userGroups.includes('companyadmin') &&
        request.user.companyId !== companyId
      ) {
        reply.status(403).send({ error: 'Forbidden' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      // `assets` is the Assets tab's badge: the company's own files, not its lists'.
      const [users, lists, assets, quotations] = await Promise.all([
        prisma.user.count({ where: { companyId } }),
        prisma.companyList.count({ where: { companyId } }),
        prisma.companyFile.count({ where: { companyId, companyListId: null } }),
        (prisma as any).quotation.count({ where: { companyId } }),
      ]);

      reply.send({
        success: true,
        counts: { contacts: users, lists, assets, quotations },
      });
    }
  );

  // Update list-level Tromp calculation
  fastify.put(
    '/business/companies/:companyId/lists/:listId/calculation-tromp',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const { calculationTromp } = request.body || {};

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const list = await prisma.companyList.findUnique({ where: { id: listId } });
      if (!list || list.companyId !== companyId) {
        reply.status(404).send({ error: 'List not found' });
        return;
      }

      const updated = await prisma.companyList.update({
        where: { id: listId },
        data: {
          calculationTromp,
          ...calculationMetrics(request.body, calculationTromp),
        },
      });

      reply.send({ success: true, list: updated });
    }
  );

  // Update list-level Schneider calculation
  fastify.put(
    '/business/companies/:companyId/lists/:listId/calculation-schneider',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const { calculationSchneider } = request.body || {};

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const list = await prisma.companyList.findUnique({ where: { id: listId } });
      if (!list || list.companyId !== companyId) {
        reply.status(404).send({ error: 'List not found' });
        return;
      }

      const updated = await prisma.companyList.update({
        where: { id: listId },
        data: {
          calculationSchneider,
          ...calculationMetrics(request.body, calculationSchneider),
        },
      });

      reply.send({ success: true, list: updated });
    }
  );

  // Quotation HTML View (for PDF generation, signed: see renderSignature.ts)
  fastify.get(
    '/business/quotation/:type/:companyId/:quotationNumber',
    async (request: any, reply: any) => {
      if (!isSignedRenderRequest('quotation', request)) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      try {
        const type = request.params.type; // 'qrsong' (Tromp) or 'schneider'
        const companyId = parseInt(request.params.companyId);
        const quotationNumber = request.params.quotationNumber;

        if (type !== 'qrsong' && type !== 'schneider') {
          reply.status(404).send({ error: 'Unknown quotation type' });
          return;
        }

        // Extract pricing options from query parameters
        const isReseller = request.query.isReseller === 'true';
        const listIdParam = request.query.listId
          ? parseInt(request.query.listId)
          : null;
        const contactUserIdParam = request.query.contactUserId
          ? parseInt(request.query.contactUserId)
          : null;
        let profitMargins = null;
        let calculatedPrices = null;

        if (request.query.profitMargins) {
          try {
            profitMargins = JSON.parse(request.query.profitMargins);
          } catch (e) {
            console.error('Error parsing profitMargins:', e);
          }
        }

        if (request.query.calculatedPrices) {
          try {
            calculatedPrices = JSON.parse(request.query.calculatedPrices);
          } catch (e) {
            console.error('Error parsing calculatedPrices:', e);
          }
        }

        // Get company data directly from database - pass ['admin'] to include onlyForAdmin companies
        const companiesResult = await business.getAllCompanies(['admin']);
        const companies = companiesResult.data.companies;
        const storedCompany = companies.find((c: any) => c.id === companyId);

        if (!storedCompany) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // The quotation can be addressed to one of the company's contacts
        // (a user linked to the company). The template prints the contact
        // block from company.contact / contactemail / contactphone, so the
        // chosen contact overrides those on a copy; without a valid contact
        // the company's own stored contact fields are printed as before.
        const company = { ...storedCompany };
        if (contactUserIdParam && !isNaN(contactUserIdParam)) {
          try {
            const prisma = PrismaInstance.getInstance();
            const contactUser = await prisma.user.findFirst({
              where: { id: contactUserIdParam, companyId },
              select: { displayName: true, email: true, phone: true },
            });
            if (contactUser) {
              company.contact = contactUser.displayName || contactUser.email;
              company.contactemail = contactUser.email;
              company.contactphone =
                contactUser.phone || storedCompany.contactphone || null;
            }
          } catch (e) {
            console.error('Error loading quotation contact:', e);
          }
        }

        // Lambda screenshots this route to produce the PDF and carries no
        // session, so the language arrives in the query string; a direct visit
        // falls back to the company's own language.
        const locale = translation.resolveBusinessLocale(
          request.query.locale || company.locale
        );
        const intlTag = translation.getIntlTag(locale);
        const quotationT = await translation.getBusinessTranslator(
          locale,
          'quotation'
        );
        // Extras (die-line drawing, cutting die) are named by the pricing
        // calculators and shared between the quotation and the invoice, so
        // they live under their own prefix.
        const extrasT = await translation.getBusinessTranslator(
          locale,
          'extras'
        );

        // VAT treatment follows the company's country, never its language:
        // NL 21%, intra-EU reverse charge (BTW verlegd), outside the EU 0%.
        const vatContext = quotationVatContext(company.countrycode);

        // The address block shows the country name in the quotation's
        // language, not the stored ISO code; the main locale bundles carry
        // countries.* for every business locale (same map invoice.ejs uses).
        // Unrecognizable legacy values fall back to the stored text.
        const countryNames = await translation.getTranslationsByPrefix(
          locale,
          'countries'
        );
        const companyCountryIso = normalizeCountryIso(company.countrycode);
        const companyCountryName =
          (companyCountryIso && countryNames?.[companyCountryIso]) ||
          company.countrycode ||
          '';

        // If a list was specified, load its per-list calculation so per-list
        // toggles (e.g. includeVotingPortal) override the company defaults.
        let listCalc: {
          name: string;
          calculationTromp: string | null;
          calculationSchneider: string | null;
        } | null = null;
        if (listIdParam && !isNaN(listIdParam)) {
          try {
            const prisma = PrismaInstance.getInstance();
            const list: any = await (prisma as any).companyList.findUnique({
              where: { id: listIdParam },
              select: {
                companyId: true,
                name: true,
                calculationTromp: true,
                calculationSchneider: true,
              },
            });
            if (list && list.companyId === companyId) {
              listCalc = list;
            }
          } catch (e) {
            console.error('Error loading list calculation:', e);
          }
        }

        let calculation: any = {};
        let calculationResult: any = {};
        let productDescription = '';
        let productDetails = '';
        // Set when Tromp sold the list: the quotation is then for our
        // license fee per set, not for boxes, on a single page. The list lives
        // under the Tromp company, so it is addressed to Tromp like any
        // company's.
        let license: { cards: number; list: string } | null = null;

        // The discount belongs to the list, like the rest of its price, and
        // the invoice reads it from there. Tromp and Schneider calculations
        // saved before it moved there have none of their own and keep the
        // company-wide one they were quoted with.
        let companyDiscountPercent = 0;
        if (company.calculation) {
          try {
            const mainCalc = JSON.parse(company.calculation);
            companyDiscountPercent = mainCalc.manualDiscountPercent || 0;
          } catch (e) {
            console.error('Error parsing main calculation for discount:', e);
          }
        }
        const discountOf = (storedCalc: any): number =>
          typeof storedCalc?.manualDiscountPercent === 'number'
            ? storedCalc.manualDiscountPercent
            : companyDiscountPercent;

        if (type === 'qrsong') {
          // Tromp calculation
          calculation = {
            quantity: 100,
            includeStansmestekening: false,
            includeStansvorm: false,
            profitMargin: 0,
            manualDiscountPercent: companyDiscountPercent,
          };

          const trompSource = listCalc?.calculationTromp ?? company.calculationTromp;
          if (trompSource) {
            try {
              const storedCalc = JSON.parse(trompSource);
              calculation = { ...storedCalc, manualDiscountPercent: discountOf(storedCalc) };
            } catch (e) {
              console.error('Error parsing Tromp calculation:', e);
            }
          }

          // Use Business.calculateTrompPricing
          const pricingResult = await business.calculateTrompPricing({
            quantity: calculation.quantity || 100,
            includeStansmestekening: calculation.includeStansmestekening || false,
            includeStansvorm: calculation.includeStansvorm || false,
            includeCustomApp: calculation.includeCustomApp || false,
            includeVotingPortal: calculation.includeVotingPortal || false,
            profitMargin: calculation.profitMargin || 0,
            printingType: calculation.printingType || 'eigen',
          });

          if (pricingResult.success) {
            calculationResult = pricingResult.calculation;
          }

          const licensePricing = listCalc
            ? listPricingFromCalculation(listCalc.calculationTromp)
            : null;
          if (listCalc && licensePricing?.trompSold) {
            license = {
              cards: licensePricing.licenseCards || 200,
              list: listCalc.name,
            };
          }

          // Set product description for Tromp
          if (license) {
            productDescription = quotationT('licenseProduct');
            productDetails = quotationT('licenseProductDetails', {
              cards: license.cards,
              list: license.list,
            });
          } else if (calculation.printingType === 'luxe') {
            productDescription = quotationT('productLuxeBox');
            productDetails = quotationT('productLuxeBoxDetails');
          } else if (calculation.printingType === 'klein') {
            productDescription = quotationT('productCardSet');
            productDetails = quotationT('productSmallBoxDetails');
          } else {
            productDescription = quotationT('productCardSet');
            productDetails = quotationT('productStandardBoxDetails');
          }
        } else {
          // Schneider calculation
          calculation = {
            quantity: 100,
            cardCount: 48,
            includeStansmes: false,
            includeCustomApp: false,
            profitMargin: 0,
            manualDiscountPercent: companyDiscountPercent,
          };

          const schneiderSource = listCalc?.calculationSchneider ?? company.calculationSchneider;
          if (schneiderSource) {
            try {
              const storedCalc = JSON.parse(schneiderSource);
              calculation = { ...storedCalc, manualDiscountPercent: discountOf(storedCalc) };
            } catch (e) {
              console.error('Error parsing Schneider calculation:', e);
            }
          }

          // Use Business.calculateSchneiderPricing. The delivery
          // country and a forced shipping price come from the calculator, so
          // the shipping line matches what it showed.
          const pricingResult = await business.calculateSchneiderPricing({
            quantity: calculation.quantity || 100,
            cardCount: calculation.cardCount || 48,
            includeStansmes: calculation.includeStansmes || false,
            includeCustomApp: calculation.includeCustomApp || false,
            includeVotingPortal: calculation.includeVotingPortal || false,
            profitMargin: calculation.profitMargin || 0,
            deliveryCountry: calculation.deliveryCountry ?? null,
            forceShippingPrice: calculation.forceShippingPrice ?? null,
          });

          if (pricingResult.success) {
            calculationResult = pricingResult.calculation;
            // Map Schneider fields to match Tromp template expectations
            calculationResult.pricePerSet = calculationResult.pricePerBox;
          }

          // Set product description based on card count
          const cardCount = calculation.cardCount || 48;
          productDescription = quotationT('productSchneiderBox', {
            count: cardCount,
          });

          switch (cardCount) {
            case 48:
              productDetails = quotationT('schneider48Details');
              break;
            case 96:
              productDetails = quotationT('schneider96Details');
              break;
            case 144:
              productDetails = quotationT('schneider144Details');
              break;
            case 192:
              productDetails = quotationT('schneider192Details');
              break;
            default:
              productDetails = quotationT('schneiderDefaultDetails', {
                count: cardCount,
              });
          }
        }

        // Date formatting functions, driven by the company's business locale.
        // The BCP47 tag carries the country conventions: de-DE renders
        // 1. September 2026 and 1.234,56, en-GB 1 September 2026 and 1,234.56.
        const formatDate = (date: Date) => {
          const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          };
          return date.toLocaleDateString(intlTag, options);
        };

        const formatCurrency = (value: number) => {
          return new Intl.NumberFormat(intlTag, {
            style: 'currency',
            currency: 'EUR',
          }).format(value);
        };

        // Amount only — the templates print the € sign themselves.
        const formatEuro = (value: number) => {
          return value.toLocaleString(intlTag, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };

        const today = new Date();
        const validUntil = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // One template for Tromp and Schneider.
        const template = 'tromp_quotation.ejs';

        // The shipping extra's line: "Versand nach Deutschland" with
        // "34 Umkartons auf 1 Palette" instead of "one-off cost".
        const describeShipping = (keyVars: Record<string, any> | undefined) =>
          shippingLineText(extrasT, keyVars, countryNames);

        await reply.view(template, {
          locale,
          t: quotationT,
          tExtra: extrasT,
          company,
          calculation,
          calculationResult,
          quotationNumber,
          validUntil,
          formatCurrency,
          formatDate,
          formatEuro,
          baseUrl,
          // New fields for pricing with reseller toggle
          isReseller,
          profitMargins,
          calculatedPrices,
          productDescription,
          productDetails,
          productType: type,
          license,
          vatContext,
          companyCountryName,
          describeShipping,
        });
      } catch (error) {
        console.error('Error rendering quotation view:', error);
        reply.status(500).send({ error: 'Failed to render quotation' });
      }
    }
  );

  // Generate quotation PDF
  fastify.post(
    '/business/quotation/:companyId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {

      try {
        const companyId = parseInt(request.params.companyId);
        const {
          type,
          isReseller,
          profitMargins,
          calculatedPrices,
          listId,
          contactUserId,
        } = request.body; // 'qrsong' (Tromp) or 'schneider'

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }
        if (type !== 'qrsong' && type !== 'schneider') {
          reply.status(400).send({ error: 'Invalid quotation type' });
          return;
        }

        // Call the business logic in the Business class
        const result = await business.generateQuotationPDF(
          companyId,
          request.user.userId,
          request.user.userGroups,
          request.user.companyId,
          type,
          { isReseller, profitMargins, calculatedPrices },
          listId ? Number(listId) : undefined,
          contactUserId ? Number(contactUserId) : undefined
        );

        if (!result.success) {
          const statusCode = result.error?.includes('Forbidden')
            ? 403
            : result.error?.includes('not found')
            ? 404
            : 500;
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        // Set response headers for PDF download
        reply.header('Content-Type', 'application/pdf');
        reply.header(
          'Content-Disposition',
          `attachment; filename="${result.filename}"`
        );

        reply.send(result.data);
      } catch (error) {
        console.error('Error generating quotation:', error);
        reply.status(500).send({ error: 'Failed to generate quotation' });
      }
    }
  );

  // Technical Instructions HTML View (for PDF generation, signed: see renderSignature.ts)
  fastify.get(
    '/business/technical-instructions/:companyId',
    async (request: any, reply: any) => {
      if (!isSignedRenderRequest('technical-instructions', request)) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      try {
        const companyId = parseInt(request.params.companyId);
        const printer = request.query.printer || 'tromp';

        // Get company data - pass ['admin'] to include onlyForAdmin companies
        const companiesResult = await business.getAllCompanies(['admin']);
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // The PDF is rendered by screenshotting this route from Lambda, which
        // carries no session — so the language travels in the query string,
        // with the company's own language as the fallback for direct visits.
        const locale = translation.resolveBusinessLocale(
          request.query.locale || company.locale
        );
        const intlTag = translation.getIntlTag(locale);

        // Date formatting function
        const formatDate = (date: Date) => {
          const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          };
          return date.toLocaleDateString(intlTag, options);
        };

        // Get base URL for assets
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Render the EJS template (matches quotation route pattern)
        await reply.view('technical_instructions.ejs', {
          company,
          baseUrl,
          formatDate,
          printer,
          locale,
          t: await translation.getBusinessTranslator(locale, 'instructions'),
        });
      } catch (error) {
        console.error('Error rendering technical instructions:', error);
        reply.status(500).send({ error: 'Failed to render technical instructions: ' + error });
      }
    }
  );

  // Generate Technical Instructions PDF
  fastify.post(
    '/business/technical-instructions/:companyId',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        // Get company data - pass ['admin'] to include onlyForAdmin companies
        const companiesResult = await business.getAllCompanies(['admin']);
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // Generate PDF using Lambda
        const PDF = require('../pdf').default;
        const pdfManager = new PDF();

        // Prepare file path
        const path = require('path');
        const tempDir = '/tmp';
        const fileName = `technical_instructions_${companyId}_${Date.now()}.pdf`;
        const filePath = path.join(tempDir, fileName);

        // Create the URL for the HTML rendering
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const printer = request.body?.printer || 'tromp';
        const locale = translation.resolveBusinessLocale(company.locale);
        // Signed, because the view itself has no login (renderSignature.ts).
        const htmlUrl = `${baseUrl}/business/technical-instructions/${companyId}?${signedRenderQuery(
          'technical-instructions',
          { companyId: String(companyId) },
          { printer: String(printer), locale }
        )}`;

        // Generate PDF
        await pdfManager.generateFromUrl(htmlUrl, filePath, {
          format: 'a4',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        });

        // Read the generated PDF
        const fs = require('fs').promises;
        const pdfBuffer = await fs.readFile(filePath);

        // Clean up
        await fs.unlink(filePath).catch(() => {});

        // Generate filename for download
        const instructionsT = await translation.getBusinessTranslator(
          locale,
          'instructions'
        );
        const downloadFilename = `${instructionsT('fileName')}_${company.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

        // Set response headers for PDF download
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);

        reply.send(pdfBuffer);
      } catch (error) {
        console.error('Error generating technical instructions PDF:', error);
        reply.status(500).send({ error: 'Failed to generate technical instructions PDF' });
      }
    }
  );

  // Delete company
  fastify.delete(
    '/business/companies/:companyId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await business.deleteCompany(companyId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company not found') {
            statusCode = 404;
          } else if (
            result.error ===
            'Company cannot be deleted because it has associated lists'
          ) {
            statusCode = 409;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting company:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Replace track in submissions
  fastify.post(
    '/business/lists/:companyListId/replace-track',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyListId = parseInt(request.params.companyListId);
        const { sourceTrackId, destinationTrackId } = request.body;

        if (
          isNaN(companyListId) ||
          !sourceTrackId ||
          !destinationTrackId ||
          isNaN(Number(sourceTrackId)) ||
          isNaN(Number(destinationTrackId))
        ) {
          reply.status(400).send({ error: 'Invalid parameters' });
          return;
        }

        const result = await business.replaceTrackInSubmissions(
          companyListId,
          Number(sourceTrackId),
          Number(destinationTrackId)
        );

        if (!result.success) {
          reply.status(500).send({ error: result.error });
          return;
        }

        reply.send({ success: true, updatedCount: result.updatedCount });
      } catch (error) {
        console.error('Error replacing track in submissions:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete submission
  fastify.delete(
    '/business/submissions/:submissionId',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const submissionId = parseInt(request.params.submissionId);

        if (isNaN(submissionId)) {
          reply.status(400).send({ error: 'Invalid submission ID' });
          return;
        }

        // If user is companyadmin, check that the submission belongs to their company
        if (request.user.userGroups.includes('companyadmin')) {
          const belongs = await business.submissionBelongsToCompany(
            submissionId,
            request.user.companyId
          );
          if (!belongs) {
            reply.status(403).send({
              error: 'Forbidden: Submission does not belong to your company',
            });
            return;
          }
        }

        const result = await business.deleteSubmission(submissionId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Submission not found') {
            statusCode = 404;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting submission:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Create company list
  fastify.post(
    '/business/companies/:companyId/lists',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const {
          name,
          description,
          slug,
          numberOfCards,
          numberOfTracks,
          playlistSource,
          playlistUrl,
        } = request.body;

        if (request.user.userGroups.includes('companyadmin')) {
          reply.status(403).send({
            error: 'Forbidden',
          });
          return;
        }

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        if (
          !name ||
          !description ||
          !slug ||
          numberOfCards === undefined ||
          numberOfTracks === undefined
        ) {
          reply.status(400).send({
            error:
              'Missing required fields: name, description, slug, numberOfCards, numberOfTracks',
          });
          return;
        }

        const listData = {
          name,
          description,
          slug,
          numberOfCards: parseInt(numberOfCards),
          numberOfTracks: parseInt(numberOfTracks),
          playlistSource,
          playlistUrl,
        };

        const result = await business.createCompanyList(companyId, listData);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Bedrijf niet gevonden') {
            statusCode = 404;
          } else if (
            result.error === 'Slug bestaat al. Kies een unieke slug.'
          ) {
            statusCode = 409;
          } else if (
            result.error === 'Ongeldig bedrijfs-ID opgegeven' ||
            result.error ===
              'Verplichte velden voor de bedrijfslijst ontbreken' ||
            result.error === 'Ongeldig aantal voor kaarten of nummers'
          ) {
            statusCode = 400;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        const responseData = {
          listId: result.data.list.id,
          list: result.data.list,
        };
        reply.status(201).send(responseData);
      } catch (error) {
        console.error('Error creating company list:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete company list
  fastify.delete(
    '/business/companies/:companyId/lists/:listId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const listId = parseInt(request.params.listId);

        if (isNaN(companyId) || isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid company or list ID' });
          return;
        }

        if (request.user.userGroups.includes('companyadmin')) {
          reply.status(403).send({
            error: 'Forbidden',
          });
          return;
        }

        const result = await business.deleteCompanyList(companyId, listId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company list not found') {
            statusCode = 404;
          } else if (result.error === 'List does not belong to this company') {
            statusCode = 403;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting company list:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Create company
  fastify.post(
    '/business/companies',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const {
          name,
          followUp,
          onlyForAdmin,
          address,
          housenumber,
          city,
          zipcode,
          countrycode,
          contact,
          contactemail,
          contactphone,
          locale,
          message,
        } = request.body;

        if (!name) {
          reply.status(400).send({ error: 'Missing required field: name' });
          return;
        }

        const result = await business.createCompany({
          name,
          followUp,
          onlyForAdmin,
          address,
          housenumber,
          city,
          zipcode,
          countrycode,
          contact,
          contactemail,
          contactphone,
          locale,
          message,
        });

        if (!result.success) {
          const statusCode =
            result.error === 'Company with this name already exists'
              ? 409
              : 500;
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.status(201).send(result.data);
      } catch (error) {
        console.error('Error creating company:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Finalize company list
  fastify.post(
    '/business/finalize',
    getAuthHandler(['admin']),
    async (request: any, reply) => {
      const { companyListId } = request.body;

      if (!companyListId) {
        return { success: false, error: 'Missing company list ID' };
      }

      return await business.finalizeList(parseInt(companyListId));
    }
  );

  // Get company list state
  fastify.get(
    '/business/state/:listId',
    getAuthHandler(['admin', 'companyadmin', 'qrvoteadmin']),
    async (request: any, reply: any) => {
      try {
        const listId = parseInt(request.params.listId);

        const result = await business.getState(listId);

        if (!result.success) {
          reply.status(404).send({ error: result.error });
          return;
        }

        // The state includes the voters' names and e-mail addresses: anyone
        // but an admin only gets a list of their own company.
        if (
          !request.user.userGroups.includes('admin') &&
          result.data.list?.companyId !== request.user.companyId
        ) {
          reply.status(403).send({
            error: 'Forbidden: List does not belong to your company',
          });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error retrieving company state:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get company lists
  fastify.get(
    '/business/company/:companyId',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      if (
        request.user.userGroups.includes('companyadmin') &&
        request.user.companyId !== parseInt(request.params.companyId)
      ) {
        reply
          .status(403)
          .send({ error: 'Forbidden: Access to this company is restricted' });
        return;
      }

      try {
        const result = await business.getCompanyLists(
          parseInt(request.params.companyId)
        );

        if (!result.success) {
          reply.status(404).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error retrieving company lists:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Update submission
  fastify.put(
    '/business/submissions/:submissionId',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const submissionId = parseInt(request.params.submissionId);
        if (isNaN(submissionId)) {
          reply.status(400).send({ error: 'Invalid submission ID' });
          return;
        }
        const { cardName } = request.body;
        if (typeof cardName !== 'string' || cardName.trim() === '') {
          reply.status(400).send({
            error: 'cardName is required and must be a non-empty string',
          });
          return;
        }

        // If user is companyadmin, check that the submission belongs to their company
        if (request.user.userGroups.includes('companyadmin')) {
          const belongs = await business.submissionBelongsToCompany(
            submissionId,
            request.user.companyId
          );
          if (!belongs) {
            reply.status(403).send({
              error: 'Forbidden: Submission does not belong to your company',
            });
            return;
          }
        }

        const result = await business.updateSubmission(submissionId, { cardName });
        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Submission not found') {
            statusCode = 404;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }
        reply.send({ success: true, data: result.data });
      } catch (error) {
        console.error('Error updating submission:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Verify submission
  fastify.put(
    '/business/submissions/:submissionId/verify',
    getAuthHandler(['admin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const submissionId = parseInt(request.params.submissionId);
        if (isNaN(submissionId)) {
          reply.status(400).send({ error: 'Invalid submission ID' });
          return;
        }

        // If user is companyadmin, check that the submission belongs to their company
        if (request.user.userGroups.includes('companyadmin')) {
          const belongs = await business.submissionBelongsToCompany(
            submissionId,
            request.user.companyId
          );
          if (!belongs) {
            reply.status(403).send({
              error: 'Forbidden: Submission does not belong to your company',
            });
            return;
          }
        }

        const result = await business.verifySubmission(submissionId);
        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Submission not found') {
            statusCode = 404;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }
        reply.send({ success: true, data: result.data });
      } catch (error) {
        console.error('Error verifying submission:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Pricing tables profit-margin config (Redis-backed, shared across browsers/users).
  // Stores the same shape the frontend used to keep in localStorage:
  //   { profitMatrix: ProfitMatrix, defaultProfits: Record<string, ProfitEntry> }
  fastify.get(
    '/business/pricing-tables/profit-config',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      try {
        const cache = Cache.getInstance();
        const [matrixRaw, defaultsRaw] = await Promise.all([
          cache.get('pricing_tables:profit_matrix', false),
          cache.get('pricing_tables:default_profits', false),
        ]);
        reply.send({
          profitMatrix: matrixRaw ? JSON.parse(matrixRaw) : null,
          defaultProfits: defaultsRaw ? JSON.parse(defaultsRaw) : null,
        });
      } catch (error) {
        console.error('Error reading pricing-tables profit config:', error);
        reply.status(500).send({ error: 'Failed to read profit config' });
      }
    }
  );

  fastify.put(
    '/business/pricing-tables/profit-config',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { profitMatrix, defaultProfits } = request.body || {};
        const cache = Cache.getInstance();
        const ops: Promise<void>[] = [];
        if (profitMatrix !== undefined) {
          ops.push(cache.set('pricing_tables:profit_matrix', JSON.stringify(profitMatrix)));
        }
        if (defaultProfits !== undefined) {
          ops.push(cache.set('pricing_tables:default_profits', JSON.stringify(defaultProfits)));
        }
        await Promise.all(ops);
        reply.send({ success: true });
      } catch (error) {
        console.error('Error writing pricing-tables profit config:', error);
        reply.status(500).send({ error: 'Failed to write profit config' });
      }
    }
  );

  // Calculate Tromp pricing (admin only)
  fastify.post(
    '/business/calculate-tromp',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await business.calculateTrompPricing(request.body);

        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send(result);
      } catch (error) {
        console.error('Error calculating Tromp pricing:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Calculate Schneider pricing (admin only). The body goes in as is:
  // quantity, cardCount, includeStansmes, includeCustomApp,
  // includeVotingPortal, profitMargin, and for shipping deliveryCountry and
  // forceShippingPrice (see calculateSchneiderPricing).
  fastify.post(
    '/business/calculate-schneider',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await business.calculateSchneiderPricing(request.body);

        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send(result);
      } catch (error) {
        console.error('Error calculating Schneider pricing:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Business price lists: the brochure view the Lambda prints, one per
  // edition (retail, reseller, client). Unauthenticated because the Lambda
  // carries no session, so the language and the profit matrix travel in the
  // query string, signed by the PDF route (priceListQuery). Without a valid
  // signature anyone could render it with an empty matrix and read the
  // printer's cost per box.
  const renderPriceList =
    (edition: PriceListEdition) => async (request: any, reply: any) => {
      try {
        const query = request.query || {};
        const matrixJson = typeof query.profitMatrix === 'string' ? query.profitMatrix : '';
        const requestedLocale = typeof query.locale === 'string' ? query.locale : '';
        if (!verifyPriceListSignature(edition, requestedLocale, matrixJson, query.sig)) {
          reply.status(403).send({ error: 'Invalid or missing signature' });
          return;
        }

        const locale = translation.resolveBusinessLocale(requestedLocale);
        const intlTag = translation.getIntlTag(locale);
        const t = await translation.getBusinessTranslator(locale, 'pricing');
        // The client edition is an informative brochure without any prices.
        const priceList =
          edition === 'client'
            ? null
            : await buildPriceList(JSON.parse(matrixJson), (params) =>
                business.calculateSchneiderPricing(params)
              );

        const formatCurrency = (value: number) =>
          new Intl.NumberFormat(intlTag, { style: 'currency', currency: 'EUR' }).format(value);
        // The one-off options are whole euros: "€ 350", not "€ 350,00".
        const formatEuros = (value: number) =>
          new Intl.NumberFormat(intlTag, {
            style: 'currency',
            currency: 'EUR',
            maximumFractionDigits: 0,
          }).format(value);
        const formatNumber = (value: number) => new Intl.NumberFormat(intlTag).format(value);
        // German writes 30 % (non-breaking space before the sign).
        const formatPercent = (value: number) =>
          new Intl.NumberFormat(intlTag, {
            style: 'percent',
            maximumFractionDigits: 1,
          }).format(value / 100);
        const formatDate = (date: Date) =>
          new Intl.DateTimeFormat(intlTag, {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }).format(date);

        await reply.view('price_list.ejs', {
          edition,
          locale,
          t,
          priceList,
          options: BUSINESS_OPTION_PRICES,
          contactEmail: businessContactEmail(locale),
          formatCurrency,
          formatEuros,
          formatNumber,
          formatPercent,
          formatDate,
          baseUrl: process.env['API_URI'] || 'http://localhost:3004',
          version: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
        });
      } catch (error) {
        if (error instanceof PriceListError) {
          reply.status(400).send({ error: error.message });
          return;
        }
        console.error(`Error rendering ${edition} price list view:`, error);
        reply.status(500).send({ error: `Failed to render ${edition} price list` });
      }
    };

  // Download name per edition, from the business bundle.
  const PRICE_LIST_FILE_KEYS: Record<PriceListEdition, string> = {
    retail: 'editionRetail',
    reseller: 'editionReseller',
    client: 'fileClient',
  };

  // `locale` is sent by the company Documents tab (the company's own
  // language) and by the pricing-tables page (an explicit choice). Only the
  // pricing-tables page sends a `profitMatrix`, so it can print numbers it
  // has not saved yet; everyone else gets the saved table.
  const priceListPdf =
    (edition: PriceListEdition) => async (request: any, reply: any) => {
      try {
        const { profitMatrix, locale: requestedLocale } = request.body || {};
        const locale = translation.resolveBusinessLocale(requestedLocale);
        // The client edition shows no prices, so it needs no profit table.
        const matrix = edition === 'client' ? {} : await resolveProfitMatrix(profitMatrix);
        if (edition !== 'client') assertProfitTable(matrix);

        const PDF = require('../pdf').default;
        const pdfManager = new PDF();
        const path = require('path');
        const fs = require('fs').promises;
        const filePath = path.join('/tmp', `${edition}_pricing_${Date.now()}.pdf`);

        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const htmlUrl = `${baseUrl}/business/${edition}-pricing?${priceListQuery(edition, locale, matrix)}`;

        // Generate PDF - let CSS @page rules control orientation
        await pdfManager.generateFromUrl(htmlUrl, filePath, {
          format: 'a4',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        });

        const pdfBuffer = await fs.readFile(filePath);

        try {
          await fs.unlink(filePath);
        } catch (unlinkError) {
          console.warn('Failed to delete temp file:', unlinkError);
        }

        const t = await translation.getBusinessTranslator(locale, 'pricing');
        const downloadFilename = `${t(PRICE_LIST_FILE_KEYS[edition]).replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;

        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);

        reply.send(pdfBuffer);
      } catch (error) {
        if (error instanceof PriceListError) {
          reply.status(400).send({ error: error.message });
          return;
        }
        console.error(`Error generating ${edition} price list PDF:`, error);
        reply.status(500).send({ error: `Failed to generate ${edition} price list PDF` });
      }
    };

  for (const edition of PRICE_LIST_EDITIONS) {
    fastify.get(`/business/${edition}-pricing`, renderPriceList(edition));
    fastify.post(`/business/${edition}-pricing/pdf`, getAuthHandler(['admin']), priceListPdf(edition));
  }

  // ============================================
  // Playlist suggestions (featured playlists brochure)
  // ============================================

  // HTML view, screenshotted by Lambda for the PDF. Unauthenticated: the
  // Lambda carries no session, so every filter travels in the query string
  // and is validated by parsePlaylistSuggestionOptions. It shows no prices,
  // so unlike the price lists it needs no signature.
  fastify.get(
    '/business/playlist-suggestions',
    async (request: any, reply: any) => {
      try {
        const parsed = parsePlaylistSuggestionOptions(request.query, translation);
        if (!parsed.ok) {
          reply.status(400).send({ error: parsed.error });
          return;
        }
        const { locale, cardCount } = parsed.opts;
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const intlTag = translation.getIntlTag(locale);

        // Cover and closing page are shared with the price lists and read
        // their labels from `t`. The suggestions bundle overrides the copy
        // that is specific to this document and falls through to `pricing.*`
        // for everything else (edition/version/contact labels, closing page).
        const suggestionsT = await translation.getBusinessTranslator(locale, 'suggestions');
        const pricingT = await translation.getBusinessTranslator(locale, 'pricing');
        const t = (key: string, vars?: Record<string, any>) => {
          const own = suggestionsT(key, vars);
          return own === key ? pricingT(key, vars) : own;
        };

        const formatDate = (date: Date) =>
          new Intl.DateTimeFormat(intlTag, {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }).format(date);
        const formatNumber = (value: number) => new Intl.NumberFormat(intlTag).format(value);

        const truncate = (text: string, max: number): string => {
          const clean = String(text || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (clean.length <= max) return clean;
          const cut = clean.slice(0, max);
          const lastSpace = cut.lastIndexOf(' ');
          return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
        };

        const rows = await data.getPlaylistSuggestions(locale, parsed.opts);
        const playlists = rows.map((p: any) => {
          const numberOfTracks = Number(p.numberOfTracks) || 0;
          return {
            id: p.id,
            playlistId: p.playlistId,
            name: p.name,
            genreName: p.genreName || t('genreUnknown'),
            description: truncate(p.description, 200),
            numberOfTracks,
            showTrackNote: numberOfTracks > cardCount,
            // Small cached JPEG instead of the full-size source, see getSuggestionArtwork.
            imageUrl: p.customImage || p.image ? `${baseUrl}${suggestionArtPath(p.playlistId)}` : null,
            spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
          };
        });

        await reply.view('playlist_suggestions.ejs', {
          locale,
          t,
          playlists,
          cardCount,
          formatDate,
          formatNumber,
          baseUrl,
        });
      } catch (error) {
        console.error('Error rendering playlist suggestions view:', error);
        reply.status(500).send({ error: 'Failed to render playlist suggestions' });
      }
    }
  );

  // Playlist artwork as a small cached JPEG for the brochure. Unauthenticated
  // because the Lambda's Chromium fetches it while rendering the view.
  fastify.get(
    '/business/playlist-suggestions/art/:playlistId',
    async (request: any, reply: any) => {
      try {
        const playlistId = String(request.params.playlistId || '');
        if (!playlistId || playlistId.length > 64) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        const jpeg = await getSuggestionArtwork(playlistId);
        if (!jpeg) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        reply.header('Content-Type', 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=86400');
        reply.send(jpeg);
      } catch (error) {
        console.error('Error serving playlist suggestion artwork:', error);
        reply.status(500).send({ error: 'Failed to load artwork' });
      }
    }
  );

  // Playlist suggestions PDF download
  fastify.post(
    '/business/playlist-suggestions/pdf',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const parsed = parsePlaylistSuggestionOptions(request.body, translation);
        if (!parsed.ok) {
          reply.status(400).send({ error: parsed.error });
          return;
        }

        const PDF = require('../pdf').default;
        const pdfManager = new PDF();
        const path = require('path');
        const fs = require('fs').promises;

        const tempDir = '/tmp';
        const fileName = `playlist_suggestions_${Date.now()}.pdf`;
        const filePath = path.join(tempDir, fileName);

        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const htmlUrl = `${baseUrl}/business/playlist-suggestions?${playlistSuggestionQuery(parsed.opts)}`;

        await pdfManager.generateFromUrl(htmlUrl, filePath, {
          format: 'a4',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        });

        const pdfBuffer = await fs.readFile(filePath);

        try {
          await fs.unlink(filePath);
        } catch (unlinkError) {
          console.warn('Failed to delete temp file:', unlinkError);
        }

        const suggestionsT = await translation.getBusinessTranslator(parsed.opts.locale, 'suggestions');
        const downloadFilename = `${suggestionsT('editionName').replace(/\s+/g, '_')}_${parsed.opts.cardCount}_${new Date().toISOString().slice(0, 10)}.pdf`;

        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);
        reply.send(pdfBuffer);
      } catch (error) {
        console.error('Error generating playlist suggestions PDF:', error);
        reply.status(500).send({ error: 'Failed to generate playlist suggestions PDF' });
      }
    }
  );

  // ============================================
  // Company Events
  // ============================================

  // Get company events
  fastify.get(
    '/business/companies/:companyId/events',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await business.getCompanyEvents(companyId);
        if (!result.success) {
          reply.status(500).send({ error: result.error });
          return;
        }

        reply.send({ success: true, events: result.data });
      } catch (error) {
        console.error('Error getting company events:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Create company event
  fastify.post(
    '/business/companies/:companyId/events',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const userId = request.user.id;
        let content = '';
        let attachmentUrl: string | null = null;

        // Handle multipart form data for file uploads
        const contentType = request.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
          const parts = request.parts();
          for await (const part of parts) {
            if (part.type === 'file' && part.fieldname === 'attachment') {
              // Save the file
              const filename = `event_${companyId}_${Date.now()}_${part.filename}`;
              const uploadDir = `${process.env['PUBLIC_DIR']}/company-events`;
              const fs = require('fs').promises;
              const path = require('path');

              // Ensure directory exists
              await fs.mkdir(uploadDir, { recursive: true });

              const filePath = path.join(uploadDir, filename);
              const buffer = await part.toBuffer();
              await fs.writeFile(filePath, buffer);

              attachmentUrl = `/public/company-events/${filename}`;
            } else if (part.fieldname === 'content') {
              // For non-file fields, use part.value
              content = part.value || '';
            }
          }
        } else {
          // JSON body
          content = request.body.content || '';
        }

        if (!content.trim()) {
          reply.status(400).send({ error: 'Content is required' });
          return;
        }

        const result = await business.createCompanyEvent(companyId, userId, content, attachmentUrl);
        if (!result.success) {
          reply.status(500).send({ error: result.error });
          return;
        }

        reply.send({ success: true, event: result.data });
      } catch (error) {
        console.error('Error creating company event:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Update company event
  fastify.put(
    '/business/companies/:companyId/events/:eventId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const eventId = parseInt(request.params.eventId);
        const { content } = request.body;

        if (isNaN(companyId) || isNaN(eventId)) {
          reply.status(400).send({ error: 'Invalid company or event ID' });
          return;
        }

        if (!content || !content.trim()) {
          reply.status(400).send({ error: 'Content is required' });
          return;
        }

        const result = await business.updateCompanyEvent(companyId, eventId, content);
        if (!result.success) {
          reply.status(result.error === 'Event not found' ? 404 : 500).send({ error: result.error });
          return;
        }

        reply.send({ success: true, event: result.data });
      } catch (error) {
        console.error('Error updating company event:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete company event
  fastify.delete(
    '/business/companies/:companyId/events/:eventId',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const eventId = parseInt(request.params.eventId);

        if (isNaN(companyId) || isNaN(eventId)) {
          reply.status(400).send({ error: 'Invalid company or event ID' });
          return;
        }

        const result = await business.deleteCompanyEvent(companyId, eventId);
        if (!result.success) {
          reply.status(result.error === 'Event not found' ? 404 : 500).send({ error: result.error });
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting company event:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // ============================================
  // Bulk Import Companies from Excel
  // ============================================

  fastify.post(
    '/business/companies/import',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const userId = request.user.id;
        let fileBuffer: Buffer | null = null;

        // Handle multipart form data
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file' && part.fieldname === 'file') {
            fileBuffer = await part.toBuffer();
          }
        }

        if (!fileBuffer) {
          reply.status(400).send({ error: 'No file uploaded' });
          return;
        }

        const result = await business.importCompaniesFromExcel(fileBuffer, userId);
        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send({
          success: true,
          imported: result.data.imported,
          skipped: result.data.skipped,
          usersCreated: result.data.usersCreated,
          errors: result.data.errors,
          details: result.data.details
        });
      } catch (error) {
        console.error('Error importing companies:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // The company asset store (files, quote requests, mail) lives in
  // routes/businessRoutes.ts.
}
