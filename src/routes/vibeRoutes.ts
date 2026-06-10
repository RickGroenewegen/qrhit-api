import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';
import { verifyToken } from '../auth';
import Vibe from '../vibe';
import Mollie from '../mollie';
import Bookkeeping from '../bookkeeping';
import AssetQueue from '../assetQueue';
import PrismaInstance from '../prisma';
import Translation from '../translation';
import Cache from '../cache';
import archiver from 'archiver';
import * as fsPromises from 'fs/promises';
import * as pathModule from 'path';

export default async function vibeRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const vibe = Vibe.getInstance();
  const mollie = new Mollie();
  const bookkeeping = Bookkeeping.getInstance();

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

  // ============================================
  // Bookkeeping (MoneyBird) — invoice creation
  // ============================================

  // Returns { provider, connected, reason? }.
  fastify.get(
    '/vibe/bookkeeping/status',
    getAuthHandler(['admin']),
    async (_request: any, reply: any) => {
      const status = await bookkeeping.getStatus();
      reply.send({ provider: bookkeeping.providerName(), ...status });
    }
  );

  // List existing MoneyBird invoices for a company list, keyed by payment
  // option ('full' | 'down' | 'remaining'). Returns null entries for ones
  // that don't exist yet.
  fastify.get(
    '/vibe/companies/:companyId/lists/:listId/invoices',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const listId = parseInt(request.params.listId);
        if (isNaN(companyId) || isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid company or list ID' });
          return;
        }
        const status = await bookkeeping.getStatus();
        if (!status.connected) {
          reply.send({
            connected: false,
            full: null,
            down: null,
            remaining: null,
          });
          return;
        }
        const prisma = PrismaInstance.getInstance();
        const list: any = await (prisma as any).companyList.findUnique({
          where: { id: listId },
          select: { id: true, name: true, companyId: true },
        });
        if (!list || list.companyId !== companyId) {
          reply.status(404).send({ error: 'List not found' });
          return;
        }
        const refs = {
          full: list.name,
          down: `${list.name} — Aanbetaling 30%`,
          remaining: `${list.name} — Slottermijn 70%`,
        };
        const [full, down, remaining] = await Promise.all([
          bookkeeping.findInvoiceByReference(refs.full),
          bookkeeping.findInvoiceByReference(refs.down),
          bookkeeping.findInvoiceByReference(refs.remaining),
        ]);
        reply.send({ connected: true, full, down, remaining });
      } catch (error: any) {
        console.error('Error listing invoices:', error?.message || error);
        reply.status(500).send({ error: 'Failed to list invoices' });
      }
    }
  );

  // Stream a sales invoice PDF from the bookkeeping provider.
  fastify.get(
    '/vibe/sales-invoices/:invoiceId/pdf',
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
  // body: { type: 'onzevibe' | 'qrsong' | 'schneider', paymentOption: 'full' | 'down' | 'remaining' }
  fastify.post(
    '/vibe/companies/:companyId/lists/:listId/invoice',
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
        const t =
          type === 'qrsong' || type === 'schneider' ? type : 'onzevibe';
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

        const built = await vibe.buildInvoiceLineItems(
          companyId,
          listId,
          t as 'onzevibe' | 'qrsong' | 'schneider',
          po as 'full' | 'down' | 'remaining'
        );
        if (!built.success || !built.items || !built.company) {
          reply
            .status(400)
            .send({ error: built.error || 'Could not build invoice items' });
          return;
        }

        const company = built.company as any;
        const list = built.list as any;

        const fullName = (company.contact || '').trim();
        const [firstname, ...rest] = fullName.split(/\s+/);
        const lastname = rest.join(' ').trim();

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
        };

        const customerKey = `qrhit-${company.id}`;
        const contact = await bookkeeping.findOrCreateContact(
          customerKey,
          contactPayload
        );
        if (!contact?.id) {
          reply
            .status(500)
            .send({ error: 'Failed to create or find bookkeeping contact' });
          return;
        }

        const refSuffix =
          po === 'down'
            ? ' — Aanbetaling 30%'
            : po === 'remaining'
              ? ' — Slottermijn 70%'
              : '';
        const reference = `${list.name}${refSuffix}`;

        const draft = await bookkeeping.createInvoice({
          contactId: contact.id,
          reference,
          invoiceDate: new Date().toISOString().slice(0, 10),
          items: built.items,
        });

        // Finalize so the invoice is no longer in "Concept" state.
        // If finalize fails, fall back to the draft so the admin still sees
        // the result (they can manually book it in MoneyBird).
        const finalized =
          draft?.id != null ? await bookkeeping.finalizeInvoice(draft.id) : null;
        const invoice = finalized || draft;

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
    '/vibe/companies',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        // Pass user groups to filter companies based on onlyForAdmin flag
        const result = await vibe.getAllCompanies(request.user?.userGroups);

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
    '/vibe/companies/:companyId/lists/:listId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const listId = parseInt(request.params.listId);

        if (isNaN(companyId) || isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid company or list ID' });
          return;
        }

        const result = await vibe.updateCompanyList(companyId, listId, request);

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
    '/vibe/users/:companyId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await vibe.getUsersByCompany(companyId);

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
    '/vibe/companies/:companyId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const {
        name,
        test,
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
      } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }
      if (!name) {
        reply.status(400).send({ error: 'Missing required field: name' });
        return;
      }

      const result = await vibe.updateCompany(companyId, {
        name,
        test,
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

  // Update company calculation
  fastify.put(
    '/vibe/companies/:companyId/calculation',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const { calculation } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }

      // If user is companyadmin, only allow editing their own company
      if (
        request.user.userGroups.includes('companyadmin') &&
        request.user.companyId !== companyId
      ) {
        reply
          .status(403)
          .send({ error: 'Forbidden: You can only edit your own company' });
        return;
      }

      const result = await vibe.updateCompany(companyId, { calculation });

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

  // Update company Tromp calculation
  fastify.put(
    '/vibe/companies/:companyId/calculation-tromp',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const { calculationTromp } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }

      const result = await vibe.updateCompany(companyId, { calculationTromp });

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

  // Update company Schneider calculation
  fastify.put(
    '/vibe/companies/:companyId/calculation-schneider',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const { calculationSchneider } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }

      const result = await vibe.updateCompany(companyId, { calculationSchneider });

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

  // Get list-level calculation with fallback to company-level
  fastify.get(
    '/vibe/companies/:companyId/lists/:listId/calculation',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const variant = (request.query?.variant || 'onzevibe') as string;

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      if (!['onzevibe', 'tromp', 'schneider'].includes(variant)) {
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
        variant === 'tromp'
          ? 'calculationTromp'
          : variant === 'schneider'
            ? 'calculationSchneider'
            : 'calculation';

      const prisma = PrismaInstance.getInstance();
      const list = await prisma.companyList.findUnique({
        where: { id: listId },
        select: {
          id: true,
          companyId: true,
          numberOfCards: true,
          calculation: true,
          calculationTromp: true,
          calculationSchneider: true,
        },
      });

      if (!list || list.companyId !== companyId) {
        reply.status(404).send({ error: 'List not found' });
        return;
      }

      const numberOfCards = list.numberOfCards;

      const listValue = (list as any)[listColumn] as string | null;
      if (listValue) {
        reply.send({
          success: true,
          source: 'list',
          calculation: listValue,
          numberOfCards,
        });
        return;
      }

      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: {
          calculation: true,
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
        });
        return;
      }

      reply.send({
        success: true,
        source: 'empty',
        calculation: null,
        numberOfCards,
      });
    }
  );

  // Update company list info (JSON). Accepts all non-design editable fields.
  fastify.put(
    '/vibe/companies/:companyId/lists/:listId/info',
    getAuthHandler(['admin', 'vibeadmin']),
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
        ...descriptionFields,
      ];
      const numberFields = [
        'numberOfTracks',
        'minimumNumberOfTracks',
        'numberOfCards',
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

      reply.send({ success: true, list: updated });
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
    '/vibe/companies/:companyId/lists/:listId/delivery-addresses',
    getAuthHandler(['admin', 'vibeadmin']),
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
    '/vibe/companies/:companyId/lists/:listId/delivery-addresses',
    getAuthHandler(['admin', 'vibeadmin']),
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
    '/vibe/companies/:companyId/lists/:listId/delivery-addresses/:addressId',
    getAuthHandler(['admin', 'vibeadmin']),
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
    '/vibe/companies/:companyId/lists/:listId/delivery-addresses/:addressId',
    getAuthHandler(['admin', 'vibeadmin']),
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

  // ---- Design files (cards / box) ----

  const LIST_FILE_TYPES: string[] = ['cards', 'box'];
  const listFilesDir = () => `${process.env['PRIVATE_DIR']}/list-files`;

  // Get design files for a list
  fastify.get(
    '/vibe/companies/:companyId/lists/:listId/files',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const prisma = PrismaInstance.getInstance();
      const files = await (prisma as any).companyListFile.findMany({
        where: { companyListId: listId },
        orderBy: { type: 'asc' },
      });
      reply.send({ success: true, files });
    }
  );

  // Upload (or replace) a design file for a list
  fastify.post(
    '/vibe/companies/:companyId/lists/:listId/files/:type',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const type = request.params.type;
      if (!LIST_FILE_TYPES.includes(type)) {
        reply.status(400).send({ error: 'Invalid file type' });
        return;
      }
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const fsPromises = require('fs').promises;
      const path = require('path');

      let savedFilename: string | null = null;
      let originalName: string | null = null;
      let mimeType: string | null = null;
      let size = 0;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'file') {
          const safeName = String(part.filename || 'design')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(-100);
          savedFilename = `list_${listId}_${type}_${Date.now()}_${safeName}`;
          originalName = part.filename || safeName;
          mimeType = part.mimetype || null;

          await fsPromises.mkdir(listFilesDir(), { recursive: true });
          const buffer = await part.toBuffer();
          size = buffer.length;
          await fsPromises.writeFile(
            path.join(listFilesDir(), savedFilename),
            buffer
          );
        }
      }

      if (!savedFilename) {
        reply.status(400).send({ error: 'No file uploaded' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const existing = await (prisma as any).companyListFile.findUnique({
        where: { companyListId_type: { companyListId: listId, type } },
      });
      if (existing) {
        // Remove the old file from disk; the DB row is replaced below.
        try {
          await fsPromises.unlink(path.join(listFilesDir(), existing.filename));
        } catch {
          /* old file may already be gone */
        }
      }

      const file = await (prisma as any).companyListFile.upsert({
        where: { companyListId_type: { companyListId: listId, type } },
        create: {
          companyListId: listId,
          type,
          filename: savedFilename,
          originalName,
          mimeType,
          size,
        },
        update: {
          filename: savedFilename,
          originalName,
          mimeType,
          size,
        },
      });
      reply.status(201).send({ success: true, file });
    }
  );

  // Download a design file
  fastify.get(
    '/vibe/companies/:companyId/lists/:listId/files/:type/download',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const type = request.params.type;
      if (!LIST_FILE_TYPES.includes(type)) {
        reply.status(400).send({ error: 'Invalid file type' });
        return;
      }
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const prisma = PrismaInstance.getInstance();
      const file = await (prisma as any).companyListFile.findUnique({
        where: { companyListId_type: { companyListId: listId, type } },
      });
      if (!file) {
        reply.status(404).send({ error: 'File not found' });
        return;
      }

      const fsPromises = require('fs').promises;
      const path = require('path');
      try {
        const buffer = await fsPromises.readFile(
          path.join(listFilesDir(), file.filename)
        );
        reply
          .header('Content-Type', file.mimeType || 'application/octet-stream')
          .header(
            'Content-Disposition',
            `attachment; filename="${encodeURIComponent(file.originalName)}"`
          )
          .send(buffer);
      } catch {
        reply.status(404).send({ error: 'File missing on disk' });
      }
    }
  );

  // Delete a design file
  fastify.delete(
    '/vibe/companies/:companyId/lists/:listId/files/:type',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const type = request.params.type;
      if (!LIST_FILE_TYPES.includes(type)) {
        reply.status(400).send({ error: 'Invalid file type' });
        return;
      }
      const list = await findCompanyList(companyId, listId, reply);
      if (!list) return;

      const prisma = PrismaInstance.getInstance();
      const file = await (prisma as any).companyListFile.findUnique({
        where: { companyListId_type: { companyListId: listId, type } },
      });
      if (!file) {
        reply.status(404).send({ error: 'File not found' });
        return;
      }

      const fsPromises = require('fs').promises;
      const path = require('path');
      try {
        await fsPromises.unlink(path.join(listFilesDir(), file.filename));
      } catch {
        /* file may already be gone */
      }
      await (prisma as any).companyListFile.delete({ where: { id: file.id } });
      reply.send({ success: true });
    }
  );

  // ---- Order e-mail ----

  // Build the printer order e-mail (Dutch) for a list
  fastify.get(
    '/vibe/companies/:companyId/lists/:listId/order-email',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
        return;
      }

      const result = await vibe.getOrderEmail(companyId, listId);
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
    '/vibe/companies/:companyId/favorite',
    getAuthHandler(['admin', 'vibeadmin']),
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

  // ---- Live orders (production lists) ----

  // Get all lists with status "production" across companies
  fastify.get(
    '/vibe/production-lists',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const result = await vibe.getProductionLists();
      if (!result.success) {
        reply.status(500).send({ error: result.error });
        return;
      }
      reply.send({ success: true, lists: result.data });
    }
  );

  // Generate or rotate the intake-form token for a list
  fastify.post(
    '/vibe/companies/:companyId/lists/:listId/intake-link',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
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

      const token = crypto.randomBytes(24).toString('base64url').slice(0, 32);

      const updated = await (prisma as any).companyList.update({
        where: { id: listId },
        data: { intakeToken: token },
      });

      reply.send({ success: true, intakeToken: updated.intakeToken });
    }
  );

  // Public intake form — fetch list + company data by token (no auth)
  fastify.get(
    '/vibe/intake/:token',
    async (request: any, reply: any) => {
      const token = String(request.params.token || '');
      if (!token || token.length < 16) {
        reply.status(400).send({ error: 'Invalid token' });
        return;
      }

      const prisma = PrismaInstance.getInstance();
      const list: any = await (prisma as any).companyList.findFirst({
        where: { intakeToken: token },
        select: {
          id: true,
          name: true,
          slug: true,
          numberOfCards: true,
          playlistSource: true,
          playlistUrl: true,
          languages: true,
          meetingDate: true,
          desiredDeliveryDate: true,
          musicWishes: true,
          designResponsibility: true,
          gameExplanation: true,
          personalizedApp: true,
          approverName: true,
          specialNotes: true,
          Company: {
            select: {
              id: true,
              name: true,
              contact: true,
              contactemail: true,
              contactphone: true,
              address: true,
              housenumber: true,
              city: true,
              zipcode: true,
              countrycode: true,
            },
          },
        },
      });

      if (!list) {
        reply.status(404).send({ error: 'Intake link is not valid' });
        return;
      }

      const { Company, ...listFields } = list;
      reply.send({
        success: true,
        company: Company,
        list: listFields,
      });
    }
  );

  // Public intake form — save (partial) list + company data by token
  fastify.put(
    '/vibe/intake/:token',
    async (request: any, reply: any) => {
      const token = String(request.params.token || '');
      if (!token || token.length < 16) {
        reply.status(400).send({ error: 'Invalid token' });
        return;
      }

      const body = request.body || {};
      const prisma = PrismaInstance.getInstance();
      const list = await (prisma as any).companyList.findFirst({
        where: { intakeToken: token },
        select: { id: true, companyId: true },
      });
      if (!list) {
        reply.status(404).send({ error: 'Intake link is not valid' });
        return;
      }

      // Whitelist fields accepted from the public form.
      const listStringFields = [
        'playlistSource',
        'playlistUrl',
        'musicWishes',
        'designResponsibility',
        'gameExplanation',
        'approverName',
        'specialNotes',
      ];
      const listNumberFields = ['numberOfCards'];
      const listDateFields = ['meetingDate', 'desiredDeliveryDate'];
      const listBooleanFields = ['personalizedApp'];

      const listUpdate: Record<string, any> = {};

      for (const f of listStringFields) {
        if (body[f] === undefined) continue;
        if (body[f] === null || body[f] === '') {
          listUpdate[f] = null;
        } else if (typeof body[f] === 'string') {
          listUpdate[f] = body[f];
        } else {
          reply.status(400).send({ error: `${f} must be a string` });
          return;
        }
      }
      for (const f of listNumberFields) {
        if (body[f] === undefined) continue;
        if (body[f] === null) {
          listUpdate[f] = null;
        } else {
          const n = Number(body[f]);
          if (!Number.isFinite(n) || n < 0) {
            reply.status(400).send({ error: `${f} must be a non-negative number` });
            return;
          }
          listUpdate[f] = Math.round(n);
        }
      }
      for (const f of listDateFields) {
        if (body[f] === undefined) continue;
        if (body[f] === null || body[f] === '') {
          listUpdate[f] = null;
        } else {
          const d = new Date(body[f]);
          if (isNaN(d.getTime())) {
            reply.status(400).send({ error: `${f} must be a valid date` });
            return;
          }
          listUpdate[f] = d;
        }
      }
      for (const f of listBooleanFields) {
        if (body[f] === undefined) continue;
        listUpdate[f] = Boolean(body[f]);
      }

      if (Object.keys(listUpdate).length > 0) {
        await (prisma as any).companyList.update({
          where: { id: list.id },
          data: listUpdate,
        });
      }

      // Company fields (contact person, email, phone) can be edited too.
      const companyStringFields = [
        'contact',
        'contactemail',
        'contactphone',
      ];
      const companyUpdate: Record<string, any> = {};
      for (const f of companyStringFields) {
        if (body.company && body.company[f] !== undefined) {
          const val = body.company[f];
          if (val === null || val === '') {
            companyUpdate[f] = null;
          } else if (typeof val === 'string') {
            companyUpdate[f] = val.trim() || null;
          }
        }
      }

      if (Object.keys(companyUpdate).length > 0) {
        await prisma.company.update({
          where: { id: list.companyId },
          data: companyUpdate,
        });
      }

      reply.send({ success: true });
    }
  );

  // Re-download a previously persisted quotation as PDF
  fastify.get(
    '/vibe/companies/:companyId/quotations/:quotationId/pdf',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const quotationId = parseInt(request.params.quotationId);
      if (isNaN(companyId) || isNaN(quotationId)) {
        reply.status(400).send({ error: 'Invalid company or quotation ID' });
        return;
      }

      const result = await vibe.getQuotationPDF(
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
    '/vibe/companies/:companyId/quotations/:quotationId',
    getAuthHandler(['admin', 'vibeadmin']),
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
    '/vibe/companies/:companyId/quotations',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
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
    '/vibe/companies/:companyId/counts',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
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
      const [users, lists, assets, quotations] = await Promise.all([
        prisma.user.count({ where: { companyId } }),
        prisma.companyList.count({ where: { companyId } }),
        prisma.companyAsset.count({ where: { companyId } }),
        (prisma as any).quotation.count({ where: { companyId } }),
      ]);

      reply.send({
        success: true,
        counts: { contacts: users, lists, assets, quotations },
      });
    }
  );

  // Update list-level OnzeVibe calculation
  fastify.put(
    '/vibe/companies/:companyId/lists/:listId/calculation',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const listId = parseInt(request.params.listId);
      const { calculation } = request.body || {};

      if (isNaN(companyId) || isNaN(listId)) {
        reply.status(400).send({ error: 'Invalid company or list ID' });
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
      const list = await prisma.companyList.findUnique({ where: { id: listId } });
      if (!list || list.companyId !== companyId) {
        reply.status(404).send({ error: 'List not found' });
        return;
      }

      const updated = await prisma.companyList.update({
        where: { id: listId },
        data: { calculation, ...extractCalculationMetrics(request.body) },
      });

      reply.send({ success: true, list: updated });
    }
  );

  // Update list-level Tromp calculation
  fastify.put(
    '/vibe/companies/:companyId/lists/:listId/calculation-tromp',
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
        data: { calculationTromp, ...extractCalculationMetrics(request.body) },
      });

      reply.send({ success: true, list: updated });
    }
  );

  // Update list-level Schneider calculation
  fastify.put(
    '/vibe/companies/:companyId/lists/:listId/calculation-schneider',
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
        data: { calculationSchneider, ...extractCalculationMetrics(request.body) },
      });

      reply.send({ success: true, list: updated });
    }
  );

  // Quotation HTML View (for PDF generation)
  fastify.get(
    '/vibe/quotation/:type/:companyId/:quotationNumber',
    async (request: any, reply: any) => {
      try {
        const type = request.params.type; // 'onzevibe', 'qrsong', or 'schneider'
        const companyId = parseInt(request.params.companyId);
        const quotationNumber = request.params.quotationNumber;

        // Extract pricing options from query parameters
        const isReseller = request.query.isReseller === 'true';
        const listIdParam = request.query.listId
          ? parseInt(request.query.listId)
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
        const companiesResult = await vibe.getAllCompanies(['admin']);
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // If a list was specified, load its per-list calculation so per-list
        // toggles (e.g. includeVotingPortal) override the company defaults.
        let listCalc: {
          calculation: string | null;
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
                calculation: true,
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

        // Load company-wide discount from main calculation field
        let companyDiscountPercent = 0;
        if (company.calculation) {
          try {
            const mainCalc = JSON.parse(company.calculation);
            companyDiscountPercent = mainCalc.manualDiscountPercent || 0;
          } catch (e) {
            console.error('Error parsing main calculation for discount:', e);
          }
        }

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
              calculation = { ...storedCalc, manualDiscountPercent: companyDiscountPercent };
            } catch (e) {
              console.error('Error parsing Tromp calculation:', e);
            }
          }

          // Use the Vibe calculateTrompPricing method
          const pricingResult = await vibe.calculateTrompPricing({
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

          // Set product description for Tromp
          if (calculation.printingType === 'luxe') {
            productDescription = 'QRSong! Luxe doos';
            productDetails = 'Luxe doos met 200 kaarten en bedrukte chips';
          } else if (calculation.printingType === 'klein') {
            productDescription = 'QRSong! muziekkaarten set';
            productDetails = 'Klein voorbedrukt doosje met 100 kaarten';
          } else {
            productDescription = 'QRSong! muziekkaarten set';
            productDetails = 'Een doos met 2 kleinere doosjes met ieder 100 kaarten (totaal 200 kaarten)';
          }
        } else if (type === 'schneider') {
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
              calculation = { ...storedCalc, manualDiscountPercent: companyDiscountPercent };
            } catch (e) {
              console.error('Error parsing Schneider calculation:', e);
            }
          }

          // Use the Vibe calculateSchneiderPricing method
          const pricingResult = await vibe.calculateSchneiderPricing({
            quantity: calculation.quantity || 100,
            cardCount: calculation.cardCount || 48,
            includeStansmes: calculation.includeStansmes || false,
            includeCustomApp: calculation.includeCustomApp || false,
            includeVotingPortal: calculation.includeVotingPortal || false,
            profitMargin: calculation.profitMargin || 0,
          });

          if (pricingResult.success) {
            calculationResult = pricingResult.calculation;
            // Map Schneider fields to match Tromp template expectations
            calculationResult.pricePerSet = calculationResult.pricePerBox;
          }

          // Set product description based on card count
          const cardCount = calculation.cardCount || 48;
          productDescription = `QRSong! Box - ${cardCount} kaarten`;

          switch (cardCount) {
            case 48:
              productDetails = 'Doos met 1 vakje, 48 kaarten';
              break;
            case 96:
              productDetails = 'Luxe doos met 2 vakjes, 2x 48 kaarten';
              break;
            case 144:
              productDetails = 'Luxe doos met 2 vakjes, 2x 72 kaarten';
              break;
            case 192:
              productDetails = 'Luxe doos met 4 vakjes, 4x 48 kaarten';
              break;
            default:
              productDetails = `Luxe doos met ${cardCount} kaarten`;
          }
        } else {
          // OnzeVibe calculation
          calculation = {
            quantity: 100,
            includePersonalization: true,
            shipmentOnLocation: false,
            soldBy: 'onzevibe',
            isReseller: false,
            manualDiscount: 0,
            fluidMode: false,
          };

          const onzevibeSource = listCalc?.calculation ?? company.calculation;
          if (onzevibeSource) {
            try {
              const storedCalc = JSON.parse(onzevibeSource);
              calculation = storedCalc;
            } catch (e) {
              console.error('Error parsing OnzeVibe calculation:', e);
            }
          }

          // Use the Vibe calculatePricing method
          const pricingResult = await vibe.calculatePricing({
            quantity: calculation.quantity || 100,
            includePersonalization:
              calculation.includePersonalization !== undefined
                ? calculation.includePersonalization
                : true,
            shipmentOnLocation: calculation.shipmentOnLocation || false,
            soldBy: calculation.soldBy || 'onzevibe',
            isReseller: calculation.isReseller || false,
            manualDiscount: calculation.manualDiscount || 0,
            fluidMode: calculation.fluidMode || false,
            includeCustomApp: calculation.includeCustomApp || false,
            includeVotingPortal: calculation.includeVotingPortal || false,
          });

          if (pricingResult.success) {
            calculationResult = pricingResult.calculation;
          }

          productDescription = 'QRSong! HappiBox';
          productDetails = 'Doos en kaarten in eigen stijl';
        }

        // Date formatting functions
        const formatDate = (date: Date) => {
          const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          };
          return date.toLocaleDateString('nl-NL', options);
        };

        const formatCurrency = (value: number) => {
          return new Intl.NumberFormat('nl-NL', {
            style: 'currency',
            currency: 'EUR',
          }).format(value);
        };

        // Format number with Dutch locale (dot as thousand separator, comma as decimal)
        const formatEuro = (value: number) => {
          return value.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };

        const today = new Date();
        const validUntil = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Use the appropriate template - use tromp_quotation for both qrsong and schneider
        const template = (type === 'qrsong' || type === 'schneider') ? 'tromp_quotation.ejs' : 'vibe_quotation.ejs';

        await reply.view(template, {
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
        });
      } catch (error) {
        console.error('Error rendering quotation view:', error);
        reply.status(500).send({ error: 'Failed to render quotation' });
      }
    }
  );

  // Generate quotation PDF
  fastify.post(
    '/vibe/quotation/:companyId',
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
        } = request.body; // 'onzevibe', 'qrsong', or 'schneider'

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        // Call the business logic in Vibe class
        const result = await vibe.generateQuotationPDF(
          companyId,
          request.user.userId,
          request.user.userGroups,
          request.user.companyId,
          type || 'onzevibe',
          { isReseller, profitMargins, calculatedPrices },
          listId ? Number(listId) : undefined
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

  // Technical Instructions HTML View (for PDF generation)
  fastify.get(
    '/vibe/technical-instructions/:companyId',
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const printer = request.query.printer || 'tromp';

        // Get company data - pass ['admin'] to include onlyForAdmin companies
        const companiesResult = await vibe.getAllCompanies(['admin']);
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // Date formatting function
        const formatDate = (date: Date) => {
          const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          };
          return date.toLocaleDateString('nl-NL', options);
        };

        // Get base URL for assets
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Render the EJS template (matches quotation route pattern)
        await reply.view('technical_instructions.ejs', {
          company,
          baseUrl,
          formatDate,
          printer,
        });
      } catch (error) {
        console.error('Error rendering technical instructions:', error);
        reply.status(500).send({ error: 'Failed to render technical instructions: ' + error });
      }
    }
  );

  // Generate Technical Instructions PDF
  fastify.post(
    '/vibe/technical-instructions/:companyId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        // Get company data - pass ['admin'] to include onlyForAdmin companies
        const companiesResult = await vibe.getAllCompanies(['admin']);
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
        const htmlUrl = `${baseUrl}/vibe/technical-instructions/${companyId}?printer=${printer}`;

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
        const downloadFilename = `Technische_Instructies_${company.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

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
    '/vibe/companies/:companyId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await vibe.deleteCompany(companyId);

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
    '/vibe/lists/:companyListId/replace-track',
    getAuthHandler(['admin', 'vibeadmin']),
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

        const result = await vibe.replaceTrackInSubmissions(
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
    '/vibe/submissions/:submissionId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const submissionId = parseInt(request.params.submissionId);

        if (isNaN(submissionId)) {
          reply.status(400).send({ error: 'Invalid submission ID' });
          return;
        }

        // If user is companyadmin, check that the submission belongs to their company
        if (request.user.userGroups.includes('companyadmin')) {
          const belongs = await vibe.submissionBelongsToCompany(
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

        const result = await vibe.deleteSubmission(submissionId);

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
    '/vibe/companies/:companyId/lists',
    getAuthHandler(['admin', 'vibeadmin']),
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

        const result = await vibe.createCompanyList(companyId, listData);

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
    '/vibe/companies/:companyId/lists/:listId',
    getAuthHandler(['admin', 'vibeadmin']),
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

        const result = await vibe.deleteCompanyList(companyId, listId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company list not found') {
            statusCode = 404;
          } else if (result.error === 'List does not belong to this company') {
            statusCode = 403;
          } else if (result.error.includes('status is not "new"')) {
            statusCode = 409;
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
    '/vibe/companies',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const {
          name,
          test,
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
        } = request.body;

        if (!name) {
          reply.status(400).send({ error: 'Missing required field: name' });
          return;
        }

        const result = await vibe.createCompany({
          name,
          test,
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
    '/vibe/finalize',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply) => {
      const { companyListId } = request.body;

      if (!companyListId) {
        return { success: false, error: 'Missing company list ID' };
      }

      return await vibe.finalizeList(parseInt(companyListId));
    }
  );

  // Get company list state
  fastify.get(
    '/vibe/state/:listId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin', 'qrvoteadmin']),
    async (request: any, reply: any) => {
      try {
        const token = request.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token || '');
        const listId = parseInt(request.params.listId);

        const result = await vibe.getState(listId);

        if (!result.success) {
          reply.status(404).send({ error: result.error });
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
    '/vibe/company/:companyId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
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
        const result = await vibe.getCompanyLists(
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

  // Generate PDF
  fastify.post(
    '/vibe/generate/:listId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const listId = parseInt(request.params.listId);

        if (isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid list ID' });
          return;
        }

        const result = await vibe.generatePDF(listId, mollie, request.clientIp);

        reply.send({
          success: true,
          message: 'PDF generation initiated (placeholder)',
        });
      } catch (error) {
        console.error('Error calling generatePDF:', error);
        reply
          .status(500)
          .send({ error: 'Internal server error during PDF generation' });
      }
    }
  );

  // Update submission
  fastify.put(
    '/vibe/submissions/:submissionId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
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
          const belongs = await vibe.submissionBelongsToCompany(
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

        const result = await vibe.updateSubmission(submissionId, { cardName });
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
    '/vibe/submissions/:submissionId/verify',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const submissionId = parseInt(request.params.submissionId);
        if (isNaN(submissionId)) {
          reply.status(400).send({ error: 'Invalid submission ID' });
          return;
        }

        // If user is companyadmin, check that the submission belongs to their company
        if (request.user.userGroups.includes('companyadmin')) {
          const belongs = await vibe.submissionBelongsToCompany(
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

        const result = await vibe.verifySubmission(submissionId);
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

  // Create company list (public endpoint)
  fastify.post('/vibe/companylist/create', async (request: any, reply: any) => {
    const result = await vibe.handleCompanyListCreate(
      request.body,
      request.clientIp
    );
    if (!result.success) {
      reply.status(result.statusCode || 400).send(result);
    } else {
      reply.send(result);
    }
  });

  // Calculate pricing (admin and vibeadmin only)
  fastify.post(
    '/vibe/calculate',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const result = await vibe.calculatePricing(request.body);

        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send(result);
      } catch (error) {
        console.error('Error calculating pricing:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Pricing tables profit-margin config (Redis-backed, shared across browsers/users).
  // Stores the same shape the frontend used to keep in localStorage:
  //   { profitMatrix: ProfitMatrix, defaultProfits: Record<string, ProfitEntry> }
  fastify.get(
    '/vibe/pricing-tables/profit-config',
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
    '/vibe/pricing-tables/profit-config',
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
    '/vibe/calculate-tromp',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await vibe.calculateTrompPricing(request.body);

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

  // Calculate Schneider pricing (admin only)
  fastify.post(
    '/vibe/calculate-schneider',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await vibe.calculateSchneiderPricing(request.body);

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

  // Vibe poster
  fastify.get('/vibe/poster/:posterId', async (request: any, reply: any) => {
    const posterId = request.params.posterId;
    const qrUrl = `${process.env['APP_DOMAIN']}/vibe/post/${posterId}`;
    await reply.view('poster_vibe.ejs', {
      posterId,
      qrUrl,
      brandColor: '#5FBFFF',
      brandSecondary: '#3F6FAF',
      brandAccent: '#E56581',
      appDomain: process.env['APP_DOMAIN'],
    });
  });

  // Reseller pricing HTML view (for PDF generation)
  fastify.get(
    '/vibe/reseller-pricing',
    async (request: any, reply: any) => {
      try {
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Get profit matrix from query params (passed as JSON)
        // Structure: productId -> quantity -> { reseller, qrsong }
        const profitMatrixParam = request.query.profitMatrix;
        const profitMatrix: Record<string, Record<number, { reseller: number; qrsong: number }>> = profitMatrixParam
          ? JSON.parse(decodeURIComponent(profitMatrixParam))
          : {};

        // Helper to get profit for a specific product and quantity
        const getProfit = (productId: string, qty: number): { reseller: number; qrsong: number } => {
          return profitMatrix[productId]?.[qty] || { reseller: 0, qrsong: 0 };
        };

        // Format helpers
        const formatCurrency = (value: number) => {
          return new Intl.NumberFormat('nl-NL', {
            style: 'currency',
            currency: 'EUR',
          }).format(value);
        };

        const formatNumber = (value: number) => {
          return new Intl.NumberFormat('nl-NL').format(value);
        };

        const formatDate = (date: Date) => {
          return new Intl.DateTimeFormat('nl-NL', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }).format(date);
        };

        // Product configurations
        const quantities = [100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000, 10000];

        const groups = [
          {
            name: 'QRSong! Box',
            products: [
              { id: 'schneider-48', name: '48 kaarten', cardCount: 48 },
              { id: 'schneider-96', name: '96 kaarten', cardCount: 96 },
              { id: 'schneider-192', name: '192 kaarten', cardCount: 192 },
            ],
          },
          {
            name: 'QRSong! HappiBox',
            products: [
              { id: 'onzevibe', name: 'Doos & kaarten eigen stijl', includePersonalization: false },
              { id: 'onzevibe-pers', name: 'Incl. personalisatie', includePersonalization: true },
            ],
          },
        ];

        // Calculate prices for all products and quantities
        const prices: Record<string, Record<number, { resellerPrice: number; retailPrice: number; qrsongProfitPercent: string; resellerProfitPercent: string }>> = {};

        for (const group of groups) {
          for (const product of group.products) {
            prices[product.id] = {};

            for (const qty of quantities) {
              try {
                if (group.name === 'QRSong! HappiBox') {
                  const result = await vibe.calculatePricing({
                    quantity: qty,
                    soldBy: 'onzevibe',
                    includePersonalization: (product as any).includePersonalization,
                    shipmentOnLocation: true,
                    isReseller: true,
                    manualDiscount: 0,
                    fluidMode: true,
                    includeCustomApp: false,
                  });

                  if (result.success && result.calculation) {
                    const pricing = result.calculation.pricing;
                    const commercialPricePerBox = pricing.commercialPricePerBox;
                    const profitPerBox = pricing.profitPerBox;
                    const resellerProfitPerBox = pricing.resellerProfit / qty;

                    // Retail = commercialPricePerBox (what end client pays)
                    // Reseller = retail - resellerProfit (what reseller pays)
                    // Inkoop = retail - resellerProfit - ourProfit
                    const retailPrice = commercialPricePerBox;
                    const resellerPrice = commercialPricePerBox - resellerProfitPerBox;
                    const purchasePrice = commercialPricePerBox - resellerProfitPerBox - profitPerBox;

                    // Calculate percentages based on purchase price
                    const qrsongProfitPercent = purchasePrice > 0 ? ((profitPerBox / purchasePrice) * 100).toFixed(1) + '%' : '0.0%';
                    const resellerProfitPercent = purchasePrice > 0 ? ((resellerProfitPerBox / purchasePrice) * 100).toFixed(1) + '%' : '0.0%';

                    prices[product.id][qty] = { resellerPrice, retailPrice, qrsongProfitPercent, resellerProfitPercent };
                  }
                } else if (group.name === 'Standaard') {
                  // Get per-product, per-tier profit settings
                  const settings = getProfit(product.id, qty);
                  const result = await vibe.calculateTrompPricing({
                    quantity: qty,
                    printingType: (product as any).printingType,
                    includeStansmestekening: false,
                    includeStansvorm: false,
                    includeCustomApp: false,
                    profitMargin: 0,
                  });

                  if (result.success && result.calculation) {
                    const pricePerSet = result.calculation.pricePerSet;
                    // Apply profit percentages
                    const qrsongProfit = pricePerSet * (settings.qrsong / 100);
                    const resellerPrice = pricePerSet + qrsongProfit;
                    // Reseller profit is calculated over resellerPrice (what they pay), not inkoop
                    const resellerProfit = resellerPrice * (settings.reseller / 100);
                    const retailPrice = resellerPrice + resellerProfit;

                    prices[product.id][qty] = {
                      resellerPrice,
                      retailPrice,
                      qrsongProfitPercent: settings.qrsong.toFixed(1) + '%',
                      resellerProfitPercent: settings.reseller.toFixed(1) + '%',
                    };
                  }
                } else if (group.name === 'QRSong! Box') {
                  // Get per-product, per-tier profit settings
                  const settings = getProfit(product.id, qty);
                  const result = await vibe.calculateSchneiderPricing({
                    quantity: qty,
                    cardCount: (product as any).cardCount,
                    includeStansmes: false,
                    includeCustomApp: false,
                    profitMargin: 0,
                  });

                  if (result.success && result.calculation) {
                    const pricePerBox = result.calculation.pricePerBox;
                    // Apply profit percentages
                    const qrsongProfit = pricePerBox * (settings.qrsong / 100);
                    const resellerPrice = pricePerBox + qrsongProfit;
                    // Reseller profit is calculated over resellerPrice (what they pay), not inkoop
                    const resellerProfit = resellerPrice * (settings.reseller / 100);
                    const retailPrice = resellerPrice + resellerProfit;

                    prices[product.id][qty] = {
                      resellerPrice,
                      retailPrice,
                      qrsongProfitPercent: settings.qrsong.toFixed(1) + '%',
                      resellerProfitPercent: settings.reseller.toFixed(1) + '%',
                    };
                  }
                }
              } catch (error) {
                console.error(`Error calculating price for ${product.id} qty ${qty}:`, error);
              }
            }
          }
        }

        const version = new Date().toISOString().slice(0, 10).replace(/-/g, '.');

        await reply.view('reseller_pricing.ejs', {
          groups,
          quantities,
          prices,
          profitMatrix,
          formatCurrency,
          formatNumber,
          formatDate,
          baseUrl,
          version,
        });
      } catch (error) {
        console.error('Error rendering reseller pricing view:', error);
        reply.status(500).send({ error: 'Failed to render reseller pricing' });
      }
    }
  );

  // Generate reseller pricing PDF
  fastify.post(
    '/vibe/reseller-pricing/pdf',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const PDF = require('../pdf').default;
        const pdfManager = new PDF();
        const path = require('path');
        const fs = require('fs').promises;

        // Get profit matrix from request body (per-product, per-tier percentages)
        const { profitMatrix } = request.body || {};

        const tempDir = '/tmp';
        const fileName = `reseller_pricing_${Date.now()}.pdf`;
        const filePath = path.join(tempDir, fileName);

        // Create the URL for the HTML rendering with profit matrix
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const profitMatrixParam = profitMatrix
          ? `?profitMatrix=${encodeURIComponent(JSON.stringify(profitMatrix))}`
          : '';
        const htmlUrl = `${baseUrl}/vibe/reseller-pricing${profitMatrixParam}`;

        // Generate PDF - let CSS @page rules control orientation
        await pdfManager.generateFromUrl(htmlUrl, filePath, {
          format: 'a4',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        });

        // Read the generated PDF
        const pdfBuffer = await fs.readFile(filePath);

        // Clean up temp file
        try {
          await fs.unlink(filePath);
        } catch (unlinkError) {
          console.warn('Failed to delete temp file:', unlinkError);
        }

        const downloadFilename = `Reseller_Prijslijst_${new Date().toISOString().slice(0, 10)}.pdf`;

        // Set response headers for PDF download
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);

        reply.send(pdfBuffer);
      } catch (error) {
        console.error('Error generating reseller pricing PDF:', error);
        reply.status(500).send({ error: 'Failed to generate reseller pricing PDF' });
      }
    }
  );

  // Retail pricing HTML view (for PDF generation) - only shows retail prices
  fastify.get(
    '/vibe/retail-pricing',
    async (request: any, reply: any) => {
      try {
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Get profit matrix from query params (passed as JSON)
        const profitMatrixParam = request.query.profitMatrix;
        const profitMatrix: Record<string, Record<number, { reseller: number; qrsong: number }>> = profitMatrixParam
          ? JSON.parse(decodeURIComponent(profitMatrixParam))
          : {};

        // Helper to get profit for a specific product and quantity
        const getProfit = (productId: string, qty: number): { reseller: number; qrsong: number } => {
          return profitMatrix[productId]?.[qty] || { reseller: 0, qrsong: 0 };
        };

        // Format helpers
        const formatCurrency = (value: number) => {
          return new Intl.NumberFormat('nl-NL', {
            style: 'currency',
            currency: 'EUR',
          }).format(value);
        };

        const formatNumber = (value: number) => {
          return new Intl.NumberFormat('nl-NL').format(value);
        };

        const formatDate = (date: Date) => {
          return new Intl.DateTimeFormat('nl-NL', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }).format(date);
        };

        // Product configurations
        const quantities = [100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000, 10000];

        const groups = [
          {
            name: 'QRSong! Box',
            products: [
              { id: 'schneider-48', name: '48 kaarten', cardCount: 48 },
              { id: 'schneider-96', name: '96 kaarten', cardCount: 96 },
              { id: 'schneider-192', name: '192 kaarten', cardCount: 192 },
            ],
          },
          {
            name: 'QRSong! HappiBox',
            products: [
              { id: 'onzevibe', name: 'Doos & kaarten eigen stijl', includePersonalization: false },
              { id: 'onzevibe-pers', name: 'Incl. personalisatie', includePersonalization: true },
            ],
          },
        ];

        // Calculate retail prices only
        const prices: Record<string, Record<number, { retailPrice: number }>> = {};

        for (const group of groups) {
          for (const product of group.products) {
            prices[product.id] = {};

            for (const qty of quantities) {
              try {
                if (group.name === 'QRSong! HappiBox') {
                  const result = await vibe.calculatePricing({
                    quantity: qty,
                    soldBy: 'onzevibe',
                    includePersonalization: (product as any).includePersonalization,
                    shipmentOnLocation: true,
                    isReseller: true,
                    manualDiscount: 0,
                    fluidMode: true,
                    includeCustomApp: false,
                  });

                  if (result.success && result.calculation) {
                    const retailPrice = result.calculation.pricing.commercialPricePerBox;
                    prices[product.id][qty] = { retailPrice };
                  }
                } else if (group.name === 'Standaard') {
                  const settings = getProfit(product.id, qty);
                  const result = await vibe.calculateTrompPricing({
                    quantity: qty,
                    printingType: (product as any).printingType,
                    includeStansmestekening: false,
                    includeStansvorm: false,
                    includeCustomApp: false,
                    profitMargin: 0,
                  });

                  if (result.success && result.calculation) {
                    const pricePerSet = result.calculation.pricePerSet;
                    const qrsongProfit = pricePerSet * (settings.qrsong / 100);
                    const resellerPrice = pricePerSet + qrsongProfit;
                    // Reseller profit is calculated over resellerPrice (what they pay), not inkoop
                    const resellerProfit = resellerPrice * (settings.reseller / 100);
                    const retailPrice = resellerPrice + resellerProfit;
                    prices[product.id][qty] = { retailPrice };
                  }
                } else if (group.name === 'QRSong! Box') {
                  const settings = getProfit(product.id, qty);
                  const result = await vibe.calculateSchneiderPricing({
                    quantity: qty,
                    cardCount: (product as any).cardCount,
                    includeStansmes: false,
                    includeCustomApp: false,
                    profitMargin: 0,
                  });

                  if (result.success && result.calculation) {
                    const pricePerBox = result.calculation.pricePerBox;
                    const qrsongProfit = pricePerBox * (settings.qrsong / 100);
                    const resellerPrice = pricePerBox + qrsongProfit;
                    // Reseller profit is calculated over resellerPrice (what they pay), not inkoop
                    const resellerProfit = resellerPrice * (settings.reseller / 100);
                    const retailPrice = resellerPrice + resellerProfit;
                    prices[product.id][qty] = { retailPrice };
                  }
                }
              } catch (error) {
                console.error(`Error calculating retail price for ${product.id} qty ${qty}:`, error);
              }
            }
          }
        }

        await reply.view('retail_pricing.ejs', {
          groups,
          quantities,
          prices,
          formatCurrency,
          formatNumber,
          formatDate,
          baseUrl,
        });
      } catch (error) {
        console.error('Error rendering retail pricing view:', error);
        reply.status(500).send({ error: 'Failed to render retail pricing' });
      }
    }
  );

  // Retail pricing PDF download
  fastify.post(
    '/vibe/retail-pricing/pdf',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const PDF = require('../pdf').default;
        const pdfManager = new PDF();
        const path = require('path');
        const fs = require('fs').promises;

        const { profitMatrix } = request.body || {};

        const tempDir = '/tmp';
        const fileName = `retail_pricing_${Date.now()}.pdf`;
        const filePath = path.join(tempDir, fileName);

        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const profitMatrixParam = profitMatrix
          ? `?profitMatrix=${encodeURIComponent(JSON.stringify(profitMatrix))}`
          : '';
        const htmlUrl = `${baseUrl}/vibe/retail-pricing${profitMatrixParam}`;

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

        const downloadFilename = `Retail_Prijslijst_${new Date().toISOString().slice(0, 10)}.pdf`;

        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);

        reply.send(pdfBuffer);
      } catch (error) {
        console.error('Error generating retail pricing PDF:', error);
        reply.status(500).send({ error: 'Failed to generate retail pricing PDF' });
      }
    }
  );

  // ============================================
  // Company Events
  // ============================================

  // Get company events
  fastify.get(
    '/vibe/companies/:companyId/events',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await vibe.getCompanyEvents(companyId);
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
    '/vibe/companies/:companyId/events',
    getAuthHandler(['admin', 'vibeadmin']),
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

        const result = await vibe.createCompanyEvent(companyId, userId, content, attachmentUrl);
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
    '/vibe/companies/:companyId/events/:eventId',
    getAuthHandler(['admin', 'vibeadmin']),
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

        const result = await vibe.updateCompanyEvent(companyId, eventId, content);
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
    '/vibe/companies/:companyId/events/:eventId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const eventId = parseInt(request.params.eventId);

        if (isNaN(companyId) || isNaN(eventId)) {
          reply.status(400).send({ error: 'Invalid company or event ID' });
          return;
        }

        const result = await vibe.deleteCompanyEvent(companyId, eventId);
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
    '/vibe/companies/import',
    getAuthHandler(['admin', 'vibeadmin']),
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

        const result = await vibe.importCompaniesFromExcel(fileBuffer, userId);
        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send({
          success: true,
          imported: result.data.imported,
          skipped: result.data.skipped,
          errors: result.data.errors,
          details: result.data.details
        });
      } catch (error) {
        console.error('Error importing companies:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // ============================================
  // Company Assets
  // ============================================

  // Generate company assets
  fastify.post(
    '/vibe/companies/:companyId/assets/generate',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        let label = '';
        let instructions = '';
        const brandingFilePaths: string[] = [];

        // Handle multipart form data
        const contentType = request.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          reply.status(400).send({ error: 'Multipart form data required' });
          return;
        }

        const prisma = PrismaInstance.getInstance();

        // Create the asset record first to get the ID for the directory
        // Upload branding files to a shared directory per timestamp
        const publicDir = process.env['PUBLIC_DIR'];
        const uploadBatch = Date.now().toString();
        const uploadDir = pathModule.join(
          publicDir || '',
          'companydata',
          'assets',
          companyId.toString(),
          'branding_' + uploadBatch
        );
        await fsPromises.mkdir(uploadDir, { recursive: true });

        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            const filename = `branding_${Date.now()}_${part.filename}`;
            const filePath = pathModule.join(uploadDir, filename);
            const buffer = await part.toBuffer();
            await fsPromises.writeFile(filePath, buffer);
            brandingFilePaths.push(filePath);
          } else if (part.fieldname === 'label') {
            label = part.value || '';
          } else if (part.fieldname === 'instructions') {
            instructions = part.value || '';
          }
        }

        if (brandingFilePaths.length === 0) {
          reply.status(400).send({ error: 'At least one branding image is required' });
          return;
        }

        const brandingFilenames = JSON.stringify(brandingFilePaths.map(p => pathModule.basename(p)));
        const assetQueue = AssetQueue.getInstance();
        const providers: ('gemini' | 'openai')[] = ['gemini', 'openai'];
        const assets: any[] = [];

        for (const provider of providers) {
          const asset = await prisma.companyAsset.create({
            data: {
              companyId,
              label: label ? `${label} (${provider})` : provider,
              llmProvider: provider,
              instructions: instructions || null,
              brandingImages: brandingFilenames,
              status: 'pending',
              progress: 0,
            },
          });

          const jobId = await assetQueue.queueAssetJob({
            companyAssetId: asset.id,
            companyId,
            brandingImagePaths: brandingFilePaths,
            instructions: instructions || undefined,
            llmProvider: provider,
          });

          await prisma.companyAsset.update({
            where: { id: asset.id },
            data: { jobId },
          });

          assets.push({ id: asset.id, status: 'pending', jobId, llmProvider: provider });
        }

        reply.send({ success: true, assets });
      } catch (error) {
        console.error('Error generating company assets:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get all company assets
  fastify.get(
    '/vibe/companies/:companyId/assets',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const prisma = PrismaInstance.getInstance();
        const assets = await prisma.companyAsset.findMany({
          where: { companyId },
          orderBy: { createdAt: 'desc' },
        });

        // Parse JSON fields for the response
        const parsed = assets.map((a: any) => ({
          id: a.id,
          companyId: a.companyId,
          label: a.label,
          llmProvider: a.llmProvider,
          status: a.status,
          progress: a.progress,
          images: a.images ? JSON.parse(a.images) : null,
          errorMessage: a.errorMessage,
          createdAt: a.createdAt,
        }));

        reply.send({ success: true, assets: parsed });
      } catch (error) {
        console.error('Error fetching company assets:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete company asset
  fastify.delete(
    '/vibe/companies/:companyId/assets/:assetId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const assetId = parseInt(request.params.assetId);
        if (isNaN(companyId) || isNaN(assetId)) {
          reply.status(400).send({ error: 'Invalid IDs' });
          return;
        }

        const prisma = PrismaInstance.getInstance();
        const asset = await prisma.companyAsset.findFirst({
          where: { id: assetId, companyId },
        });

        if (!asset) {
          reply.status(404).send({ error: 'Asset not found' });
          return;
        }

        // Try to remove files on disk
        const publicDir = process.env['PUBLIC_DIR'] || '';
        const assetDir = pathModule.join(
          publicDir,
          'companydata',
          'assets',
          companyId.toString(),
          assetId.toString()
        );
        try {
          await fsPromises.rm(assetDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }

        await prisma.companyAsset.delete({ where: { id: assetId } });

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting company asset:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Download company assets as ZIP
  fastify.get(
    '/vibe/companies/:companyId/assets/:assetId/download-zip',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const assetId = parseInt(request.params.assetId);
        if (isNaN(companyId) || isNaN(assetId)) {
          reply.status(400).send({ error: 'Invalid IDs' });
          return;
        }

        const prisma = PrismaInstance.getInstance();
        const asset = await prisma.companyAsset.findFirst({
          where: { id: assetId, companyId },
        });

        if (!asset || asset.status !== 'completed' || !asset.images) {
          reply.status(404).send({ error: 'Asset not found or not ready' });
          return;
        }

        const images: string[] = JSON.parse(asset.images);
        const publicDir = process.env['PUBLIC_DIR'] || '';
        const assetDir = pathModule.join(
          publicDir,
          'companydata',
          'assets',
          companyId.toString(),
          assetId.toString()
        );

        const zipName = `company_assets_${asset.label ? asset.label.replace(/[^a-zA-Z0-9]/g, '_') + '_' : ''}${assetId}.zip`;

        // Build ZIP in memory
        const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
          const archive = archiver('zip', { zlib: { level: 9 } });
          const chunks: Buffer[] = [];

          archive.on('data', (chunk: Buffer) => chunks.push(chunk));
          archive.on('end', () => resolve(Buffer.concat(chunks)));
          archive.on('error', (err: Error) => reject(err));

          for (const filename of images) {
            const filePath = pathModule.join(assetDir, filename);
            if (require('fs').existsSync(filePath)) {
              archive.file(filePath, { name: filename });
            }
          }

          archive.finalize();
        });

        reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${zipName}"`)
          .send(zipBuffer);
      } catch (error) {
        console.error('Error downloading company assets ZIP:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
